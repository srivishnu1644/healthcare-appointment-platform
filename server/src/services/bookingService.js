/**
 * Appointment booking and lifecycle.
 *
 * Every state-changing operation here runs inside ONE `withTransaction`. That is
 * the whole point of this module: before Phase 6 these were sequences of
 * independent writes, so any failure in the middle left the system inconsistent.
 * Concretely, `bookAppointment` used to do, in order and without a transaction:
 *
 *     setStatus(slot, 'booked')   <- slot now looks taken
 *     insert appointment          <- if THIS failed, the slot stayed 'booked'
 *     record status history
 *     send notifications
 *
 * A failure at step 2 therefore produced a slot that no patient could book and no
 * appointment referencing it - invisible to the user, and never repaired. The
 * same shape existed in cancel (slot released before the appointment was marked
 * cancelled) and reschedule (old slot released before the new one was claimed, so
 * a failure lost the booking entirely).
 *
 * Ordering inside the transaction
 * -------------------------------
 * Locks are always taken before any decision is made, and the order is consistent
 * (appointment, then slot) so two concurrent lifecycle operations cannot deadlock
 * by grabbing the same two rows in opposite orders.
 *
 * Concurrency
 * -----------
 * The database is the authority. `appointments_one_active_per_slot` and
 * `appointments_patient_no_overlap` mean a double booking is unrepresentable
 * regardless of what this file believes. The row locks and conditional writes
 * here exist so that the *loser* of a race gets a precise 409 instead of a
 * constraint error surfacing as a 500, and so the loser does not do pointless
 * work. utils/dbErrors maps the constraint violation itself to the same code, so
 * correctness does not depend on the lock being taken at all.
 *
 * Notifications
 * -------------
 * Rendered and persisted INSIDE the transaction (so the message cannot be lost),
 * but delivered afterwards. External delivery failing must not roll back a
 * committed booking, so no network call ever happens while a transaction is open.
 */
import { withTransaction } from "../config/database.js";
import slotRepo from "../repositories/slotRepo.js";
import appointmentRepo from "../repositories/appointmentRepo.js";
import queueRepo from "../repositories/queueRepo.js";
import doctorRepo from "../repositories/doctorRepo.js";
import userRepo from "../repositories/userRepo.js";
import { facilities } from "../repositories/referenceRepo.js";
import { AppError } from "../utils/responses.js";
import { withDbErrorMapping } from "../utils/dbErrors.js";
import { enqueueNotifications, deliverNotification } from "./notificationService.js";
import { roomKeyFor } from "./queueService.js";
import * as time from "../utils/time.js";
import logger from "../utils/logger.js";

const log = logger.tag("booking");

/** Statuses that still occupy their slot. */
const ACTIVE_STATUSES = ["scheduled", "confirmed", "in-progress"];

/** Statuses that can no longer change. */
const CLOSED_STATUSES = ["completed", "cancelled", "no-show"];

/**
 * The legal status transitions.
 *
 * Single source of truth for the whole application. Previously this table lived
 * in `updateStatus` while `cancelAppointment` had its own separate checks, so two
 * code paths could disagree about whether a transition was legal. `cancel()` is
 * now reachable through `changeStatus`, so this table governs every path.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  scheduled: ["confirmed", "in-progress", "cancelled", "no-show"],
  confirmed: ["in-progress", "cancelled", "no-show"],
  "in-progress": ["completed", "cancelled", "no-show"],
  completed: [],
  cancelled: [],
  "no-show": [],
});

/** Which roles may perform each transition. */
const TRANSITION_ROLES = {
  "in-progress": ["doctor", "admin", "patient"],
  confirmed: ["doctor", "admin"],
  completed: ["doctor", "admin"],
  "no-show": ["doctor", "admin"],
  cancelled: ["doctor", "admin", "patient"],
};

/**
 * A slot is bookable only if its local date has not passed.
 *
 * Date-based rather than instant-based: a clinic's current day stays bookable
 * right up to 23:59 local, which is what a patient standing in reception at 6pm
 * expects. Phase 5 established that this comparison happens in the configured
 * business zone rather than against a fixed UTC offset.
 */
const assertBookableDate = (date, instant) => {
  if (time.isBookableDate(date)) return;
  throw new AppError(
    "That appointment date has already passed. Please pick an upcoming slot.",
    400,
    "SLOT_IN_PAST",
  );
};

/* ------------------------------------------------------------------ *
 *  Shared validation                                                  *
 * ------------------------------------------------------------------ */

