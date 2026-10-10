/**
 * Admin analytics.
 *
 * This is the module that removes the ~130 full-array scans
 * `adminController.overview` performed per request in the JSON model:
 * 14 days x 4 lookups for the trend, 10 specialties x 4, 12 doctors x 2,
 * plus the KPI and slot counts — all of which are now single SQL passes
 * over an index.
 */
import { query, rows, one } from "../config/database.js";
import { find, DATE_EXPR, TIME_EXPR, tzLiteral } from "./base.js";

/**
 * "Today" in the business timezone, computed by the database.
 *
 * This previously hardcoded the Asia/Kolkata offset regardless of APP_TIMEZONE,
 * so a deployment configured for any other zone computed its daily figures
 * against the wrong day. It now uses the configured zone like every other
 * repository.
 */
const todayLocal = () =>
  one(`SELECT to_char(now() AT TIME ZONE ${tzLiteral}, 'YYYY-MM-DD') AS d`).then(
    (r) => r.d,
  );

/**
 * Headline KPIs.
 */
export const kpis = async (today) => {
  const [counts, slotStats, patients] = await Promise.all([
    one(`
      SELECT
        count(*)::int                                                   AS total,
        count(*) FILTER (WHERE status = 'completed')::int                AS completed,
        count(*) FILTER (WHERE status = 'cancelled')::int                AS cancelled,
        count(*) FILTER (WHERE status = 'no-show')::int                  AS no_show,
        count(*) FILTER (WHERE status IN ('scheduled','confirmed')
                          AND ${DATE_EXPR("a", "starts_at")} >= $1)::int AS upcoming,
        count(*) FILTER (WHERE ${DATE_EXPR("a", "starts_at")} = $1)::int AS today_count,
        COALESCE(sum(fee) FILTER (WHERE status = 'completed'), 0)::numeric AS revenue
      FROM appointments a`, [today]),
    one(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status IN ('booked','blocked'))::int AS used
      FROM slots`),
    one("SELECT count(DISTINCT patient_id)::int AS c FROM appointments"),
  ]);

  // "booked" was previously `everything not cancelled`, which made the
  // denominator for these rates ambiguous. Using total bookings keeps the
  // ratio interpretable.
  const total = counts.total;
  return {
    totalAppointments: total,
    booked: total,
    completed: counts.completed,
    cancelled: counts.cancelled,
    noShow: counts.no_show,
    upcoming: counts.upcoming,
    todayCount: counts.today_count,
    cancelRate: total ? Number(((counts.cancelled / total) * 100).toFixed(1)) : 0,
    noShowRate: total ? Number(((counts.no_show / total) * 100).toFixed(1)) : 0,
    revenue: Number(counts.revenue),
    slotUtilization: slotStats.total
      ? Math.round((slotStats.used / slotStats.total) * 100)
      : 0,
    activePatients: patients.c,
  };
};

/**
 * 14-day trend, including days with zero appointments.
 * The JSON version built the series in a loop with four scans per day;
 * this is one grouped query joined to a generated date series.
 */
export const trend = async (days = 14) =>
  (
    await rows(`
      WITH series AS (
        SELECT generate_series(
                 (now() AT TIME ZONE ${tzLiteral})::date - ($1::int - 1),
                 (now() AT TIME ZONE ${tzLiteral})::date,
                 interval '1 day'
               )::date AS d
      ),
      counts AS (
        SELECT ${DATE_EXPR("a", "starts_at")} AS d,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'completed')::int AS completed,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
               count(*) FILTER (WHERE status = 'no-show')::int   AS no_show
          FROM appointments a
         GROUP BY 1
      )
      SELECT to_char(series.d, 'YYYY-MM-DD') AS date,
             COALESCE(counts.total, 0)     AS appointments,
             COALESCE(counts.completed, 0) AS completed,
             COALESCE(counts.cancelled, 0) AS cancelled,
             COALESCE(counts.no_show, 0)   AS no_show
        FROM series LEFT JOIN counts ON counts.d = to_char(series.d, 'YYYY-MM-DD')
       ORDER BY series.d`, [String(days)])
  ).map((r) => ({
    date: r.date,
    appointments: Number(r.appointments),
    completed: Number(r.completed),
    cancelled: Number(r.cancelled),
    noShow: Number(r.no_show),
  }));

/**
 * Appointment volume grouped by specialty.
 */
export const bySpecialty = async () =>
  (
    await rows(`
      SELECT s.name AS specialty,
             count(*)::int AS total,
             count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
             count(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
             count(*) FILTER (WHERE a.status = 'no-show')::int   AS no_show
        FROM appointments a
        JOIN specialties s ON s.id = a.specialty_id
       GROUP BY s.name
      HAVING count(*) > 0
       ORDER BY s.name`)
  ).map((r) => ({
    specialty: r.specialty,
    total: Number(r.total),
    completed: Number(r.completed),
    cancelled: Number(r.cancelled),
    noShow: Number(r.no_show),
    utilization: r.total
      ? Math.round((Number(r.completed) / Number(r.total)) * 100)
      : 0,
  }));

/**
 * Top doctors by completed volume, with the revenue figure the dashboard
 * has always displayed.
 */
export const topDoctors = async (limit = 8) =>
  (
    await rows(`
      SELECT d.id AS doctor_id,
             u.full_name AS name,
             s.name AS specialty_name,
             d.seed_rating AS rating,
             d.consultation_fee,
             count(*) FILTER (WHERE a.status = 'completed')::int AS completed,
             count(*) FILTER (WHERE a.status = 'no-show')::int   AS no_show
        FROM appointments a
        JOIN doctors d     ON d.id = a.doctor_id
        JOIN users u       ON u.id = d.user_id
        JOIN specialties s ON s.id = d.specialty_id
       GROUP BY d.id, u.full_name, s.name, d.seed_rating, d.consultation_fee
       ORDER BY completed DESC, u.full_name
       LIMIT ${Number(limit)}`)
  ).map((r) => {
    const completed = Number(r.completed);
    return {
      doctorId: r.doctor_id,
      name: r.name,
      specialtyName: r.specialty_name,
      completed,
      rating: r.rating === null ? 0 : Number(r.rating),
      revenue: completed * Number(r.consultation_fee),
      noShow: Number(r.no_show),
    };
  });

/** Entity counts for the dashboard sidebar. */
export const counts = async () => {
  const [doctors, facilities, services, specialties, users, slots] = await Promise.all([
    one("SELECT count(*)::int AS c FROM doctors"),
    one("SELECT count(*)::int AS c FROM facilities"),
    one("SELECT count(*)::int AS c FROM services"),
    one("SELECT count(*)::int AS c FROM specialties"),
    one("SELECT count(*)::int AS c FROM users"),
    one(`SELECT count(*) FILTER (WHERE ${DATE_EXPR("sl")} >= $1)::int AS upcoming,
                 count(*) FILTER (WHERE ${DATE_EXPR("sl")} >= $1 AND status = 'available')::int AS open,
                 count(*)::int AS all_slots
            FROM slots sl`, [await todayLocal()]),
  ]);

  return {
    doctors: doctors.c,
    facilities: facilities.c,
    services: services.c,
    specialties: specialties.c,
    users: users.c,
    upcomingSlotCount: slots.upcoming,
    openSlotCount: slots.open,
  };
};

/**
 * Patient administration list.
 *
 * The counts were previously computed by scanning every appointment for
 * every patient (an O(n·m) loop); they are now a single grouped join.
 * Passwords are never selected — the user's row is aggregated in a
 * subquery, not joined wholesale.
 */
export const patients = async () =>
  (
    await rows(`
      SELECT u.id, u.full_name AS name, u.email, u.phone,
             p.blood_group, COALESCE(allergy.allergens, '{}') AS allergies,
             COALESCE(agg.total, 0)::int     AS total_appointments,
             COALESCE(agg.completed, 0)::int AS completed,
             COALESCE(agg.no_show, 0)::int   AS no_show,
             COALESCE(agg.cancelled, 0)::int AS cancelled,
             agg.last_visit
        FROM users u
        LEFT JOIN patient_profiles p ON p.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT COALESCE(array_agg(al.allergen), '{}') AS allergens
            FROM patient_allergies al WHERE al.patient_id = u.id
        ) allergy ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE status = 'completed')::int AS completed,
                 count(*) FILTER (WHERE status = 'no-show')::int   AS no_show,
                 count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                 min(${DATE_EXPR("ap", "starts_at")})
                   FILTER (WHERE status = 'completed')             AS last_visit
            FROM appointments ap WHERE ap.patient_id = u.id
        ) agg ON true
       WHERE u.role = 'patient'
       ORDER BY u.full_name`)
  ).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    bloodGroup: r.blood_group,
    allergies: r.allergies || [],
    totalAppointments: Number(r.total_appointments),
    completed: Number(r.completed),
    noShow: Number(r.no_show),
    cancelled: Number(r.cancelled),
    lastVisit: r.last_visit,
  }));

export default { kpis, trend, bySpecialty, topDoctors, counts, patients, todayLocal };