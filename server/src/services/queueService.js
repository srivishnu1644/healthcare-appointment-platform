/**
 * The live waiting room.
 *
 * Check-in joins the queue, and does so in one transaction. Two things have to be
 * true together: the entry exists, and the appointment's status reflects that the
 * patient arrived. Before this, `joinQueue` inserted a queue entry and then
 * updated the appointment as separate steps, so a failure between them left a
 * patient sitting in the queue for an appointment still marked "confirmed".
 *
 * THE ROOM
 * One waiting room per (doctor_id, clinic_date). Patients hold separate
 * appointment slots but wait for the same person, so their order comes from when
 * they ARRIVED. Positions are computed with row_number() over the waiting set,
 * never stored: there is no counter to inflate (the Phase 0 finding D-B4) and no
 * compaction to get wrong when someone leaves. The patient in consultation is
 * excluded from the ranking and returned separately.
 *
 * `queue_entries.position` survives as a legacy per-slot number for older
 * readers. It is never used to rank the room.
 *
 * LOCKING CONTRACT (this order, everywhere)
 *   1. the room's advisory lock  - pg_advisory_xact_lock, taken FIRST
 *   2. the appointment row lock
 *   3. the slot row lock
 *
 * Why the advisory lock must come first: it is a single per-room mutex, so it is
 * what makes "the head of the queue" a stable answer. Taken after a row lock it
 * would invert against a path that holds that row lock and wants the room -
 * check-in and call-next would then be able to deadlock each other.
 *
 * Why no deadlock exists, and will not after this:
 *   * EVERY path that touches the room takes the advisory lock before any row
 *     lock. That set is: check-in (joinQueue), call-next (callNext), and
 *     reschedule / cancel / changeStatus in bookingService, each of which moves
 *     or deletes a queue entry;
 *   * so a transaction holding the advisory lock can only ever wait on a row
 *     lock, and no path asks for the advisory lock after holding one;
 *   * booking (bookingService.book) takes the slot lock and never touches the
 *     room at all, so it cannot participate in a cycle;
 *   * two transactions on DIFFERENT rooms use different advisory keys and never
 *     meet.
 *   A cycle would require some path to take a row lock and then the advisory
 *   lock. There is none.
 *
 *   The advisory lock is not merely for deadlock freedom: it is also what makes
 *   a queue mutation and a queue read agree. Without it, `call next` could
 *   promote a patient that a completion was concurrently finishing.
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
  // Read (unlocked) only to learn WHICH ROOM this is, so the room lock can be
  // taken first. This is safe because it cannot change between here and the
  // lock: rescheduling requires an appointment that has NOT started
  // (bookingService.isActionable), and check-in only happens once the slot HAS
  // started. So an appointment that can be checked in cannot move to another
  // slot or another clinic day.
  const preview = await appointmentRepo.findById(appointmentId);
  if (!preview) {
    throw new AppError("Appointment not found", 404, "APPOINTMENT_NOT_FOUND");
  }

  // Read outside the transaction on purpose: `findById` goes to the pool, and a
  // pooled query inside a transaction is refused. This is safe for the same
  // reason as the read above - a slot's start instant is immutable, and the
  // appointment cannot move to another slot before it has started.
  const roomSlot = await slotRepo.findById(preview.slotId);
  const clinicDate = time.localDate(roomSlot?.starts_at);

  const outcome = await withTransaction(async (tx) => {
    // ---- LOCK ORDER: room advisory lock FIRST, then appointment, then slot.
    // See the locking contract at the top of this module.
    await queueRepo.lockRoom(preview.doctorId, clinicDate, tx);

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
 * Which waiting room does this appointment belong to?
 *
 * A POOLED read, deliberately taken outside any transaction: this is how a
 * caller learns the room key so it can take the room's advisory lock FIRST.
 * `lockRoom` must never be reached through a pooled query inside a transaction.
 *
 * The slot cannot change between this read and the lock for the paths that use
 * it: rescheduling requires an appointment that has not started, and every
 * queue mutation here is for one that has.
 *
 * @returns {Promise<{doctorId: string, clinicDate: string}|null>}
 */
export const roomKeyFor = async (appointmentId) => {
  const appointment = await appointmentRepo.findById(appointmentId);
  if (!appointment) return null;
  const slot = await slotRepo.findById(appointment.slotId);
  return {
    doctorId: appointment.doctorId,
    clinicDate: time.localDate(slot?.starts_at),
  };
};

