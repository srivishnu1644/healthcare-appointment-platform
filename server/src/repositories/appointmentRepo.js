/**
 * Appointments.
 *
 * The names that used to be denormalised onto every appointment row
 * (patientName, doctorName, specialtyName, facilityName) and the
 * date/startTime/endTime copies are all derived here by JOIN, so they
 * cannot go stale. The camelCase shape is preserved because the client
 * renders these fields directly.
 *
 * Concurrency is enforced by the schema, not by this file:
 *   appointments_one_active_per_slot   (partial unique)
 *   appointments_patient_no_overlap    (exclusion)
 * Phase 6 will wrap booking in withTransaction() and map those SQLSTATE
 * codes to 409s. This phase deliberately leaves booking logic untouched.
 */
import { query, rows, one } from "../config/database.js";
import { inClause, DATE_EXPR, TIME_EXPR } from "./base.js";

const APPOINTMENT_SELECT = `
  a.id, a.patient_id, a.doctor_id, a.slot_id, a.specialty_id, a.facility_id,
  a.mode, a.status, a.reason, a.symptoms, a.fee,
  a.cancel_reason, a.cancelled_at, a.cancelled_by,
  a.checked_in_at, a.completed_at, a.reminder_sent_at,
  a.created_at, a.updated_at,
  ${DATE_EXPR("a", "starts_at")} AS date,
  ${TIME_EXPR("a", "starts_at")} AS start_time,
  ${TIME_EXPR("a", "ends_at")}   AS end_time,
  pu.full_name AS patient_name,
  du.full_name AS doctor_name,
  s.name       AS specialty_name,
  f.name       AS facility_name,
  a.starts_at, a.ends_at
`;

const FROM_APPOINTMENT = `
  FROM appointments a
  JOIN users pu      ON pu.id = a.patient_id
  JOIN users du      ON du.id = (SELECT d.user_id FROM doctors d WHERE d.id = a.doctor_id)
  JOIN specialties s ON s.id = a.specialty_id
  JOIN facilities  f ON f.id = a.facility_id
`;

const toAppointment = (r) =>
  r && {
    id: r.id,
    patientId: r.patient_id,
    patientName: r.patient_name,
    doctorId: r.doctor_id,
    doctorName: r.doctor_name,
    specialtyName: r.specialty_name,
    facilityId: r.facility_id,
    facilityName: r.facility_name,
    slotId: r.slot_id,
    date: r.date,
    startTime: r.start_time,
    endTime: r.end_time,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    mode: r.mode,
    reason: r.reason,
    symptoms: r.symptoms,
    status: r.status,
    fee: r.fee === null ? null : Number(r.fee),
    queuePosition: null,
    createdAt: r.created_at,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    cancelledBy: r.cancelled_by,
    checkedInAt: r.checked_in_at,
    completedAt: r.completed_at,
    reminderSentAt: r.reminder_sent_at,
  };

/**
 * List appointments with the same scope semantics the controller has
 * always applied: patients see their own, doctors see their own
 * schedule, admins see everything.
 */
