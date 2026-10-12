/**
 * Queue entries.
 *
 * Replaces the three inconsistent JSON stores: the `db.queue[]` array,
 * `slots.current_queue` (a counter that only ever incremented), and
 * `appointments.queue_position` (a denormalised copy). Position is now
 * allocated by the database and cannot be forged.
 */
import { query, rows, one } from "../config/database.js";
import { DATE_EXPR, TIME_EXPR, tzLiteral } from "./base.js";

const QUEUE_SELECT = `
  q.id, q.slot_id, q.appointment_id, q.doctor_id, q.patient_id,
  q.state, q.position, q.clinic_date, q.joined_at, q.called_at, q.left_at,
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
    // Legacy per-slot number, still written and still read by the older
    // projections. The room ranking is computed and never comes from it.
    position: r.position,
    clinicDate: r.clinic_date,
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

/* ------------------------------------------------------------------ *
 *  The waiting room: (doctor_id, clinic_date)                         *
 * ------------------------------------------------------------------ *
 * Patients hold separate slots but wait for the same person, so their order
 * comes from arrival, not from the slot. `row_number()` over the waiting set
 * gives a contiguous 1..N that renumbers itself the moment anyone leaves, with
 * no stored counter and therefore no compaction code and no gaps.
 *
 * The patient in consultation is deliberately EXCLUDED from the ranking and
 * returned separately, so "you are 2nd" never silently changes meaning.
 */

// `PARTITION BY q.state` is load-bearing: without it the window would rank the
// finished visits in the room alongside the waiting ones, and the first waiting
// patient would be handed position 2. Only the waiting set is ever surfaced, so
// ranking it on its own is what makes positions start at 1 and stay contiguous.
const ROOM_RANKED_SELECT = `
  SELECT ${QUEUE_SELECT},
         ${TIME_EXPR("sl")} AS start_time,
         CASE WHEN q.state = 'waiting'
              THEN row_number() OVER (
                     PARTITION BY q.state
                     ORDER BY q.joined_at ASC, q.id ASC)
              ELSE NULL END AS room_position
    FROM queue_entries q
    JOIN users pu ON pu.id = q.patient_id
    JOIN slots sl ON sl.id = q.slot_id
   WHERE q.doctor_id = $1 AND q.clinic_date = $2::date
   ORDER BY
     -- the consultation first, then the waiting order, then history
     (q.state <> 'in-consultation'),
     q.state = 'completed',
     q.joined_at ASC,
     q.id ASC
