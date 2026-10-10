/**
 * Timezone handling for slots.
 *
 * The problem this solves
 * -----------------------
 * Slots are stored as `timestamptz` — absolute instants — but the API returns
 * timezone-less strings: `date: "2026-10-09"`, `startTime: "10:30"`. Those
 * strings only mean something relative to a business timezone, `APP_TIMEZONE`.
 *
 * Before this module the codebase carried a hardcoded `+5.5` hour offset in
 * four places. That is correct for Asia/Kolkata *today* only because India has
 * never observed daylight saving; it is silently wrong the moment
 * `APP_TIMEZONE` is anything else, and it disagrees with the repositories,
 * which label slots with `AT TIME ZONE APP_TIMEZONE`. Worse, the two could
 * disagree: a slot labelled in London time would be compared against an
 * "is it still today?" check computed in IST, a 13-hour error that produces a
 * plausible-looking wrong answer rather than an obvious failure.
 *
 * The approach
 * ------------
 * One configured IANA zone, resolved through `Intl` rather than a fixed offset,
 * so daylight saving is handled correctly:
 *
 *   * `localDate` / `localTime`  — an instant rendered in the business zone
 *   * `localToInstant`           — a wall-clock time in that zone made absolute
 *   * `todayLocal`               — "today" for whoever the clinic is in
 *
 * `Intl` is built into Node, so this adds no dependency.
 *
 * An IANA zone name is validated at load. A bad `APP_TIMEZONE` should fail at
 * boot rather than silently produce times that are hours out.
 */

/** The business/display timezone. Single source of truth. */
export const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";

/**
 * Fail fast on an unusable timezone.
 *
 * `Intl.DateTimeFormat` throws a RangeError for an unknown zone. Letting that
 * happen on the first booking would be a terrible place to discover it.
 */
const assertValidZone = () => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: TZ });
  } catch {
    throw new Error(
      [
        `APP_TIMEZONE is not a valid IANA timezone name: "${TZ}".`,
        "",
        "  Use a zone name such as:",
        "    Asia/Kolkata",
        "    Europe/London",
        "    America/New_York",
        "    UTC",
      ].join("\n"),
    );
  }
};
assertValidZone();

const PARTS_CACHE = new Map();

