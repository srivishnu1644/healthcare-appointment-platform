/**
 * Translate a PostgreSQL constraint violation into a domain error.
 *
 * Why this exists
 * ---------------
 * Booking correctness is enforced by the database, not by application checks.
 * That is deliberate: a check-then-act sequence in JavaScript is a race, and two
 * concurrent requests can both pass the check. So the authoritative outcome of
 * "someone got there first" is a constraint violation raised by PostgreSQL, and
 * this module's job is to turn it into a response the client can act on.
 *
 * The global error handler (middlewares/errorHandler.js) already maps
 * SQLSTATE codes, but only coarsely: every 23505 becomes `CONFLICT` and every
 * 23P01 becomes `SLOT_TAKEN`. Booking needs to tell them apart, because they are
 * different failures for the user:
 *
 *   * the slot was taken by somebody else  -> offer another time
 *   * you already have an appointment then -> you cannot hold two
 *
 * Both are 409, but the client shows a different message and the tests assert
 * different codes, so the distinction has to survive to the response.
 *
 * Dispatch is by constraint NAME rather than SQLSTATE wherever possible, because
 * a single SQLSTATE covers many unrelated indexes. Where a rule is enforced by a
 * trigger, PostgreSQL raises with a message and no constraint name, so those
 * entries match on the message text instead.
 */
import { AppError } from "./responses.js";
import { DB_ERROR_CODES } from "../config/database.js";

/**
 * Constraint-specific outcomes.
 *
 * Ordered most specific first; the lookup is exact-match on `err.constraint`, so
 * order does not actually matter, but keeping related entries adjacent makes the
 * table readable and reviewable.
 */
const BY_CONSTRAINT = {
  // --- booking ------------------------------------------------------------
  // A second active appointment for one slot. This is the constraint that makes
  // double booking impossible no matter what the application code believes.
  appointments_one_active_per_slot: () =>
    new AppError(
      "This slot was just taken. Please pick another time.",
      409,
      "SLOT_TAKEN",
    ),

  // One patient, two overlapping appointments. Distinct from SLOT_TAKEN: the
  // slot may be free, but this patient cannot take it.
  appointments_patient_no_overlap: () =>
    new AppError(
      "You already have an appointment at this time",
      409,
      "PATIENT_CLASH",
    ),

  // --- slots --------------------------------------------------------------
  // Two of the same doctor's slots overlapping each other.
  slots_no_doctor_overlap: () =>
    new AppError(
      "That time overlaps an existing slot",
      409,
      "SLOT_OVERLAP",
    ),

  // The same doctor cannot have two slots starting at the same instant.
  slots_doctor_start_key: () =>
    new AppError(
      "That slot already exists",
      409,
      "SLOT_TAKEN",
    ),

  // --- queue --------------------------------------------------------------
  // Two entries waiting at the same position in one slot.
  queue_unique_position: () =>
    new AppError(
      "The waiting room is full for this slot",
      409,
      "QUEUE_FULL",
    ),

  // At most one patient in consultation per doctor-day. Application logic takes
  // the room's advisory lock so two callers cannot both reach the insert; this is
  // the structural backstop underneath that.
  queue_one_active_consultation: () =>
    new AppError(
      "Another patient is already in consultation",
      409,
      "QUEUE_BUSY",
    ),

  queue_one_entry_per_appointment: () =>
    new AppError(
      "This appointment is already checked in",
      409,
      "ALREADY_CHECKED_IN",
    ),

  // --- consistency --------------------------------------------------------
  // The schema requires a cancelled appointment to carry its audit fields, and
  // vice versa. Reaching this means an update path wrote one without the other,
  // which is a bug rather than a user error - so it stays a 400 but is logged
  // loudly by the caller.
  appointments_cancel_consistent: () =>
    new AppError(
      "That change would leave the appointment inconsistent",
      400,
      "INCONSISTENT_STATE",
    ),
};

/**
 * Rules enforced by a trigger, which raise a message with no constraint name.
 *
 * `appointments_slot_doctor_match` fires when the appointment's doctor_id does
 * not own the named slot. A CHECK constraint cannot contain a subquery, so this
 * had to be a trigger; see migration 008.
 */
const BY_MESSAGE = [
  {
    match: /does not own slot/i,
    build: () =>
      new AppError(
        "The chosen slot does not belong to this doctor",
        400,
        "SLOT_MISMATCH",
      ),
  },
  {
    match: /slot .* does not exist/i,
    build: () => new AppError("Selected slot no longer exists", 404, "SLOT_NOT_FOUND"),
  },
];

/** Coarse fallbacks, used only when no constraint name is available. */
const BY_SQLSTATE = {
  [DB_ERROR_CODES.UNIQUE_VIOLATION]: () =>
    new AppError("That record already exists", 409, "CONFLICT"),
  [DB_ERROR_CODES.EXCLUSION_VIOLATION]: () =>
    new AppError("That time is no longer available", 409, "SLOT_TAKEN"),
  [DB_ERROR_CODES.CHECK_VIOLATION]: () =>
    new AppError("That value is not allowed", 400, "CONSTRAINT_VIOLATION"),
  [DB_ERROR_CODES.FOREIGN_KEY_VIOLATION]: () =>
    new AppError("A referenced record no longer exists", 409, "STALE_REFERENCE"),
};

/**
 * Convert a driver error into an AppError, if it is one we recognise.
 *
 * @param {object} err a `pg` error
 * @returns {AppError|null} the domain error, or null when the error is not a
 *   constraint violation this module understands and should be rethrown
 *   untouched for the global handler to deal with.
 */
export const mapDbError = (err) => {
  if (!err || err instanceof AppError) return null;

  const byConstraint = err.constraint && BY_CONSTRAINT[err.constraint];
  if (byConstraint) return byConstraint();

  for (const { match, build } of BY_MESSAGE) {
    if (typeof err.message === "string" && match.test(err.message)) return build();
  }

  const byState = err.code && BY_SQLSTATE[err.code];
  if (byState) return byState();

  return null;
};

/**
 * Run `fn`, translating any recognised constraint violation into an AppError.
 *
 * Used around the write phase of a transaction so the caller sees a precise
 * 409/400 instead of having to interpret a SQLSTATE. Anything unrecognised is
 * rethrown untouched, so genuine faults still reach the global handler and are
 * reported as 500s rather than being disguised as conflicts.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export const withDbErrorMapping = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped) throw mapped;
    throw err;
  }
};

export default { mapDbError, withDbErrorMapping };