`;

/**
 * Every entry in one doctor's room for one clinic date, with computed positions.
 *
 * Read-only, so no transaction and no lock.
 */
export const listRoom = async (doctorId, clinicDate, tx = null) => {
  const params = [doctorId, clinicDate];
  // `rows` is a standalone helper, not an object with a `.query` method, so the
  // transaction path has to be spelled out rather than swapped in.
  const result = tx
    ? (await tx.query(ROOM_RANKED_SELECT, params)).rows
    : await rows(ROOM_RANKED_SELECT, params);
  return result.map((r) => ({ ...toEntry(r), roomPosition: r.room_position }));
};

/**
 * The patient currently in consultation in this room, or null.
 *
 * This is the first thing "call next" reads: if someone is already with the
 * doctor, calling again is a no-op rather than a promotion.
 */
export const findActiveConsultation = async (doctorId, clinicDate, tx = null) => {
  const runner = tx ?? { one };
  return runner
    .one(
      `SELECT ${QUEUE_SELECT}, ${TIME_EXPR("sl")} AS start_time
         FROM queue_entries q
         JOIN users pu ON pu.id = q.patient_id
         JOIN slots sl ON sl.id = q.slot_id
        WHERE q.doctor_id = $1 AND q.clinic_date = $2::date
          AND q.state = 'in-consultation'
        LIMIT 1`,
      [doctorId, clinicDate],
    )
    .then(toEntry);
};

/**
 * The next patient to be seen: the earliest arrival still waiting.
 *
 * `FOR UPDATE` so the row cannot change underneath a promotion. Callers hold
 * the room's advisory lock (see lockRoom), which is what makes "head of the
 * queue" a stable answer rather than a race between two doctors' browsers.
 */
export const headWaiting = async (doctorId, clinicDate, tx = null) => {
  const runner = tx ?? { one };
  return runner
    .one(
      `SELECT ${QUEUE_SELECT}, ${TIME_EXPR("sl")} AS start_time
         FROM queue_entries q
         JOIN users pu ON pu.id = q.patient_id
         JOIN slots sl ON sl.id = q.slot_id
        WHERE q.doctor_id = $1 AND q.clinic_date = $2::date
          AND q.state = 'waiting'
        ORDER BY q.joined_at ASC, q.id ASC
        LIMIT 1
        FOR UPDATE OF q`,
      [doctorId, clinicDate],
    )
    .then(toEntry);
};

/**
 * Serialise every mutation of one waiting room.
 *
 * A transaction-scoped advisory lock: released automatically at COMMIT or
 * ROLLBACK, so it cannot leak, and it is per-room, so two doctors never contend.
 *
 * LOCK ORDER (see the module comment in queueService.js):
 *   1. this advisory room lock   2. appointment row   3. slot row
 * It must be the FIRST lock any operation takes. Taken later it would invert
 * against a path that already holds a row lock, and two transactions could
 * deadlock.
 */
export const lockRoom = async (doctorId, clinicDate, tx) => {
  if (!tx) throw new Error("lockRoom requires a transaction");
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`${doctorId}:${clinicDate}`],
  );
};

/**
 * A patient's own place in the room, computed rather than counted.
 *
 * "Ahead of you" is every entry still waiting that arrived earlier, with the id
 * breaking a tie in the same millisecond. Returns null when the patient is not
 * waiting, which is the only honest answer for someone who has left the room.
 */
export const roomPositionFor = async (appointmentId, tx = null) => {
  const runner = tx ?? { one };
  const r = await runner.one(
    `SELECT count(*)::int AS ahead
       FROM queue_entries mine
       JOIN queue_entries other
         ON other.doctor_id = mine.doctor_id
        AND other.clinic_date = mine.clinic_date
        AND other.state = 'waiting'
      WHERE mine.appointment_id = $1
        AND mine.state = 'waiting'
        AND (other.joined_at, other.id) < (mine.joined_at, mine.id)`,
    [appointmentId],
  );
  if (!r || r.ahead === null) return null;
  return r.ahead + 1;
};

/**
 * Room positions for a whole page of appointments, in ONE query.
 *
 * Replaces the old projection that read the stored per-slot number, which was
 * always 1 and so told a patient waiting behind two others that they were next.
 * The window function is evaluated per room and then joined back, so the cost is
 * one pass regardless of page size. Ids go through a bound array parameter and
 * never into the SQL text.
 *
 * @param {string[]} appointmentIds
 * @returns {Promise<Map<string, number>>} appointmentId -> room position
 */
export const roomPositionsForAppointments = async (appointmentIds) => {
  const ids = [...new Set((appointmentIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const result = await rows(
    `SELECT appointment_id, room_position, room_state
       FROM (
         SELECT q.appointment_id, q.state AS room_state,
                CASE WHEN q.state = 'waiting'
                     THEN row_number() OVER (
                       -- The room is the partition. Ranking globally would
                       -- report a patient's place in every waiting room in the
                       -- system rather than their own.
                       PARTITION BY q.doctor_id, q.clinic_date
                       ORDER BY q.joined_at ASC, q.id ASC)
                     ELSE NULL END AS room_position
           FROM queue_entries q
          -- The patient in consultation is IN the room but has no place in the
          -- line, so they carry a state and no number.
          WHERE q.state IN ('waiting', 'in-consultation')
       ) ranked
      WHERE ranked.appointment_id = ANY($1::text[])`,
    [ids],
  );
  return new Map(
    result.map((r) => [
      r.appointment_id,
      { position: r.room_position, state: r.room_state },
    ]),
  );
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
export const join = async (
  { appointmentId, slotId, doctorId, patientId, capacity = null },
  tx = null,
) => {
  const runner = tx ?? { one };

  const existing = await findByAppointment(appointmentId, tx);
  if (existing) return { entry: existing, created: false, full: false };

  // Legacy per-slot number, retained only so the readers that still use it keep
  // working. The room position is computed at read time and ignores this.
  const next = await runner.one(
    `SELECT COALESCE(max(position), 0) + 1 AS next
       FROM queue_entries WHERE slot_id = $1 AND state = 'waiting'`,
    [slotId],
  );

  if (capacity !== null && next.next > capacity) {
    return { entry: null, created: false, full: true };
  }

  // `clinic_date` names the waiting room this entry joins, and is derived with
  // the same expression the repositories use to label a slot by its clinic date
  // (and the same one the 017 migration backfilled with), so the two cannot
  // drift apart.
  const r = await runner.one(
    `INSERT INTO queue_entries
       (id, appointment_id, slot_id, doctor_id, patient_id, position, clinic_date)
     SELECT gen_random_uuid()::text, $1, $2, $3, $4, $5,
            to_char(sl.starts_at AT TIME ZONE ${tzLiteral}, 'YYYY-MM-DD')::date
       FROM slots sl
      WHERE sl.id = $2
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

/**
 * Mark a patient's queue entry as having left, keeping the record.
 *
 * Used by no-show. A patient who never checked in has no entry and this is a
 * no-op, so it needs no special-casing at the call site.
 */
export const markLeftForAppointment = async (appointmentId, tx = null) => {
  const runner = tx ?? { query };
  const r = await runner.query(
    `UPDATE queue_entries
        SET state = 'left', left_at = now()
      WHERE appointment_id = $1 AND state <> 'completed'`,
    [appointmentId],
  );
  return r.rowCount ?? 0;
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

/**
 * Batched active-queue lookup for a set of appointments.
 *
 * Returns Map<appointmentId, position> for entries that still represent a live
 * place in the queue (`waiting` or `in-consultation`). A `completed` or `left`
 * entry is terminal: the visit already happened or the patient left, so there is
 * no position to report and none is invented here.
 *
 * Deliberately ONE query for the whole page: the list endpoint would otherwise
 * issue a lookup per row. Ids go through a bound array parameter, never into the
 * SQL text.
 *
 * @param {string[]} appointmentIds
 * @returns {Promise<Map<string, number>>}
 */
export const positionsForAppointments = async (appointmentIds) => {
  const ids = [...new Set((appointmentIds || []).filter(Boolean))];
  if (!ids.length) return new Map();

  const result = await rows(
    `SELECT q.appointment_id, q.position
       FROM queue_entries q
      WHERE q.appointment_id = ANY($1::text[])
        AND q.state IN ('waiting', 'in-consultation')`,
    [ids],
  );
  return new Map(result.map((r) => [r.appointment_id, r.position]));
};

export default {
  listForDoctor,
  listRoom,
  findActiveConsultation,
  headWaiting,
  lockRoom,
  roomPositionFor,
  roomPositionsForAppointments,
  findByAppointment,
  positionsForAppointments,
  join,
  setState,
  markLeftForAppointment,
  clearForAppointment,
  occupancy,
};
