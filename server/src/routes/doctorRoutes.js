import { Router } from "express";
import * as ctrl from "../controllers/doctorController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

const router = Router();

/* ------------------------------------------------------------------ *
 *  Validation schemas                                                 *
 *                                                                     *
 *  The directory is public, so these are the only thing standing    *
 *  between a query string and the database. Validating here means a  *
 *  typo is a 422 with a named field instead of either a silently    *
 *  empty result set or an unindexed scan.                            *
 *                                                                     *
 *  `limit` is left unset by default so existing callers keep getting *
 *  every match; the controller applies the ceiling.                  *
 * ------------------------------------------------------------------ */

/** Opaque text key. Slugs are lowercase words, ids are short hex. */
const ID = { type: "string", minLength: 1, maxLength: 64 };
const SLUG = { type: "string", minLength: 1, maxLength: 64 };

/** Comma-separated lists are how multi-select filters arrive. */
const LIST = { type: "string", maxLength: 200 };

const DOCTOR_QUERY = {
  search: { type: "string", maxLength: 120 },
  specialty: LIST,
  facilityId: LIST,
  city: LIST,
  language: LIST,
  maxFee: { type: "number", min: 0, max: 1000000 },
  minRating: { type: "number", min: 0, max: 5 },
  mode: { enum: ["in-person", "video"] },
  acceptingOnly: { type: "boolean" },
  sort: { enum: ["rating", "fee-low", "experience", "soonest"] },
  limit: { type: "number", min: 1, max: 100 },
  offset: { type: "number", min: 0 },
};

/* ------------------------------------------------------------------ *
 *  Public reference data + discovery.                                *
 *  Browsing doctors before signing in is a core part of the          *
 *  patient journey, so these routes intentionally do NOT require auth. *
 * ------------------------------------------------------------------ */

// --- specialties ---
router.get(
  "/specialties",
  validate({ search: { type: "string", maxLength: 80 } }, "query"),
  ctrl.listSpecialties,
);
router.get("/specialties/:idOrSlug", validate({ idOrSlug: SLUG }, "params"), ctrl.getSpecialty);

// --- services ---
router.get("/services", ctrl.listServices);
router.get("/services/:id", validate({ id: ID }, "params"), ctrl.getService);

// --- facilities ---
router.get(
  "/facilities",
  validate(
    {
      city: { type: "string", maxLength: 80 },
      search: { type: "string", maxLength: 120 },
    },
    "query",
  ),
  ctrl.listFacilities,
);
router.get("/facilities/:id", validate({ id: ID }, "params"), ctrl.getFacility);

// --- discovery ---
router.get(
  "/recommended",
  validate(
    {
      specialty: LIST,
      city: LIST,
      facilityId: LIST,
      maxFee: { type: "number", min: 0, max: 1000000 },
      mode: { enum: ["in-person", "video"] },
      limit: { type: "number", min: 1, max: 50 },
    },
    "query",
  ),
  ctrl.getRecommended,
);

router.get("/", validate(DOCTOR_QUERY, "query"), ctrl.listDoctors);

// --- public profile ---
router.get("/:id", validate({ id: ID }, "params"), ctrl.getDoctor);
router.get("/:id/services", validate({ id: ID }, "params"), ctrl.doctorServices);

/**
 * Slot query filters.
 *
 * `from`/`to` accept either a date ("2026-10-09", meaning the start/end of that
 * local day) or a clock time ("09:00"), and are resolved to absolute instants in
 * the configured zone by services/slotService. That is why they are bounded by
 * 10 characters rather than 5: the earlier 5-character cap silently truncated a
 * date to "2026-", which matched nothing.
 *
 * `limit` is deliberately unset by default, so callers that omit it keep
 * receiving every slot and cannot have whole dates dropped from the response by
 * a page boundary.
 */
const SLOT_QUERY = {
  date: { type: "date" },
  from: { type: "string", maxLength: 10 },
  to: { type: "string", maxLength: 10 },
  mode: { enum: ["in-person", "video"] },
  status: { enum: ["available", "booked", "blocked"] },
  futureOnly: { type: "boolean" },
  limit: { type: "number", min: 1, max: 200 },
  offset: { type: "number", min: 0 },
};

router.get(
  "/:id/slots",
  validate({ id: ID, ...SLOT_QUERY }, "query"),
  ctrl.doctorSlots,
);

// A single slot. Declared after "/:id/slots" so it is not shadowed by it.
router.get(
  "/:id/slots/:slotId",
  validate({ id: ID, slotId: ID }, "params"),
  ctrl.doctorSlot,
);

// Availability. `?range=1` switches from a single summary to one row per date.
router.get(
  "/:id/availability",
  validate(
    {
      id: ID,
      date: { type: "date" },
      from: { type: "string", maxLength: 10 },
      to: { type: "string", maxLength: 10 },
      mode: { enum: ["in-person", "video"] },
      range: { type: "boolean" },
      days: { type: "number", min: 1, max: 90 },
    },
    "query",
  ),
  ctrl.doctorAvailability,
);

// Everything below manages provider state and needs a session.
router.use(requireAuth);

/* --- provider self-service (declared before /:id to avoid shadowing) --- */
router.get(
  "/me/schedule",
  requireRole("doctor"),
  validate({ date: { type: "date" } }, "query"),
  ctrl.mySchedule,
);

/* --- provider slot management --- */
router.patch(
  "/:id/slots/:slotId",
  requireRole("doctor", "admin"),
  validate(
    {
      id: ID,
      slotId: ID,
      // `booked` is not settable: whether a slot is taken is a fact about the
      // appointments pointing at it, not something a provider may assert.
      status: { enum: ["available", "blocked"] },
      mode: { enum: ["in-person", "video"] },
      fee: { type: "number", min: 0 },
      maxQueue: { type: "number", min: 1, max: 100 },
    },
    "body",
  ),
  ctrl.updateSlot,
);

router.post(
  "/:id/slots",
  requireRole("doctor", "admin"),
  validate({
    id: ID,
    date: { required: true, type: "date" },
    // The validator cannot describe per-element rules, so each entry is checked
    // as an "HH:MM" clock time by services/slotService, which reports the
    // offending value by name.
    times: { required: true, type: "array", minLength: 1, maxLength: 100 },
    duration: { type: "number", default: 30, min: 5, max: 480 },
    mode: { enum: ["in-person", "video"], default: "in-person" },
    fee: { type: "number", min: 0 },
    maxQueue: { type: "number", min: 1, max: 100, default: 3 },
  }),
  ctrl.generateSlots,
);

export default router;