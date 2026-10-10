import { Router } from "express";
import rateLimit from "express-rate-limit";
import * as ctrl from "../controllers/authController.js";
import { requireAuth, attachUserIfPresent } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

const router = Router();

/**
 * Brute-force protection on the credential endpoints.
 *
 * The limiter is ALWAYS active. It previously carried
 * `skip: () => process.env.NODE_ENV !== "production"`, which meant a
 * deployment that forgot to set NODE_ENV silently ran with no protection.
 * Rate limiting is a security control, not a production-only convenience, so
 * it is kept on in development too and tuned loose enough not to interfere
 * with local work.
 */
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts, please try again later",
  },
});

/**
 * A separate budget for the session endpoints.
 *
 * Refresh is a higher-frequency operation than login - a client refreshes
 * whenever its 15-minute access token expires - so the two must not share a
 * counter. A shared budget would let an ordinary user's refreshes exhaust the
 * allowance that exists to slow password guessing, and would let password
 * spraying lock a legitimate user out of refreshing.
 *
 * The cap is still finite because /refresh is unauthenticated and must not be
 * usable as a free oracle or a way to burn database connections.
 */
const sessionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many session requests, please try again later",
  },
});

router.post(
  "/register",
  authLimiter,
  // `role` is no longer accepted. Public registration always creates a patient;
  // doctor accounts are provisioned by an admin, so a caller cannot escalate by
  // posting { "role": "provider" }.
  validate({
    name: { required: true, type: "string", min: 2, maxLength: 80 },
    email: { required: true, type: "email" },
    password: { required: true, type: "string", min: 8, maxLength: 128 },
    phone: { type: "string", maxLength: 40 },
  }),
  ctrl.register,
);

router.post(
  "/login",
  authLimiter,
  validate({
    email: { required: true, type: "email" },
    password: { required: true, type: "string" },
  }),
  ctrl.login,
);

/**
 * Exchange a refresh token for a new pair.
 *
 * Deliberately NOT behind requireAuth: the caller's access token has expired,
 * which is the entire reason for calling this. The refresh token is the
 * credential here, and it is checked against the stored digest rather than
 * trusted.
 *
 * The shape constraint is only a floor/ceiling on length. Constraining a
 * base64url token any further would produce a different error message for the
 * same invalid token without rejecting anything extra.
 */
router.post(
  "/refresh",
  sessionLimiter,
  validate({
    refreshToken: {
      required: true,
      type: "string",
      minLength: 32,
      maxLength: 200,
    },
  }),
  ctrl.refresh,
);

/**
 * End a session.
 *
 * Unauthenticated on purpose, for the same reason as /refresh: a client whose
 * access token has already expired still needs to be able to sign out and clear
 * its local state. An unknown token is not an error.
 */
router.post(
  "/logout",
  sessionLimiter,
  // Optional: a valid access token lets `allDevices: true` end every session for
  // the account. A missing or expired token is not an error here — the caller
  // still needs to be able to sign out and clear local state.
  attachUserIfPresent,
  validate({
    refreshToken: { type: "string", maxLength: 200 },
    allDevices: { type: "boolean" },
  }),
  ctrl.logout,
);

/** Validate the current access token and report what the server knows about it. */
router.get("/session", requireAuth, ctrl.session);

router.get("/me", requireAuth, ctrl.me);
router.patch("/me", requireAuth, ctrl.updateProfile);

export default router;