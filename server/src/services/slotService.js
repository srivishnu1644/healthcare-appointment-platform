/**
 * Slot management.
 *
 * Booking is untouched and lives in services/appointmentService.js. What is here
 * is everything around a slot: reading availability, and the provider-facing
 * create/update operations.
 *
 * Where validation lives
 * ----------------------
 * All of it, in one place, because these rules are interlocking:
 *
 *   * a slot's start and end must be real local times on a real date, and the
 *     end must follow the start;
 *   * a wall-clock time must actually exist on that date (spring-forward skips
 *     an hour);
 *   * the range must lie in the future, otherwise the slot is junk in every
 *     availability view;
 *   * a doctor may only touch their own slots;
 *   * a facility must belong to that doctor's record, since a slot's facility is
 *     not free-form.
 *
 * Overlap between a doctor's slots is *not* checked here. The database decides,
 * via `slots_no_doctor_overlap`, and this service translates the rejection into
 * a clear error. Duplicating that rule in application code would create two
 * sources of truth that could disagree.
 */
import slotRepo from "../repositories/slotRepo.js";
import doctorRepo from "../repositories/doctorRepo.js";
import { AppError } from "../utils/responses.js";
import {
  localToInstant,
  isValidDate,
  isValidTime,
  isBookableDate,
  durationMinutesBetween,
  nonexistentLocalTime,
  localTime,
  todayLocal,
} from "../utils/time.js";
import logger from "../utils/logger.js";

const log = logger.tag("slots");

/** Longest single appointment the schema allows, in minutes. */
const MAX_DURATION_MIN = 480;

/** Ceiling on how many slots one request may create. */
const MAX_SLOTS_PER_REQUEST = 100;

/** Add minutes to an "HH:MM" string. */
const addMinutes = (hhmm, minutes) => {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ *
 *  Reading                                                            *
 * ------------------------------------------------------------------ */

/**
 * Parse a `from` / `to` query value into an instant.
 *
 * Accepts a date (`2026-10-09` meaning 00:00 local) or a clock time
 * (`09:00`, resolved against `fromDate` or today). Anything else is rejected
 * rather than guessed, because a misread range silently returns the wrong slots.
 */
const resolveBoundary = (value, fallbackDate, isEnd = false) => {
  if (!value) return null;

  if (isValidDate(value)) {
    return localToInstant(value, isEnd ? "23:59" : "00:00");
  }
  if (isValidTime(value)) {
    return localToInstant(fallbackDate ?? todayLocal(), value);
  }
  throw new AppError(
    `"${value}" is not a valid date (YYYY-MM-DD) or time (HH:MM)`,
    400,
    "INVALID_DATE_RANGE",
  );
};

/**
 * List slots for a doctor.
 *
 * @param {object} query
 * @param {number} [query.limit]
 * @param {number} [query.offset]
 */
export const listSlots = async (query = {}) => {
  const doctor = await doctorRepo.findById(query.doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  // A date narrows the range, so the clock-time boundaries resolve against it
  // rather than against today.
  const baseDate = query.date ?? todayLocal();
  const from = resolveBoundary(query.from, baseDate, false);
  const to = resolveBoundary(query.to, baseDate, true);

  if (from && to && from > to) {
    throw new AppError(
      "The start of the range is after its end",
      400,
      "INVALID_DATE_RANGE",
    );
  }

  const filters = {
    doctorId: doctor.id,
    date: query.date,
    from,
    to,
    mode: query.mode,
    status: query.status,
    futureOnly: query.futureOnly,
  };

  const [slots, total] = await Promise.all([
    slotRepo.list({ ...filters, limit: query.limit, offset: query.offset }),
    slotRepo.countMatching(filters),
  ]);

  return { doctor, slots, total, limit: query.limit ?? null };
};

/**
 * One slot, with the doctor's and facility's names.
 *
 * The slot must belong to the doctor in the path, so a valid slot id cannot be
 * read through a mismatched doctor URL.
 */
export const slotDetail = async (doctorId, slotId) => {
  const slot = await slotRepo.findById(slotId);
  if (!slot || slot.doctorId !== doctorId) {
    throw new AppError("Slot not found", 404, "SLOT_NOT_FOUND");
  }
  return slot;
};

/** Dates with at least one bookable slot. */
export const listAvailableDates = async (doctorId, { mode } = {}) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");
  return slotRepo.availableDates(doctor.id, { mode });
};

/** Availability summary for a doctor. */
export const availabilitySummary = async (doctorId, { date, from, to, mode } = {}) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const baseDate = date ?? todayLocal();
  return slotRepo.availabilitySummary(doctor.id, {
    date,
    from: from ? resolveBoundary(from, baseDate, false) : undefined,
    to: to ? resolveBoundary(to, baseDate, true) : undefined,
    mode,
  });
};

