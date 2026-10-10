import { AppError, sendError } from "../utils/responses.js";
import logger from "../utils/logger.js";

const log = logger.tag("error");

export const notFound = (req, res) =>
  sendError(
    res,
    `Route not found: ${req.method} ${req.originalUrl}`,
    404,
    "NOT_FOUND",
  );

/**
 * Translate a PostgreSQL constraint violation into a domain error.
 *
 * Since Phase 2 the database is the final arbiter of booking correctness, so
 * its constraint violations are meaningful outcomes rather than internal
 * faults. Two of them make double booking impossible; without this mapping a
 * correct rejection would surface as an opaque 500.
 *
 * @param {object} err
 * @returns {AppError|null} a domain error, or null if this is not a
 *   constraint violation we recognise
 */
const mapDatabaseError = (err) => {
  switch (err.code) {
    // appointments_one_active_per_slot, slots_doctor_start_key,
    // users_email_key, queue_one_entry_per_appointment, ...
    case "23505":
      return new AppError(
        "That record already exists, or that time was just taken",
        409,
        "CONFLICT",
        { constraint: err.constraint },
      );

    // slots_no_doctor_overlap, appointments_patient_no_overlap
    case "23P01":
      return new AppError(
        "That time is no longer available",
        409,
        "SLOT_TAKEN",
        { constraint: err.constraint },
      );

    // A referenced row does not exist.
    case "23503":
      return new AppError(
        "A referenced record no longer exists",
        409,
        "STALE_REFERENCE",
        { constraint: err.constraint },
      );

    // A CHECK constraint failed: bad enum value, impossible date, and so on.
    case "23514":
      return new AppError(
        "That value is not allowed",
        400,
        "CONSTRAINT_VIOLATION",
        { constraint: err.constraint },
      );

    case "23502":
      return new AppError("A required field was missing", 400, "MISSING_FIELD", {
        column: err.column,
      });

    default:
      return null;
  }
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return sendError(res, err.message, err.status, err.code, err.details);
  }

  const mapped = mapDatabaseError(err);
  if (mapped) {
    if (mapped.status >= 500) {
      log.error(`${err.code}: ${err.message}`);
    } else {
      // Expected outcome, logged at warn rather than error.
      log.warn(`${mapped.code} (${err.code} ${err.constraint ?? ""})`);
    }
    return sendError(res, mapped.message, mapped.status, mapped.code, mapped.details);
  }

  // Connection-level failures are worth distinguishing: they are usually
  // transient, and the health check reports them too.
  if (["ECONNREFUSED", "ETIMEDOUT", "08006", "08003", "57P01"].includes(err.code)) {
    log.error(`database unavailable: ${err.code}`);
    return sendError(
      res,
      "The service is temporarily unavailable",
      503,
      "DB_UNAVAILABLE",
    );
  }

  log.error(err?.stack || err?.message || err);
  return sendError(
    res,
    "Something went wrong on our side",
    500,
    "INTERNAL_ERROR",
  );
};