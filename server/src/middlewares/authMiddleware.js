import appointmentRepo from "../repositories/appointmentRepo.js";
import doctorRepo from "../repositories/doctorRepo.js";
import userRepo from "../repositories/userRepo.js";
import { AppError } from "../utils/responses.js";
import { selfDoctor } from "../utils/projections.js";
import { verifyToken } from "../utils/jwt.js";

// Re-exported so existing importers keep working; the implementation now lives
// in utils/jwt.js so the session service can sign tokens without pulling in this
// middleware's request-handling dependencies.
export { signToken } from "../utils/jwt.js";

/**
 * Validates the bearer access token and attaches `req.user`.
 *
 * The access token is stateless, so this is a signature check plus one lookup to
 * reload the user. Reloading matters: it means a deactivated account, or a role
 * change, takes effect on the next request rather than when the token expires.
 */
export const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token)
    return next(new AppError("Authentication required", 401, "NO_TOKEN"));

  const result = verifyToken(token);

  // Expired and invalid are reported separately. An expired token is a routine
  // event the client resolves by exchanging its refresh token; an invalid one
  // means the credential itself is wrong, and refreshing would only mint
  // another bad access token.
  if (!result.ok) {
    return result.reason === "expired"
      ? next(
          new AppError("Session expired, please sign in again", 401, "TOKEN_EXPIRED"),
        )
      : next(new AppError("Invalid session", 401, "INVALID_TOKEN"));
  }

  try {
    const user = await userRepo.findById(result.payload.sub);
    if (!user)
      return next(
        new AppError("Account no longer exists", 401, "USER_NOT_FOUND"),
      );

    // A deactivated account must not keep working on an unexpired token.
    if (user.isActive === false)
      return next(
        new AppError("This account has been deactivated", 401, "ACCOUNT_DISABLED"),
      );

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      profile: user.profile,
    };

    // Doctors carry their provider record for convenience. Projected, never
    // raw.
    if (user.role === "doctor") {
      req.user.doctor = selfDoctor(await doctorRepo.findByUserId(user.id));
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

/**
 * Populate `req.user` when a usable access token is present, but never reject.
 *
 * For endpoints that work both signed-in and anonymously. Sign-out is the case
 * that matters: a user whose access token has just expired still needs to be
 * able to end their session, so requiring authentication here would lock them
 * into a session they cannot revoke.
 *
 * A missing or invalid token simply leaves `req.user` unset.
 */
export const attachUserIfPresent = async (req, res, next) => {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return next();

  const result = verifyToken(header.slice(7));
  if (!result.ok) return next();

  try {
    const user = await userRepo.findById(result.payload.sub);
    if (user && user.isActive !== false) {
      req.user = { id: user.id, email: user.email, role: user.role };
    }
    return next();
  } catch (err) {
    return next(err);
  }
};

/** Role gate. Usage: router.post('/x', requireAuth, requireRole('admin'), handler) */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user)
      return next(new AppError("Authentication required", 401, "NO_TOKEN"));
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          `This action requires: ${roles.join(" or ")}`,
          403,
          "FORBIDDEN",
        ),
      );
    }
    return next();
  };

/**
 * Resolve the appointment named by `:id` and determine the caller's access.
 *
 * Ownership checks were previously duplicated in each controller, which is
 * how `check-in` shipped with none at all. This is the single place that
 * answers "may this caller act on this appointment?".
 *
 * @param {object} user     the authenticated user
 * @param {string} appointmentId
 * @returns {Promise<{appointment: object, isOwner: boolean,
 *                    isProvider: boolean, isAdmin: boolean}>}
 */
export const resolveAppointmentAccess = async (user, appointmentId) => {
  const appointment = await appointmentRepo.findById(appointmentId);
  if (!appointment)
    throw new AppError(
      "Appointment not found",
      404,
      "APPOINTMENT_NOT_FOUND",
    );

  const isOwner = appointment.patientId === user.id;

  const me = user.role === "doctor" ? await doctorRepo.findByUserId(user.id) : null;
  const isProvider = Boolean(me && me.id === appointment.doctorId);

  return { appointment, isOwner, isProvider, isAdmin: user.role === "admin" };
};

/**
 * Owner / assigned doctor / admin gate for a route with an `:id` param.
 *
 * @param {string} message error message used on failure
 * @returns {import('express').RequestHandler}
 */
export const requireAppointmentAccess =
  (message = "You cannot access this appointment") =>
  async (req, res, next) => {
    if (!req.user)
      return next(new AppError("Authentication required", 401, "NO_TOKEN"));

    try {
      const { isOwner, isProvider, isAdmin } = await resolveAppointmentAccess(
        req.user,
        req.params.id,
      );
      if (!isOwner && !isProvider && !isAdmin)
        return next(new AppError(message, 403, "FORBIDDEN"));
      return next();
    } catch (err) {
      return next(err);
    }
  };