import { Router } from "express";
import * as ctrl from "../controllers/appointmentController.js";
import {
  requireAuth,
  requireRole,
  requireAppointmentAccess,
} from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";
// The keys of the transition table ARE the complete set of appointment statuses,
// so this validates against the same list the booking rules use rather than a
// second copy that could drift. A status added to the table is accepted here the
// moment it exists - no second edit in this file.
import { ALLOWED_TRANSITIONS } from "../services/bookingService.js";

const router = Router();
router.use(requireAuth);

/* ------------------------------------------------------------------ *
 *  Ownership                                                          *
 *                                                                     *
 *  Every per-appointment route below is guarded by                     *
 *  `requireAppointmentAccess`, which resolves the appointment and       *
 *  allows only its owner, its assigned doctor, or an admin.           *
 *                                                                     *
 *  This middleware previously did not exist for `/:id/check-in`,      *
 *  which let any authenticated user check in — and mutate — a         *
 *  stranger's appointment.                                             *
 * ------------------------------------------------------------------ */

// --- patient / provider / admin actions ---
router.post(
  "/",
  requireRole("patient"),
  validate({
    doctorId: { required: true, type: "string" },
    slotId: { required: true, type: "string" },
    reason: { type: "string", maxLength: 500 },
    symptoms: { type: "string", maxLength: 1000 },
    mode: { enum: ["in-person", "video"] },
  }),
  ctrl.createAppointment,
);

router.patch(
  "/:id/reschedule",
  requireAppointmentAccess("You cannot reschedule this appointment"),
  validate({ slotId: { required: true, type: "string" } }),
  ctrl.reschedule,
);

router.patch(
  "/:id/cancel",
  requireAppointmentAccess("You cannot cancel this appointment"),
  validate({ reason: { type: "string", maxLength: 300 } }),
  ctrl.cancel,
);

router.patch(
  "/:id/status",
  requireRole("doctor", "admin"),
  requireAppointmentAccess("You can only update your own appointments"),
  validate({
    status: {
      required: true,
      enum: [
        "scheduled",
        "confirmed",
        "in-progress",
        "completed",
        "cancelled",
        "no-show",
      ],
    },
    note: { type: "string", maxLength: 300 },
  }),
  ctrl.changeStatus,
);

router.post(
  "/:id/check-in",
  requireAppointmentAccess("You cannot check in to this appointment"),
  ctrl.checkIn,
);

// Collection-level routes are registered after the `:id` routes above so
// they are not shadowed by the ownership middleware.
// `doctorId` and `date` are checked for FORMAT here, but deliberately NOT marked
// `required`.
//
// Marking it required moved the answer for a missing doctorId from the
// controller's explicit `400 MISSING_DOCTOR` to a generic `422 VALIDATION_ERROR`,
// and the queue suite caught the regression. The specific message is the more
// useful contract, so presence stays the controller's job and the route only
// refuses a value that is present and malformed - which used to reach a uuid
// cast and answer 500.
router.get(
  "/queue",
  validate(
    {
      doctorId: { type: "uuid" },
      date: { type: "date" },
    },
    "query",
  ),
  ctrl.liveQueue,
);

// Call the next patient. Registered here, beside the read, so the collection
// path exists before any `:id` route could shadow it.
//
// The date is checked in the CONTROLLER, not here, and that is deliberate: this
// endpoint answers MISSING_DATE for an absent field and INVALID_DATE for one
// that is malformed. A single `required` rule cannot tell those apart, and the
// two messages tell a caller whether they forgot a field or mistyped it.
router.post(
  "/queue/next",
  validate({
    body: {
      doctorId: { required: true, type: "string" },
      date: { required: true, type: "string" },
    },
  }),
  ctrl.callNext,
);

// Same reasoning as `/queue`: format checked here, presence left to the
// controller so `400 MISSING_DOCTOR` is preserved.
router.get(
  "/availability",
  validate(
    {
      doctorId: { type: "uuid" },
      date: { type: "date" },
    },
    "query",
  ),
  ctrl.availabilitySummary,
);

// Phase 13. `status` is an enum rather than a free string: an unknown status
// used to return 200 with an empty list, which reads as "you have none" rather
// than "that is not a status". `limit`/`offset` are bounded so page 2 cannot be
// silently page 1. `from`/`to` use `calendarDate` rather than `date` because on
// this endpoint there is no controller-level date check to catch 2026-02-31 -
// without it the value reaches a `::date` cast and answers 500.
router.get(
  "/",
  validate(
    {
      status: { type: "string", maxLength: 120, enumList: Object.keys(ALLOWED_TRANSITIONS) },
      doctorId: { type: "uuid" },
      patientId: { type: "uuid" },
      from: { type: "calendarDate" },
      to: { type: "calendarDate" },
      limit: { type: "number", min: 1, max: 200 },
      offset: { type: "number", min: 0 },
    },
    "query",
  ),
  ctrl.listAppointments,
);
router.get(
  "/:id",
  requireAppointmentAccess("You cannot view this appointment"),
  ctrl.getAppointment,
);

export default router;