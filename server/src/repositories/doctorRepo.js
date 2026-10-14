/**
 * Doctors — directory, discovery, search and admin listing.
 *
 * The JSON doctor record carried duplicates of the specialty name, the
 * facility name, the city and the address, plus a full embedded copy of
 * its `users` row (which held the password hash and caused three Phase 0
 * data leaks). All of that is now derived by JOIN. Nothing in this file
 * can select a password, because no query here joins `users` unless it
 * is explicitly asked for the account email.
 */
import { query, rows, one } from "../config/database.js";
import { findOne, inClause, DATE_EXPR } from "./base.js";
import { todayLocal } from "../utils/time.js";

/**
 * The single canonical projection for a doctor, shaped exactly as the
 * existing `shape()` helper produced it.
 */
const PUBLIC_COLUMNS = `
  d.id, d.specialty_id, d.facility_id, d.qualification, d.experience_years,
  d.bio, d.consultation_fee, d.is_accepting_new, d.avatar_color,
  d.seed_rating, d.seed_review_count,
  s.name AS specialty_name,
  f.name AS facility_name, f.city, f.address,
  COALESCE(l.langs, '{}') AS languages,
  COALESCE(sv.service_ids, '{}') AS service_ids
`;

/**
 * The one definition of the directory joins, shared by every query in this
 * file so they cannot drift apart.
 *
 * `users` is joined here because the display name lives on the account, not on
 * the doctor row, and because a deactivated account must never appear in a
 * public listing.
 *
 * Languages and services are aggregated in LATERAL subqueries rather than
 * joined directly, so joining them cannot multiply doctor rows and silently
 * corrupt a count.
 */
const DIRECTORY_JOINS = `
  FROM doctors d
  JOIN specialties s ON s.id = d.specialty_id
  JOIN facilities  f ON f.id = d.facility_id
  JOIN users u       ON u.id = d.user_id
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT dl.language) AS langs
      FROM doctor_languages dl WHERE dl.doctor_id = d.id
  ) l ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT ds.service_id) AS service_ids
      FROM doctor_services ds WHERE ds.doctor_id = d.id
  ) sv ON true
`;

const toDoctor = (r) =>
  r && {
    id: r.id,
    name: r.full_name,
    // `name` used to be duplicated on the doctor row; it is the user's.
    userId: r.user_id,
    specialty: r.specialty_id,
    specialtyName: r.specialty_name,
    facilityId: r.facility_id,
    facilityName: r.facility_name,
    city: r.city,
    address: r.address,
    qualification: r.qualification,
    experience: r.experience_years,
    bio: r.bio,
    consultationFee: Number(r.consultation_fee),
    rating: r.seed_rating === null ? 0 : Number(r.seed_rating),
    reviewCount: r.seed_review_count,
    languages: r.languages || [],
    isAcceptingNew: r.is_accepting_new,
    imageColor: r.avatar_color,
    serviceIds: r.service_ids || [],
  };

/**
 * Fetch one doctor.
 * @param {string} id
 */
/**
 * `tx` is accepted so a read inside the booking transaction runs on that
 * transaction's connection. Booking needs the doctor's specialty and facility to
 * snapshot onto the appointment, and those must come from the same snapshot as
 * the slot it is validating, not from a separate pooled connection.
 */
export const findById = async (id, tx = null) => {
  const runner = tx ?? { one };
  return toDoctor(
    await runner.one(
      `SELECT ${PUBLIC_COLUMNS}, u.full_name, d.user_id
         ${DIRECTORY_JOINS}
        WHERE d.id = $1`,
      [id],
    ),
  );
};

/**
 * Find a doctor by the id of its login account.
 * @param {string} userId
 */
export const findByUserId = async (userId) =>
  toDoctor(
    await findOne(
      `SELECT ${PUBLIC_COLUMNS}, u.full_name, d.user_id
         ${DIRECTORY_JOINS}
        WHERE d.user_id = $1`,
      [userId],
    ),
  );

/**
 * Directory search with all the filters the existing endpoint supported,
 * now applied in SQL instead of in-memory array scans.
 *
 * @param {object} filters
 * @returns {Promise<object[]>}
 */
/**
 * Build the WHERE clause shared by the search and the count.
 *
 * Both must agree exactly, otherwise `total` would disagree with the rows
 * actually returned and the directory would claim more results than it shows.
 * Centralising the clause is what guarantees that.
 *
 * Note the explicit `!== undefined && !== null` tests rather than truthiness:
 * `maxFee=0` and `minRating=0` are meaningful filters, and a truthiness test
 * would silently drop them.
 */