/**
 * Availability day by day across a range, for a booking calendar.
 *
 * Each row counts every slot that falls on that date and reports how many are
 * still bookable, which is the same split availabilitySummary() uses for a single
 * date. `futureOnly` is not exposed here on purpose: asking for a range already
 * starts from a date, so whole-day totals are what the calendar needs.
 */
export const availabilityRange = async (doctorId, { from, days = 14, mode } = {}) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const fromInstant = from
    ? resolveBoundary(from, todayLocal(), false)
    : new Date();

  return slotRepo.availabilityByDate(doctor.id, { from: fromInstant, days, mode });
};

/* ------------------------------------------------------------------ *
 *  Create                                                             *
 * ------------------------------------------------------------------ */

/**
 * Validate one requested slot and turn it into instants.
 *
 * @throws {AppError} with a message naming the offending time
 */
const buildCandidate = (date, time, { duration, mode, fee, maxQueue }) => {
  if (!isValidDate(date)) {
    throw new AppError(`"${date}" is not a valid date`, 400, "INVALID_DATE");
  }
  if (!isValidTime(time)) {
    throw new AppError(`"${time}" is not a valid time (HH:MM)`, 400, "INVALID_TIME");
  }
  if (!isBookableDate(date)) {
    throw new AppError(
      "Slots cannot be created for a date in the past",
      400,
      "SLOT_IN_PAST",
    );
  }
  // On a spring-forward date the skipped hour genuinely does not exist.
  if (nonexistentLocalTime(date, time)) {
    throw new AppError(
      `${time} does not exist on ${date} in this timezone (daylight saving)`,
      400,
      "NONEXISTENT_LOCAL_TIME",
    );
  }

  const minutes = durationMinutesBetween(time, addMinutes(time, duration));
  if (minutes !== duration) {
    // duration crossed midnight; the slot would end on the next day.
    throw new AppError(
      `A ${duration}-minute slot starting at ${time} would end on the following day`,
      400,
      "INVALID_TIME_RANGE",
    );
  }

  return {
    startsAt: localToInstant(date, time),
    endsAt: localToInstant(date, addMinutes(time, duration)),
    mode,
    fee,
    maxQueue,
    localDate: date,
    localTime: time,
    localEndTime: localTime(localToInstant(date, addMinutes(time, duration))),
  };
};

/**
 * Create slots for a doctor.
 *
 * @param {object} input
 * @param {object} input.actor   `{ id, role }` from requireAuth
 * @returns {Promise<object>} counts and the created slots
 */
export const createSlots = async ({
  actor,
  doctorId,
  date,
  times,
  duration = 30,
  mode = "in-person",
  fee,
  maxQueue = 3,
}) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  // A provider may only manage their own calendar. An admin may manage any.
  if (actor.role === "doctor") {
    const me = await doctorRepo.findByUserId(actor.id);
    if (!me || me.id !== doctor.id) {
      throw new AppError(
        "You can only manage your own schedule",
        403,
        "FORBIDDEN",
      );
    }
  } else if (actor.role !== "admin") {
    throw new AppError("Not permitted to manage slots", 403, "FORBIDDEN");
  }

  if (!Array.isArray(times) || times.length === 0) {
    throw new AppError("times must be a non-empty array", 400, "MISSING_TIMES");
  }
  if (times.length > MAX_SLOTS_PER_REQUEST) {
    throw new AppError(
      `At most ${MAX_SLOTS_PER_REQUEST} slots can be created at once`,
      400,
      "TOO_MANY_SLOTS",
    );
  }

  const boundedDuration = Number(duration);
  if (!Number.isFinite(boundedDuration) || boundedDuration < 5 || boundedDuration > MAX_DURATION_MIN) {
    throw new AppError(
      `duration must be between 5 and ${MAX_DURATION_MIN} minutes`,
      400,
      "INVALID_DURATION",
    );
  }

  const boundedMaxQueue = Number(maxQueue);
  if (!Number.isInteger(boundedMaxQueue) || boundedMaxQueue < 1) {
    throw new AppError("maxQueue must be a positive integer", 400, "INVALID_MAX_QUEUE");
  }

  // Validate every time before writing anything, so a request is all-or-nothing
  // with respect to *validation*; overlaps are then reported per slot.
  const seen = new Set();
  const candidates = [];
  for (const raw of times) {
    const time = String(raw).trim();
    const candidate = buildCandidate(date, time, {
      duration: boundedDuration,
      mode,
      fee: fee === undefined || fee === null ? doctor.consultationFee : Number(fee),
      maxQueue: boundedMaxQueue,
    });
    // Two identical times in one request would collide with each other.
    if (seen.has(candidate.startsAt.toISOString())) continue;
    seen.add(candidate.startsAt.toISOString());
    candidates.push(candidate);
  }

  if (!candidates.length) {
    throw new AppError("No valid times to create", 400, "MISSING_TIMES");
  }

  const { created, skipped, errors } = await slotRepo.insertMany(
    doctor.id,
    doctor.facilityId,
    candidates,
  );

  if (errors.length) {
    log.warn(`slot creation reported ${errors.length} error(s) for ${doctor.id}`);
  }

  log.info(
    `${created.length} slot(s) created for ${doctor.name} on ${date} ` +
      `(${skipped.length} skipped)`,
  );

  return {
    created: created.map((c) => ({
      id: c.id,
      date: c.localDate,
      startTime: c.localTime,
      endTime: c.localEndTime,
      mode: c.mode,
    })),
    createdCount: created.length,
    skipped,
    errors,
  };
};

