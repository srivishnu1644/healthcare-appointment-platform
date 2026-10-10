/**
 * Specialties, facilities and services — the reference data that used to be
 * three more arrays in the JSON datastore.
 *
 * These tables are the authority for the names that used to be copied onto
 * every doctor and appointment row, so nothing here denormalises: a rename or a
 * re-assignment is reflected everywhere by the next read.
 *
 * Two conventions throughout:
 *   * every value is a $n parameter, never interpolated;
 *   * every SELECT names its columns explicitly.
 */
import { rows, one } from "../config/database.js";

/* ------------------------------------------------------------------ *
 *  Specialties                                                       *
 * ------------------------------------------------------------------ */

const SPECIALTY_COLUMNS = `
  s.id, s.name, s.slug, s.description, s.icon,
  (SELECT count(*)::int FROM doctors d WHERE d.specialty_id = s.id) AS doctor_count,
  (SELECT count(DISTINCT d.facility_id)::int FROM doctors d
    WHERE d.specialty_id = s.id) AS facility_count
`;

const toSpecialty = (r) =>
  r && {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    icon: r.icon,
    // Additive fields. The directory renders counts, and deriving them in SQL
    // avoids shipping the whole doctor list to the client just to count it.
    doctorCount: r.doctor_count,
    facilityCount: r.facility_count,
  };

export const specialties = {
  /** All specialties with doctor and facility counts. */
  all: async () =>
    (await rows(`SELECT ${SPECIALTY_COLUMNS} FROM specialties s ORDER BY s.name`)).map(
      toSpecialty,
    ),

  /**
   * Look up one specialty by id or by slug.
   *
   * Slugs exist so a detail URL can be readable and stable, so both are
   * accepted rather than forcing a client to know the opaque id.
   *
   * @param {string} key
   * @returns {Promise<object|null>}
   */
  findByIdOrSlug: async (key) => {
    const r = await one(
      `SELECT ${SPECIALTY_COLUMNS} FROM specialties s
        WHERE s.id = $1 OR s.slug = lower($1)`,
      [String(key)],
    );
    return toSpecialty(r);
  },

  /**
   * Facilities that have at least one doctor in this specialty.
   * Used by the specialty detail view to show "where can I book this?".
   */
  facilitiesFor: async (specialtyId) =>
    rows(
      `SELECT DISTINCT f.id, f.name, f.city, f.address, f.type
         FROM facilities f
         JOIN doctors d ON d.facility_id = f.id
        WHERE d.specialty_id = $1
        ORDER BY f.name`,
      [specialtyId],
    ).then((rs) =>
      rs.map((r) => ({
        id: r.id,
        name: r.name,
        city: r.city,
        address: r.address,
        type: r.type,
      })),
    ),

  /** Look up a specialty by name (case-insensitive), used by AI triage. */
  findByName: async (name) =>
    one("SELECT id, name FROM specialties WHERE lower(name) = lower($1)", [name]),
};

/* ------------------------------------------------------------------ *
 *  Facilities                                                        *
 * ------------------------------------------------------------------ */

const FACILITY_COLUMNS = `
  f.id, f.name, f.city, f.address, f.type, f.phone, f.open_hours,
  f.rating, f.queue_enabled,
  (SELECT count(*)::int FROM doctors d WHERE d.facility_id = f.id) AS doctor_count
`;

const toFacility = (r) =>
  r && {
    id: r.id,
    name: r.name,
    city: r.city,
    address: r.address,
    type: r.type,
    phone: r.phone,
    openHours: r.open_hours,
    rating: r.rating === null ? null : Number(r.rating),
    queueEnabled: r.queue_enabled,
    doctorCount: r.doctor_count,
  };

/** Fields an admin may change. Anything not listed cannot be written. */
const FACILITY_PATCHABLE = {
  name: "name",
  city: "city",
  address: "address",
  type: "type",
  phone: "phone",
  openHours: "open_hours",
  rating: "rating",
  queueEnabled: "queue_enabled",
};

