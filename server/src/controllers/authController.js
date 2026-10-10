import userRepo from "../repositories/userRepo.js";
import doctorRepo from "../repositories/doctorRepo.js";
import sessionRepo from "../repositories/sessionRepo.js";
import {
  issueSession,
  rotateSession,
  endSession,
  endAllSessions,
  refreshTtlSeconds,
} from "../services/sessionService.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { publicUser, selfDoctor } from "../utils/projections.js";
import { hashPassword, verifyPassword, needsRehash } from "../utils/password.js";
import logger from "../utils/logger.js";

const log = logger.tag("auth");

/**
 * Allowed profile fields.
 *
 * An explicit allow-list is mandatory: merging a caller-supplied `profile`
 * wholesale previously let a client persist arbitrary keys (`role`,
 * `isAdmin`) and corrupt field types.
 */
const PROFILE_FIELDS = [
  "dateOfBirth",
  "gender",
  "bloodGroup",
  "address",
  "emergencyContact",
];

const GENDERS = ["male", "female", "other", "prefer_not_to-say"];
const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

/** Coerce and bound one profile field; unknown values are dropped, not stored. */
const sanitizeProfileValue = (field, value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  if (field === "allergies") {
    if (!Array.isArray(value)) return undefined;
    return value
      .filter((a) => typeof a === "string")
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 50);
  }

  if (field === "gender") {
    const v = String(value).trim().toLowerCase();
    return GENDERS.includes(v) ? v : undefined;
  }

  if (field === "bloodGroup") {
    const v = String(value).trim().toUpperCase();
    return BLOOD_GROUPS.includes(v) ? v : undefined;
  }

  if (field === "dateOfBirth") {
    const v = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    if (Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) return undefined;
    return v;
  }

  const v = String(value).trim();
  return v.length > 240 ? v.slice(0, 240) : v;
};

/** Build the user payload. The doctor record is attached only to that doctor. */
const userPayload = async (user) => {
  const base = publicUser(user);
  if (user.role === "doctor") {
    const doctor = await doctorRepo.findByUserId(user.id);
    base.doctor = selfDoctor(doctor);
  }
  return base;
};

/**
 * The token pair returned by login and refresh.
 *
 * `token` keeps its name and meaning from Phase 1: it is the access token, and
 * existing clients keep working unchanged. `refreshToken` is additive.
 *
 * `expiresIn` is seconds until the access token expires, so the client can
 * refresh proactively rather than waiting for a 401.
 */
const tokenPair = (session) => ({
  token: session.accessToken,
  refreshToken: session.refreshToken,
  expiresIn: session.expiresIn,
  refreshExpiresIn: refreshTtlSeconds(),
});

/* ------------------------------------------------------------------ *
 *  POST /api/auth/register                                           *
 * ------------------------------------------------------------------ */
export const register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;
  const normalisedEmail = String(email).trim().toLowerCase();

  const existing = await userRepo.findByEmail(normalisedEmail);
  if (existing) {
    throw new AppError(
      "An account with this email already exists",
      409,
      "EMAIL_TAKEN",
    );
  }

  // Role is assigned server-side. A caller-supplied `role` is ignored:
  // self-registration creates PATIENT accounts only. Doctor accounts are
  // provisioned by an admin (Phase 12), never by the public signup form.
  const passwordHash = await hashPassword(password);

  const incoming = req.body.profile || {};
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    const clean = sanitizeProfileValue(field, incoming[field]);
    if (clean !== undefined) profile[field] = clean;
  }
  const allergies = sanitizeProfileValue("allergies", incoming.allergies);
  if (allergies !== undefined) profile.allergies = allergies;

  const user = await userRepo.create({
    name: String(name).trim(),
    email: normalisedEmail,
    password: passwordHash,
    role: "patient",
    phone: phone ? String(phone).trim() : null,
    profile,
  });

  // Registration signs the user in, so it issues a session exactly as login
  // does rather than leaving the client to call login immediately afterwards.
  const session = await issueSession(user, req);

  log.info(`registered patient ${user.email}`);

  return sendSuccess(
    res,
    { ...tokenPair(session), user: await userPayload(user) },
    "Account created",
    201,
  );
});

/* ------------------------------------------------------------------ *
 *  POST /api/auth/login                                              *
 * ------------------------------------------------------------------ */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await userRepo.findByEmail(String(email).trim().toLowerCase());

  // Uniform error message: don't leak whether the email exists.
  const ok = await verifyPassword(password, user?.password);
  if (!user || !ok) {
    throw new AppError("Invalid email or password", 401, "BAD_CREDENTIALS");
  }

  // A deactivated account must not be able to obtain a session even with the
  // right password.
  if (user.isActive === false) {
    throw new AppError(
      "This account has been deactivated",
      403,
      "ACCOUNT_DISABLED",
    );
  }

  // Transparently upgrade a legacy `hashed:` value (or a low-cost bcrypt hash)
  // to the current scheme, so the plaintext-equivalent value is overwritten on
  // first successful sign-in.
  //
  // Done BEFORE issuing the session, because writing the new hash bumps
  // token_version and the session records the version it was issued under. The
  // reverse order would make every freshly upgraded account's first refresh
  // fail with SESSION_INVALIDATED.
  if (needsRehash(user.password)) {
    await userRepo.setPasswordHash(user.id, await hashPassword(password));
    log.info(`upgraded password hash for ${user.email}`);
    user.password = await hashPassword(password);
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  }

  const session = await issueSession(user, req);

  log.info(`login ${user.email} (${user.role})`);
  return sendSuccess(
    res,
    { ...tokenPair(session), user: await userPayload(user) },
    "Signed in",
  );
});

