/**
 * The live waiting room.
 *
 * Check-in joins the queue, and does so in one transaction. Two things have to be
 * true together: the entry exists, and the appointment's status reflects that the
 * patient arrived. Before this, `joinQueue` inserted a queue entry and then
 * updated the appointment as separate steps, so a failure between them left a
 * patient sitting in the queue for an appointment still marked "confirmed".
 *
 * Two invariants this module is responsible for:
 *
 *   1. POSITION IS DERIVED, NEVER INCREMENTED. Every position comes from
 *      `max(position) + 1` over the entries actually waiting for that slot. There
 *      is no stored counter to bump, which is what closed the Phase 0 finding
 *      (D-B4) where a patient could inflate their own place by calling check-in
 *      repeatedly.
 *
 *   2. CAPACITY IS HONOURED. `slots.max_queue` existed but nothing read it, so a
 *      waiting room could grow without limit. It is checked here, under the slot
 *      lock, and the unique index on (slot_id, position) is the backstop.
 *
 * Locking the slot row for the whole check-and-insert is what makes the capacity
 * check meaningful: without the lock, two patients arriving at the same moment
 * could both read a count of 2 against a limit of 3 and both be admitted.
 */
import { withTransaction } from "../config/database.js";
import appointmentRepo from "../repositories/appointmentRepo.js";
import slotRepo from "../repositories/slotRepo.js";
import queueRepo from "../repositories/queueRepo.js";
import { AppError } from "../utils/responses.js";
import { withDbErrorMapping } from "../utils/dbErrors.js";
import * as time from "../utils/time.js";
import logger from "../utils/logger.js";

const log = logger.tag("queue");

/** Minutes assumed per consultation, for the wait estimate. */
const PER_PATIENT_MINUTES = 15;

/** Statuses for which an appointment is still open. */
const CLOSED_STATUSES = ["completed", "cancelled", "no-show"];

const waitFor = (position) => {
  if (!position) {
    return { queuePosition: null, estimatedWaitMinutes: 0, estimatedWaitLabel: "Not queued" };
  }
  const ahead = position - 1;
  return {
    queuePosition: position,
    estimatedWaitMinutes: ahead * PER_PATIENT_MINUTES,
    estimatedWaitLabel:
      ahead === 0 ? "No wait - you are next" : `~${ahead * PER_PATIENT_MINUTES} min wait`,
  };
};

/**
 * Has this appointment's slot started yet?
 *
 * The documented rule (Phase 0 finding D-B4, closed by Phase 6):
 *
 *   "joinQueue ... reject future appointments"                    v2-roadmap 6.10
 *   "Check-in on a future appointment -> 400"                     v2-roadmap
 *   "CHECK (appointment.starts_at <= now()) in joinQueue"         migration plan
 *   "Reject unless starts_at <= now()"                            feature matrix
 *
 * All four say the same thing, and it is an INSTANT comparison, not a calendar
 * one. A previous implementation compared local dates - `slot.date === today` -
 * which is looser than the requirement: it admitted a patient at 13:50 for a
 * 14:00 slot, an instant the documents say must be refused.
 *
 * Comparing instants also makes the rule timezone-proof. `starts_at` is a
 * timestamptz, so there is nothing to interpret and no zone can shift the answer.
 * The business zone is still used for anything a human reads, such as naming the
 * time in the error message.
 *
 * Exported and pure so the boundary can be tested exactly, with no dependence on
 * when the test happens to run.
 *
 * @param {string|Date} startsAt
 * @param {number|Date} [now]
 * @returns {boolean} true once the slot has started
 */
export const hasStarted = (startsAt, now = Date.now()) => {
  const start = new Date(startsAt).getTime();
  const reference = new Date(now).getTime();
  if (!Number.isFinite(start)) return false;
  return start <= reference;
};

/**
 * Put a patient into the waiting room for their appointment.
 *
 * Check-in requires that the appointment's slot has already started, per the
 * documents quoted on {@link hasStarted}.
 *
 * Idempotent by design: checking in twice returns the existing position rather
 * than creating a second entry or moving the patient forward.
 *
 * @param {object} input
 * @param {object} input.actor `{ id, role }`
 * @returns {Promise<{appointment: object, queuePosition: number|null,
 *                    estimatedWaitMinutes: number, estimatedWaitLabel: string}>}
 */