/* ------------------------------------------------------------------ *
 *  Update                                                             *
 * ------------------------------------------------------------------ */

/** Status values a provider is allowed to set. */
const PROVIDER_STATUSES = ["available", "blocked"];

/**
 * Update a slot.
 *
 * A provider may set availability and mode on their own slots. An admin may do
 * the same plus the fee. Neither may move the slot's time or reassign it, so a
 * published slot cannot be shifted under an existing booking.
 */
export const updateSlot = async ({ actor, doctorId, slotId, patch }) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  const slot = await slotRepo.findById(slotId);
  if (!slot || slot.doctorId !== doctor.id) {
    throw new AppError("Slot not found", 404, "SLOT_NOT_FOUND");
  }

  if (actor.role === "doctor") {
    const me = await doctorRepo.findByUserId(actor.id);
    if (!me || me.id !== doctor.id) {
      throw new AppError(
        "You can only manage your own slots",
        403,
        "FORBIDDEN",
      );
    }
  } else if (actor.role !== "admin") {
    throw new AppError("Not permitted to manage slots", 403, "FORBIDDEN");
  }

  const clean = {};

  if (patch.status !== undefined) {
    if (!PROVIDER_STATUSES.includes(patch.status)) {
      throw new AppError(
        `status must be one of: ${PROVIDER_STATUSES.join(", ")}`,
        400,
        "INVALID_STATUS",
      );
    }
    // A provider blocking their own slot is fine; a provider re-opening a slot
    // that already has an appointment would publish a second patient into it.
    clean.status = patch.status;
  }

  if (patch.mode !== undefined) {
    if (!["in-person", "video"].includes(patch.mode)) {
      throw new AppError(
        "mode must be one of: in-person, video",
        400,
        "INVALID_MODE",
      );
    }
    clean.mode = patch.mode;
  }

  // Fee is an admin-only field: a provider changing their own price is a
  // commercial decision, not a scheduling one.
  if (patch.fee !== undefined) {
    if (actor.role !== "admin") {
      throw new AppError(
        "Only an administrator can change a slot price",
        403,
        "FORBIDDEN",
      );
    }
    const value = Number(patch.fee);
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError("fee must be a non-negative number", 400, "INVALID_FEE");
    }
    clean.fee = value;
  }

  if (patch.maxQueue !== undefined) {
    if (actor.role !== "admin") {
      throw new AppError(
        "Only an administrator can change the queue capacity",
        403,
        "FORBIDDEN",
      );
    }
    const value = Number(patch.maxQueue);
    if (!Number.isInteger(value) || value < 1) {
      throw new AppError(
        "maxQueue must be a positive integer",
        400,
        "INVALID_MAX_QUEUE",
      );
    }
    clean.maxQueue = value;
  }

  if (!Object.keys(clean).length) {
    throw new AppError("No updatable fields supplied", 400, "EMPTY_PATCH");
  }

  const updated = await slotRepo.update(slotId, clean);
  if (!updated) throw new AppError("Slot not found", 404, "SLOT_NOT_FOUND");

  log.info(`slot ${slotId} updated by ${actor.role} (${Object.keys(clean).join(", ")})`);
  return updated;
};

/* ------------------------------------------------------------------ *
 *  Delete                                                              *
 * ------------------------------------------------------------------ */

