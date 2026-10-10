/**
 * Session lifecycle: issuing, rotating and ending sessions.
 *
 * The model
 * ---------
 *   * An **access token** is a short-lived stateless JWT. Cheap to verify, not
 *     revocable, 15 minutes by default.
 *   * A **refresh token** is an opaque 256-bit random string. Only its SHA-256
 *     digest is stored, so the database never holds a usable session.
 *
 * Every login starts a **family**. Every refresh rotates the token inside its
 * family and revokes the one presented:
 *
 *      login ──> T1 ──refresh──> T2 ──refresh──> T3
 *                revoked          revoked        live
 *
 * If a token that is already revoked is presented again, the chain has been
 * replayed: a stolen token or a broken client. We cannot distinguish the two, so
 * the whole family is revoked. Failing toward "signed out" is the only safe
 * direction; the alternative is trusting a token we already know was spent.
 *
 * Transaction boundaries
 * ----------------------
 * Rotation must be atomic — a crash between minting the successor and revoking
 * the predecessor would leave a live old token beside a new one the client never
 * received, which is indistinguishable from theft. So rotation runs inside one
 * transaction.
 *
 * Revocation on reuse detection must NOT be. It is triggered by an error path,
 * and an error rolls the transaction back — which would silently undo the very
 * revocation we are trying to keep. Those revocations are therefore committed
 * outside the transaction. This is the single most important detail in this
 * file.
 */
import { isIP } from "node:net";

import sessionRepo from "../repositories/sessionRepo.js";
import userRepo from "../repositories/userRepo.js";
import { withTransaction } from "../config/database.js";
import { signToken, accessTtlSeconds } from "../utils/jwt.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
} from "../utils/token.js";
import { AppError } from "../utils/responses.js";
import logger from "../utils/logger.js";

const log = logger.tag("session");

/** How long a refresh token stays usable, in days. */
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;

const refreshExpiry = (from = new Date()) =>
  new Date(from.getTime() + REFRESH_TTL_DAYS * 86400_000);

/** Trim and bound a User-Agent so a hostile header cannot bloat the table. */
const cleanUserAgent = (req) => {
  const ua = req?.headers?.["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 512) : null;
};

/**
 * A client's IP, or null if it is not a valid address.
 *
 * `req.ip` depends on the trust-proxy setting, so rather than trusting whatever
 * shape it arrives in, anything `isIP` rejects is dropped instead of becoming a
 * failed insert on an `inet` column.
 */
const cleanIp = (req) => {
  const ip = req?.ip;
  return typeof ip === "string" && isIP(ip) ? ip : null;
};

/**
 * Error carrying the family that must be revoked once the transaction has
 * rolled back.
 *
 * @param {string} familyId
 * @param {string} code
 */
const reuseSignal = (familyId, code = "REFRESH_TOKEN_REUSED") => {
  const err = new AppError(
    "This session has been signed out. Please sign in again.",
    401,
    code,
  );
  // Non-enumerable so it never reaches a client response.
  Object.defineProperty(err, "familyId", { value: familyId, enumerable: false });
  return err;
};

/**
 * Issue a brand-new session: a token pair plus a database record for the
 * refresh token.
 *
 * @param {object} user  the user row (needs id, role, tokenVersion)
 * @param {object} [req]  request, for session metadata
 */
export const issueSession = async (user, req = {}) => {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);
  const familyId = generateRefreshToken();

  const id = await sessionRepo.create({
    userId: user.id,
    tokenHash,
    expiresAt: refreshExpiry(),
    familyId,
    // Snapshot so a later password change can invalidate this session.
    tokenVersion: user.tokenVersion ?? 0,
    userAgent: cleanUserAgent(req),
    ip: cleanIp(req),
  });

  return {
    id,
    familyId,
    accessToken: signToken(user),
    refreshToken,
    expiresIn: accessTtlSeconds(),
  };
};

/**
 * Exchange a refresh token for a new pair, rotating the stored token.
 *
 * @param {string} presented  raw token from the client
 * @param {object} [req]
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresIn: number,
 *                    user: object, familyId: string}>}
 */