/**
 * One doctor's waiting room for one clinic day.
 *
 * Positions are computed by the repository, so they renumber themselves the
 * moment anyone leaves; nothing here counts, compacts, or stores a rank.
 *
 * @param {string} doctorId
 * @param {string} clinicDate `YYYY-MM-DD` in the clinic's timezone
 */
export const getRoom = async (doctorId, clinicDate) => {
  const entries = await queueRepo.listRoom(doctorId, clinicDate);
  const waiting = entries.filter((e) => e.state === "waiting");
  const activeConsultation = entries.find((e) => e.state === "in-consultation") ?? null;

  return {
    doctorId,
    date: clinicDate,
    clinicDate,
    // `total` counts every entry in the room, including finished visits, so the
    // existing field keeps its meaning.
    total: entries.length,
    waitingCount: waiting.length,
    // Kept for compatibility with the existing response shape.
    waiting: waiting.length,
    averageWaitMinutes: waiting.length ? waiting.length * PER_PATIENT_MINUTES : 0,
    activeConsultation,
    entries,
  };
};

/**
 * Promote the next waiting patient into consultation.
 *
 * Idempotent by design. If someone is already with the doctor, that person IS
 * the answer and is returned unchanged: a doctor who taps "call next" twice, or
 * whose browser retries, must not skip a patient.
 *
 * Concurrency: the room advisory lock is taken first, so two simultaneous
 * requests serialise and the second one finds the consultation already started.
 * The partial unique index on (doctor_id, clinic_date) WHERE state =
 * 'in-consultation' is the database backstop for anything that slips past.
 *
 * Appointment status is deliberately NOT touched here. Check-in already moved it
 * to in-progress, and the lifecycle rules for a visit belong to
 * bookingService, not to the waiting room.
 *
 * @returns {Promise<{entry: object, promoted: boolean}>}
 */
export const callNext = async ({ doctorId, clinicDate }) => {
  const outcome = await withTransaction(async (tx) => {
    // ---- LOCK ORDER: room advisory lock FIRST (see the locking contract).
    await queueRepo.lockRoom(doctorId, clinicDate, tx);

    const active = await queueRepo.findActiveConsultation(doctorId, clinicDate, tx);
    if (active) return { entry: active, promoted: false };

    const head = await queueRepo.headWaiting(doctorId, clinicDate, tx);
    if (!head) {
      throw new AppError("Nobody is waiting in this room", 404, "NO_WAITING_PATIENT");
    }

    try {
      await queueRepo.setState(head.id, "in-consultation", tx);
    } catch (err) {
      // Two transactions cannot both reach here (the advisory lock), but the
      // unique index is the real guarantee. Losing that race is a conflict, not
      // a server fault.
      throw new AppError(
        "Another patient is already in consultation",
        409,
        "QUEUE_BUSY",
      );
    }

    const entry = await queueRepo.findByAppointment(head.appointmentId, tx);
    log.info(`call-next ${doctorId} @ ${clinicDate} -> ${head.patientName}`);
    return { entry, promoted: true };
  });

  return outcome;
};

/**
 * A patient's own position for one appointment, or null if not queued.
 */
export const positionFor = async (appointmentId) => {
  const entry = await queueRepo.findByAppointment(appointmentId);
  if (!entry) return waitFor(null);
  // The patient's real place in the ROOM, computed. The stored per-slot number
  // is always 1 and told someone waiting behind two others that they were next.
  const position = await queueRepo.roomPositionFor(appointmentId);
  return waitFor(position);
};

/**
 * Queue positions for a whole page of appointments, in ONE query.
 *
 * Now the computed room position rather than the stored per-slot number, which
 * was always 1. Same field, honest value: a patient waiting behind two others
 * is told 3.
 *
 * @param {object[]} appointments
 * @returns {Promise<Map<string, {position: number|null, state: string}>>}
 *   appointmentId -> room position and queue state. `position` is set only for a
 *   patient who is waiting; someone in consultation has a state but no number.
 */
export const positionsForAppointments = async (appointments) => {
  const ids = (appointments || []).map((a) => a?.id).filter(Boolean);
  return queueRepo.roomPositionsForAppointments(ids);
};

export default {
  roomKeyFor,
  joinQueue,
  getQueue,
  getRoom,
  callNext,
  positionFor,
  positionsForAppointments,
  hasStarted,
};