/**
 * Read and validate a slot inside the transaction, holding a row lock on it.
 *
 * Every check that decides whether a booking may proceed runs against this
 * locked row, so the decision is made from committed state rather than from
 * whatever was true when the request started.
 *
 * @param {string} slotId
 * @param {object} tx
 * @param {object} [opts]
 * @param {boolean} [opts.requireAvailable] false when releasing or moving away
 * @returns {Promise<object>} the locked slot row
 */
const lockBookableSlot = async (slotId, tx, { requireAvailable = true } = {}) => {
  const slot = await slotRepo.lockForUpdate(slotId, tx);
  if (!slot) {
    throw new AppError("Selected slot no longer exists", 404, "SLOT_NOT_FOUND");
  }

  // The slot row's own status can disagree with reality if an older code path set
  // it without creating an appointment, so the appointment table is checked too
  // rather than trusting the flag.
  const active = await appointmentRepo.findActiveForSlot(slotId, tx);
  if (active) {
    throw new AppError(
      "This slot was just taken. Please pick another time.",
      409,
      "SLOT_TAKEN",
    );
  }

  if (slot.status === "blocked") {
    throw new AppError("This slot is blocked by the provider", 400, "SLOT_BLOCKED");
  }
  if (requireAvailable && slot.status !== "available") {
    throw new AppError(
      "This slot was just taken. Please pick another time.",
      409,
      "SLOT_TAKEN",
    );
  }

  assertBookableDate(slot.date, slot.starts_at);
  return slot;
};

/* ------------------------------------------------------------------ *
 *  Book                                                               *
 * ------------------------------------------------------------------ */

/**
 * Book an appointment.
 *
 * One transaction covering: slot claim, appointment insert, status history,
 * queue cleanup and the notification intent. Any failure rolls all of it back,
 * so the slot is never left marked booked for an appointment that does not exist.
 *
 * Trust boundaries
 * ----------------
 *   * `doctor_id` is DERIVED FROM THE SLOT, never taken from the request body. A
 *     caller naming a different doctor gets SLOT_MISMATCH rather than an
 *     appointment attached to the wrong doctor.
 *   * `mode` comes from the SLOT. A consultation is in-person or video because
 *     the slot is; letting the client assert it would let a patient book an
 *     in-person slot and store it as a video visit.
 *   * `fee` is the slot's price, falling back to the doctor's published fee. It
 *     is a snapshot of what was agreed at booking time.
 *
 * @param {object} input
 * @param {object} input.actor  `{ id, role }` from requireAuth
 * @returns {Promise<object>} the booked appointment
 */
export const book = async ({
  actor,
  patientId,
  doctorId: requestedDoctorId,
  slotId,
  reason,
  symptoms,
  mode: _ignoredMode,
}) => {
  if (actor.role !== "patient") {
    throw new AppError(
      "Only a patient can book an appointment",
      403,
      "FORBIDDEN",
    );
  }

  const outcome = await withTransaction(async (tx) => {
    const slot = await lockBookableSlot(slotId, tx);

    // The slot is the authority on who this appointment is with.
    const slotDoctorId = slot.doctor_id;
    if (requestedDoctorId && requestedDoctorId !== slotDoctorId) {
      throw new AppError(
        "That slot does not belong to this doctor",
        400,
        "SLOT_MISMATCH",
      );
    }

    const [doctor, patient] = await Promise.all([
      doctorRepo.findById(slotDoctorId, tx),
      userRepo.findById(patientId, tx),
    ]);
    if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");
    if (!patient) throw new AppError("Account not found", 404, "USER_NOT_FOUND");

    // Courtesy check so the user gets a clear message. The exclusion constraint
    // is the authority and raises the same PATIENT_CLASH if this is missed.
    const clash = await appointmentRepo.findPatientClash(
      patientId,
      slot.starts_at,
      slot.ends_at,
      tx,
    );
    if (clash) {
      throw new AppError(
        "You already have an appointment at this time",
        409,
        "PATIENT_CLASH",
      );
    }

    // Conditional claim: succeeds only if the slot is still offered. Inside the
    // transaction, having locked the row, this cannot lose a race; it is the
    // belt to the unique index's braces.
    const claimed = await slotRepo.claimIfAvailable(slotId, tx);
    if (!claimed) {
      throw new AppError(
        "This slot was just taken. Please pick another time.",
        409,
        "SLOT_TAKEN",
      );
    }

    const appointmentId = await withDbErrorMapping(() =>
      appointmentRepo.insert(
        {
          patientId,
          doctorId: slotDoctorId,
          slotId,
          specialtyId: doctor.specialty,
          facilityId: slot.facility_id ?? doctor.facilityId,
          mode: slot.mode,
          status: "confirmed",
          reason: reason || "General consultation",
          symptoms: symptoms || null,
          fee: slot.fee ?? doctor.consultationFee ?? null,
          startsAt: slot.starts_at,
          endsAt: slot.ends_at,
        },
        tx,
      ),
    );

    await appointmentRepo.history.record(
      {
        appointmentId,
        fromStatus: null,
        toStatus: "confirmed",
        changedBy: actor.id,
        note: reason || "General consultation",
      },
      tx,
    );

    // A stale queue entry for this appointment would misreport its position.
    await queueRepo.clearForAppointment(appointmentId, tx);

    const facility = await facilities.findById(slot.facility_id ?? doctor.facilityId, tx);
    const queued = await enqueueNotifications({
      event: "appointment_booked",
      // The template renders `date` and `startTime`, so the appointment has to
      // carry them: passing only id/patientName/fee produced "confirmed for
      // undefined at undefined". The values come from the slot row already
      // locked above, which derives them in the business timezone, so the
      // message states the same time the booking did. Nothing extra is read or
      // written, and the transaction boundary is unchanged.
      appointment: {
        id: appointmentId,
        patientName: patient.name,
        fee: slot.fee,
        date: slot.date,
        startTime: slot.start_time,
        facilityName: facility?.name ?? undefined,
      },
      doctor,
      facility,
      patient: { id: patientId, name: patient.name, phone: patient.phone, email: patient.email },
      tx,
    });

    return { appointmentId, queued };
  });

  // Committed. Only now may anything leave the process.
  const appointment = await appointmentRepo.findById(outcome.appointmentId);
  for (const q of outcome.queued) {
    await deliverNotification(q.id);
  }

  log.info(
    `booked ${outcome.appointmentId} | ${appointment.doctorName} | ${appointment.date} ${appointment.startTime}`,
  );
  return appointment;
};