const buildFilters = ({
  search: term,
  specialty,
  facilityId,
  city,
  maxFee,
  minRating,
  language,
  mode,
  acceptingOnly,
  isAcceptingNew,
  today,
} = {}) => {
  const params = [];
  const where = ["u.is_active = true"];

  if (term) {
    params.push(`%${String(term).toLowerCase()}%`);
    where.push(
      `(lower(u.full_name) LIKE $${params.length}
        OR lower(s.name)         LIKE $${params.length}
        OR lower(f.name)         LIKE $${params.length}
        OR lower(f.city)         LIKE $${params.length}
        OR lower(coalesce(d.bio, '')) LIKE $${params.length}
        OR lower(coalesce(d.qualification, '')) LIKE $${params.length})`,
    );
  }

  if (specialty) {
    const names = String(specialty)
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (names.length) {
      const { clause, params: p } = inClause(names, params.length + 1);
      params.push(...p);
      where.push(`lower(s.name) IN (${clause})`);
    }
  }

  // Facility filter. Accepts a comma-separated list so a client can offer
  // multi-select without a second round trip.
  if (facilityId) {
    const ids = String(facilityId)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (ids.length) {
      const { clause, params: p } = inClause(ids, params.length + 1);
      params.push(...p);
      where.push(`d.facility_id IN (${clause})`);
    }
  }

  if (city) {
    const names = String(city)
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (names.length) {
      const { clause, params: p } = inClause(names, params.length + 1);
      params.push(...p);
      where.push(`lower(f.city) IN (${clause})`);
    }
  }

  if (maxFee !== undefined && maxFee !== null && maxFee !== "") {
    params.push(Number(maxFee));
    where.push(`d.consultation_fee <= $${params.length}`);
  }

  if (minRating !== undefined && minRating !== null && minRating !== "") {
    params.push(Number(minRating));
    where.push(`d.seed_rating >= $${params.length}`);
  }

  if (language) {
    const langs = String(language)
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (langs.length) {
      const { clause, params: p } = inClause(langs, params.length + 1);
      params.push(...p);
      where.push(
        `EXISTS (SELECT 1 FROM doctor_languages dl
                   WHERE dl.doctor_id = d.id AND lower(dl.language) IN (${clause}))`,
      );
    }
  }

  if (mode) {
    // "Offers at least one future slot in this mode", as before.
    const modes = String(mode)
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (modes.length) {
      const { clause, params: p } = inClause(modes, params.length + 1);
      params.push(...p);
      params.push(today || todayLocal());
      where.push(
        `EXISTS (SELECT 1 FROM slots sl
                   WHERE sl.doctor_id = d.id
                     AND lower(sl.mode::text) IN (${clause})
                     AND ${DATE_EXPR("sl")} >= $${params.length})`,
      );
    }
  }

  if (acceptingOnly === true || acceptingOnly === "true") {
    where.push("d.is_accepting_new = true");
  }
  if (isAcceptingNew === false) {
    where.push("d.is_accepting_new = false");
  }

  return { params, where };
};

/**
 * Search the doctor directory.
 *
 * @param {object} filters
 * @param {number} [limit]   page size; omitted returns every match
 * @param {number} [offset]  rows to skip, for pagination
 * @returns {Promise<object[]>}
 */
