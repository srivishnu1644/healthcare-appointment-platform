/**
 * Appointment predicates and ordering, shared by every patient screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Is this appointment upcoming?" is a question about *time*, and there are two
 * representations of time in an appointment payload:
 *
 *   - `date` + `startTime`  a calendar date and a wall-clock time, both
 *                           rendered by the server in the CLINIC's timezone.
 *   - `startsAt`            an absolute instant (timestamptz).
 *
 * Comparing calendar dates is what made the old `todayISO()` bug possible: the
 * browser's "today" and the clinic's "today" are not the same day for part of
 * the day, and for an IST user between 00:00 and 05:30 `toISOString()` returns
 * yesterday. That misfiled real appointments as past.
 *
 * The rule used everywhere from here on is the one the API itself enforces
 * (Phase 6): `startsAt` is the authority and comparisons are absolute-instant
 * comparisons. Calendar dates remain for *display* (`formatDay`, the date chip,
 * "Today"/"Tomorrow"), which genuinely want a calendar day.
 */

/** Statuses a patient can still act on. Check-in moves one to "in-progress". */
export const LIVE_STATUSES = ["scheduled", "confirmed", "in-progress"];

/** Statuses that will never happen again; used to hide finished rows. */
export const CLOSED_STATUSES = ["cancelled", "completed", "no-show"];

/**
 * The appointment's start as epoch milliseconds, or `null` when it cannot be
 * determined.
 *
 * Prefers `startsAt` because it is unambiguous. Falls back to composing
 * `date` + `startTime`, which is only exactly right when the browser shares the
 * clinic's timezone — the same assumption the rest of the UI already makes when
 * it prints a date.
 */
export const startInstant = (appointment) => {
  if (!appointment) return null;
  const iso = appointment.startsAt;
  if (iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const { date, startTime } = appointment;
  if (!date || !startTime) return null;
  const parsed = Date.parse(
    `${date}T${String(startTime).slice(0, 5)}:00`,
  );
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Has this appointment's slot started?
 *
 * This is the client-side mirror of the server rule `starts_at <= now()`
 * (queueService.hasStarted). The server remains the authority: the button is
 * hidden rather than shown-when-wrong, and the API still refuses a check-in
 * that arrives early.
 *
 * Falls back to true when the start cannot be determined, so a payload missing
 * `startsAt` does not hide the button entirely.
 */
export const hasStarted = (appointment, now = Date.now()) => {
  const start = startInstant(appointment);
  if (start === null) return true;
  return start <= now;
};

/**
 * Should this appointment appear in the "upcoming" bucket?
 *
 * Two conditions, both intentional:
 *   1. the status is still actionable, and
 *   2. the slot has not started yet (`startsAt > now`).
 *
 * A slot that started an hour ago is *not* upcoming even though its calendar
 * date may still be today.
 */
export const isUpcoming = (appointment, now = Date.now()) => {
  if (!LIVE_STATUSES.includes(appointment?.status)) return false;
  const start = startInstant(appointment);
  if (start === null) return false;
  return start > now;
};

/** Can the patient still cancel or reschedule this one? */
export const isActionable = (appointment, now = Date.now()) =>
  LIVE_STATUSES.includes(appointment?.status) && !hasStarted(appointment, now);

/** Chronological: soonest first. Ties break on start time, then id. */
export const byStartAscending = (a, b) => {
  const sa = startInstant(a) ?? Number.MAX_SAFE_INTEGER;
  const sb = startInstant(b) ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return String(a.id).localeCompare(String(b.id));
};

/**
 * Whole minutes since a queue entry joined, or null when it cannot be told.
 *
 * `joinedAt` is an absolute UTC instant, so this is a difference between two
 * instants and is therefore correct in every timezone. Rendering the instant
 * itself is NOT safe here: the browser has no idea what the clinic's timezone
 * is, so a formatted clock reading can be hours out. An elapsed count cannot be.
 *
 * The previous waiting-room preview printed `joinedAt.slice(11, 16)`, which is
 * the UTC time of day and was silently wrong for any clinic outside UTC.
 */
export const minutesSinceJoin = (joinedAt, now = Date.now()) => {
  if (!joinedAt) return null;
  const at = new Date(joinedAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
};

/** "checked in 12 min ago" / "just now" / null when unknown. */
export const joinedAgo = (joinedAt, now = Date.now()) => {
  const mins = minutesSinceJoin(joinedAt, now);
  if (mins === null) return null;
  if (mins < 1) return "just now";
  return `${mins} min ago`;
};

/**
 * Pair each queue entry with the appointment it belongs to.
 *
 * The queue payload carries no appointment time — `queueRepo.listForDoctor`
 * selects `start_time` but `toEntry` drops it — so the time, mode and status are
 * taken from the appointment record the dashboard already fetched. Nothing is
 * computed here: this only joins two server payloads on `appointmentId`.
 *
 * The server's own ordering is preserved exactly; entries are never re-sorted.
 */
export const joinQueueWithAppointments = (entries = [], appointments = []) => {
  const byId = new Map(appointments.map((a) => [a.id, a]));
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    appointment: byId.get(entry.appointmentId) ?? null,
  }));
};