/* ------------------------------------------------------------------ *
 *  Reschedule                                                         *
 * ------------------------------------------------------------------ */

/**
 * Move an appointment to a different slot.
 *
 * One transaction: validate the target, release the old slot, claim the new one,
 * move the appointment, record history. The lock order is old appointment, then
 * new slot, then old slot, so two simultaneous reschedules of the same
 * appointment queue behind each other instead of deadlocking.
 *
 * The appointment is RE-PRICED from the new slot, because the patient is agreeing
 * to a different slot and that slot may carry a different fee. The mode is taken
 * from the new slot for the same reason.
 *
 * @param {object} input
 * @param {string} input.actorRole the actor's role, for the audit trail
 */
export const reschedule = async ({
  actor,
  appointmentId,
  newSlotId,
  note = null,
}) => {
  // ---- LOCK ORDER: the room's advisory lock FIRST, then the appointment row.
  // Rescheduling, cancelling and changing status all touch the waiting room
  // (they move or delete a queue entry). Taking only the appointment lock here
  // would let `call next` promote an entry that one of these is concurrently
  // finishing. The room key is read from the pool on purpose, BEFORE the
  // transaction opens, because a pooled query inside one is refused.
  const room = await roomKeyFor(appointmentId);

  const outcome = await withTransaction(async (tx) => {
    if (room) await queueRepo.lockRoom(room.doctorId, room.clinicDate, tx);
    const appointment = await appointmentRepo.lockById(appointmentId, tx);
    if (!appointment) {
      throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
    }
    if (CLOSED_STATUSES.includes(appointment.status)) {
      throw new AppError(
        `Cannot reschedule a ${appointment.status} appointment`,
        400,
        "INVALID_STATUS",
      );
    }

    const previous = {
      date: time.localDate(appointment.starts_at),
      startTime: time.localTime(appointment.starts_at),
    };

    // Refuse a no-op before taking a second lock.
    if (newSlotId === appointment.slot_id) {
      throw new AppError(
        "That is already the booked slot",
        400,
        "SLOT_UNCHANGED",
      );
    }

    const newSlot = await lockBookableSlot(newSlotId, tx);
    if (newSlot.doctor_id !== appointment.doctor_id) {
      throw new AppError(
        "New slot belongs to a different doctor",
        400,
        "SLOT_MISMATCH",
      );
    }

    const claimed = await slotRepo.claimIfAvailable(newSlotId, tx);
    if (!claimed) {
      throw new AppError("That slot is already taken", 409, "SLOT_TAKEN");
    }

    // Release the old slot only after the new one is secured, so a failure here
    // leaves the original booking intact rather than dropping it.
    await slotRepo.release(appointment.slot_id, "available", tx);

    await withDbErrorMapping(() =>
      appointmentRepo.reschedule(
        appointmentId,
        {
          slotId: newSlotId,
          startsAt: newSlot.starts_at,
          endsAt: newSlot.ends_at,
          mode: newSlot.mode,
          fee: newSlot.fee,
        },
        tx,
      ),
    );

    // A queue entry is tied to a slot, so moving the appointment invalidates it.
    await queueRepo.clearForAppointment(appointmentId, tx);

    await appointmentRepo.history.record(
      {
        appointmentId,
        fromStatus: appointment.status,
        toStatus: "confirmed",
        changedBy: actor?.id ?? null,
        note: note || `Rescheduled from ${previous.date} ${previous.startTime}`,
      },
      tx,
    );

    const updated = await appointmentRepo.findById(appointmentId, tx);
    const doctor = await doctorRepo.findById(appointment.doctor_id, tx);
    const facility = await facilities.findById(updated.facilityId, tx);
    const queued = await enqueueNotifications({
      event: "appointment_rescheduled",
      appointment: updated,
      doctor,
      facility,
      patient: { id: updated.patientId, name: updated.patientName },
      reason: note,
      previous,
      tx,
    });

    return { appointmentId, queued, previous };
  });

  const updated = await appointmentRepo.findById(outcome.appointmentId);
  for (const q of outcome.queued) await deliverNotification(q.id);

  log.info(
    `rescheduled ${outcome.appointmentId} from ${outcome.previous.date} ${outcome.previous.startTime} by ${actor?.email ?? actor?.role ?? "unknown"}`,
  );
  return updated;
};

