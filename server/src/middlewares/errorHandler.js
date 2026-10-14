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

/**
 * Translate a body-parser failure into a client error.
 *
 * body-parser runs before any route handler, so its parse failures arrive here
 * as raw exceptions. Nothing recognised them, so a malformed JSON body was
 * reported as "Something went wrong on our side" - a 500 that blamed the server
 * for the caller's typo, and dumped the unparsed payload into the error log.
 *
 * Matched on `err.type`, which only body-parser sets. Deliberately no fallback
 * on `err.status`: an internal failure can carry any status, and guessing would
 * downgrade real faults to 4xx. Anything unrecognised falls through to the 500
 * branch below.
 *
 * The raw body is never echoed into the response or the log. It is caller input,
 * it may be a credential, and reflecting it invites injection.
 *
 * @param {object} err
 * @returns {AppError|null} a client error, or null if this is not a body
 *   parse failure
 */
const mapBodyParseError = (err) => {
  const type = typeof err?.type === "string" ? err.type : "";

  // The body is not valid JSON, or was truncated mid-document.
  if (type === "entity.parse.failed") {
    return new AppError("Request body is not valid JSON", 400, "INVALID_JSON");
  }

  // Parsed fine, simply too large for the configured limit.
  if (type === "entity.too.large") {
    return new AppError("Request body is too large", 413, "PAYLOAD_TOO_LARGE");
  }

  // A charset or content-encoding we do not accept.
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    return new AppError(
      "Unsupported content encoding",
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  return null;
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (err instanceof AppError) {
    return sendError(res, err.message, err.status, err.code, err.details);
  }

  const bodyError = mapBodyParseError(err);
  if (bodyError) {
    // The caller's mistake, and an expected one: warn rather than error, and
    // log only the type so the payload never reaches disk.
    log.warn(`rejected body: ${err.type}`);
    return sendError(res, bodyError.message, bodyError.status, bodyError.code);
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