/**
 * Is this slot one the patient is allowed to pick right now?
 *
 * Strict on purpose. `status === "available"` alone is not enough — the booking
 * endpoint refuses a slot that has already started with SLOT_IN_PAST, and a slot
 * whose start cannot be determined cannot be shown to be in the future. Both are
 * excluded rather than offered and then rejected by the server.
 *
 * The server remains the authority: this only decides what is *offered*, never
 * what is allowed. `SLOT_TAKEN` and `PATIENT_CLASH` still come from the API.
 *
 * @param {object} slot  a row from GET /doctors/:id/slots
 * @param {number} [now]
 */
export const isBookableSlot = (slot, now = Date.now()) => {
  if (!slot || slot.status !== "available") return false;
  const start = startInstant(slot);
  return start !== null && start > now;
};

/**
 * Summarise a provider's day from their own appointments.
 *
 * Day membership is a compare against `today` - the clinic's own calendar date,
 * which the API already labels each row with - not a clock read, so a 23:30 IST
 * visit belongs to today even when the browser is still on the previous UTC day.
 * Ordering and "next up" are decided on real instants instead, so a visit that
 * has already begun is never offered as the next one.
 *
 * Pure, so the classification can be exercised against controlled data rather
 * than whatever the seed happened to produce for today.
 *
 * `checkedInIds` should be the appointments that hold an ACTIVE queue entry
 * (`waiting` or `in-consultation`). That is the authoritative record of a check-in:
 * `in-progress` on its own is not, because a provider may also set that status
 * directly without the patient ever having checked in, which would over-count
 * the room. When no set is supplied the appointment status is used instead, and
 * that approximation is reported by `checkedInIsAuthoritative`.
 *
 * @param {object[]} appointments
 * @param {{now?: number, today: string, checkedInIds?: Set<string>}} opts
 */
export const summariseDay = (
  appointments,
  { now = Date.now(), today, checkedInIds } = {},
) => {
  const list = Array.isArray(appointments) ? appointments : [];
  const todays = list.filter((a) => a.date === today);
  const next = list
    .filter((a) => {
      if (!LIVE_STATUSES.includes(a.status)) return false;
      const start = startInstant(a);
      return start !== null && start > now;
    })
    .sort(byStartAscending)[0] ?? null;

  const checkedInIsAuthoritative = checkedInIds instanceof Set;
  const isCheckedIn = checkedInIsAuthoritative
    ? (a) => checkedInIds.has(a.id)
    : (a) => a.status === "in-progress";

  return {
    todayCount: todays.length,
    liveCount: todays.filter((a) => LIVE_STATUSES.includes(a.status)).length,
    todays,
    // Check-in writes a queue entry (queueService.joinQueue) and also moves the
    // appointment to in-progress, so the status alone would also count visits a
    // provider marked in-progress by hand.
    checkedIn: todays.filter(isCheckedIn),
    checkedInIsAuthoritative,
    completed: todays.filter((a) => a.status === "completed"),
    next,
  };
};

/**
 * Split a list into the two buckets the patient screens render.
 *
 * `past` deliberately keeps the order the API returned (newest first) rather
 * than being re-sorted, matching the previous behaviour.
 */
export const splitByTime = (appointments, now = Date.now()) => {
  const list = appointments || [];
  return {
    upcoming: list.filter((a) => isUpcoming(a, now)).sort(byStartAscending),
    past: list.filter((a) => !isUpcoming(a, now)),
  };
};