/* ------------------------------------------------------------------ *
 *  Cancel                                                             *
 * ------------------------------------------------------------------ */

/**
 * Cancel an appointment.
 *
 * This is the ONLY path that produces a cancelled appointment. `changeStatus`
 * delegates here for `cancelled`, which removes the old bug where cancelling via
 * PATCH /:id/status recorded `cancelled_by = 'provider'` no matter who actually
 * cancelled, and skipped the slot release on some paths.
 *
 * One transaction: release the slot, clear queue entries, mark cancelled with its
 * audit fields, record history.
 */
export const cancel = async ({ actor, appointmentId, reason = null }) => {
  // ---- LOCK ORDER: the room's advisory lock FIRST, then the appointment row.
  // Rescheduling, cancelling and changing status all touch the waiting room
  // (they move or delete a queue entry). Taking only the appointment lock here
  // would let `call next` promote an entry that one of these is concurrently
  // finishing. The room key is read from the pool on purpose, BEFORE the
  // transaction opens, because a pooled query inside one is refused.
  const room = await roomKeyFor(appointmentId);

  const outcome = await withTransaction(async (tx) => {
    if (room) await queueRepo.lockRoom(room.doctorId, room.clinicDate, tx);
    const appointment = await appointmentRepo.lockById(appointmentId, tx);
    if (!appointment) {
      throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
    }
    if (appointment.status === "cancelled") {
      throw new AppError("Already cancelled", 400, "ALREADY_CANCELLED");
    }
    if (appointment.status === "completed") {
      throw new AppError(
        "Completed visits cannot be cancelled",
        400,
        "INVALID_STATUS",
      );
    }

    // Slot released first: a cancelled appointment frees its slot, and if the
    // transaction fails the slot is still marked booked, which is consistent
    // because the appointment is still active.
    await slotRepo.release(appointment.slot_id, "available", tx);
    await queueRepo.clearForAppointment(appointmentId, tx);

    const actorRole =
      actor?.role === "admin" ? "admin" : actor?.role === "doctor" ? "provider" : "patient";

    const updated = await appointmentRepo.markCancelled(
      appointmentId,
      {
        reason:
          reason ||
          (actorRole === "provider"
            ? "Cancelled by provider"
            : actorRole === "admin"
              ? "Cancelled by admin"
              : "Cancelled by patient"),
        actorRole,
      },
      tx,
    );

    await appointmentRepo.history.record(
      {
        appointmentId,
        fromStatus: appointment.status,
        toStatus: "cancelled",
        changedBy: actor?.id ?? null,
        note: reason ?? null,
      },
      tx,
    );

    const doctor = await doctorRepo.findById(appointment.doctor_id, tx);
    const facility = await facilities.findById(updated.facilityId, tx);
    const queued = await enqueueNotifications({
      event: "appointment_cancelled",
      appointment: updated,
      doctor,
      facility,
      patient: { id: updated.patientId, name: updated.patientName },
      reason: updated.cancelReason,
      tx,
    });

    return { appointmentId, queued };
  });

  const updated = await appointmentRepo.findById(outcome.appointmentId);
  for (const q of outcome.queued) await deliverNotification(q.id);

  log.info(`cancelled ${outcome.appointmentId} by ${actor?.role ?? "unknown"}`);
  return updated;
};

