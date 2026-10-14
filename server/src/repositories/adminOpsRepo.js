/**
 * Administrative read models.
 *
 * WHY A SEPARATE REPOSITORY
 * -------------------------
 * These are not new sources of truth. Every query here reads the same
 * `appointments`, `queue_entries`, `slots` and `users` rows the booking and queue
 * services own. What it adds is the CROSS-DOCTOR, CROSS-PATIENT view an
 * administrator needs and no patient or provider endpoint may ever offer.
 *
 * Two rules are enforced by construction rather than by discipline:
 *
 *   1. NOTHING IS WRITTEN. There is no INSERT, UPDATE or DELETE in this file.
 *      Administrative changes go through the ordinary booking and queue services,
 *      so the locking contract, the conflict rules and the ownership checks all
 *      still apply. An admin who could write here could bypass them.
 *   2. EVERY LIST IS PAGINATED AND COUNTED IN THE SAME QUERY SHAPE. Returning a
 *      whole table and slicing it in JavaScript is how a directory page turns
 *      into an outage as the data grows, and it makes "page 2" a lie.
 *
 * Parameterised throughout: no value from a request reaches SQL as text.
 */
import { rows, one } from "../config/database.js";
import { DATE_EXPR, TIME_EXPR } from "./base.js";

/**
 * A DATE-comparable form of the clinic-zone date.
 *
 * `DATE_EXPR` deliberately returns TEXT: it is the same expression the
 * patient-facing API uses to LABEL a slot, and its output goes straight into a
 * response. Comparing that text to a real date fails with
 * "operator does not exist: text >= date" - a 500 from the database, for a
 * perfectly reasonable query parameter.
 *
 * This hit the availability query and then the date range twice more, so it is
 * now ONE helper used by every date comparison in this file rather than four
 * separate casts that can each be forgotten.
 */
const dateOf = (table, column) => `(${DATE_EXPR(table, column)})::date`;

/** Clamped so a hostile `limit=10000000` cannot ask for the whole table. */
const pageSize = (limit, fallback = 50) =>
  Math.min(Math.max(Number(limit) || fallback, 1), 200);
const offsetOf = (offset) => Math.max(Number(offset) || 0, 0);

/**
 * `sort` is a whitelist, never interpolated from the request.
 *
 * A caller asking for `?sort=; DROP TABLE users` gets the default column rather
 * than SQL, because the value is compared against this list and the matched
 * STRING is used - the request text itself is never placed in the query.
 */
const APPOINTMENT_SORTS = {
  newest: `a.starts_at DESC, ${TIME_EXPR("a", "starts_at")} DESC`,
  oldest: `a.starts_at ASC, ${TIME_EXPR("a", "starts_at")} ASC`,
  patient: `pu.full_name ASC, a.starts_at DESC`,
  doctor: `du.full_name ASC, a.starts_at DESC`,
  status: `a.status ASC, a.starts_at DESC`,
};

/* ------------------------------------------------------------------ *
 *  Appointments                                                      *
 * ------------------------------------------------------------------ */

/**
 * Every appointment, across every doctor, with the filters an administrator
 * actually needs to answer "what is happening".
 *
 * @returns {Promise<{appointments: object[], total: number, limit: number,
 *                    offset: number}>}
 */
