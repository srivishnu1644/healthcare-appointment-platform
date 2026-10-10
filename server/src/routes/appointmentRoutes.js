import { Router } from "express";
import * as ctrl from "../controllers/appointmentController.js";
import {
  requireAuth,
  requireRole,
  requireAppointmentAccess,
} from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

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
router.get("/queue", ctrl.liveQueue);
router.get("/availability", ctrl.availabilitySummary);

router.get("/", ctrl.listAppointments);
router.get(
  "/:id",
  requireAppointmentAccess("You cannot view this appointment"),
  ctrl.getAppointment,
);

export default router;