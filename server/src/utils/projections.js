/**
 * Response projections.
 *
 * Every field that leaves the API is built here from an explicit whitelist. No
 * controller may return a datastore record directly — the Phase 0 audit found
 * three endpoints doing exactly that, which leaked `doctor.user.password`
 * (the seeded doctors embed a full copy of their user row, hash included).
 */

/** Never serialised, regardless of context. Defence in depth. */
const SECRET_KEYS = new Set([
  "password",
  "passwordHash",
  "password_hash",
  "user",
  "token",
  "refreshToken",
]);

/**
 * Recursively delete secret keys from an object.
 *
 * Use as a belt-and-braces pass on top of the explicit projections below, so a
 * newly added datastore field cannot accidentally become public.
 *
 * @param {*} value
 * @returns {*} a deep copy with secret keys removed
 */
export const stripSecrets = (value) => {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = stripSecrets(val);
  }
  return out;
};

/**
 * Public-safe user projection.
 *
 * Never includes the password or the nested `doctor` record — the doctor is
 * projected separately via {@link publicDoctor} when a caller is entitled to it.
 *
 * @param {object} user a record from `db.users`
 * @returns {object|null}
 */
export const publicUser = (user) => {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone ?? null,
    profile: user.profile ?? {},
    createdAt: user.createdAt,
  };
};

/**
 * Public-safe doctor projection for directory and discovery responses.
 *
 * Intentionally excludes `userId` and `user` so a login account can never be
 * correlated with a public profile.
 *
 * @param {object} doctor a record from `db.doctors`
 * @returns {object|null}
 */
export const publicDoctor = (doctor) => {
  if (!doctor) return null;
  return {
    id: doctor.id,
    name: doctor.name,
    specialty: doctor.specialty,
    specialtyName: doctor.specialtyName,
    facilityId: doctor.facilityId,
    facilityName: doctor.facilityName,
    city: doctor.city,
    address: doctor.address,
    qualification: doctor.qualification,
    experience: doctor.experience,
    bio: doctor.bio,
    consultationFee: doctor.consultationFee,
    rating: doctor.rating,
    reviewCount: doctor.reviewCount,
    languages: doctor.languages ?? [],
    isAcceptingNew: doctor.isAcceptingNew,
    imageColor: doctor.imageColor,
    serviceIds: doctor.serviceIds ?? [],
  };
};

/**
 * Doctor projection for the authenticated doctor themself (`/auth/me`).
 * Includes their own contact details but never the login record.
 *
 * @param {object} doctor
 * @returns {object|null}
 */
export const selfDoctor = (doctor) => {
  if (!doctor) return null;
  return {
    ...publicDoctor(doctor),
    userId: doctor.userId,
  };
};

export default { stripSecrets, publicUser, publicDoctor, selfDoctor };