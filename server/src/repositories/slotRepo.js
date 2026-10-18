/**
 * Slots and availability.
 *
 * Time handling
 * -------------
 *   * stored      -> `timestamptz` (`starts_at`, `ends_at`), absolute instants
 *   * API shape   -> `date` ("YYYY-MM-DD") and `startTime`/`endTime` ("HH:MM"),
 *                    derived with `AT TIME ZONE APP_TIMEZONE`, unchanged from
 *                    the prototype so the client keeps rendering the same strings
 *   * comparisons -> always against `starts_at`/`ends_at` as instants
 *
 * Range filtering deserves a note. The earlier version compared
 * `to_char(starts_at, 'HH24:MI')` strings for the `from`/`to` filters. Those
 * strings do carry the zone, so the comparison was internally consistent - but
 * it was a string comparison of a time-of-day, which cannot express a range
 * that crosses midnight, and it silently ignores the zone. Callers now pass
 * real instants (computed by services/slotService from the configured zone),
 * so a range filter means what it says.
 *
 * Overlap between a doctor's slots is prevented by the database
 * (`slots_no_doctor_overlap`), not by application code. Nothing here tries.
 */
import { query, rows, one } from "../config/database.js";
import { findOne, inClause, DATE_EXPR, TIME_EXPR, tzLiteral } from "./base.js";

const SLOT_SELECT = `
  sl.id, sl.doctor_id, sl.facility_id, sl.service_id, sl.mode, sl.status,
  sl.fee, sl.max_queue, sl.created_at, sl.updated_at,
  sl.starts_at, sl.ends_at,
  ${DATE_EXPR("sl")} AS date,
  ${TIME_EXPR("sl")} AS start_time,
  ${TIME_EXPR("sl", "ends_at")} AS end_time
`;

/**
 * Waiting-patient count for a slot.
 *
 * A correlated subquery rather than a join: joining would multiply slot rows
 * by the queue length and corrupt any count applied alongside it.
 */
const QUEUE_COUNT = `
  (SELECT count(*)::int FROM queue_entries q
    WHERE q.slot_id = sl.id AND q.state = 'waiting') AS current_queue
`;

/**
 * Whether an active appointment exists for the slot.
 *
 * Used to report `booked` accurately. The slot's own `status` column is the
 * authority for what is offered; this describes what is actually taken.
 */
const APPOINTED = `
  EXISTS (SELECT 1 FROM appointments a
           WHERE a.slot_id = sl.id
             AND a.status IN ('scheduled','confirmed','in-progress')) AS has_appointment
`;

/**
 * Whether the slot has ever been booked — any appointment status at all.
 *
 * Not the same question as `has_appointment`, and deliberately stricter. The
 * `appointments.slot_id` foreign key is ON DELETE RESTRICT, so a slot that was
 * booked once cannot be removed even after that appointment is cancelled: the
 * row is the audit record of a visit that actually happened. `isBooked`
 * therefore cannot decide this, and the UI must not offer to delete a slot on
 * the strength of it.
 */
const HAS_HISTORY = `
  EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = sl.id) AS has_history
`;

/**
 * Shape a slot row into the camelCase object the API always returned.
 *
 * `appointmentId` is intentionally absent: the JSON model kept a bidirectional
 * slot<->appointment link that nothing enforced and that demonstrably diverged
 * (a cancellation left the slot stuck as "booked"). Only `appointments.slot_id`
 * exists now.
 */
const toSlot = (r) =>
  r && {
    id: r.id,
    doctorId: r.doctor_id,
    facilityId: r.facility_id ?? null,
    date: r.date,
    startTime: r.start_time,
    endTime: r.end_time,
    mode: r.mode,
    status: r.status,
    maxQueue: r.max_queue,
    currentQueue: r.current_queue ?? 0,
    fee: r.fee === null ? null : Number(r.fee),
    createdAt: r.created_at,
    // Additive: the absolute instant behind the local strings, so a client can
    // reason about timezones instead of guessing.
    startsAt: r.starts_at,
    endsAt: r.ends_at,
  };