/**
 * Remove published slots.
 *
 * WHY DELETE EXISTS AT ALL, WHEN `blocked` ALREADY HIDES A SLOT
 * Blocking is the reversible half of this: the row stays, patients stop seeing
 * it, and it comes back with one click. Deleting is for the slots a provider
 * never meant to publish — a duplicate created by mistake, a whole afternoon
 * left behind by a cancelled clinic — where keeping a row nobody will ever open
 * is just noise in their own schedule.
 *
 * The line between them is `appointments.slot_id`, which is ON DELETE RESTRICT.
 * A slot that has ever been booked cannot be removed, cancelled or not, because
 * that row is the record of a visit. So this is not the same rule as "is
 * booked": `slot.isBooked` is false for a slot whose only appointment was
 * cancelled, and that slot is still undeletable. The client is given
 * `isDeletable` for exactly this reason.
 *
 * The whole request is refused rather than partly applied. Deleting three of
 * five slots because the other two are load-bearing is a worse outcome than
 * deleting none and saying which two are the problem.
 *
 * @param {object} input.actor    `{ id, role }` from requireAuth
 * @param {string} input.doctorId
 * @param {string[]} input.slotIds
 * @returns {Promise<{deletedCount: number, deleted: object[]}>}
 */
export const deleteSlots = async ({ actor, doctorId, slotIds }) => {
  const doctor = await doctorRepo.findById(doctorId);
  if (!doctor) throw new AppError("Doctor not found", 404, "DOCTOR_NOT_FOUND");

  // Same ownership rule as `updateSlot`: a provider manages only their own
  // calendar, an admin may manage any.
  if (actor.role === "doctor") {
    const me = await doctorRepo.findByUserId(actor.id);
    if (!me || me.id !== doctor.id) {
      throw new AppError(
        "You can only manage your own schedule",
        403,
        "FORBIDDEN",
      );
    }
  } else if (actor.role !== "admin") {
    throw new AppError("Not permitted to manage slots", 403, "FORBIDDEN");
  }

  if (!Array.isArray(slotIds) || slotIds.length === 0) {
    throw new AppError(
      "slotIds must be a non-empty array",
      400,
      "MISSING_SLOT_IDS",
    );
  }
  if (slotIds.length > MAX_SLOTS_PER_REQUEST) {
    throw new AppError(
      `At most ${MAX_SLOTS_PER_REQUEST} slots can be deleted at once`,
      400,
      "TOO_MANY_SLOTS",
    );
  }

  // The validator describes an array but cannot describe its elements, so the
  // id shape is checked here — before anything is interpolated into SQL.
  const ids = [...new Set(slotIds.map((id) => String(id).trim()))].filter(
    Boolean,
  );
  if (!ids.length) {
    throw new AppError("slotIds must be a non-empty array", 400, "MISSING_SLOT_IDS");
  }
  const malformed = ids.filter((id) => id.length > 64);
  if (malformed.length) {
    throw new AppError(
      `Not a slot id: ${malformed.slice(0, 3).join(", ")}`,
      400,
      "INVALID_SLOT_ID",
    );
  }

  // Checked before the delete, so a refusal leaves nothing changed.
  const blocked = await slotRepo.findUndeletable(doctor.id, ids);
  if (blocked.length) {
    const named = blocked
      .map((s) => `${s.date} ${s.local_time}`)
      .join(", ");
    throw new AppError(
      blocked.length === 1
        ? `The slot at ${named} has an appointment against it and cannot be ` +
            `deleted. Cancel the appointment first.`
        : `${blocked.length} of those slots have appointments against them and ` +
            `cannot be deleted (${named}). Cancel the appointments first.`,
      409,
      "SLOT_HAS_APPOINTMENT",
    );
  }

  const deleted = await slotRepo.deleteByIds(doctor.id, ids);

  // Ids that were not this doctor's, or never existed, are simply absent from
  // the result. They are not an error: the request asked for slots to be gone,
  // and they are gone. Saying so keeps a stale UI from reporting a failure for
  // a slot someone else already removed.
  if (deleted.length !== ids.length) {
    log.warn(
      `delete requested ${ids.length} slot(s) for ${doctor.id}, removed ` +
        `${deleted.length}`,
    );
  }

  log.info(
    `${deleted.length} slot(s) deleted for ${doctor.name} by ${actor.role}`,
  );

  return {
    deletedCount: deleted.length,
    deleted: deleted.map((s) => ({
      id: s.id,
      date: s.date,
      startTime: s.local_time,
    })),
  };
};

export default {
  listSlots,
  slotDetail,
  listAvailableDates,
  availabilitySummary,
  availabilityRange,
  createSlots,
  updateSlot,
  deleteSlots,
};