/**
 * Consistent success envelope so the client can rely on one shape.
 */
export const sendSuccess = (res, data, message = "OK", status = 200) =>
  res.status(status).json({ success: true, message, data });

/**
 * Consistent failure envelope.
 */
export const sendError = (
  res,
  message,
  status = 400,
  code = "BAD_REQUEST",
  details = null,
) =>
  res
    .status(status)
    .json({ success: false, message, error: { code, details } });

/**
 * Throw this from anywhere and the global error handler will format it.
 */
export class AppError extends Error {
  constructor(message, status = 400, code = "BAD_REQUEST", details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Wraps async route handlers so rejected promises reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
