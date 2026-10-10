import doctorRepo from "../repositories/doctorRepo.js";
import { facilities, services } from "../repositories/referenceRepo.js";
import analyticsRepo from "../repositories/analyticsRepo.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { publicDoctor, stripSecrets } from "../utils/projections.js";
import logger from "../utils/logger.js";

const log = logger.tag("admin");

/* ------------------------------------------------------------------ *
 *  GET /api/admin/overview                                          *
 *                                                                     *
 *  Every figure here was previously computed by repeated in-memory     *
 *  array scans (~130 per request). It is now a handful of grouped     *
 *  SQL queries.                                                       *
 * ------------------------------------------------------------------ */
export const overview = asyncHandler(async (req, res) => {
  const today = await analyticsRepo.todayLocal();

  const [kpis, counts, trend, bySpecialty, topDoctors] = await Promise.all([
    analyticsRepo.kpis(today),
    analyticsRepo.counts(),
    analyticsRepo.trend(14),
    analyticsRepo.bySpecialty(),
    analyticsRepo.topDoctors(8),
  ]);

  return sendSuccess(res, { kpis, counts, trend, bySpecialty, topDoctors });
});

/* ------------------------------------------------------------------ *
 *  Facility / doctor admin CRUD                                      *
 * ------------------------------------------------------------------ */
export const listDoctorsAdmin = asyncHandler(async (req, res) => {
  const { limit, offset } = req.query.limit
    ? {
        limit: Math.min(Number(req.query.limit) || 100, 100),
        offset: Number(req.query.offset) || 0,
      }
    : {};

  const [list, total] = await Promise.all([
    doctorRepo.listForAdmin({
      search: req.query.search,
      specialty: req.query.specialty,
      city: req.query.city,
      facilityId: req.query.facilityId,
      accepting: req.query.accepting,
      limit,
      offset,
    }),
    doctorRepo.countMatching({
      search: req.query.search,
      specialty: req.query.specialty,
      city: req.query.city,
      facilityId: req.query.facilityId,
      acceptingOnly: req.query.accepting,
    }),
  ]);

  return sendSuccess(res, { doctors: list, count: list.length, total });
});

/**
 * Admin-editable doctor fields.
 *
 * `rating` was previously in this list, letting an admin overwrite review
 * data that no review table backs. Removed.
 */
const DOCTOR_PATCH_FIELDS = [
  "isAcceptingNew",
  "consultationFee",
  "facilityId",
  "experience",
  "bio",
  "qualification",
];

export const updateDoctor = asyncHandler(async (req, res) => {
  const existing = await doctorRepo.findById(req.params.id);
  if (!existing) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const patch = {};
  for (const field of DOCTOR_PATCH_FIELDS) {
    if (req.body[field] !== undefined) patch[field] = req.body[field];
  }

  const doctor = await doctorRepo.updateByAdmin(req.params.id, patch);
  log.info(`doctor ${doctor.id} updated by admin`);
  return sendSuccess(res, { doctor: publicDoctor(doctor) }, "Doctor updated");
});

export const listFacilitiesAdmin = asyncHandler(async (req, res) => {
  const list = await facilities.listWithAppointmentCounts();
  return sendSuccess(res, { facilities: list, count: list.length });
});

export const createFacility = asyncHandler(async (req, res) => {
  const { name, city, address, type, phone, openHours, rating } = req.body;

  try {
    const facility = await facilities.create({
      name,
      city,
      address,
      type,
      phone,
      openHours,
      rating,
    });
    log.info(`facility created: ${facility.name}`);
    return sendSuccess(res, { facility }, "Facility created", 201);
  } catch (err) {
    // The unique index is the real duplicate guard; surface it as a 409.
    if (err.code === "23505") {
      throw new AppError(
        "A facility with this name already exists",
        409,
        "DUPLICATE",
      );
    }
    throw err;
  }
});

export const listServicesAdmin = asyncHandler(async (req, res) => {
  const list = await services.listWithDoctorCounts();
  return sendSuccess(res, { services: list, count: list.length });
});

/**
 * PATCH /api/admin/facilities/:id
 *
 * Absent from the API until now: facilities could be created but never
 * corrected. The repository's allow-list decides what is writable, so a caller
 * cannot rename an id or write an arbitrary column.
 */
export const updateFacility = asyncHandler(async (req, res) => {
  const existing = await facilities.findById(req.params.id);
  if (!existing) throw new AppError("Facility not found", 404, "FACILITY_NOT_FOUND");

  const patch = {};
  for (const field of [
    "name",
    "city",
    "address",
    "type",
    "phone",
    "openHours",
    "rating",
    "queueEnabled",
  ]) {
    if (req.body[field] !== undefined) patch[field] = req.body[field];
  }

  // Renaming into a name that already exists would violate the unique index on
  // lower(name); surface that as a conflict rather than a 500.
  if (patch.name && (await facilities.existsByName(patch.name, req.params.id))) {
    throw new AppError(
      "A facility with this name already exists",
      409,
      "DUPLICATE",
    );
  }

  let facility;
  try {
    facility = await facilities.updateByAdmin(req.params.id, patch);
  } catch (err) {
    if (err.code === "23505") {
      throw new AppError(
        "A facility with this name already exists",
        409,
        "DUPLICATE",
      );
    }
    throw err;
  }

  if (!facility) {
    throw new AppError("Facility not found", 404, "FACILITY_NOT_FOUND");
  }

  log.info(`facility ${facility.id} updated by admin`);
  return sendSuccess(res, { facility }, "Facility updated");
});

/* ------------------------------------------------------------------ *
 *  GET /api/admin/patients                                          *
 * ------------------------------------------------------------------ */
export const listPatients = asyncHandler(async (req, res) => {
  // `stripSecrets` is a second pass so a future column cannot leak from
  // this PHI view. The repository never selects a password.
  const patients = (await analyticsRepo.patients()).map(stripSecrets);
  return sendSuccess(res, { patients, count: patients.length });
});

/* ------------------------------------------------------------------ *
 *  GET /api/admin/notifications  (platform-wide dispatch log)       *
 * ------------------------------------------------------------------ */
export const notificationLog = asyncHandler(async (req, res) => {
  const notificationRepo = (
    await import("../repositories/notificationRepo.js")
  ).default;

  const stats = await notificationRepo.stats();
  return sendSuccess(res, {
    notifications: (await notificationRepo.listAll(req.query.limit)).map(
      stripSecrets,
    ),
    total: stats.total,
    sent: stats.sent,
    simulated: stats.simulated,
  });
});