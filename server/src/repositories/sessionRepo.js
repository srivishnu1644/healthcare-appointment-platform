/**
 * Refresh-token persistence.
 *
 * Every statement here operates on digests, never on token values: the raw
 * token exists only in the request that presented it and in the response that
 * issued it.
 *
 * Rows are never deleted on revoke. Revocation is a state change, and keeping
 * revoked rows is what makes reuse detection possible — if a spent token were
 * removed, a replay would look like an unknown token rather than the replay it
 * actually is.
 */
import { query, rows, one } from "../config/database.js";

/**
 * Insert a new session token.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.tokenHash   SHA-256 digest, never the token
 * @param {Date}   input.expiresAt
 * @param {string} input.familyId
 * @param {number} input.tokenVersion  users.token_version at issue time
 * @param {string|null} [input.userAgent]
 * @param {string|null} [input.ip]
 * @returns {Promise<string>} the new row id
 */
export const create = async ({
  userId,
  tokenHash,
  expiresAt,
  familyId,
  tokenVersion = 0,
  userAgent = null,
  ip = null,
}) => {
  const r = await one(
    `INSERT INTO refresh_tokens
       (user_id, token_hash, expires_at, family_id, token_version, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::inet)
     RETURNING id`,
    [userId, tokenHash, expiresAt, familyId, tokenVersion, userAgent, ip],
  );
  return r.id;
};

/**
 * Look a token up by digest.
 *
 * Returns revoked and expired rows too: the caller needs to distinguish
 * "unknown token" from "already spent", and those demand different responses.
 *
 * @param {string} tokenHash
 * @returns {Promise<object|null>}
 */
export const findByHash = async (tokenHash) =>
  one(
    `SELECT id, user_id, family_id, expires_at, revoked_at, revoked_reason,
            replaced_by, used_at, token_version, created_at
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  );

/**
 * Revoke one token.
 *
 * @param {string} id
 * @param {string} reason one of the values allowed by the schema CHECK
 * @returns {Promise<boolean>} true if the row was live and is now revoked
 */
export const revoke = async (id, reason) => {
  const r = await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, reason],
  );
  return r.rowCount === 1;
};

/**
 * Revoke every live token in a family.
 *
 * This is the reuse-detection response: one replayed token condemns the whole
 * rotation chain, because we cannot tell a stolen token from a stale client and
 * must assume the worse.
 *
 * @param {string} familyId
 * @param {string} reason
 * @returns {Promise<number>} how many sessions were revoked
 */
export const revokeFamily = async (familyId, reason) => {
  const r = await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
  return r.rowCount;
};

/**
 * Revoke every live session for a user, across all families.
 *
 * Used when the account's security context changes — a password change must
 * end every session, not just the one that triggered it.
 *
 * @param {string} userId
 * @param {string} reason
 * @returns {Promise<number>}
 */
export const revokeAllForUser = async (userId, reason = "revoked") => {
  const r = await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return r.rowCount;
};

/**
 * Live session count for a user.
 *
 * Reported by the profile endpoint so a user can see how many devices hold a
 * valid refresh token for their account.
 */
export const countActive = async (userId) =>
  one(
    `SELECT count(*)::int AS c FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );

export default {
  create,
  findByHash,
  revoke,
  revokeFamily,
  revokeAllForUser,
  countActive,
};