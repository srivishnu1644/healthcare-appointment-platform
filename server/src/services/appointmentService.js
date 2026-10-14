/**
 * Appointment READ helpers.
 *
 * The state-changing half of this module moved to bookingService.js and
 * queueService.js in Phase 6, because those operations have to run inside a
 * transaction and `withTransaction` does not automatically enlist the pooled
 * `query`/`rows`/`one` helpers - each repository call on a write path has to be
 * handed the transaction handle explicitly. Keeping the reads here and the writes
 * there makes the boundary obvious: anything in this file is safe to call without
 * a transaction, and nothing in it writes.
 *
 * Slot and availability reads delegate to slotService (Phase 5), so there is one
 * place that decides what "bookable" means.
 */
import slotRepo from "../repositories/slotRepo.js";
import queueRepo from "../repositories/queueRepo.js";
import * as time from "../utils/time.js";

/**
 * "Today" in the business timezone, matching how slots are dated.
 *
 * Delegated to utils/time.js rather than shifting the clock by a fixed offset: a
 * fixed +5.5 is right for Asia/Kolkata only because India has never observed
 * daylight saving, and it disagreed with the repositories, which label slots with
 * `AT TIME ZONE APP_TIMEZONE`.
 */
export const todayLocal = () => time.todayLocal();

/** Slots for a doctor, with the Phase 5 filters. */
export const getSlots = (filters) => slotRepo.list(filters);

/** Dates with at least one bookable slot. */
export const availableDates = (doctorId) => slotRepo.availableDates(doctorId);

/** Availability summary for one doctor, optionally for a date. */
export const getAvailabilitySummary = (doctorId, date) =>
  slotRepo.availabilitySummary(doctorId, { date });

/**
 * Estimated wait for a slot: how many patients are ahead of you.
 *
 * Derived from the queue entries rather than a counter, and reported for the
 * slot rather than for an appointment the caller may not hold, so it cannot leak
 * the waiting list.
 */
export const estimateWait = async (slot) => {
  if (!slot) return null;
  const occupancy = await queueRepo.occupancy(slot.id);
  const position = (occupancy?.waiting ?? 0) + 1;
  const ahead = position - 1;
  const perPatient = 15; // average consult duration in minutes
  return {
    queuePosition: position,
    estimatedWaitMinutes: ahead * perPatient,
    estimatedWaitLabel:
      ahead === 0 ? "No wait - you are next" : `~${ahead * perPatient} min wait`,
  };
};

export default {
  getSlots,
  availableDates,
  getAvailabilitySummary,
  estimateWait,
  todayLocal,
};