/* ------------------------------------------------------------------ *
 *  POST /api/auth/refresh                                            *
 *                                                                     *
 *  Unauthenticated by design: the caller's access token has expired,    *
 *  which is the entire reason they are here.                          *
 * ------------------------------------------------------------------ */
export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken) {
    throw new AppError("refreshToken is required", 400, "MISSING_REFRESH_TOKEN");
  }

  const session = await rotateSession(String(refreshToken), req);

  return sendSuccess(
    res,
    { ...tokenPair(session), user: await userPayload(session.user) },
    "Session refreshed",
  );
});

/* ------------------------------------------------------------------ *
 *  POST /api/auth/logout                                             *
 * ------------------------------------------------------------------ */
export const logout = asyncHandler(async (req, res) => {
  // The refresh token identifies the session to end. It is accepted from the
  // body or from an Authorization: Bearer <refresh> header, so a client that
  // prefers not to put credentials in a JSON body can use the header instead.
  const header = req.headers.authorization || "";
  const refreshToken =
    req.body?.refreshToken ??
    (header.startsWith("Bearer ") ? header.slice(7) : null);

  // `allDevices` signs the account out everywhere. Only honoured for an
  // authenticated caller: revoking sessions requires an identity to scope them
  // to, and an anonymous logout falls back to ending just the presented
  // session.
  const allDevices = req.body?.allDevices === true && Boolean(req.user);

  let revoked = 0;
  if (allDevices) {
    revoked = await endAllSessions(req.user.id);
    log.info(
      `logout: ended ${revoked} session(s) for ${req.user.id} (all devices)`,
    );
  } else {
    const result = await endSession(refreshToken);
    revoked = result.revoked;
    log.info(
      revoked > 0
        ? `logout: ended ${revoked} session(s) for ${result.userId}`
        : "logout: no live session matched",
    );
  }

  // Always 200, even for an unknown token. Reporting "that session did not
  // exist" would tell an attacker whether a token was real, and would leave the
  // client unable to clear local state — which is when it most needs to.
  return sendSuccess(res, { ok: true, revoked }, "Signed out");
});

/* ------------------------------------------------------------------ *
 *  GET /api/auth/session                                             *
 *                                                                     *
 *  Current-session validation: confirms the access token is still good  *
 *  and reports what the server knows about this session.              *
 * ------------------------------------------------------------------ */
export const session = asyncHandler(async (req, res) => {
  const user = await userRepo.findById(req.user.id);
  if (!user) throw new AppError("Account not found", 404, "USER_NOT_FOUND");

  // Which session, if any, the caller is currently using. Read from a header
  // rather than the body, because this is a GET; and from a header rather than a
  // query parameter, because query strings end up in access logs and proxies,
  // and a refresh token must not be written to a log file.
  const presented = req.headers["x-refresh-token"];
  let current = null;
  if (typeof presented === "string" && presented) {
    const { hashRefreshToken } = await import("../utils/token.js");
    const found = await sessionRepo.findByHash(hashRefreshToken(presented));
    // Scoped to the authenticated user, so a token belonging to somebody else
    // is reported as "not this session" rather than leaking its details.
    if (found && found.user_id === user.id && !found.revoked_at) {
      current = {
        createdAt: found.created_at,
        expiresAt: found.expires_at,
        expiresInSeconds: Math.max(
          0,
          Math.floor(
            (new Date(found.expires_at).getTime() - Date.now()) / 1000,
          ),
        ),
      };
    }
  }

  return sendSuccess(res, {
    user: await userPayload(user),
    session: current,
    activeSessions: (await sessionRepo.countActive(user.id)).c,
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/auth/me                                                  *
 * ------------------------------------------------------------------ */
export const me = asyncHandler(async (req, res) => {
  const user = await userRepo.findById(req.user.id);
  if (!user) throw new AppError("Account not found", 404, "USER_NOT_FOUND");
  return sendSuccess(res, { user: await userPayload(user) });
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/auth/me                                                *
 * ------------------------------------------------------------------ */
export const updateProfile = asyncHandler(async (req, res) => {
  const user = await userRepo.findById(req.user.id);
  if (!user) throw new AppError("Account not found", 404, "USER_NOT_FOUND");

  const { name, phone, profile } = req.body;

  const patch = {};
  if (name !== undefined) {
    const clean = String(name).trim();
    if (clean.length >= 2) patch.name = clean.slice(0, 120);
  }
  if (phone !== undefined) patch.phone = phone ? String(phone).trim().slice(0, 40) : null;

  const cleanProfile = {};
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    // Field-by-field from the allow-list. Any key not present here
    // (`role`, `isAdmin`, or anything invented) is ignored.
    for (const field of PROFILE_FIELDS) {
      const clean = sanitizeProfileValue(field, profile[field]);
      if (clean !== undefined) cleanProfile[field] = clean;
    }
    const allergies = sanitizeProfileValue("allergies", profile.allergies);
    if (allergies !== undefined) cleanProfile.allergies = allergies;
  }

  const updated = await userRepo.updateOwn(user.id, { ...patch, profile: cleanProfile });
  log.info(`profile updated for ${updated.email}`);
  return sendSuccess(res, { user: await userPayload(updated) }, "Profile updated");
});