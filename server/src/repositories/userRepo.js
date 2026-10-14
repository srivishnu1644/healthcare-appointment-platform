/**
 * Users, patient profiles and allergies.
 *
 * Maps the former JSON `users[]` array (whose `profile` was an untyped
 * blob) onto typed tables, and returns exactly the camelCase shape the
 * auth controller expects.
 */
import { query, rows, one } from "../config/database.js";
import { findOne } from "./base.js";

const USER_COLUMNS = `
  u.id, u.email, u.password_hash, u.role, u.full_name, u.phone,
  u.is_active, u.token_version, u.created_at, u.updated_at,
  p.date_of_birth, p.gender, p.blood_group, p.address_line,
  p.emergency_contact,
  COALESCE(
    (SELECT array_agg(a.allergen ORDER BY a.allergen)
       FROM patient_allergies a WHERE a.patient_id = u.id),
    '{}'
  ) AS allergies
`;

const FROM_USERS = `FROM users u LEFT JOIN patient_profiles p ON p.user_id = u.id`;

/**
 * Convert a database row to the camelCase user object the controllers
 * already consume. `password` is retained for the login path only and is
 * never placed in a response (see utils/projections.js).
 */
const toUser = (r) =>
  r && {
    id: r.id,
    email: r.email,
    password: r.password_hash,
    role: r.role,
    name: r.full_name,
    phone: r.phone,
    isActive: r.is_active,
    tokenVersion: r.token_version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    profile: {
      dateOfBirth: r.date_of_birth,
      gender: r.gender,
      bloodGroup: r.blood_group,
      address: r.address_line,
      emergencyContact: r.emergency_contact,
      allergies: r.allergies || [],
    },
  };

/**
 * Find a user by email (case-insensitive via citext).
 * @param {string} email
 */
export const findByEmail = async (email) =>
  toUser(
    await findOne(`SELECT ${USER_COLUMNS} ${FROM_USERS} WHERE u.email = $1`, [
      email,
    ]),
  );

/**
 * Find a user by id.
 *
 * @param {string} id
 * @param {object} [tx] optional transaction handle. Required when called from
 *   inside `withTransaction`: without it this would check out a *second*
 *   pooled connection, which breaks the guarantee that the whole transaction
 *   sees its own uncommitted writes — and deadlocks outright once the pool is
 *   saturated.
 */
export const findById = async (id, tx = null) => {
  const runner = tx ?? { one };
  return toUser(
    await runner.one(`SELECT ${USER_COLUMNS} ${FROM_USERS} WHERE u.id = $1`, [id]),
  );
};

/** Count users, optionally by role. */
export const count = async (role) =>
  role
    ? one("SELECT count(*)::int AS c FROM users WHERE role = $1", [role])
    : one("SELECT count(*)::int AS c FROM users");

/**
 * Create a user plus its optional profile and allergies, in one transaction.
 *
 * @param {{id?: string, name: string, email: string, password: string,
 *          role?: string, phone?: string|null, profile?: object}} input
 * @returns {Promise<object>} the created user
 */
export const create = async ({
  id,
  name,
  email,
  password,
  role = "patient",
  phone = null,
  profile = {},
}) =>
  await (async () => {
    const created = await query(
      `INSERT INTO users (id, email, password_hash, role, full_name, phone)
       VALUES (COALESCE($1, gen_random_uuid()::text), $2, $3, $4, $5, $6)
       RETURNING id`,
      [id ?? null, email, password, role, name, phone],
    );
    const userId = created.rows[0].id;

    const hasProfile = Object.values(profile).some(
      (v) => v !== undefined && v !== null && v !== "",
    );
    if (hasProfile || role === "patient") {
      await query(
        `INSERT INTO patient_profiles
           (user_id, date_of_birth, gender, blood_group, address_line, emergency_contact)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          userId,
          profile.dateOfBirth ?? null,
          profile.gender ?? null,
          profile.bloodGroup ?? null,
          profile.address ?? null,
          profile.emergencyContact ?? null,
        ],
      );
    }

    const allergies = Array.isArray(profile.allergies) ? profile.allergies : [];
    for (const allergen of allergies) {
      await query(
        `INSERT INTO patient_allergies (patient_id, allergen) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, String(allergen)],
      );
    }

    return findById(userId);
  })();

/**
 * Update a user's own editable fields: name, phone and profile.
 *
 * `role` is deliberately not updatable from here. Role changes go through
 * an explicit admin path (Phase 12), which is what closes the profile
 * injection finding (S-08).
 */
export const updateOwn = async (id, { name, phone, profile = {} }) =>
  await (async () => {
    if (name !== undefined) {
      await query("UPDATE users SET full_name = $2, updated_at = now() WHERE id = $1", [
        id,
        name,
      ]);
    }
    if (phone !== undefined) {
      await query("UPDATE users SET phone = $2, updated_at = now() WHERE id = $1", [
        id,
        phone,
      ]);
    }

    if (Object.keys(profile).length) {
      await query(
        `INSERT INTO patient_profiles
           (user_id, date_of_birth, gender, blood_group, address_line, emergency_contact)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           date_of_birth     = COALESCE($2, patient_profiles.date_of_birth),
           gender            = COALESCE($3, patient_profiles.gender),
           blood_group       = COALESCE($4, patient_profiles.blood_group),
           address_line      = COALESCE($5, patient_profiles.address_line),
           emergency_contact = COALESCE($6, patient_profiles.emergency_contact),
           updated_at        = now()`,
        [
          id,
          profile.dateOfBirth ?? null,
          profile.gender ?? null,
          profile.bloodGroup ?? null,
          profile.address ?? null,
          profile.emergencyContact ?? null,
        ],
      );

      if (Array.isArray(profile.allergies)) {
        await query("DELETE FROM patient_allergies WHERE patient_id = $1", [id]);
        for (const allergen of profile.allergies) {
          await query(
            `INSERT INTO patient_allergies (patient_id, allergen) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [id, String(allergen)],
          );
        }
      }
    }

    return findById(id);
  })();

/**
 * Overwrite the stored password hash.
 * Used by the login path to upgrade a legacy value to bcrypt.
 */
export const setPasswordHash = async (id, hash) => {
  await query(
    "UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1",
    [id, hash],
  );
};

export default {
  findByEmail,
  findById,
  count,
  create,
  updateOwn,
  setPasswordHash,
};