export const joinQueue = async ({ actor, appointmentId }) => {
  const outcome = await withTransaction(async (tx) => {
    const appointment = await appointmentRepo.lockById(appointmentId, tx);
    if (!appointment) {
      throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
    }
    if (CLOSED_STATUSES.includes(appointment.status)) {
      throw new AppError("This appointment is closed", 400, "INVALID_STATUS");
    }

    // Lock the slot for the whole capacity check and insert.
    const slot = await slotRepo.lockForUpdate(appointment.slot_id, tx);
    if (!slot) throw new AppError("Slot not found", 404, "SLOT_NOT_FOUND");

    if (slot.status === "blocked") {
      throw new AppError(
        "This appointment has been blocked by the provider",
        400,
        "SLOT_BLOCKED",
      );
    }

    // The instant rule: a slot that has not started yet cannot be joined. Both
    // sides are absolute instants, so the configured zone cannot shift the
    // decision; it is used only to name the time the patient turned up for.
    if (!hasStarted(slot.starts_at)) {
      throw new AppError(
        `This appointment has not started yet (${time.localDate(slot.starts_at)} ` +
          `${time.localTime(slot.starts_at)} ${time.TZ}). You can check in once it begins.`,
        400,
        "SLOT_NOT_STARTED",
      );
    }

    const { entry, created, full } = await withDbErrorMapping(() =>
      queueRepo.join(
        {
          appointmentId,
          slotId: appointment.slot_id,
          doctorId: appointment.doctor_id,
          patientId: appointment.patient_id,
          capacity: slot.max_queue ?? null,
        },
        tx,
      ),
    );

    if (full) {
      throw new AppError(
        "The waiting room for this slot is full",
        409,
        "QUEUE_FULL",
      );
    }
    if (!entry) {
      throw new AppError("Could not join the waiting room", 500, "QUEUE_JOIN_FAILED");
    }

    // Arriving puts the appointment into the waiting room. The schema has no
    // separate "arrived" state, so this reuses in-progress, matching the client,
    // which disables the button and shows "Checked in" once it is set.
    if (appointment.status === "confirmed" || appointment.status === "scheduled") {
      await appointmentRepo.updateFields(appointmentId, { status: "in-progress" }, tx);
      await appointmentRepo.markCheckedIn(appointmentId, tx);
      await appointmentRepo.history.record(
        {
          appointmentId,
          fromStatus: appointment.status,
          toStatus: "in-progress",
          // Recorded so the audit trail shows WHO checked in.
          changedBy: actor?.id ?? null,
          note: "Patient checked in",
        },
        tx,
      );
    }

    const appointmentRow = await appointmentRepo.findById(appointmentId, tx);
    return { appointmentRow, position: entry.position, created };
  });

  if (outcome.created) {
    log.info(
      `check-in ${appointmentId} -> position ${outcome.position} by ${actor?.id ?? "unknown"}`,
    );
  }

  return { appointment: outcome.appointmentRow, ...waitFor(outcome.position) };
};

/**
 * Live queue snapshot for a doctor on a date.
 *
 * Read-only, so no transaction. Positions come from the entries themselves; this
 * endpoint never computes a position from anything else.
 */
export const getQueue = async (doctorId, date) => {
  const entries = await queueRepo.listForDoctor(doctorId, date);
  const waiting = entries.filter((e) => e.state === "waiting");
  return {
    doctorId,
    date,
    total: entries.length,
    waiting: waiting.length,
    averageWaitMinutes: waiting.length ? waiting.length * PER_PATIENT_MINUTES : 0,
    entries,
  };
};

/**
 * A patient's own position for one appointment, or null if not queued.
 */
export const positionFor = async (appointmentId) => {
  const entry = await queueRepo.findByAppointment(appointmentId);
  return entry ? waitFor(entry.position) : waitFor(null);
};

export default { joinQueue, getQueue, positionFor, hasStarted };
