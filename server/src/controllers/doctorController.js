import doctorRepo from "../repositories/doctorRepo.js";
import { facilities, services, specialties } from "../repositories/referenceRepo.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { publicDoctor } from "../utils/projections.js";
import { recommendDoctors } from "../services/aiService.js";
import slotService from "../services/slotService.js";
import * as time from "../utils/time.js";
import logger from "../utils/logger.js";

const log = logger.tag("doctor-ctrl");

/** Public-safe doctor projection. */
const shape = publicDoctor;

/**
 * "Today" for the clinic.
 *
 * Was `Date.now() + 5.5 hours`, a hardcoded IST offset. That is only right
 * because India has never observed daylight saving, and it disagreed with the
 * repositories, which label slots with `AT TIME ZONE APP_TIMEZONE`.
 */
const todayStr = time.todayLocal;

/**
 * Page size ceiling.
 *
 * The directory is browsed without pagination, so an unbounded SELECT is a real
 * risk on a large dataset. Clamping the response keeps the payload sane while
 * `total` still reports the true match count, so the UI's "N match" text stays
 * correct. 100 comfortably covers the current catalogue.
 */
const MAX_PAGE_SIZE = 100;

/**
 * Normalise `limit` / `offset`.
 *
 * Returns `limit: undefined` when the caller did not ask for a page, which the
 * repository treats as "return every match" - preserving the pre-existing
 * behaviour for existing callers that omit it.
 */
const paging = (query) => {
  const limit = Number(query.limit);
  const offset = Number(query.offset);
  if (!Number.isFinite(limit) || limit <= 0) return {};
  return {
    limit: Math.min(Math.trunc(limit), MAX_PAGE_SIZE),
    offset: Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0,
  };
};

/** Identifiers are opaque text keys; bound the length before hitting the database. */
const ID_RULE = { type: "string", minLength: 1, maxLength: 64 };

/* ------------------------------------------------------------------ *
 *  GET /api/doctors                                                 *
 * ------------------------------------------------------------------ */
