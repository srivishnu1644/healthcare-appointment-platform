/**
 * Queue entries.
 *
 * Replaces the three inconsistent JSON stores: the `db.queue[]` array,
 * `slots.current_queue` (a counter that only ever incremented), and
 * `appointments.queue_position` (a denormalised copy). Position is now
 * allocated by the database and cannot be forged.
 */
import { query, rows, one } from "../config/database.js";
import { DATE_EXPR, TIME_EXPR } from "./base.js";

const QUEUE_SELECT = `
  q.id, q.slot_id, q.appointment_id, q.doctor_id, q.patient_id,
  q.state, q.position, q.joined_at, q.called_at, q.left_at,
  pu.full_name AS patient_name
`;

const FROM_QUEUE = `
  FROM queue_entries q
  JOIN users pu ON pu.id = q.patient_id
`;

const toEntry = (r) =>
  r && {
    id: r.id,
    slotId: r.slot_id,
    appointmentId: r.appointment_id,
    doctorId: r.doctor_id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    state: r.state,
    position: r.position,
    joinedAt: r.joined_at,
    calledAt: r.called_at,
    leftAt: r.left_at,
  };

/**
 * Full waiting list for a doctor, optionally restricted to a date.
 * `position` is the authoritative value.
 */
export const listForDoctor = async (doctorId, date) => {
  const params = [doctorId];
  let clause = "";
  if (date) {
    params.push(date);
    clause = `AND ${DATE_EXPR("sl")} = $${params.length}`;
  }

  return (
    await rows(
      `SELECT ${QUEUE_SELECT}, ${TIME_EXPR("sl")} AS start_time
         ${FROM_QUEUE}
         JOIN slots sl ON sl.id = q.slot_id
        WHERE q.doctor_id = $1 ${clause}
        ORDER BY sl.starts_at, q.position`,
      params,
    )
  ).map(toEntry);
};

/** A patient's own queue entry for an appointment, if any. */
export const findByAppointment = async (appointmentId, tx = null) => {
  const runner = tx ?? { one };
  return toEntry(
    await runner.one(`SELECT ${QUEUE_SELECT} ${FROM_QUEUE} WHERE q.appointment_id = $1`, [
      appointmentId,
    ]),
  );
};

/**
 * Insert a queue entry, allocating the next position for the slot.
 *
 * Idempotent: a second check-in for the same appointment is a no-op, and
 * the unique index on appointment_id enforces that at the database level.
 *
 * @returns {Promise<{entry: object|null, created: boolean}>}
 */
/**
 * Join the waiting room for an appointment.
 *
 * Position is DERIVED from the highest position already waiting for the slot,
 * never incremented from a stored counter. That is what makes it impossible for a
 * patient to inflate their own place by calling check-in repeatedly: there is no
 * counter to increment, and a second call returns the existing entry unchanged
 * (Phase 0 finding D-B4).
 *
 * `capacity` is enforced here as well as by `queue_unique_position`. The unique
 * index only stops two entries claiming the same position; it knows nothing
 * about how many the slot will hold. Honouring `slots.max_queue` needs an
 * explicit comparison, done under the caller's lock so the count cannot change
 * between the check and the insert.
 *
 * Must run inside a transaction that has locked the slot row; see
 * queueService.joinQueue.
 *
 * @returns {Promise<{entry: object|null, created: boolean, full: boolean}>}
 */
export const join = async ({ appointmentId, slotId, doctorId, patientId, capacity = null }, tx = null) => {
  const runner = tx ?? { one };

  const existing = await findByAppointment(appointmentId, tx);
  if (existing) return { entry: existing, created: false, full: false };

  const next = await runner.one(
    `SELECT COALESCE(max(position), 0) + 1 AS next
       FROM queue_entries WHERE slot_id = $1 AND state = 'waiting'`,
    [slotId],
  );

  if (capacity !== null && next.next > capacity) {
    return { entry: null, created: false, full: true };
  }

  const r = await runner.one(
    `INSERT INTO queue_entries
       (id, appointment_id, slot_id, doctor_id, patient_id, position)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)
     RETURNING id`,
    [appointmentId, slotId, doctorId, patientId, next.next],
  );
  if (!r) throw new Error(`failed to create a queue entry for ${appointmentId}`);

  // Look the entry up by its APPOINTMENT id, not by the queue row's own id:
  // findByAppointment matches on appointment_id.
  return {
    entry: toEntry(await findByAppointment(appointmentId, tx)),
    created: true,
    full: false,
  };
};

/** Advance an entry to the next state. */
export const setState = async (id, state, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    `UPDATE queue_entries
        SET state = $2::queue_state,
            called_at = CASE WHEN $2::queue_state IN ('in-consultation','completed')
                            THEN COALESCE(called_at, now()) ELSE called_at END,
            left_at   = CASE WHEN $2::queue_state = 'left' THEN now() ELSE left_at END
      WHERE id = $1`,
    [id, state],
  );
};

/** Remove every entry for an appointment (used on cancellation). */
export const clearForAppointment = async (appointmentId, tx = null) => {
  const runner = tx ?? { query };
  await runner.query("DELETE FROM queue_entries WHERE appointment_id = $1", [appointmentId]);
};

/** Capacity check: how many are waiting versus the slot's max. */
export const occupancy = async (slotId, tx = null) => {
  const runner = tx ?? { one };
  return runner.one(
    `SELECT
       (SELECT count(*)::int FROM queue_entries WHERE slot_id = $1 AND state = 'waiting') AS waiting,
       (SELECT max_queue FROM slots WHERE id = $1) AS max_queue`,
    [slotId],
  );
};

export default { listForDoctor, findByAppointment, join, setState, clearForAppointment, occupancy };