export const search = async ({ sort, today, limit, offset, ...filters } = {}) => {
  const { params, where } = buildFilters({ ...filters, today });

  // `soonest` orders by the next open slot, which needs one extra parameter for
  // the "from today" comparison. It is appended only for that sort, so the
  // placeholder indexes in the WHERE clause stay aligned.
  let sqlParams = params;
  let orderBy = {
    "fee-low": "d.consultation_fee ASC",
    experience: "d.experience_years DESC NULLS LAST",
    rating: "d.seed_rating DESC NULLS LAST, d.seed_review_count DESC",
  }[sort] ?? "d.seed_rating DESC NULLS LAST, d.seed_review_count DESC";

  if (sort === "soonest") {
    sqlParams = [...params, today || todayLocal()];
    orderBy = `(SELECT min(sl.starts_at) FROM slots sl
                WHERE sl.doctor_id = d.id AND sl.status = 'available'
                  AND ${DATE_EXPR("sl")} >= $${sqlParams.length}) ASC NULLS LAST`;
  }

  // LIMIT/OFFSET are interpolated rather than parameterised, but only after
  // being coerced to an integer in the controller's validation, so no caller
  // input can reach the SQL text.
  const paging =
    limit !== undefined && limit !== null
      ? ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`
      : "";

  const result = await rows(
    `SELECT ${PUBLIC_COLUMNS}, u.full_name, d.user_id
       ${DIRECTORY_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}${paging}`,
    sqlParams,
  );

  return result.map(toDoctor);
};

/**
 * Total number of doctors matching a filter set.
 *
 * Uses the same clause builder as {@link search}, so the count can never drift
 * from the rows. Needed because the directory shows "N specialists match" and a
 * paginated response must still report the full number.
 */
export const countMatching = async ({ today, ...filters } = {}) => {
  const { params, where } = buildFilters({ ...filters, today });
  const r = await one(
    `SELECT count(*)::int AS c
       ${DIRECTORY_JOINS}
      WHERE ${where.join(" AND ")}`,
    params,
  );
  return r.c;
};

/** Doctors practising a specialty. Used by the specialty detail view. */
export const bySpecialty = async (specialtyId, options = {}) => {
  const name = await one("SELECT name FROM specialties WHERE id = $1", [specialtyId]);
  if (!name) return [];
  return search({ ...options, specialty: name.name });
};

/** Doctors practising at a facility. Used by the facility detail view. */
export const byFacility = async (facilityId, options = {}) =>
  search({ ...options, facilityId });

/**
 * Distinct cities and specialties, for the directory filter controls.
 */
export const facets = async () => ({
  cities: (
    await rows("SELECT DISTINCT f.city FROM facilities f ORDER BY f.city")
  ).map((r) => r.city),
  specialties: (
    await rows("SELECT id, name, slug, description, icon FROM specialties ORDER BY name")
  ).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    icon: r.icon,
  })),
  // Facilities are a first-class directory filter now, so the option list has
  // to include them alongside cities and specialties.
  facilities: (
    await rows(
      `SELECT f.id, f.name, f.city
         FROM facilities f
        WHERE EXISTS (SELECT 1 FROM doctors d WHERE d.facility_id = f.id)
        ORDER BY f.name`,
    )
  ).map((r) => ({ id: r.id, name: r.name, city: r.city })),
});

/**
 * Admin listing: the doctor plus the contact details of its login
 * account. The account's password is never selected.
 */
export const listForAdmin = async ({
  search: term,
  specialty,
  city,
  facilityId,
  accepting,
  limit,
  offset,
} = {}) => {
  const params = [];
  // Unlike the public directory, the admin list includes doctors whose account
  // is deactivated: an administrator needs to see them in order to reactivate
  // them. That is the one intentional difference from `search`.
  const where = ["1=1"];

  if (term) {
    params.push(`%${String(term).toLowerCase()}%`);
    where.push(
      `(lower(u.full_name) LIKE $${params.length}
        OR lower(s.name)         LIKE $${params.length}
        OR lower(f.name)         LIKE $${params.length}
        OR lower(f.city)         LIKE $${params.length}
        OR lower(u.email)        LIKE $${params.length})`,
    );
  }
  if (specialty) {
    params.push(specialty);
    where.push(`s.name = $${params.length}`);
  }
  if (city) {
    params.push(city);
    where.push(`f.city = $${params.length}`);
  }
  if (facilityId) {
    params.push(facilityId);
    where.push(`d.facility_id = $${params.length}`);
  }
  if (accepting === "true" || accepting === true) where.push("d.is_accepting_new = true");

  const paging =
    limit !== undefined && limit !== null
      ? ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`
      : "";

  return (
    await rows(
      `SELECT ${PUBLIC_COLUMNS}, u.full_name, d.user_id, u.email, u.phone,
              u.is_active AS account_is_active
         ${DIRECTORY_JOINS}
        WHERE ${where.join(" AND ")}
        ORDER BY u.full_name${paging}`,
      params,
    )
  ).map((r) => ({
    ...toDoctor(r),
    // Contact details of the login account are admin-only. The password hash is
    // never selected, so it cannot be leaked from here.
    email: r.email,
    phone: r.phone,
    accountActive: r.account_is_active !== false,
  }));
};

/**
 * Apply an admin patch. The allow-list is explicit and excludes `rating`,
 * which an admin could previously overwrite despite having no review data
 * behind it.
 */
export const updateByAdmin = async (id, patch) => {
  const columnFor = {
    isAcceptingNew: "is_accepting_new",
    consultationFee: "consultation_fee",
    facilityId: "facility_id",
    experience: "experience_years",
    bio: "bio",
    qualification: "qualification",
  };

  const sets = [];
  const params = [id];
  for (const [key, column] of Object.entries(columnFor)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (!sets.length) return findById(id);

  await query(
    `UPDATE doctors SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    params,
  );
  return findById(id);
};

/** Replace a doctor's linked services. */
export const setServices = async (doctorId, serviceIds) => {
  await query("DELETE FROM doctor_services WHERE doctor_id = $1", [doctorId]);
  for (const sid of serviceIds) {
    await query(
      "INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [doctorId, sid],
    );
  }
};

export const count = async () => one("SELECT count(*)::int AS c FROM doctors");

export default {
  findById,
  findByUserId,
  search,
  countMatching,
  bySpecialty,
  byFacility,
  facets,
  listForAdmin,
  updateByAdmin,
  setServices,
  count,
};