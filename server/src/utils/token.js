/**
 * Opaque refresh-token generation and hashing.
 *
 * A refresh token is deliberately NOT a JWT. It has to be revocable, and a
 * signed-but-stateless token can only be revoked by consulting the database
 * anyway — so signing it would add a key without adding a capability, while
 * making the value longer and harder to compare safely.
 *
 * Instead: 32 bytes from the CSPRNG, base64url-encoded. Only a SHA-256 digest
 * is stored, so a database dump yields no usable session.
 *
 * SHA-256 (not bcrypt) is the correct choice here, unlike for passwords:
 *   * the input is 256 bits of CSPRNG output, so there is no dictionary to
 *     brute-force and no need for a deliberately slow KDF;
 *   * refresh tokens are looked up on every single authenticated request, and
 *     bcrypt's cost would turn that into a visible latency tax;
 *   * a fast hash is acceptable precisely because the pre-image is
 *     unguessable.
 */
import { createHash, randomBytes } from "node:crypto";

/** 32 bytes = 256 bits of entropy, which is the refresh-token lifetime limit. */
const TOKEN_BYTES = 32;

/**
 * Mint a new opaque refresh token.
 * @returns {string} base64url token, safe to place in JSON and in a cookie
 */
export const generateRefreshToken = () =>
  randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * Digest a refresh token for storage and lookup.
 *
 * Deterministic, because lookup is by digest.
 *
 * @param {string} token
 * @returns {string} 64-character lowercase hex
 */
export const hashRefreshToken = (token) =>
  createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");

/**
 * Shape check only. This tells the caller a value cannot possibly be one of
 * ours, so an obviously wrong token is rejected before a database round trip.
 * It is NOT a validation of authenticity.
 *
 * Authenticity comes from the lookup: the digest is computed and matched
 * against a unique index by PostgreSQL, so there is no comparison in this
 * process to make timing-safe.
 */
export const looksLikeRefreshToken = (token) =>
  typeof token === "string" &&
  token.length >= 32 &&
  token.length <= 128 &&
  /^[A-Za-z0-9_-]+$/.test(token);

export default {
  generateRefreshToken,
  hashRefreshToken,
  looksLikeRefreshToken,
};