/* ------------------------------------------------------------------ *
 *  Status machine                                                     *
 * ------------------------------------------------------------------ */

/**
 * Apply a status transition.
 *
 * The transition table above is the only place legality is decided, and
 * `cancelled` is delegated to `cancel()` so there is exactly one implementation
 * of "cancelling releases the slot".
 *
 * @param {object} input
 * @param {string} input.actorRole
 * @returns {Promise<object>} the updated appointment
 */
export const changeStatus = async ({
  actor,
  appointmentId,
  nextStatus,
  note = null,
  reason = null,
}) => {
  // Cancelling has side effects beyond a status write, so it goes through the one
  // canonical path rather than being reimplemented here.
  if (nextStatus === "cancelled") {
    return cancel({ actor, appointmentId, reason: reason ?? note });
  }

  const allowedRoles = TRANSITION_ROLES[nextStatus];
  if (allowedRoles && actor?.role && !allowedRoles.includes(actor.role)) {
    throw new AppError(
      `Your role cannot mark an appointment "${nextStatus}"`,
      403,
      "FORBIDDEN",
    );
  }

  // ---- LOCK ORDER: the room's advisory lock FIRST, then the appointment row.
  // Rescheduling, cancelling and changing status all touch the waiting room
  // (they move or delete a queue entry). Taking only the appointment lock here
  // would let `call next` promote an entry that one of these is concurrently
  // finishing. The room key is read from the pool on purpose, BEFORE the
  // transaction opens, because a pooled query inside one is refused.
  const room = await roomKeyFor(appointmentId);

  const outcome = await withTransaction(async (tx) => {
    if (room) await queueRepo.lockRoom(room.doctorId, room.clinicDate, tx);
    const appointment = await appointmentRepo.lockById(appointmentId, tx);
    if (!appointment) {
      throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
    }

    const allowed = ALLOWED_TRANSITIONS[appointment.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new AppError(
        `Cannot move from ${appointment.status} to ${nextStatus}`,
        400,
        "INVALID_TRANSITION",
        { from: appointment.status, to: nextStatus, allowed },
      );
    }

    await appointmentRepo.updateFields(appointmentId, { status: nextStatus }, tx);

    if (nextStatus === "completed") {
      await appointmentRepo.markCompleted(appointmentId, tx);
      // The visit is over, so the slot returns to the pool and the queue entry is
      // finished rather than left "waiting" forever.
      await slotRepo.release(appointment.slot_id, "available", tx);
      const entry = await queueRepo.findByAppointment(appointmentId, tx);
      if (entry) await queueRepo.setState(entry.id, "completed", tx);
    }

    if (nextStatus === "no-show") {
      await slotRepo.release(appointment.slot_id, "available", tx);
      // A no-show is a record worth keeping: the patient was in the room and
      // then was not there, which is different from never arriving. `left` is
      // a state this enum already had and nothing ever wrote. A patient who
      // never checked in has no entry, so this is a no-op for them.
      //
      // Cancellation still removes the entry (clearForAppointment). That is
      // existing behaviour and is deliberately left alone.
      await queueRepo.markLeftForAppointment(appointmentId, tx);
    }

    await appointmentRepo.history.record(
      {
        appointmentId,
        fromStatus: appointment.status,
        toStatus: nextStatus,
        changedBy: actor?.id ?? null,
        note,
      },
      tx,
    );

    const updated = await appointmentRepo.findById(appointmentId, tx);
    const doctor = await doctorRepo.findById(appointment.doctor_id, tx);
    const facility = await facilities.findById(updated.facilityId, tx);
    const queued = await enqueueNotifications({
      event: "status_update",
      appointment: updated,
      doctor,
      facility,
      patient: { id: updated.patientId, name: updated.patientName },
      status: nextStatus,
      tx,
    });

    return { appointmentId, queued };
  });

  const updated = await appointmentRepo.findById(outcome.appointmentId);
  for (const q of outcome.queued) await deliverNotification(q.id);
  return updated;
};

export { ACTIVE_STATUSES, CLOSED_STATUSES };
export default {
  book,
  reschedule,
  cancel,
  changeStatus,
  ALLOWED_TRANSITIONS,
};
