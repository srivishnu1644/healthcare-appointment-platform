import doctorRepo from "../repositories/doctorRepo.js";
import appointmentRepo from "../repositories/appointmentRepo.js";
import { facilities } from "../repositories/referenceRepo.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { resolveAppointmentAccess } from "../middlewares/authMiddleware.js";
import { publicDoctor } from "../utils/projections.js";
import { isValidDate } from "../utils/time.js";
import logger from "../utils/logger.js";
import {
  getSlots,
  availableDates,
  getAvailabilitySummary,
  estimateWait,
} from "../services/appointmentService.js";
// Every state change goes through these, each of which owns exactly one
// transaction. The controller holds no database writes of its own.
import bookingService from "../services/bookingService.js";
import queueService from "../services/queueService.js";

const log = logger.tag("appt-ctrl");

/**
 * Appointment fields safe to return to any caller entitled to see the
 * record. Built from an explicit allow-list rather than by deleting keys,
 * so a future column cannot leak by default.
 */
const publicAppointment = (a) => ({
  id: a.id,
  patientId: a.patientId,
  doctorId: a.doctorId,
  slotId: a.slotId,
  date: a.date,
  startTime: a.startTime,
  endTime: a.endTime,
  mode: a.mode,
  status: a.status,
  reason: a.reason,
  symptoms: a.symptoms,
  fee: a.fee,
  queuePosition: a.queuePosition ?? null,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  cancelledAt: a.cancelledAt ?? null,
  cancelledBy: a.cancelledBy ?? null,
  cancelReason: a.cancelReason ?? null,
  // Added in Phase 6. A lifecycle endpoint that cannot say WHEN a visit was
  // checked into or completed is not reporting the lifecycle, and the repository
  // already selects both columns.
  checkedInAt: a.checkedInAt ?? null,
  completedAt: a.completedAt ?? null,
  // The absolute instant behind the local date/startTime. Added because the
  // client gates the check-in button on whether the slot has STARTED, and a
  // local date cannot answer that: a 14:00 slot is bookable on the same date at
  // 09:00 and at 14:00 with opposite outcomes.
  startsAt: a.startsAt ?? null,
});

/**
 * Display names are re-derived by the repository JOIN rather than stored on
 * the row, so they can never go stale. Kept in the response so the client
 * renders unchanged.
 */
const withNames = (a) => ({
  ...publicAppointment(a),
  patientName: a.patientName,
  doctorName: a.doctorName,
  specialtyName: a.specialtyName,
  facilityName: a.facilityName,
});

/* ------------------------------------------------------------------ *
 *  GET /api/appointments                                            *
 * ------------------------------------------------------------------ */
export const listAppointments = asyncHandler(async (req, res) => {
  const { scope = "mine", status, doctorId, patientId, from, to } = req.query;

  // Scope guards. A patient only ever sees their own; a doctor only their
  // own schedule. `patientId` is honoured solely for admin.
  const filters = { status, doctorId, from, to };

  if (req.user.role === "patient") {
    filters.patientId = req.user.id;
  } else if (req.user.role === "doctor") {
    const me = await doctorRepo.findByUserId(req.user.id);
    filters.doctorId = me?.id;
    if (!me?.id) filters.patientId = "__none__";
  } else if (scope === "mine" && patientId) {
    filters.patientId = patientId;
  } else if (patientId) {
    filters.patientId = patientId;
  }

  const list = await appointmentRepo.list(filters);

  // The caller's own queue position, for the rows that still hold one.
  //
  // One query for the whole page, and only ever attached to appointments this
  // caller is already entitled to see, so it exposes nothing that the scoped
  // list did not already contain. Rows without an active entry keep the
  // existing `queuePosition: null` from the projection — nothing is invented.
  const positions = await queueService.positionsForAppointments(list);

  return sendSuccess(res, {
    appointments: list.map((a) => {
      const queued = positions.get(a.id);
      return {
        ...withNames(a),
        // The place in the LINE. Null for a patient who is in consultation
        // (they are in the room, not in the queue) and for anyone not waiting.
        queuePosition: queued?.position ?? null,
        // Additive, so the client can say "in consultation" rather than
        // showing a blank where a number used to be.
        queueState: queued?.state ?? null,
      };
    }),
    count: list.length,
  });
});

