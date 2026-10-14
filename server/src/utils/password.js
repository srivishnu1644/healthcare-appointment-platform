/**
 * Password hashing helpers.
 *
 * The only supported storage format is a bcrypt hash. The prototype's previous
 * scheme — storing the literal string `hashed:${plaintext}` — was reversible and
 * is removed. Legacy values are still *readable* through `verifyPassword` so that
 * an existing `db.json` can be migrated transparently on first successful login,
 * but they are never written back.
 */
import bcrypt from "bcryptjs";
import { timingSafeEqual } from "node:crypto";

/** bcrypt cost factor. Defaults to 10; override with BCRYPT_ROUNDS. */
const ROUNDS = (() => {
  const raw = Number(process.env.BCRYPT_ROUNDS);
  // bcryptjs is pure JS and slower than the native binding; keep the factor in a
  // sane range rather than trusting an arbitrary value from the environment.
  if (!Number.isInteger(raw) || raw < 4 || raw > 15) return 10;
  return raw;
})();

/** True when `stored` is a real bcrypt hash rather than a legacy value. */
export const isBcryptHash = (stored) =>
  typeof stored === "string" && /^\$2[aby]\$\d{2}\$/.test(stored);

/** True when `stored` is a legacy `hashed:` value from the prototype. */
export const isLegacyHash = (stored) =>
  typeof stored === "string" && stored.startsWith("hashed:");

/**
 * Hash a plaintext password with bcrypt.
 * @param {string} plain
 * @returns {Promise<string>} a bcrypt hash
 */
export const hashPassword = async (plain) => bcrypt.hash(plain, ROUNDS);

/**
 * Verify a plaintext password against a stored value.
 *
 * Accepts both a real bcrypt hash and a legacy `hashed:` value, so accounts
 * created before this fix still sign in. Use `needsRehash` to decide whether the
 * stored value should be upgraded.
 *
 * @param {string} plain   the candidate password
 * @param {string} stored  the value from the datastore
 * @returns {Promise<boolean>}
 */
export const verifyPassword = async (plain, stored) => {
  if (typeof plain !== "string" || typeof stored !== "string") return false;

  if (isBcryptHash(stored)) return bcrypt.compare(plain, stored);

  if (isLegacyHash(stored)) {
    // The legacy format stored the plaintext itself, so this is a direct
    // comparison rather than a hash comparison. `timingSafeEqual` avoids leaking
    // the value through response timing; it requires equal lengths, which are
    // checked first. The matched value is re-hashed by the caller on success.
    const expected = stored.slice("hashed:".length);
    const a = Buffer.from(plain, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  return false;
};

/**
 * Whether a verified password should be re-stored under a stronger hash.
 * True for legacy values and for bcrypt hashes below the current cost factor.
 */
export const needsRehash = (stored) => {
  if (isLegacyHash(stored)) return true;
  if (!isBcryptHash(stored)) return true;
  const cost = Number(stored.split("$")[2]);
  return Number.isInteger(cost) && cost < ROUNDS;
};

export default {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  isLegacyHash,
  needsRehash,
};