export const list = async ({ scope, patientId, doctorId, status, from, to, limit } = {}) => {
  const params = [];
  const where = [];

  if (patientId) {
    params.push(patientId);
    where.push(`a.patient_id = $${params.length}`);
  }
  if (doctorId) {
    params.push(doctorId);
    where.push(`a.doctor_id = $${params.length}`);
  }
  if (status) {
    const list0 = String(status).split(",");
    const { clause, params: p } = inClause(list0, params.length + 1);
    params.push(...p);
    where.push(`a.status::text IN (${clause})`);
  }
  if (from) {
    params.push(from);
    where.push(`${DATE_EXPR("a", "starts_at")} >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`${DATE_EXPR("a", "starts_at")} <= $${params.length}`);
  }

  const sql = `
    SELECT ${APPOINTMENT_SELECT}
    ${FROM_APPOINTMENT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY a.starts_at DESC, ${TIME_EXPR("a", "starts_at")} DESC
    ${limit ? `LIMIT ${Number(limit)}` : ""}`;

  return (await rows(sql, params)).map(toAppointment);
};

/**
 * `tx` is accepted everywhere in this file so that a read taken inside the
 * booking transaction observes that transaction's own uncommitted writes, rather
 * than a stale snapshot from a different pooled connection.
 */
export const findById = async (id, tx = null) => {
  const runner = tx ?? { one };
  return toAppointment(
    await runner.one(`SELECT ${APPOINTMENT_SELECT} ${FROM_APPOINTMENT} WHERE a.id = $1`, [id]),
  );
};

/** Minimal projection for internal service use. */
export const findRawById = async (id, tx = null) => {
  const runner = tx ?? { one };
  return runner.one(
    `SELECT id, patient_id, doctor_id, slot_id, mode, status, reason, symptoms, fee,
            starts_at, ends_at, cancel_reason, cancelled_at, reminder_sent_at
       FROM appointments WHERE id = $1`,
    [id],
  );
};

/**
 * Read an appointment and hold a row lock on it for the rest of the transaction.
 *
 * Lifecycle changes (cancel, reschedule, status) lock the appointment first, so
 * two concurrent requests cannot both read the same `status` and both decide the
 * transition is legal. Without the lock, "read status, then write status" is a
 * race that the status-transition table cannot close.
 *
 * Must be called inside a transaction.
 */
export const lockById = async (id, tx) => {
  const r = await tx.one(
    `SELECT id, patient_id, doctor_id, slot_id, mode, status, reason, symptoms, fee,
            starts_at, ends_at, cancel_reason, cancelled_at, reminder_sent_at
       FROM appointments WHERE id = $1
       FOR UPDATE`,
    [id],
  );
  return r;
};

/**
 * Insert an appointment.
 *
 * The unique/exclusion constraints on the table are the authority: a
 * concurrent double booking surfaces here as SQLSTATE 23505 or 23P01.
 *
 * @param {object} input
 * @param {import('../config/database.js')} [tx] optional transaction client
 */
export const insert = async (
  { id, patientId, doctorId, slotId, specialtyId, facilityId, mode, status = "confirmed", reason, symptoms, fee, startsAt, endsAt },
  tx = null,
) => {
  const runner = tx ?? { query };
  const r = await runner.query(
    `INSERT INTO appointments
       (id, patient_id, doctor_id, slot_id, specialty_id, facility_id,
        mode, status, reason, symptoms, fee, starts_at, ends_at)
     VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [id ?? null, patientId, doctorId, slotId, specialtyId, facilityId, mode, status, reason ?? null, symptoms ?? null, fee ?? null, startsAt, endsAt],
  );
  return r.rows[0].id;
};

/** Update the mutable fields of an appointment. */
export const updateFields = async (id, patch, tx = null) => {
  const runner = tx ?? { query };
  // Enum-typed columns are cast explicitly: PostgreSQL cannot deduce that one
  // placeholder is both a `consult_mode` and an `appt_status`.
  const columnFor = {
    reason: { column: "reason", cast: null },
    symptoms: { column: "symptoms", cast: null },
    mode: { column: "mode", cast: "::consult_mode" },
    status: { column: "status", cast: "::appt_status" },
    fee: { column: "fee", cast: null },
    // No `status_note` column: a note on a transition belongs in
    // appointment_status_history, which is append-only and queryable.
  };
  const sets = [];
  const params = [id];
  for (const [key, { column, cast }] of Object.entries(columnFor)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${column} = $${params.length}${cast ?? ""}`);
    }
  }
  if (!sets.length) return;
  await runner.query(
    `UPDATE appointments SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    params,
  );
};

/**
 * Mark an appointment cancelled. Also stamps the audit fields, which the
 * schema requires to be consistent with the status.
 */
/**
 * Mark an appointment cancelled, stamping the audit fields the schema requires
 * to be consistent with the status (`appointments_cancel_consistent`).
 *
 * Returns the re-read row using the SAME connection when called inside a
 * transaction, so the returned value includes this update rather than a snapshot
 * taken before it.
 */
export const markCancelled = async (id, { reason, actorRole }, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    `UPDATE appointments
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
            cancel_reason = $3, updated_at = now()
      WHERE id = $1`,
    [id, actorRole, reason || null],
  );
  return findById(id, tx);
};

export const markCompleted = async (id, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    "UPDATE appointments SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1",
    [id],
  );
};