export const listAppointments = async ({
  search = "",
  status,
  doctorId,
  patientId,
  from,
  to,
  sort = "newest",
  limit,
  offset,
} = {}) => {
  const params = [];
  const where = [];

  // Free-text across the two names an administrator would search by.
  const term = String(search || "").trim();
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    const p = params.length;
    where.push(
      `(lower(pu.full_name) LIKE $${p} OR lower(du.full_name) LIKE $${p} ` +
        `OR lower(pu.email) LIKE $${p} OR a.id::text LIKE $${p})`,
    );
  }

  if (status) {
    const wanted = String(status)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (wanted.length) {
      params.push(wanted);
      where.push(`a.status::text = ANY($${params.length}::text[])`);
    }
  }

  if (doctorId) {
    params.push(doctorId);
    where.push(`a.doctor_id = $${params.length}`);
  }
  if (patientId) {
    params.push(patientId);
    where.push(`a.patient_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`${dateOf("a", "starts_at")} >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`${dateOf("a", "starts_at")} <= $${params.length}::date`);
  }

  const whereSql = where.length ? `AND ${where.join(" AND ")}` : "";
  const orderSql = APPOINTMENT_SORTS[String(sort)] ?? APPOINTMENT_SORTS.newest;
  const size = pageSize(limit);
  const skip = offsetOf(offset);

  // The same FROM and the same predicates for both queries, so `total` always
  // describes exactly the set the page is drawn from. A count built from a
  // different join than the rows is how "page 2 of 1" happens.
  const FROM = `
         FROM appointments a
         JOIN users pu ON pu.id = a.patient_id
         JOIN doctors d  ON d.id  = a.doctor_id
         JOIN users du  ON du.id = d.user_id`;

  const total = (
    await one(
      `SELECT count(*)::int AS n${FROM} WHERE true ${whereSql}`,
      params,
    )
  ).n;

  const appointments = await rows(
    `SELECT a.id, a.status, a.starts_at, a.ends_at, a.mode, a.fee,
            a.reason, a.checked_in_at, a.cancelled_at, a.cancel_reason,
            a.created_at,
            a.patient_id  AS "patientId",
            pu.full_name  AS "patientName",
            pu.email      AS "patientEmail",
            a.doctor_id   AS "doctorId",
            du.full_name  AS "doctorName",
            d.specialty_id AS "specialtyId",
            ${DATE_EXPR("a", "starts_at")} AS "date",
            ${TIME_EXPR("a", "starts_at")} AS "startTime",
            ${TIME_EXPR("a", "ends_at")}   AS "endTime",
            (SELECT q.state FROM queue_entries q WHERE q.appointment_id = a.id)
              AS "queueState",
            -- The room position, computed exactly as the patient-facing API
            -- computes it. Self-contained on a.id: the earlier version compared
            -- against q.id, a name from a different subquery, so it referenced
            -- nothing and the column was always NULL.
            (SELECT ranked.room_position FROM (
               SELECT e.appointment_id,
                      row_number() OVER (
                        PARTITION BY e.doctor_id, e.clinic_date
                        ORDER BY e.joined_at ASC, e.id ASC
                      ) AS room_position
                 FROM queue_entries e
                WHERE e.state = 'waiting'
             ) ranked WHERE ranked.appointment_id = a.id) AS "roomPosition"${FROM}
      WHERE true ${whereSql}
      ORDER BY ${orderSql}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, skip],
  );

  return { appointments, total, limit: size, offset: skip };
};

/* ------------------------------------------------------------------ *
 *  Waiting rooms                                                     *
 * ------------------------------------------------------------------ */

/**
 * Every room with somebody in it, for the operations view.
 *
 * A room is (doctor_id, clinic_date) - the Phase 9 model - so "queue length" is a
 * property of a provider's day, not of a slot. Counting here uses the same
 * definition the patient-facing API uses, so the two can never disagree.
 */
export const activeRooms = async ({ limit = 50, offset = 0 } = {}) => {
  const size = pageSize(limit);
  const skip = offsetOf(offset);

  const total = (
    await one(
      `SELECT count(DISTINCT (q.doctor_id, q.clinic_date))::int AS n
         FROM queue_entries q
        WHERE q.state IN ('waiting', 'in-consultation')`,
    )
  ).n;

  const rooms = await rows(
    `SELECT q.doctor_id   AS "doctorId",
            du.full_name  AS "doctorName",
            q.clinic_date::text AS "clinicDate",
            count(*) FILTER (WHERE q.state = 'waiting')::int         AS waiting,
            count(*) FILTER (WHERE q.state = 'in-consultation')::int AS "inConsultation",
            min(q.joined_at) FILTER (WHERE q.state = 'waiting')      AS "oldestWaitingAt",
            (SELECT jsonb_build_object(
                      'appointmentId', c.appointment_id,
                      'patientName',   cu.full_name,
                      'calledAt',      c.called_at
                    )
               FROM queue_entries c JOIN users cu ON cu.id = c.patient_id
              WHERE c.doctor_id = q.doctor_id AND c.clinic_date = q.clinic_date
                AND c.state = 'in-consultation'
              LIMIT 1) AS "activeConsultation"
       FROM queue_entries q
       JOIN doctors d ON d.id = q.doctor_id
       JOIN users   du ON du.id = d.user_id
      WHERE q.state IN ('waiting', 'in-consultation')
      GROUP BY q.doctor_id, du.full_name, q.clinic_date
      ORDER BY "oldestWaitingAt" ASC NULLS LAST, q.clinic_date DESC
      LIMIT $1 OFFSET $2`,
    [size, skip],
  );

  return { rooms, total, limit: size, offset: skip };
};

/** Platform-wide waiting-room counters, for the dashboard header. */
export const queueSummary = async () => {
  const r = await one(
    `SELECT
       count(DISTINCT (doctor_id, clinic_date)) FILTER (
         WHERE state IN ('waiting','in-consultation'))::int AS rooms,
       count(*) FILTER (WHERE state = 'waiting')::int         AS waiting,
       count(*) FILTER (WHERE state = 'in-consultation')::int AS in_consultation,
       min(joined_at) FILTER (WHERE state = 'waiting')        AS oldest_waiting_at
     FROM queue_entries`,
  );
  return {
    rooms: r.rooms ?? 0,
    waiting: r.waiting ?? 0,
    inConsultation: r.in_consultation ?? 0,
    oldestWaitingAt: r.oldest_waiting_at ?? null,
  };
};

/* ------------------------------------------------------------------ *
 *  Availability                                                      *
 * ------------------------------------------------------------------ */

/**
 * A provider's calendar for one day, split into counts rather than rows.
 *
 * An administrator monitoring capacity does not want a thousand slot rows; they
 * want "37 slots, 22 taken, 5 blocked". Listing is a separate, paginated view.
 */
export const doctorAvailability = async (doctorId, date) => {
  // Counted with FILTER/EXISTS rather than by joining appointments: one slot
  // with two active appointments would otherwise be counted twice and `total`
  // would stop meaning "slots". The date comparison goes through `dateOf` -
  // comparing DATE_EXPR's TEXT directly to $2::date is a 500.
  const r = await one(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE s.status = 'available')::int AS available,
       count(*) FILTER (WHERE s.status = 'booked')::int    AS booked,
       count(*) FILTER (WHERE s.status = 'blocked')::int   AS blocked,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM appointments a
          WHERE a.slot_id = s.id
            AND a.status IN ('scheduled','confirmed','in-progress')
       ))::int AS "hasActiveAppointment",
       COALESCE(sum(s.fee) FILTER (WHERE s.status = 'available'), 0)::int
         AS "availableFees"
     FROM slots s
    WHERE s.doctor_id = $1
      AND ${dateOf("s", "starts_at")} = $2::date`,
    [doctorId, date],
  );
  return {
    doctorId,
    date,
    total: r.total ?? 0,
    available: r.available ?? 0,
    booked: r.booked ?? 0,
    blocked: r.blocked ?? 0,
    withActiveAppointment: r.hasActiveAppointment ?? 0,
    availableFees: r.availableFees ?? 0,
  };
};