/* ------------------------------------------------------------------ *
 *  GET /api/appointments/:id                                         *
 * ------------------------------------------------------------------ */
export const getAppointment = asyncHandler(async (req, res) => {
  const { appointment, isProvider } = await resolveAppointmentAccess(
    req.user,
    req.params.id,
  );

  const slot = await (await import("../repositories/slotRepo.js")).default.findRawById(
    appointment.slotId,
  );

  return sendSuccess(res, {
    appointment: withNames(appointment),
    doctor: publicDoctor(await doctorRepo.findById(appointment.doctorId)),
    facility: await facilities.findById(appointment.facilityId),
    history: await appointmentRepo.history.forAppointment(appointment.id),
    // Wait information is only meaningful to the parties to the appointment.
    wait:
      isProvider || appointment.patientId === req.user.id
        ? await estimateWait(
            slot ? { id: slot.id, currentQueue: 0 } : null,
          )
        : null,
  });
});

/* ------------------------------------------------------------------ *
 *  POST /api/appointments                                            *
 * ------------------------------------------------------------------ */
export const createAppointment = asyncHandler(async (req, res) => {
  const { doctorId, slotId, reason, symptoms, mode } = req.body;

  // `mode` is accepted so an obviously invalid value is still rejected with a
  // clear message, but it is NOT trusted: the stored mode comes from the slot,
  // because that is what actually determines whether the visit is in person or
  // by video. A client asking for a different mode is asking for a different
  // slot, and bookingService ignores the request body here.
  const appointment = await bookingService.book({
    actor: req.user,
    patientId: req.user.id,
    doctorId,
    slotId,
    reason,
    symptoms,
    mode,
  });

  return sendSuccess(
    res,
    { appointment: withNames(appointment) },
    "Appointment booked",
    201,
  );
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/appointments/:id/reschedule                            *
 * ------------------------------------------------------------------ */
export const reschedule = asyncHandler(async (req, res) => {
  const { slotId, note } = req.body;
  // `requireAppointmentAccess` has already refused anyone who is not the owner,
  // the assigned doctor, or an admin. Re-checking here would be a second read of
  // the same row for no additional protection.
  const { appointment } = await resolveAppointmentAccess(req.user, req.params.id);

  const updated = await bookingService.reschedule({
    actor: req.user,
    appointmentId: appointment.id,
    newSlotId: slotId,
    note,
  });

  return sendSuccess(
    res,
    { appointment: withNames(updated) },
    "Appointment rescheduled",
  );
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/appointments/:id/cancel                                *
 * ------------------------------------------------------------------ */
export const cancel = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const { appointment } = await resolveAppointmentAccess(req.user, req.params.id);

  // `cancelled_by` is derived from the AUTHENTICATED role inside the service, not
  // from the caller's claim. Previously the controller computed it here and the
  // status endpoint hardcoded "provider", so a cancellation could be attributed to
  // the wrong person.
  const updated = await bookingService.cancel({
    actor: req.user,
    appointmentId: appointment.id,
    reason,
  });

  return sendSuccess(
    res,
    { appointment: withNames(updated) },
    "Appointment cancelled",
  );
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/appointments/:id/status                                *
 * ------------------------------------------------------------------ */
export const changeStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;

  if (req.user.role === "patient") {
    throw new AppError(
      "Patients cannot change appointment status directly",
      403,
      "FORBIDDEN",
    );
  }

  // A doctor may only change the status of their own appointments; admins
  // may change any.
  const { appointment, isProvider, isAdmin } = await resolveAppointmentAccess(
    req.user,
    req.params.id,
  );

  if (!isProvider && !isAdmin) {
    throw new AppError(
      "You can only update appointments assigned to you",
      403,
      "FORBIDDEN",
    );
  }

  // `cancelled` is handled inside the service by delegating to the canonical
  // cancel path, so the slot is released and the audit fields are stamped the
  // same way whichever endpoint is used. The notification is enqueued inside that
  // transaction rather than fired separately here.
  const updated = await bookingService.changeStatus({
    actor: req.user,
    appointmentId: appointment.id,
    nextStatus: status,
    note,
  });

  log.info(`status ${appointment.id} -> ${status}`);
  return sendSuccess(
    res,
    { appointment: withNames(updated) },
    "Status updated",
  );
});

/* ------------------------------------------------------------------ *
 *  POST /api/appointments/:id/check-in                               *
 * ------------------------------------------------------------------ */
export const checkIn = asyncHandler(async (req, res) => {
  const { appointment, isOwner, isProvider, isAdmin } = await resolveAppointmentAccess(
    req.user,
    req.params.id,
  );

  if (!isOwner && !isProvider && !isAdmin) {
    throw new AppError(
      "You cannot check in to this appointment",
      403,
      "FORBIDDEN",
    );
  }

  const result = await queueService.joinQueue({
    actor: req.user,
    appointmentId: appointment.id,
  });

  return sendSuccess(
    res,
    { ...result, appointment: withNames(result.appointment) },
    "Checked in to the queue",
  );
});

/* ------------------------------------------------------------------ *
 *  Queue                                                             *
 * ------------------------------------------------------------------ */
export const liveQueue = asyncHandler(async (req, res) => {
  const { doctorId, date } = req.query;
  if (!doctorId)
    throw new AppError("doctorId is required", 400, "MISSING_DOCTOR");

  // Validated as a REAL day, not merely as the right number of digits and dashes.
  //
  // The shape-only check that used to be here let 2026-02-31 through, and it then
  // reached a `::date` cast deep in the queue query. PostgreSQL raised
  // "date/time field value out of range" and the caller received a 500 for a
  // mistyped query parameter.
  if (date !== undefined && !isValidDate(date)) {
    throw new AppError(
      "date must be a real calendar date (YYYY-MM-DD)",
      400,
      "INVALID_DATE",
    );
  }

  let resolvedDate = date;
  if (!resolvedDate) {
    const slots = await getSlots({ doctorId });
    resolvedDate = slots.find((s) => s.status !== "blocked")?.date;
  }

  // A clinic date names a real waiting ROOM (doctor_id, clinic_date), so the
  // room view is used whenever a date is known. `getQueue` remains for the
  // undated path, where there is no room to scope to.
  const room =
    resolvedDate && isValidDate(resolvedDate)
      ? await queueService.getRoom(doctorId, resolvedDate)
      : await queueService.getQueue(doctorId, resolvedDate);
  const queue = room;

  // The waiting list exposes patient names, so it is scoped: a doctor sees
  // their own queue, an admin sees any. Everyone else sees only their own
  // entry.
  const me = await doctorRepo.findByUserId(req.user.id);
  const isAssignedDoctor = req.user.role === "doctor" && me?.id === doctorId;

  if (req.user.role === "admin" || isAssignedDoctor) return sendSuccess(res, queue);

  // A patient can hold MORE THAN ONE entry in the same room over a clinic day -
  // a finished visit is kept in the room as history, and a repeat booking for the
  // same doctor adds a second - so "their" entry has to be chosen rather than
  // taken as the first row that matches. Taking the first returned a completed
  // visit from earlier in the day, which reported a null place in the line for a
  // patient who was in fact waiting.
  //
  // Priority: whoever is in consultation, then the most recently joined live
  // entry, then the most recent entry of any state. That is what the patient is
  // asking about in every case.
  const candidates = queue.entries.filter((e) => e.patientId === req.user.id);
  const newestFirst = (list) =>
    [...list].sort((a, b) => String(b.joinedAt).localeCompare(String(a.joinedAt)));
  const mine =
    candidates.find((e) => e.state === "in-consultation") ??
    newestFirst(candidates.filter((e) => e.state === "waiting"))[0] ??
    newestFirst(candidates)[0] ??
    null;

  // A patient sees themselves and nothing else. The doctor-facing fields
  // (`total`, `activeConsultation`, other patients' positions) describe the
  // room, which is the provider's information, so none of it is included here.
  const self = mine
    ? {
        id: mine.id,
        slotId: mine.slotId,
        appointmentId: mine.appointmentId,
        // The caller's OWN id, which they already know. Included so a client can
        // confirm the row is theirs; it exposes nobody else's.
        patientId: mine.patientId,
        state: mine.state,
        joinedAt: mine.joinedAt,
        // `roomPosition`, the SAME key the provider view uses. Naming it
        // `position` here would hand a patient the legacy per-slot number under
        // the name the room model gives the computed one, and for every row
        // after the first the two disagree.
        roomPosition: mine.roomPosition ?? null,
      }
    : null;

  return sendSuccess(res, {
    doctorId,
    date: resolvedDate,
    clinicDate: resolvedDate,
    entries: self ? [self] : [],
    activeConsultation: null,
    // No `waitingCount` here, even a caller-scoped one. The name reads as a room
    // total, and a field that means "just you" while looking like "the room" is
    // the kind of thing that gets misread by the next caller. The client's own
    // row carries the state, which is the only fact that is theirs.
    self,
  });
});

/**
 * Call the next patient in this doctor's waiting room.
 *
 * Idempotent: while someone is in consultation, calling again returns that same
 * patient rather than advancing the queue, so a double click, a retry, or two
 * browsers cannot skip anyone.
 */
export const callNext = asyncHandler(async (req, res) => {
  const { doctorId, date } = req.body ?? {};

  if (!doctorId) throw new AppError("doctorId is required", 400, "MISSING_DOCTOR");
  // `isValidDate`, not a shape regex: 2026-02-31 has the right SHAPE and no day
  // behind it, and it used to become a 500 from the clinic_date cast in the queue
  // query. Missing and malformed answer with different codes so a caller can tell
  // a typo from an omitted field.
  if (!date) {
    throw new AppError("date must be YYYY-MM-DD", 400, "MISSING_DATE");
  }
  if (!isValidDate(date)) {
    throw new AppError(
      "date must be a real calendar date (YYYY-MM-DD)",
      400,
      "INVALID_DATE",
    );
  }

  // Only the provider this room belongs to (or an admin) may advance it. A
  // patient asking for someone else's waiting room is refused outright rather
  // than quietly scoped, because unlike a read there is nothing here for them.
  const me = await doctorRepo.findByUserId(req.user.id);
  const isAssignedDoctor = req.user.role === "doctor" && me?.id === doctorId;
  if (!isAssignedDoctor && req.user.role !== "admin") {
    throw new AppError("You cannot call patients in this waiting room", 403, "FORBIDDEN");
  }

  const result = await queueService.callNext({ doctorId, clinicDate: date });
  const appointment = await appointmentRepo.findById(result.entry.appointmentId);
  const room = await queueService.getRoom(doctorId, date);

  return sendSuccess(
    res,
    {
      promoted: result.promoted,
      entry: result.entry,
      appointment,
      position: result.entry.roomPosition ?? null,
      activeConsultation: room.activeConsultation,
      waitingCount: room.waitingCount,
      entries: room.entries,
    },
    result.promoted ? "Called the next patient" : "That patient is already in consultation",
  );
});

export const availabilitySummary = asyncHandler(async (req, res) => {
  const { doctorId, date } = req.query;
  if (!doctorId)
    throw new AppError("doctorId is required", 400, "MISSING_DOCTOR");
  return sendSuccess(res, await getAvailabilitySummary(doctorId, date));
});

export { getSlots, availableDates };