export const facilities = {
  /**
   * List facilities with an aggregated doctor count and distinct specialty
   * list, matching the previous endpoint payload.
   *
   * @param {{city?: string, search?: string}} filters
   */
  list: async ({ city, search } = {}) => {
    const params = [];
    const where = [];

    if (city) {
      params.push(city);
      where.push(`lower(f.city) = lower($${params.length})`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(
        `(f.name ILIKE $${params.length} OR f.city ILIKE $${params.length}
          OR f.address ILIKE $${params.length} OR f.type ILIKE $${params.length})`,
      );
    }

    const sql = `
      SELECT ${FACILITY_COLUMNS},
        COALESCE((
          SELECT array_agg(DISTINCT sp.name)
            FROM doctors d JOIN specialties sp ON sp.id = d.specialty_id
           WHERE d.facility_id = f.id
        ), '{}') AS specialty_names
      FROM facilities f
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY f.name`;

    return (await rows(sql, params)).map((r) => ({
      ...toFacility(r),
      specialties: r.specialty_names || [],
    }));
  },

  /**
   * One facility, with the specialties practised there.
   *
   * `doctorCount` is included; `specialties` is aggregated so the client can
   * render the facility's departments without a second request.
   */
  /**
   * `tx` is accepted so this can be read inside a transaction. Booking looks up
   * the facility while holding an open transaction, and a pooled read there
   * escapes the transaction - which at a small pool size deadlocks, and at a
   * larger one silently reads a different snapshot than the surrounding writes.
   */
  findById: async (id, tx = null) => {
    const runner = tx ?? { one };
    const r = await runner.one(
      `SELECT ${FACILITY_COLUMNS},
         COALESCE((
           SELECT array_agg(DISTINCT sp.name)
             FROM doctors d JOIN specialties sp ON sp.id = d.specialty_id
            WHERE d.facility_id = f.id
         ), '{}') AS specialty_names
         FROM facilities f
        WHERE f.id = $1`,
      [id],
    );
    if (!r) return null;
    return { ...toFacility(r), specialties: r.specialty_names || [] };
  },

  /**
   * Admin variant: adds appointmentCount, which the admin facilities endpoint
   * has always returned.
   */
  listWithAppointmentCounts: async () =>
    (
      await rows(`
        SELECT ${FACILITY_COLUMNS},
          (SELECT count(*)::int FROM appointments a WHERE a.facility_id = f.id)
            AS appointment_count
        FROM facilities f ORDER BY f.name`)
    ).map((r) => ({
      ...toFacility(r),
      appointmentCount: r.appointment_count,
    })),

  /**
   * Create a facility. The unique index on lower(name) is what actually
   * prevents duplicates; the service maps 23505 to a 409.
   */
  create: async ({
    name,
    city,
    address,
    type,
    phone,
    openHours,
    rating,
    queueEnabled,
  }) => {
    const r = await one(
      `INSERT INTO facilities
         (name, city, address, type, phone, open_hours, rating, queue_enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, city, address, type, phone, open_hours,
                 rating, queue_enabled, 0 AS doctor_count`,
      [
        name,
        city,
        address,
        type || "Clinic",
        phone ?? null,
        openHours || "9:00 AM - 8:00 PM",
        rating === undefined || rating === null ? 4 : Number(rating),
        queueEnabled === undefined ? true : Boolean(queueEnabled),
      ],
    );
    return toFacility(r);
  },

  /**
   * Apply an admin patch.
   *
   * An explicit allow-list: a caller cannot write `id` or `queue_enabled` by
   * accident, and an unknown key is ignored rather than interpolated into SQL.
   * Returns null when the facility does not exist.
   *
   * @returns {Promise<object|null>}
   */
  updateByAdmin: async (id, patch) => {
    const sets = [];
    const params = [id];

    for (const [key, column] of Object.entries(FACILITY_PATCHABLE)) {
      if (patch[key] !== undefined) {
        params.push(patch[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (!sets.length) return facilities.findById(id);

    const updated = await one(
      `UPDATE facilities SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      params,
    );
    return updated ? facilities.findById(id) : null;
  },

  /** True when a facility with this name exists, ignoring case. */
  existsByName: async (name, exceptId = null) =>
    one(
      `SELECT 1 AS ok FROM facilities
        WHERE lower(name) = lower($1) AND ($2::text IS NULL OR id <> $2)`,
      [name, exceptId],
    ),
};

/* ------------------------------------------------------------------ *
 *  Services                                                          *
 * ------------------------------------------------------------------ */

const SERVICE_COLUMNS = `
  s.id, s.name, s.description, s.duration_minutes, s.price, s.currency
`;

const toService = (r) =>
  r && {
    id: r.id,
    name: r.name,
    description: r.description,
    duration: r.duration_minutes,
    price: Number(r.price),
    currency: r.currency,
  };

export const services = {
  all: async () =>
    (await rows(`SELECT ${SERVICE_COLUMNS} FROM services s ORDER BY s.name`)).map(
      toService,
    ),

  findById: async (id) =>
    toService(await one(`SELECT ${SERVICE_COLUMNS} FROM services s WHERE s.id = $1`, [id])),

  listWithDoctorCounts: async () =>
    (
      await rows(`
        SELECT ${SERVICE_COLUMNS},
          (SELECT count(*)::int FROM doctor_services ds WHERE ds.service_id = s.id)
            AS doctor_count
        FROM services s ORDER BY s.name`)
    ).map((r) => ({
      ...toService(r),
      doctorCount: r.doctor_count,
    })),

  /** Services offered by a specific doctor. */
  forDoctor: async (doctorId) =>
    (
      await rows(
        `SELECT ${SERVICE_COLUMNS}
           FROM services s JOIN doctor_services ds ON ds.service_id = s.id
          WHERE ds.doctor_id = $1
          ORDER BY s.name`,
        [doctorId],
      )
    ).map(toService),
};

export default { specialties, facilities, services };