export const markCheckedIn = async (id, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    "UPDATE appointments SET checked_in_at = COALESCE(checked_in_at, now()), updated_at = now() WHERE id = $1",
    [id],
  );
};

export const markReminderSent = async (id, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    "UPDATE appointments SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL",
    [id],
  );
};

/**
 * Reschedule in one statement. `starts_at` / `ends_at` move with the new
 * slot so the exclusion constraint applies to the new time.
 */
export const reschedule = async (id, { slotId, startsAt, endsAt, mode, fee }, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    `UPDATE appointments
        SET slot_id = $2, starts_at = $3, ends_at = $4, mode = $5,
            fee = COALESCE($6, fee), status = 'confirmed', updated_at = now()
      WHERE id = $1`,
    [id, slotId, startsAt, endsAt, mode, fee ?? null],
  );
  return findById(id, tx);
};

/**
 * Patient double-booking probe. The database enforces this too; the
 * service still checks first so the user gets a friendly message.
 */
/**
 * Patient double-booking probe, for a friendly error before the database has to
 * reject the insert.
 *
 * Compares INTERSECTING TIME WINDOWS, not the date and clock time. The original
 * compared `date + startTime` strings, so a patient could hold 09:00-09:30 and
 * then book 09:15-09:45 and both were accepted (Phase 0 finding D-B1). Overlap is
 * now computed on the real instants, which is also what
 * `appointments_patient_no_overlap` enforces.
 *
 * This remains a courtesy check: the exclusion constraint is the authority, and
 * its violation is mapped to the same PATIENT_CLASH the caller would have got
 * here.
 */
export const findPatientClash = async (patientId, startsAt, endsAt, tx = null) => {
  const runner = tx ?? { one };
  return runner.one(
    `SELECT a.id
       FROM appointments a
      WHERE a.patient_id = $1
        AND a.status IN ('scheduled','confirmed','in-progress')
        AND tstzrange(a.starts_at, a.ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
      LIMIT 1`,
    [patientId, startsAt, endsAt],
  );
};

/**
 * The active appointment for a slot, if any.
 *
 * Read inside the booking transaction to distinguish "this slot is free" from
 * "the slot row says available but an active appointment already points at it".
 * The two can disagree if an earlier code path set the status without creating
 * the appointment, so the appointment is treated as the authority.
 */
export const findActiveForSlot = async (slotId, tx = null) => {
  const runner = tx ?? { one };
  return runner.one(
    `SELECT id FROM appointments
      WHERE slot_id = $1 AND status IN ('scheduled','confirmed','in-progress')
      LIMIT 1`,
    [slotId],
  );
};

export const count = async () => one("SELECT count(*)::int AS c FROM appointments");

/* ------------------------------------------------------------------ *
 *  Status history (new in this phase)                                *
 * ------------------------------------------------------------------ */

export const history = {
  /** Append one transition. */
  record: async ({ appointmentId, fromStatus = null, toStatus, changedBy = null, note = null }, tx = null) => {
    const runner = tx ?? { query };
    await runner.query(
      `INSERT INTO appointment_status_history
         (appointment_id, from_status, to_status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [appointmentId, fromStatus, toStatus, changedBy, note],
    );
  },

  /** Timeline for one appointment, oldest first. */
  forAppointment: async (appointmentId) =>
    (
      await rows(
        `SELECT h.id, h.from_status, h.to_status, h.changed_by, h.note, h.created_at,
                u.full_name AS changed_by_name
           FROM appointment_status_history h
           LEFT JOIN users u ON u.id = h.changed_by
          WHERE h.appointment_id = $1
          ORDER BY h.created_at, h.id`,
        [appointmentId],
      )
    ).map((r) => ({
      id: Number(r.id),
      fromStatus: r.from_status,
      toStatus: r.to_status,
      changedBy: r.changed_by,
      changedByName: r.changed_by_name,
      note: r.note,
      createdAt: r.created_at,
    })),
};

export default { list, findById, findRawById, lockById, insert, updateFields, markCancelled, markCompleted, markCheckedIn, markReminderSent, reschedule, findPatientClash, findActiveForSlot, count, history };