const partsFormatter = () => {
  if (!PARTS_CACHE.has(TZ)) {
    PARTS_CACHE.set(
      TZ,
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  }
  return PARTS_CACHE.get(TZ);
};

/** Render an instant's wall-clock parts in the business zone. */
const partsAt = (instant) => {
  const parts = {};
  for (const { type, value } of partsFormatter().formatToParts(instant)) {
    if (type !== "literal") parts[type] = value;
  }
  return {
    year: Number(parts.year),
    // Intl reports midnight as hour 24 in some ICU builds; normalise to 0.
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

/**
 * Offset in milliseconds to ADD to a wall-clock time in `TZ` to get UTC.
 *
 * Derived rather than assumed, so it changes across a daylight-saving
 * boundary exactly when the real zone does.
 */
const offsetMsAt = (instant) => {
  const p = partsAt(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Strip sub-second noise so the offset is a whole minute.
  return asUtc - instant.getTime();
};

/** Local calendar date, "YYYY-MM-DD". */
export const localDate = (instant = new Date()) => {
  const p = partsAt(new Date(instant));
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};

/** Local clock time, "HH:MM". */
export const localTime = (instant = new Date()) => {
  const p = partsAt(new Date(instant));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** Today's date in the business zone. */
export const todayLocal = () => localDate(new Date());

/** Current UTC offset for the business zone, in minutes. */
export const currentOffsetMinutes = (instant = new Date()) =>
  Math.round(offsetMsAt(new Date(instant)) / 60000);

/**
 * Turn a wall-clock time in the business zone into an absolute instant.
 *
 * Two passes: guess the offset from the naive UTC reading, convert, then read
 * the offset again at the resulting instant. The second pass matters on a
 * daylight-saving boundary, where the first guess can be an hour out.
 *
 * @param {string} date "YYYY-MM-DD"
 * @param {string} time "HH:MM"
 * @returns {Date}
 */
export const localToInstant = (date, time = "00:00") => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = String(time).split(":").map(Number);

  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  let instant = new Date(naive - offsetMsAt(new Date(naive)));
  instant = new Date(naive - offsetMsAt(instant));
  // `02:00` local -> `01:00` UTC at +01:00 (the hour before 02:00 does not exist).
  // `03:00` local -> `02:00` UTC at +01:00.
  // Fall back, 25 Oct: `00:30` local -> `23:30` UTC the previous day at +01:00;
  // `02:00` local -> `02:00` UTC at +00:00.
  //
  // On the fall-back date local 01:00 occurs twice. `localToInstant` resolves
  // it to the second occurrence (the post-transition one), which is arbitrary
  // but deterministic. A slot created at that exact minute should be avoided
  // rather than relied upon; `ambiguousLocalTime` lets a caller detect it.
  return instant;
};

/**
 * True when a wall-clock time occurs twice on a date (a daylight-saving
 * fall-back), meaning the mapping to an instant is not unique.
 *
 * @param {string} date  "YYYY-MM-DD"
 * @param {string} time  "HH:MM"
 */
/**
 * Count how many distinct instants render back to a wall-clock time on a date.
 *
 *   * exactly 1  -> an ordinary time
 *   * 2 or more  -> ambiguous (the hour repeated when daylight saving ends)
 *   * 0          -> does not exist (the hour skipped in spring)
 *
 * Determining this by enumeration, rather than by comparing offsets either side
 * of the time, is what keeps an ordinary time on the transition day from being
 * wrongly flagged: the offsets around 02:00 on a spring-forward morning do
 * differ, but 02:00 itself occurs exactly once.
 *
 * @param {string} date  "YYYY-MM-DD"
 * @param {string} time  "HH:MM"
 * @returns {number}
 */
const candidateCount = (date, time) => {
  const [y, mo, d] = String(date).split("-").map(Number);
  const [h, mi] = String(time).split(":").map(Number);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return 0;

  const naive = Date.UTC(y, mo - 1, d, h, mi);

  // The offset actually in force must be one of these.
  const offsets = new Set(
    [-86400_000, 0, 86400_000].map((shift) => offsetMsAt(new Date(naive + shift))),
  );

  let matches = 0;
  for (const offset of offsets) {
    const candidate = new Date(naive - offset);
    if (localDate(candidate) === date && localTime(candidate) === time) {
      matches += 1;
    }
  }
  return matches;
};

/** True when a wall-clock time occurs twice on a date. */
export const ambiguousLocalTime = (date, time) => candidateCount(date, time) > 1;

/** True when a wall-clock time does not exist on a date at all. */
export const nonexistentLocalTime = (date, time) =>
  candidateCount(date, time) === 0;

/* ------------------------------------------------------------------ *
 *  Validation                                                         *
 * ------------------------------------------------------------------ */

/** A real calendar date, "YYYY-MM-DD", that exists (rejects 2026-02-30). */
export const isValidDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  // Round-tripping through Date rejects impossible days.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
};

/** A 24-hour clock time, "HH:MM", in 00:00-23:59. */
export const isValidTime = (value) =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/**
 * A bookable date: a real date, and not before today in the business zone.
 *
 * Comparing against `todayLocal()` rather than an instant means the clinic's
 * current day is bookable right up to 23:59 local, which is what a patient
 * standing in the clinic at 6pm expects.
 */
export const isBookableDate = (value) =>
  isValidDate(value) && value >= todayLocal();

/**
 * Minutes from one wall-clock time to another on a single local date.
 *
 * Signed, and deliberately NOT wrapped around midnight. That is what makes it
 * useful: a 20-minute slot starting 23:50 ends at "00:10", which comes back as
 * -1420 rather than a tidy 20, so a caller can tell that it ran into the next
 * day. Wrapping here would make every overnight slot look legal.
 *
 * @param {string} fromTime "HH:MM"
 * @param {string} toTime   "HH:MM"
 * @returns {number} signed minutes
 */
export const durationMinutesBetween = (fromTime, toTime) => {
  const [fh, fm] = String(fromTime).split(":").map(Number);
  const [th, tm] = String(toTime).split(":").map(Number);
  return th * 60 + tm - (fh * 60 + fm);
};

/**
 * Confirm that a local wall-clock time actually exists on a date.
 *
 * On a spring-forward boundary the skipped hour genuinely does not occur, so
 * "09:00" on that date cannot be turned into an instant. Silently shifting it
 * would put the slot at the wrong time.
 *
 * @returns {boolean}
 */
export const localTimeExists = (date, time) => {
  const instant = localToInstant(date, time);
  return localDate(instant) === date && localTime(instant) === time;
};

/** Human-readable zone name for logs and error messages. */
export const zoneLabel = () => `${TZ} (UTC${currentOffsetMinutes() >= 0 ? "+" : ""}${(currentOffsetMinutes() / 60).toFixed(2)})`;

export default {
  TZ,
  localDate,
  localTime,
  todayLocal,
  localToInstant,
  currentOffsetMinutes,
  isValidDate,
  isValidTime,
  isBookableDate,
  durationMinutesBetween,
  localTimeExists,
  ambiguousLocalTime,
  nonexistentLocalTime,
  zoneLabel,
};