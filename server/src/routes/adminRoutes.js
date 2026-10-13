import { Router } from "express";
import * as ctrl from "../controllers/adminController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";
import { ALLOWED_TRANSITIONS } from "../services/bookingService.js";

const router = Router();

// Every admin route is authenticated *and* role-gated.
router.use(requireAuth, requireRole("admin"));

/* ---------------- dashboard / analytics ---------------- */
router.get("/overview", ctrl.overview);

/* ---------------- doctors ---------------- */
router.get(
  "/doctors",
  validate(
    {
      search: { type: "string", maxLength: 120 },
      specialty: { type: "string", maxLength: 120 },
      city: { type: "string", maxLength: 80 },
      facilityId: { type: "string", maxLength: 64 },
      accepting: { type: "boolean" },
      limit: { type: "number", min: 1, max: 100 },
      offset: { type: "number", min: 0 },
    },
    "query",
  ),
  ctrl.listDoctorsAdmin,
);
router.patch(
  "/doctors/:id",
  validate({ id: { type: "string", minLength: 1, maxLength: 64 } }, "params"),
  validate({
    isAcceptingNew: { type: "boolean" },
    consultationFee: { type: "number", min: 0 },
    facilityId: { type: "string", maxLength: 64 },
    experience: { type: "number", min: 0, max: 70 },
    bio: { type: "string", maxLength: 2000 },
    qualification: { type: "string", maxLength: 240 },
  }),
  ctrl.updateDoctor,
);

/* ---------------- facilities ---------------- */
const FACILITY_FIELDS = {
  name: { type: "string", min: 2, maxLength: 120 },
  address: { type: "string", maxLength: 240 },
  city: { type: "string", maxLength: 80 },
  type: { type: "string", maxLength: 60 },
  phone: { type: "string", maxLength: 40 },
  openHours: { type: "string", maxLength: 80 },
  // The schema constrains rating to 0-5 with one decimal place; validating it
  // here turns a bad value into a 422 instead of a 23514 from the database.
  rating: { type: "number", min: 0, max: 5 },
  queueEnabled: { type: "boolean" },
};

router.get("/facilities", ctrl.listFacilitiesAdmin);

router.post(
  "/facilities",
  validate({ ...FACILITY_FIELDS, name: { ...FACILITY_FIELDS.name, required: true },
             address: { ...FACILITY_FIELDS.address, required: true },
             city: { ...FACILITY_FIELDS.city, required: true } }),
  ctrl.createFacility,
);

// Update. The whole set is optional, so a caller can rename without resending
// the address. `updateByAdmin` applies its own allow-list as well; two layers,
// because validation says "is this well formed" and the allow-list says "may
// this be written".
router.patch(
  "/facilities/:id",
  validate({ id: { type: "string", minLength: 1, maxLength: 64 } }, "params"),
  validate(FACILITY_FIELDS),
  ctrl.updateFacility,
);

/* ---------------- services ---------------- */
router.get("/services", ctrl.listServicesAdmin);

/* ---------------- appointments ---------------- */
// Cross-clinic appointment view, read-only. An admin who needs to CHANGE an
// appointment uses /appointments/:id/status, which enforces the same ownership,
// transition and lock rules a provider gets - an admin endpoint that wrote
// directly would be a way around all of them.
const ADMIN_PAGE = {
  search: { type: "string", maxLength: 120 },
  limit: { type: "number", min: 1, max: 200 },
  offset: { type: "number", min: 0 },
};

router.get(
  "/appointments",
  validate(
    {
      ...ADMIN_PAGE,
      // Comma-separated so a dashboard can ask for "scheduled,confirmed" in one
      // round trip. Length-capped so the array cannot be made arbitrarily large.
      status: { type: "string", maxLength: 120, enumList: Object.keys(ALLOWED_TRANSITIONS) },
      doctorId: { type: "string", maxLength: 64 },
      patientId: { type: "string", maxLength: 64 },
      // Dates are checked for shape here; the repository casts them, and an
      // impossible date such as 2026-02-31 is rejected by PostgreSQL rather
      // than silently becoming the 3rd of March.
      // `calendarDate`, not `date`: `date` is shape-only (it has to stay that way
      // so /doctors/:id/slots keeps answering 400 INVALID_DATE), so 2026-02-31
      // would sail through and reach a `::date` cast - a 500 for a typo. This
      // rule checks the day actually exists, so it is a 422 at the edge.
      from: { type: "calendarDate" },
      to: { type: "calendarDate" },
      sort: { type: "string", maxLength: 20 },
    },
    "query",
  ),
  ctrl.listAppointments,
);

/* ---------------- waiting rooms ---------------- */
router.get(
  "/queue",
  validate({ limit: { type: "number", min: 1, max: 200 }, offset: { type: "number", min: 0 } }, "query"),
  ctrl.queueOverview,
);

/* ---------------- provider availability ---------------- */
router.get(
  "/doctors/:id/availability",
  validate({ id: { type: "string", minLength: 1, maxLength: 64 } }, "params"),
  validate({ date: { type: "calendarDate" } }, "query"),
  ctrl.doctorAvailability,
);

/* ---------------- background passes ---------------- */
router.get("/scheduler", ctrl.schedulerStatus);

/* ---------------- patients ---------------- */
router.get(
  "/patients",
  validate(
    {
      search: { type: "string", maxLength: 120 },
      sort: { type: "string", maxLength: 20 },
      limit: { type: "number", min: 1, max: 200 },
      offset: { type: "number", min: 0 },
    },
    "query",
  ),
  ctrl.listPatients,
);

/* ---------------- notification audit log ---------------- */
router.get(
  "/notifications",
  validate({ limit: { type: "number", min: 1, max: 500 } }, "query"),
  ctrl.notificationLog,
);

export default router;