/* ------------------------------------------------------------------ *
 *  Patients                                                          *
 * ------------------------------------------------------------------ */

/**
 * The patient directory, filtered and paginated.
 *
 * `analyticsRepo.patients()` returns the whole table for the dashboard. An
 * administrator paging a directory needs the filtered set AND its true total, so
 * this does the counting in SQL. The same columns are selected - the PHI view is
 * not widened here, and the controller still runs `stripSecrets`.
 */
export const searchPatients = async ({
  search = "",
  sort = "name",
  limit,
  offset,
} = {}) => {
  const params = [];
  const where = ["u.role = 'patient'"];

  const term = String(search || "").trim();
  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    const p = params.length;
    where.push(
      `(lower(u.full_name) LIKE $${p} OR lower(u.email) LIKE $${p} OR u.phone LIKE $${p})`,
    );
  }

  const ORDERS = {
    name: "u.full_name ASC",
    "name_desc": "u.full_name DESC",
    email: "u.email ASC",
    newest: "u.created_at DESC",
  };
  const orderSql = ORDERS[String(sort)] ?? ORDERS.name;
  const size = pageSize(limit);
  const skip = offsetOf(offset);
  const whereSql = where.join(" AND ");

  const total = (
    await one(`SELECT count(*)::int AS n FROM users u WHERE ${whereSql}`, params)
  ).n;

  const patients = await rows(
    `SELECT u.id, u.full_name AS name, u.email, u.phone, u.created_at AS "createdAt",
            p.blood_group AS "bloodGroup",
            (SELECT count(*)::int FROM appointments a
              WHERE a.patient_id = u.id
                AND a.status IN ('scheduled','confirmed','in-progress'))::int
              AS upcoming,
            (SELECT count(*)::int FROM appointments a
              WHERE a.patient_id = u.id AND a.status = 'completed')::int AS completed,
            (SELECT max(${dateOf("a", "starts_at")}) FROM appointments a
              WHERE a.patient_id = u.id AND a.status = 'completed') AS "lastVisit"
       FROM users u
       LEFT JOIN patient_profiles p ON p.user_id = u.id
      WHERE ${whereSql}
      ORDER BY ${orderSql}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, skip],
  );

  return { patients, total, limit: size, offset: skip };
};

/* ------------------------------------------------------------------ *
 *  Notification operations                                           *
 * ------------------------------------------------------------------ */

/**
 * Notification counters over a window, for the operations view.
 *
 * Failures are counted explicitly rather than inferred from a total, because
 * "delivered" and "nothing about delivery" are the same number in every other
 * arrangement and only the split tells you the outbox is stuck.
 */
export const notificationOps = async () => {
  const r = await one(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE read_at IS NULL)::int AS unread,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS "last24h"
     FROM notifications`,
  );
  const deliveries = (
    await one(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::int   AS queued,
         count(*) FILTER (WHERE status = 'failed')::int   AS failed,
         count(*) FILTER (WHERE status = 'sent')::int     AS sent,
         count(*) FILTER (WHERE status = 'simulated')::int AS simulated
       FROM notification_deliveries`,
    )
  );
  return {
    total: r.total ?? 0,
    unread: r.unread ?? 0,
    last24h: r.last24h ?? 0,
    deliveries: {
      queued: deliveries.queued ?? 0,
      failed: deliveries.failed ?? 0,
      sent: deliveries.sent ?? 0,
      simulated: deliveries.simulated ?? 0,
    },
  };
};

export default {
  listAppointments,
  activeRooms,
  queueSummary,
  doctorAvailability,
  searchPatients,
  notificationOps,
};