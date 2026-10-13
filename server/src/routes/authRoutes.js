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
/**
 * Phase 13. Bounded, because this endpoint had no validation at all.
 *
 * The controller used to `.slice(0, 120)` and `.slice(0, 40)` a longer name and
 * phone and answer 200, so a 500-character name was quietly stored as its first
 * 120 characters and the caller was told it had been saved. Silently accepting
 * data and discarding most of it is worse than refusing it: the user leaves
 * believing a name is stored when it is not.
 *
 * Field names match what the controller reads - `name`, `phone`, `profile`.
 * An unknown top-level key is ignored rather than rejected, so adding a field
 * to the client does not require a coordinated server release.
 */
router.patch(
  "/me",
  requireAuth,
  // The rule keys are the BODY's field names directly. There is no `{ body: ... }`
  // wrapper - the middleware reads `req[source]`, and a wrapper would make it
  // look for a field literally called "body" inside the body.
  validate({
    name: { type: "string", min: 1, maxLength: 120 },
    phone: { type: "string", maxLength: 40 },
    // Structurally bounded only. Every individual profile field is already
    // validated by `sanitizeProfileValue` in the controller - allergies to an
    // array of at most 50 strings, gender and bloodGroup against their allowed
    // sets, dateOfBirth as a real date, the rest to 240 characters - and that
    // allow-list is what stops a caller promoting themselves by posting a `role`
    // key.
    //
    // Repeating those rules here would duplicate working logic AND change the
    // contract: the controller SANITISES a bad field away, whereas a route rule
    // REJECTS the whole request. That broke the S-08 security check, which posts
    // `role: "admin"` alongside `allergies: "not-an-array"` and asserts nothing
    // was persisted. The point stands either way, but rejecting is not this
    // endpoint's established behaviour, so the sanitiser stays in charge.
    //
    // `maxKeys` is the one bound nothing else provides: an object has no
    // `.length`, so an unbounded blob of keys reaches the sanitiser untouched.
    profile: { type: "object", maxKeys: 24 },
  }),
  ctrl.updateProfile,
);

export default router;