export const rotateSession = async (presented, req = {}) => {
  // A value that cannot be one of ours is rejected without a database round
  // trip. This is an early exit for efficiency, not a security check.
  if (!looksLikeRefreshToken(presented)) {
    throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
  }

  const presentedHash = hashRefreshToken(presented);

  /* ================================================================
   *  Phase 1 — classify, outside any transaction
   *
   *  Revocations here are committed immediately, so they survive the
   *  rollback that any error below will cause.
   * ================================================================ */

  const stored = await sessionRepo.findByHash(presentedHash);

  // Unknown: never issued, or already purged. There is no family to revoke, so
  // this is just an invalid credential.
  if (!stored) {
    throw new AppError("Invalid refresh token", 401, "INVALID_REFRESH_TOKEN");
  }

  // Replay of a token already spent. This is the reuse-detection path: it fires
  // for a token revoked by rotation, by logout, or by an earlier reuse
  // response.
  if (stored.revoked_at) {
    const killed = await sessionRepo.revokeFamily(
      stored.family_id,
      "reuse_detected",
    );
    log.warn(
      `refresh token reuse detected for user ${stored.user_id}; ` +
        `revoked ${killed} live session(s) in family ${stored.family_id}`,
    );
    throw reuseSignal(stored.family_id);
  }

  if (new Date(stored.expires_at).getTime() <= Date.now()) {
    await sessionRepo.revoke(stored.id, "expired");
    throw new AppError(
      "Your session has expired. Please sign in again.",
      401,
      "REFRESH_TOKEN_EXPIRED",
    );
  }

  /* ================================================================
   *  Phase 2 — rotate atomically
   * ================================================================ */

  try {
    return await withTransaction(async (tx) => {
      // Re-read under a row lock. The row may have been revoked between the
      // lookup above and here, and FOR UPDATE makes concurrent refreshes of the
      // same token serialise rather than race.
      const current = await tx.one(
        `SELECT id, user_id, family_id, expires_at, revoked_at, token_version
           FROM refresh_tokens
          WHERE id = $1
          FOR UPDATE`,
        [stored.id],
      );

      // Someone else consumed it while we waited for the lock. Carries the
      // family so it is revoked below, after this transaction rolls back.
      if (!current || current.revoked_at) {
        throw reuseSignal(stored.family_id);
      }

      // On the transaction client, not the pool: a second pooled connection
      // would deadlock a saturated pool and would read outside this
      // transaction's snapshot.
      const user = await userRepo.findById(current.user_id, tx);
      if (!user || user.isActive === false) {
        throw reuseSignal(stored.family_id, "ACCOUNT_UNAVAILABLE");
      }

      // users.token_version is bumped on every password write, so this catches
      // a session issued before a password change without a timestamp compare.
      if ((user.tokenVersion ?? 0) !== current.token_version) {
        log.info(
          `session ${current.id} rejected: token_version changed for user ${user.id}`,
        );
        throw reuseSignal(stored.family_id, "SESSION_INVALIDATED");
      }

      const nextRefresh = generateRefreshToken();
      const created = await tx.one(
        `INSERT INTO refresh_tokens
           (user_id, token_hash, expires_at, family_id, token_version, user_agent, ip)
         VALUES ($1, $2, $3, $4, $5, $6, $7::inet)
         RETURNING id`,
        [
          user.id,
          hashRefreshToken(nextRefresh),
          refreshExpiry(),
          current.family_id,
          current.token_version,
          cleanUserAgent(req),
          cleanIp(req),
        ],
      );

      // Guarded on the token still being live, so the rotation cannot succeed
      // twice even if the row lock were somehow bypassed.
      const rotated = await tx.query(
        `UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = 'rotated',
                replaced_by = $2, used_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [current.id, created.id],
      );

      if (rotated.rowCount !== 1) {
        throw reuseSignal(current.family_id);
      }

      return {
        accessToken: signToken(user),
        refreshToken: nextRefresh,
        expiresIn: accessTtlSeconds(),
        user,
        familyId: current.family_id,
      };
    });
  } catch (err) {
    // The transaction has rolled back, so any revocation issued inside it is
    // gone. Apply the reuse revocation now, where it will commit.
    if (err?.familyId) {
      const killed = await sessionRepo.revokeFamily(
        err.familyId,
        "reuse_detected",
      );
      if (killed > 0) {
        log.warn(
          `revoked ${killed} session(s) in family ${err.familyId} ` +
            `after ${err.code}`,
        );
      }
    }
    throw err;
  }
};

/**
 * Revoke the presented session and its whole family.
 *
 * The family is revoked rather than the single token because every token in the
 * chain is one logical session on one device. Revoking only the presented token
 * would leave its rotated successors live, which is not what "log out" means.
 *
 * An unknown or already-revoked token still succeeds: there is nothing to leak
 * by confirming, and failing would stop a client from clearing local state —
 * which is exactly when it most needs to.
 *
 * @param {string} presented
 * @returns {Promise<{revoked: number, userId: string|null}>}
 */
export const endSession = async (presented) => {
  if (!looksLikeRefreshToken(presented)) return { revoked: 0, userId: null };

  const stored = await sessionRepo.findByHash(hashRefreshToken(presented));
  if (!stored) return { revoked: 0, userId: null };

  const revoked = await sessionRepo.revokeFamily(stored.family_id, "logout");

  if (stored.revoked_at && revoked === 0) {
    log.info(`logout presented an already-revoked token for ${stored.user_id}`);
  }

  return { revoked, userId: stored.user_id };
};

/**
 * Revoke every session for a user, on every device.
 *
 * Call this whenever a credential changes. Note that the login path's legacy
 * password upgrade deliberately does NOT: it bumps token_version and then
 * immediately issues the new session, so revoking would undo its own work.
 *
 * @param {string} userId
 * @returns {Promise<number>} how many sessions were ended
 */
export const endAllSessions = async (userId) =>
  sessionRepo.revokeAllForUser(userId, "revoked");

/** Refresh-token lifetime in seconds, reported to the client. */
export const refreshTtlSeconds = () => REFRESH_TTL_DAYS * 86400;

export default {
  issueSession,
  rotateSession,
  endSession,
  endAllSessions,
  refreshTtlSeconds,
};