/**
 * Build the WHERE clause for a slot query. Shared by `list` and `countMatching`
 * so a reported total can never disagree with the rows returned.
 */
const buildFilters = ({
  doctorId,
  date,
  from,
  to,
  mode,
  status,
  facilityId,
  futureOnly,
} = {}) => {
  const params = [];
  const where = [];

  if (doctorId) {
    params.push(doctorId);
    where.push(`sl.doctor_id = $${params.length}`);
  }
  if (facilityId) {
    params.push(facilityId);
    where.push(`sl.facility_id = $${params.length}`);
  }
  if (date) {
    params.push(date);
    where.push(`${DATE_EXPR("sl")} = $${params.length}`);
  }
  // `from` / `to` are instants, not clock strings: a caller that means
  // "09:00 onward" converts it in the configured zone first.
  if (from) {
    params.push(from);
    where.push(`sl.starts_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`sl.starts_at <= $${params.length}`);
  }
  if (mode) {
    const modes = String(mode)
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (modes.length) {
      const { clause, params: p } = inClause(modes, params.length + 1);
      params.push(...p);
      where.push(`sl.mode IN (${clause})`);
    }
  }
  if (status) {
    const states = String(status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (states.length) {
      const { clause, params: p } = inClause(states, params.length + 1);
      params.push(...p);
      where.push(`sl.status IN (${clause})`);
    }
  }
  // "Bookable" means the slot has not started yet. A slot earlier today is not
  // offered: the patient cannot attend it.
  if (futureOnly) where.push("sl.starts_at > now()");

  return { params, where };
};

/**
 * List slots.
 *
 * @param {object} filters
 * @param {number} [filters.limit]
 * @param {number} [filters.offset]
 * @returns {Promise<object[]>}
 */
export const list = async ({ limit, offset, ...filters } = {}) => {
  const { params, where } = buildFilters(filters);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // No `limit` means no LIMIT clause at all, which is the default: the booking
  // client fetches a doctor's whole schedule and filters by date locally, so a
  // default page size would hide dates from it.
  const paging =
    limit === undefined || limit === null
      ? ""
      : ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`;

  const result = await rows(
    `SELECT ${SLOT_SELECT}, ${QUEUE_COUNT}, ${APPOINTED}, ${HAS_HISTORY}
       FROM slots sl
       ${clause}
       ORDER BY sl.starts_at${paging}`,
    params,
  );

  return result.map((r) => ({
    ...toSlot(r),
    // Reported rather than derived from status, so "booked" is not a claim.
    isBooked: r.has_appointment,
    isDeletable: !r.has_history,
  }));
};

/** Total slots matching a filter set, using the same clause as `list`. */
export const countMatching = async (filters = {}) => {
  const { params, where } = buildFilters(filters);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await one(
    `SELECT count(*)::int AS c FROM slots sl ${clause}`,
    params,
  );
  return r.c;
};

/**
 * One slot, with the doctor and facility names.
 *
 * Used by the detail endpoint. `facilityName` is derived by join so it cannot
 * go stale; the facility itself is authoritative on the slot.
 */
export const findById = async (id) => {
  const r = await findOne(
    `SELECT ${SLOT_SELECT}, ${QUEUE_COUNT}, ${APPOINTED}, ${HAS_HISTORY},
            u.full_name AS doctor_name,
            f.name    AS facility_name, f.city AS facility_city
       FROM slots sl
       JOIN doctors d    ON d.id = sl.doctor_id
       JOIN users u      ON u.id = d.user_id
       JOIN facilities f ON f.id = sl.facility_id
      WHERE sl.id = $1`,
    [id],
  );
  if (!r) return null;
  return {
    ...toSlot(r),
    doctorName: r.doctor_name,
    facilityName: r.facility_name,
    facilityCity: r.facility_city,
    isBooked: r.has_appointment,
    isDeletable: !r.has_history,
  };
};

/**
 * A slot's raw row, for services that need the stored instants.
 *
 * Deliberately separate from {@link findById}: callers inside a booking flow
 * want the columns, not the decorated public shape.
 */
export const findRawById = async (id, tx = null) => {
  const runner = tx ?? { one };
  return runner.one(
    `SELECT sl.id, sl.doctor_id, sl.facility_id, sl.service_id,
            sl.starts_at, sl.ends_at, sl.mode, sl.status, sl.fee, sl.max_queue,
            ${DATE_EXPR("sl")} AS date,
            ${TIME_EXPR("sl")} AS start_time
       FROM slots sl WHERE sl.id = $1`,
    [id],
  );
};

/**
 * Read a slot and hold a row lock on it for the rest of the transaction.
 *
 * This is the mechanism that serialises competing bookings of the same slot.
 * Two transactions that both want slot X queue behind each other here, so the
 * second one re-reads the slot *after* the first has committed and sees it as
 * already taken.
 *
 * It matters that the lock is taken on the slot row rather than relying on the
 * unique index alone: the index alone would reject the loser, but only after
 * both transactions had already done their reads and decided to proceed, which
 * makes correct error reporting impossible and wastes work. Locking first means
 * the loser's validation runs against committed state.
 *
 * Must be called inside a transaction: a `FOR UPDATE` outside one is released
 * immediately at the end of the implicit statement transaction, so it would lock
 * nothing.
 *
 * @param {string} id
 * @param {object} tx transaction handle from withTransaction
 */
export const lockForUpdate = async (id, tx) => {
  const r = await tx.one(
    `SELECT sl.id, sl.doctor_id, sl.facility_id, sl.service_id,
            sl.starts_at, sl.ends_at, sl.mode, sl.status, sl.fee, sl.max_queue,
            ${DATE_EXPR("sl")} AS date,
            ${TIME_EXPR("sl")} AS start_time
       FROM slots sl WHERE sl.id = $1
       FOR UPDATE`,
    [id],
  );
  if (!r) return null;
  return r;
};

/**
 * Claim a slot, but only if it is still offered.
 *
 * The `AND status = 'available'` predicate makes this a conditional write: it
 * reports zero affected rows if anyone else claimed the slot in the meantime,
 * which is a definitive answer rather than a guess based on a stale read.
 *
 * @returns {Promise<boolean>} true when this call is the one that claimed it
 */
export const claimIfAvailable = async (id, tx) => {
  const r = await tx.query(
    `UPDATE slots SET status = 'booked', updated_at = now()
      WHERE id = $1 AND status = 'available'`,
    [id],
  );
  return r.rowCount === 1;
};

/**
 * Dates on which a doctor has at least one bookable slot, from today onward.
 *
 * "Bookable" excludes slots that have already started, so a patient is never
 * shown a date whose only remaining slots are in the past. This previously
 * compared against today's date, which left today itself listed once every
 * slot on it had started.
 */
export const availableDates = async (doctorId, { mode, futureOnly = true } = {}) => {
  const { params, where } = buildFilters({ doctorId, mode, futureOnly });
  where.push("sl.status = 'available'");
  const r = await rows(
    `SELECT DISTINCT ${DATE_EXPR("sl")} AS d
       FROM slots sl
      WHERE ${where.join(" AND ")}
      ORDER BY d`,
    params,
  );
  return r.map((x) => x.d);
};

/**
 * Availability summary for one doctor, optionally scoped to a date or range.
 *
 * `available` counts slots that are offered AND have not started. Without that,
 * a summary for today would advertise slots the patient can no longer attend.
 * `elapsed` is reported separately so a caller can still see the day's shape.
 *
 * @returns {Promise<object>}
 */
export const availabilitySummary = async (doctorId, { date, from, to, mode } = {}) => {
  const { params, where } = buildFilters({ doctorId, date, from, to, mode });
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totals = await one(
    `SELECT
       count(*)::int                                     AS total,
       count(*) FILTER (WHERE status = 'available')::int  AS available,
       count(*) FILTER (WHERE status = 'booked')::int     AS booked,
       count(*) FILTER (WHERE status = 'blocked')::int    AS blocked,
       -- Offered but already started: not bookable.
       count(*) FILTER (WHERE status = 'available'
                          AND starts_at <= now())::int   AS elapsed
     FROM slots sl ${clause}`,
    params,
  );

  const total = totals.total;
  const bookable = totals.available - totals.elapsed;
  const utilization = total ? Math.round((totals.booked / total) * 100) : 0;

  // The advertised next slot must genuinely be in the future.
  const next = await one(
    `SELECT ${DATE_EXPR("sl")} AS date, ${TIME_EXPR("sl")} AS time, sl.mode
       FROM slots sl
      WHERE sl.doctor_id = $1
        AND sl.status = 'available'
        AND sl.starts_at > now()
        ${mode ? `AND sl.mode = $2::consult_mode` : ""}
      ORDER BY sl.starts_at
      LIMIT 1`,
    mode ? [doctorId, mode] : [doctorId],
  );

  return {
    doctorId,
    date: date ?? null,
    totalSlots: total,
    available: bookable,
    booked: totals.booked,
    blocked: totals.blocked,
    elapsed: totals.elapsed,
    utilizationPercent: utilization,
    nextAvailableSlot: next
      ? { date: next.date, time: next.time, mode: next.mode }
      : null,
    status:
      total === 0
        ? "unavailable"
        : bookable === 0
          ? "fully-booked"
          : bookable <= 2
            ? "filling-up"
            : "available",
  };
};

/**
 * Availability across a whole range, one row per date.
 *
 * The booking calendar needs this shape: a day at a glance, without one query
 * per day. Returns only dates that actually have slots.
 *
 * @param {object} range
 * @param {number} range.days how many days from `from` (default 14)
 */
export const availabilityByDate = async (
  doctorId,
  // `futureOnly` defaults to FALSE. It used to default to true, which dropped
  // elapsed rows from the day's totals, so for today the calendar reported a
  // smaller totalSlots than availabilitySummary() and than the slot list for the
  // same date - three views of one day disagreeing. A day's row now always counts
  // every slot that falls on it, and `available` alone carries the
  // "still bookable" meaning, exactly as in availabilitySummary().
  { from, days = 14, mode, futureOnly = false } = {},
) => {
  const params = [doctorId, from, String(days)];
  let n = 3;
  if (mode) {
    n += 1;
    params.push(mode);
  }
  // Applies to whole ROWS, i.e. to which days appear at all. The `available`
  // count inside each row is always future-only, whether or not this is set.

  // `days` counts the dates inclusively: days=14 starting on `from` ends on
  // `from` + 13, not `from` + 14.
  const endDay = `($2::timestamptz AT TIME ZONE ${tzLiteral} + (($3::int - 1) || ' days')::interval)`;

  const rs = await rows(
    `WITH per_day AS (
       SELECT
         ${DATE_EXPR("sl")} AS date,
         count(*)::int                                     AS total,
         count(*) FILTER (WHERE sl.status = 'available'
                            AND sl.starts_at > now())::int  AS available,
         count(*) FILTER (WHERE sl.status = 'booked')::int    AS booked,
         count(*) FILTER (WHERE sl.status = 'blocked')::int   AS blocked,
         min(sl.starts_at) FILTER (WHERE sl.status = 'available'
                                      AND sl.starts_at > now()) AS first_open,
         -- The mode belonging to that same earliest slot, so nextAvailableSlot
         -- is self-consistent rather than the mode of some unrelated row.
         (array_agg(sl.mode ORDER BY sl.starts_at)
           FILTER (WHERE sl.status = 'available'
                     AND sl.starts_at > now()))[1]        AS first_open_mode
       FROM slots sl
       WHERE sl.doctor_id = $1
         ${mode ? `AND sl.mode = $${n}::consult_mode` : ""}
         AND (${DATE_EXPR("sl")}) >= to_char($2::timestamptz AT TIME ZONE ${tzLiteral}, 'YYYY-MM-DD')
         AND (${DATE_EXPR("sl")}) <= to_char(${endDay}, 'YYYY-MM-DD')
         ${futureOnly ? "AND sl.starts_at > now()" : ""}
       GROUP BY 1
     )
     SELECT date, total, available, booked, blocked,
            -- Same definition as availabilitySummary: booked as a share of
            -- every slot offered that day, whether taken or not.
            CASE WHEN total > 0
                 THEN round(booked * 100.0 / total)::int
                 ELSE 0 END AS utilization_percent,
            to_char(first_open AT TIME ZONE ${tzLiteral}, 'HH24:MI') AS first_open_time,
            first_open, first_open_mode
       FROM per_day
      ORDER BY date`,
    params,
  );

  return rs.map((r) => ({
    date: r.date,
    totalSlots: r.total,
    available: r.available,
    booked: r.booked,
    blocked: r.blocked,
    utilizationPercent: r.utilization_percent,
    // Same field name and shape as availabilitySummary, so the profile page's
    // per-date cards and its "next available" banner read identically whether
    // the data came from one call or seven.
    nextAvailableSlot: r.first_open
      ? { date: r.date, time: r.first_open_time, mode: r.first_open_mode }
      : null,
    firstOpen: r.first_open,
    status:
      r.available === 0
        ? r.total
          ? "fully-booked"
          : "unavailable"
        : r.available <= 2
          ? "filling-up"
          : "available",
  }));
};

/**
 * Insert one slot.
 *
 * `startsAt` / `endsAt` are absolute instants. Overlap and duration are
 * enforced by the database (`slots_no_doctor_overlap`, `slots_time_order`), so
 * a rejected insert surfaces as SQLSTATE 23P01 / 23514 for the caller to map.
 */
export const insert = async ({
  id,
  doctorId,
  facilityId,
  serviceId = null,
  startsAt,
  endsAt,
  mode = "in-person",
  status = "available",
  fee = null,
  maxQueue = 3,
}) => {
  const r = await one(
    `INSERT INTO slots
       (id, doctor_id, facility_id, service_id, starts_at, ends_at,
        mode, status, fee, max_queue)
     VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6,
             $7::consult_mode, $8::slot_status, $9, $10)
     RETURNING id`,
    [id ?? null, doctorId, facilityId, serviceId, startsAt, endsAt, mode, status, fee, maxQueue],
  );
  return r.id;
};

/**
 * Create slots, reporting exactly which ones were taken and why.
 *
 * Runs as one batch so a partially-applied set is reported rather than silently
 * half-created. Each candidate is attempted independently: a clash with one
 * existing slot must not prevent the others from being created.
 *
 * @param {object[]} candidates  each `{startsAt, endsAt, mode, fee, maxQueue}`
 * @returns {Promise<{created: object[], skipped: object[], errors: object[]}>}
 */
export const insertMany = async (doctorId, facilityId, candidates) => {
  const created = [];
  const skipped = [];
  const errors = [];

  for (const c of candidates) {
    // Exact duplicate (doctor, start) is a no-op, not an error.
    const existing = await one(
      "SELECT 1 AS ok FROM slots WHERE doctor_id = $1 AND starts_at = $2",
      [doctorId, c.startsAt],
    );
    if (existing) {
      skipped.push({ ...c, reason: "duplicate" });
      continue;
    }

    try {
      const id = await insert({ doctorId, facilityId, ...c });
      created.push({ ...c, id });
    } catch (err) {
      if (err.code === "23P01") {
        skipped.push({ ...c, reason: "overlaps" });
      } else if (err.code === "23514") {
        errors.push({ ...c, reason: "invalid", message: err.message });
      } else {
        errors.push({ ...c, reason: err.code || "unknown", message: err.message });
      }
    }
  }

  return { created, skipped, errors };
};

/**
 * Fields a provider or admin may change on an existing slot, and the SQL type
 * each is cast to.
 *
 * `doctor_id`, `facility_id` and the time window are deliberately absent:
 * moving a slot between doctors or facilities is a scheduling change, not a
 * status toggle, and published times are immutable so a booked appointment
 * cannot be shifted out from under a patient.
 */
const SLOT_PATCHABLE = {
  status: { column: "status", cast: "::slot_status" },
  mode: { column: "mode", cast: "::consult_mode" },
  fee: { column: "fee", cast: "" },
  maxQueue: { column: "max_queue", cast: "" },
};

/**
 * Apply a patch to a slot.
 *
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object|null>} the updated slot, or null if it does not exist
 */
export const update = async (id, patch) => {
  const sets = [];
  const params = [id];

  for (const [key, { column, cast }] of Object.entries(SLOT_PATCHABLE)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${column} = $${params.length}${cast}`);
    }
  }

  // Nothing recognised: return the slot unchanged rather than reporting a miss.
  if (!sets.length) return findById(id);

  const r = await one(
    `UPDATE slots SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1
      RETURNING id`,
    params,
  );
  return r ? findById(id) : null;
};

/** Set a slot's status. */
export const setStatus = async (id, status, tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    "UPDATE slots SET status = $2::slot_status, updated_at = now() WHERE id = $1",
    [id, status],
  );
};

/**
 * Release a slot back to the pool (cancellation) or close it (completion).
 *
 * Status only. The appointment row stays the authority on what is booked;
 * this exists so a released slot becomes bookable again.
 */
export const release = async (id, status = "available", tx = null) => {
  const runner = tx ?? { query };
  await runner.query(
    "UPDATE slots SET status = $2::slot_status, updated_at = now() WHERE id = $1",
    [id, status],
  );
};

export const count = async () => one("SELECT count(*)::int AS c FROM slots");

/* ------------------------------------------------------------------ *
 *  Delete                                                              *
 * ------------------------------------------------------------------ */

/**
 * Slots that cannot be removed, and why.
 *
 * `appointments.slot_id` is ON DELETE RESTRICT, so any appointment row at all —
 * live, completed or cancelled — makes its slot undeletable. The cancelled case
 * is the one worth stating plainly: the appointment is no longer a booking, but
 * the row is the record that it happened, and deleting the slot to tidy up a
 * calendar must not take a patient's visit history with it.
 *
 * Returned rather than thrown so the caller can decide: the service refuses the
 * whole request, but it needs the offending times by name to do that usefully.
 */
export const findUndeletable = async (doctorId, ids) => {
  const r = await rows(
    `SELECT sl.id, ${DATE_EXPR("sl")} AS date, ${TIME_EXPR("sl")} AS local_time
       FROM slots sl
      WHERE sl.id = ANY($1::text[])
        AND sl.doctor_id = $2
        AND EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = sl.id)
      ORDER BY sl.starts_at`,
    [ids, doctorId],
  );
  return r;
};

/**
 * Remove slots outright.
 *
 * All-or-nothing by design: the caller has already established that none of
 * these ids is referenced (see `findUndeletable`), and the `doctor_id`
 * predicate keeps a request for one doctor's slots from ever reaching another's
 * rows even if a caller passes an id it does not own. `queue_entries` cascades,
 * so waiting entries go with the slot.
 *
 * `RESTRICT` remains the backstop: if an appointment lands between the check
 * above and this statement, PostgreSQL raises rather than orphaning the row.
 */
export const deleteByIds = async (doctorId, ids) => {
  const r = await rows(
    `DELETE FROM slots sl
      WHERE sl.id = ANY($1::text[]) AND sl.doctor_id = $2
      RETURNING sl.id, ${DATE_EXPR("sl")} AS date, ${TIME_EXPR("sl")} AS local_time`,
    [ids, doctorId],
  );
  return r;
};

export default {
  list,
  countMatching,
  findById,
  findRawById,
  lockForUpdate,
  claimIfAvailable,
  availableDates,
  availabilitySummary,
  availabilityByDate,
  insert,
  insertMany,
  update,
  setStatus,
  release,
  findUndeletable,
  deleteByIds,
  count,
};