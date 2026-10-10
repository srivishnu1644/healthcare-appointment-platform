/**
 * Access-token signing and verification.
 *
 * Kept separate from the auth middleware so the session service can mint tokens
 * without importing the whole request-handling chain, and so token policy has a
 * single home.
 *
 * Policy
 * ------
 * The access token is a *short-lived, stateless* bearer token. It is not
 * revocable — that is the refresh token's job, and the whole point of the pair.
 * A logout therefore cannot invalidate an access token that has already been
 * issued; it can only stop new ones being minted. See REFRESH notes in
 * services/sessionService.js.
 *
 * Claims are limited to `{ sub, role }`:
 *   * `sub` identifies the user, and the user is reloaded from the database on
 *     every request, so nothing else needs to be in the token;
 *   * `role` lets `requireRole` reject before any query runs;
 *   * no email, name, or profile data — a token is readable by anyone holding
 *     it, so it is not a place to put PII.
 *
 * A `ver` claim holding users.token_version would let a password change kill
 * outstanding access tokens immediately. It is deliberately omitted: the token
 * stays minimal, and the window in which a stolen access token survives a
 * password change is bounded by its 15-minute lifetime. Refresh tokens, which
 * are long-lived, do carry that binding — so the practical effect of a
 * password change is immediate for anything beyond the access-token window.
 */
import jwt from "jsonwebtoken";

// Resolved in config/env.js, which app.js imports first. Outside `test` a
// missing JWT_SECRET is fatal there, so this cannot silently be undefined.
const SECRET = process.env.JWT_SECRET;
const ISSUER = process.env.JWT_ISSUER || "medicare-api";

if (!SECRET) {
  throw new Error(
    "JWT_SECRET is not configured. Import config/env.js before the token helpers.",
  );
}

/**
 * Access-token lifetime. Short by design: the shorter this is, the less a
 * stolen token is worth and the more often the client must refresh.
 * Set via JWT_EXPIRES_IN (e.g. "15m", "900s", "1h").
 */
export const ACCESS_TTL = process.env.JWT_EXPIRES_IN || "15m";

/** Access-token lifetime in seconds, for the client to schedule a refresh. */
export const accessTtlSeconds = () => {
  const raw = String(ACCESS_TTL).trim();
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(raw);
  if (!match) return 900;
  const n = Number(match[1]);
  const unit = (match[2] || "s").toLowerCase();
  const factor = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return Math.max(1, Math.round(n * factor));
};

/**
 * Sign an access token for a user.
 *
 * @param {{id: string, role: string}} user
 * @returns {string} signed JWT
 */
export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, SECRET, {
    expiresIn: ACCESS_TTL,
    issuer: ISSUER,
  });

/**
 * Verify an access token.
 *
 * @param {string} token
 * @returns {{ok: true, payload: object} | {ok: false, reason: "expired"|"invalid"}}
 */
export const verifyToken = (token) => {
  try {
    const payload = jwt.verify(token, SECRET, { issuer: ISSUER });
    if (!payload?.sub) return { ok: false, reason: "invalid" };
    return { ok: true, payload };
  } catch (err) {
    // Distinguishing these matters: an expired token is a normal event that the
    // client fixes by refreshing, whereas an invalid one means the credential
    // itself is wrong and refreshing would only produce another bad token.
    return {
      ok: false,
      reason: err?.name === "TokenExpiredError" ? "expired" : "invalid",
    };
  }
};

export default { signToken, verifyToken, ACCESS_TTL, accessTtlSeconds };