export const listDoctors = asyncHandler(async (req, res) => {
  const filters = {
    search: req.query.search,
    specialty: req.query.specialty,
    facilityId: req.query.facilityId,
    city: req.query.city,
    maxFee: req.query.maxFee,
    minRating: req.query.minRating,
    mode: req.query.mode,
    language: req.query.language,
    acceptingOnly: req.query.acceptingOnly,
    sort: req.query.sort,
    today: todayStr(),
  };

  const { limit, offset } = paging(req.query);

  // The rows and the total are computed from the same filter clause inside the
  // repository, so they cannot disagree. `total` is the full match count, which
  // is what the directory renders as "N specialists match your filters" - it
  // must not silently become the page size.
  const [doctors, total, facets] = await Promise.all([
    doctorRepo.search({ ...filters, limit, offset }),
    doctorRepo.countMatching(filters),
    doctorRepo.facets(),
  ]);

  return sendSuccess(res, {
    doctors: doctors.map(shape),
    count: doctors.length,
    total,
    filters: {
      cities: facets.cities,
      specialties: facets.specialties,
      facilities: facets.facilities,
    },
    ...(limit === undefined
      ? {}
      : { limit, offset, hasMore: offset + doctors.length < total }),
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/doctors/recommended                                     *
 * ------------------------------------------------------------------ */
export const getRecommended = asyncHandler(async (req, res) => {
  const { specialty, city, maxFee, mode, limit } = req.query;
  const results = await recommendDoctors({
    specialty,
    city,
    maxFee,
    mode,
    limit: Number(limit) || 6,
  });
  return sendSuccess(res, {
    recommendations: results.map((r) => ({ ...shape(r.doctor), matchScore: r.score })),
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/doctors/:id                                             *
 * ------------------------------------------------------------------ */
export const getDoctor = asyncHandler(async (req, res) => {
  const doctor = await doctorRepo.findById(req.params.id);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const facility = await facilities.findById(doctor.facilityId);
  const offered = await services.forDoctor(doctor.id);

  // A near-term availability snapshot per date for the profile page.
  //
  // This used to list the dates and then call availabilitySummary once per date -
  // up to seven round trips to render one page. One grouped query replaces it,
  // and returns the same fields, so the client is unaffected.
  const availability = await slotService.availabilityRange(doctor.id, { days: 7 });

  // A count, not a list: this endpoint is public, so returning appointment
  // records here would expose patient names to anonymous callers.
  const upcoming = doctor.upcomingAppointments ?? 0;

  return sendSuccess(res, {
    doctor: shape(doctor),
    facility: facility || null,
    services: offered,
    availability,
    upcomingAppointments: upcoming,
    stats: {
      totalReviews: doctor.reviewCount,
      patientsTreated: 500 + doctor.experience * 40,
      repeatRate: 65 + (doctor.id.charCodeAt(doctor.id.length - 1) % 25),
    },
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/doctors/:id/slots                                        *
 * ------------------------------------------------------------------ */
/**
 * GET /api/doctors/:id/slots
 *
 * The response shape (`slots`, `dates`, `summary`) is what the booking UI has
 * always consumed, so it is unchanged; `total`/`limit`/`offset` are additive.
 *
 * Pagination is opt-in. With no `limit` every slot for the doctor is returned,
 * because the client fetches once and then filters by date locally - a default
 * page size would silently hide whole dates from it. A caller that passes
 * `limit` gets a page plus an accurate `total`.
 *
 * `futureOnly=true` drops slots that have already started. That is not the
 * default, because a provider asking for their own schedule legitimately wants
 * to see the day that is in progress.
 */
export const doctorSlots = asyncHandler(async (req, res) => {
  const { doctor, slots, total, limit } = await slotService.listSlots({
    doctorId: req.params.id,
    date: req.query.date,
    from: req.query.from,
    to: req.query.to,
    mode: req.query.mode,
    status: req.query.status,
    futureOnly: req.query.futureOnly,
    limit: req.query.limit,
    offset: req.query.offset,
  });

  return sendSuccess(res, {
    slots,
    dates: await slotService.listAvailableDates(doctor.id, { mode: req.query.mode }),
    summary: req.query.date
      ? await slotService.availabilitySummary(doctor.id, {
          date: req.query.date,
          mode: req.query.mode,
        })
      : null,
    total,
    limit: limit ?? null,
    offset: req.query.offset ?? 0,
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/doctors/:id/slots/:slotId                                 *
 * ------------------------------------------------------------------ */

/**
 * One slot, with the doctor's and facility's names.
 *
 * The slot must belong to the doctor in the path, so a valid slot id cannot be
 * read through a mismatched URL. Public, consistent with the slots list: it
 * reveals nothing the list does not already show.
 */
export const doctorSlot = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    slot: await slotService.slotDetail(req.params.id, req.params.slotId),
  }),
);

/* ------------------------------------------------------------------ *
 *  GET /api/doctors/:id/availability                                  *
 * ------------------------------------------------------------------ */

/**
 * Availability for a doctor, either summarised or day by day.
 *
 * Always future-facing: a slot that has already started is not availability.
 * `?range=1` returns one row per date for a booking calendar instead of a
 * single aggregate, so the calendar needs a single query rather than one per
 * date.
 */
export const doctorAvailability = asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (req.query.range) {
    const days = await slotService.availabilityRange(id, {
      from: req.query.from,
      days: req.query.days,
      mode: req.query.mode,
    });
    return sendSuccess(res, {
      doctorId: id,
      days,
      timezone: time.zoneLabel(),
    });
  }

  return sendSuccess(res, {
    ...(await slotService.availabilitySummary(id, {
      date: req.query.date,
      from: req.query.from,
      to: req.query.to,
      mode: req.query.mode,
    })),
    timezone: time.zoneLabel(),
  });
});

/* ------------------------------------------------------------------ *
 *  Provider self-service: my schedule                                 *
 * ------------------------------------------------------------------ */
export const mySchedule = asyncHandler(async (req, res) => {
  const me = await doctorRepo.findByUserId(req.user.id);
  if (!me)
    throw new AppError(
      "No provider profile linked to this account",
      404,
      "NO_DOCTOR_PROFILE",
    );

  const { appointmentRepo } = await import("../repositories/index.js");
  const appointments = await appointmentRepo.list({ doctorId: me.id });
  const today = todayStr();

  return sendSuccess(res, {
    doctor: shape(me),
    slots: (await slotService.listSlots({ doctorId: me.id, date: req.query.date })).slots,
    dates: await slotService.listAvailableDates(me.id),
    // A doctor may see their own patients, so names are included. Rows are
    // rebuilt field by field rather than returned raw.
    appointments: appointments.map((a) => ({
      id: a.id,
      patientId: a.patientId,
      patientName: a.patientName,
      date: a.date,
      startTime: a.startTime,
      endTime: a.endTime,
      mode: a.mode,
      reason: a.reason,
      symptoms: a.symptoms,
      status: a.status,
      fee: a.fee,
      queuePosition: a.queuePosition ?? null,
      createdAt: a.createdAt,
      cancelledAt: a.cancelledAt ?? null,
      cancelReason: a.cancelReason ?? null,
    })),
    today: appointments.filter((a) => a.date === today).length,
    summary: await slotService.availabilitySummary(me.id, {
      date: req.query.date || today,
    }),
  });
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/doctors/:id/slots/:slotId                              *
 * ------------------------------------------------------------------ */
export const updateSlot = asyncHandler(async (req, res) => {
  const slot = await slotService.updateSlot({
    actor: req.user,
    doctorId: req.params.id,
    slotId: req.params.slotId,
    patch: req.body,
  });

  return sendSuccess(res, { slot }, "Slot updated");
});

/* ------------------------------------------------------------------ *
 *  POST /api/doctors/:id/slots  (bulk generate)                      *
 * ------------------------------------------------------------------ */
/**
 * POST /api/doctors/:id/slots  (bulk create)
 *
 * Previously hand-rolled its own timezone arithmetic and validated almost
 * nothing: any string was accepted as a time, so `times: ["abc"]` produced a
 * slot whose stored instant was silently nonsense, and a duration that crossed
 * midnight produced a slot on the wrong day. All of that now lives in
 * services/slotService, which validates the whole request before writing and
 * converts local times through the configured zone.
 *
 * Clashes with existing slots are reported per time in `skipped` rather than
 * failing the request, so a partially-free list still gets created. That is
 * deliberate: the provider can see exactly what was taken.
 */
export const generateSlots = asyncHandler(async (req, res) => {
  const result = await slotService.createSlots({
    actor: req.user,
    doctorId: req.params.id,
    date: req.body.date,
    times: req.body.times,
    duration: req.body.duration,
    mode: req.body.mode,
    fee: req.body.fee,
    maxQueue: req.body.maxQueue,
  });

  log.info(
    `${result.createdCount} slot(s) created on ${req.body.date} ` +
      `(${result.skipped.length} skipped)`,
  );
  return sendSuccess(res, result, "Slots created", 201);
});

/* ------------------------------------------------------------------ *
 *  Specialties                                                        *
 * ------------------------------------------------------------------ */

/**
 * GET /api/doctors/specialties
 *
 * Now carries doctorCount / facilityCount so a filter dropdown can show "Cardiology
 * (3)" without downloading the whole directory to count it.
 */
export const listSpecialties = asyncHandler(async (req, res) => {
  const list = await specialties.all();
  return sendSuccess(res, { specialties: list, count: list.length });
});

/**
 * GET /api/doctors/specialties/:idOrSlug
 *
 * Accepts the id or the human-readable slug, so a detail URL can be
 * `/specialties/cardiology` and stay stable across data changes.
 */
export const getSpecialty = asyncHandler(async (req, res) => {
  const specialty = await specialties.findByIdOrSlug(req.params.idOrSlug);
  if (!specialty) {
    throw new AppError("Specialty not found", 404, "SPECIALTY_NOT_FOUND");
  }

  // Which facilities actually offer it, derived by join rather than stored.
  const [atFacilities, matching] = await Promise.all([
    specialties.facilitiesFor(specialty.id),
    doctorRepo.bySpecialty(specialty.id, { limit: MAX_PAGE_SIZE, sort: "rating" }),
  ]);

  return sendSuccess(res, {
    specialty,
    facilities: atFacilities,
    // Public projection only: no userId, no account fields.
    doctors: matching.map(shape),
    count: matching.length,
  });
});

/* ------------------------------------------------------------------ *
 *  Facilities                                                         *
 * ------------------------------------------------------------------ */

export const listFacilities = asyncHandler(async (req, res) => {
  const [list, facets] = await Promise.all([
    facilities.list({ city: req.query.city, search: req.query.search }),
    doctorRepo.facets(),
  ]);

  return sendSuccess(res, {
    facilities: list,
    count: list.length,
    cities: facets.cities,
  });
});

/** GET /api/doctors/facilities/:id */
export const getFacility = asyncHandler(async (req, res) => {
  const facility = await facilities.findById(req.params.id);
  if (!facility) {
    throw new AppError("Facility not found", 404, "FACILITY_NOT_FOUND");
  }

  const matching = await doctorRepo.byFacility(facility.id, {
    limit: MAX_PAGE_SIZE,
    sort: "rating",
  });

  return sendSuccess(res, {
    facility,
    doctors: matching.map(shape),
    count: matching.length,
  });
});

/* ------------------------------------------------------------------ *
 *  Services                                                          *
 * ------------------------------------------------------------------ */

export const listServices = asyncHandler(async (req, res) => {
  const list = await services.all();
  return sendSuccess(res, { services: list, count: list.length });
});

/** GET /api/doctors/services/:id */
export const getService = asyncHandler(async (req, res) => {
  const service = await services.findById(req.params.id);
  if (!service) throw new AppError("Service not found", 404, "SERVICE_NOT_FOUND");
  return sendSuccess(res, { service });
});

/** GET /api/doctors/:id/services - the catalogue a doctor offers. */
export const doctorServices = asyncHandler(async (req, res) => {
  const doctor = await doctorRepo.findById(req.params.id);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const list = await services.forDoctor(doctor.id);
  return sendSuccess(res, {
    doctorId: doctor.id,
    services: list,
    count: list.length,
  });
});

export { shape as shapeDoctor };