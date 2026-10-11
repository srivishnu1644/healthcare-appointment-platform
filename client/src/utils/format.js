/**
 * Formatting + small display helpers shared across pages.
 * Keeping these in one place stops date/time drift between dashboards.
 */

export const currency = (value, code = "INR") => {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `₹${n}`;
  }
};

export const num = (value) => Number(value || 0).toLocaleString("en-IN");

/** "2026-10-05" -> "5 Oct 2026" */
export const formatDate = (iso, opts = {}) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...opts,
  });
};

/** "2026-10-05" -> "Sun, 5 Oct" */
export const formatDay = (iso) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
};

export const weekdayShort = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { weekday: "short" });
};

export const dayNum = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getDate());
};

/**
 * "2026-10-05" -> "Oct"
 *
 * Added so date chips do not have to chop `formatDay()` up with
 * `.split(" ")[2]`, which silently breaks if the locale format ever changes.
 */
export const monthShort = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { month: "short" });
};

/** "09:00" -> "9:00 AM" */
export const formatTime = (hhmm) => {
  if (!hhmm) return "—";
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m || 0).padStart(2, "0")} ${period}`;
};

/** ISO timestamp -> "3 Oct, 4:20 PM" */
export const formatDateTime = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  })}, ${formatTime(
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
      2,
      "0",
    )}`,
  )}`;
};

/**
 * "YYYY-MM-DD" as UTC midnight.
 *
 * Both sides of a day-count are pinned to UTC so a daylight-saving transition
 * cannot make a "day" 23 or 25 hours long and shift the result by one. The
 * inputs are plain calendar dates, so no timezone is being smuggled in — this
 * is only a safe ruler for measuring the gap between two of them.
 */
const utcMidnight = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return Date.UTC(y || 1970, (m || 1) - 1, d || 1);
};

/** Whole days from `fromISO` to `toISO`; negative when `toISO` is earlier. */
export const calendarDaysBetween = (fromISO, toISO) =>
  Math.round((utcMidnight(toISO) - utcMidnight(fromISO)) / 86400000);

/** "in 3 days" / "2 days ago" / "today" */
export const relativeDay = (iso) => {
  if (!iso) return "";
  const diff = calendarDaysBetween(todayISO(), iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 0) return `in ${diff} days`;
  return `${Math.abs(diff)} days ago`;
};

/**
 * Today's calendar date as "YYYY-MM-DD", in the *browser's* timezone.
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is the date in
 * **UTC**. That is wrong for every user whose day is not UTC: at 00:30 in India
 * (UTC+5:30) it returns yesterday, so appointments were filed under the wrong
 * day and the check-in button disappeared for the first five and a half hours of
 * the morning. `toISOString()` is only correct for someone sitting on the
 * Greenwich meridian.
 *
 * The local getters are used instead, so the answer always agrees with the
 * clock on the wall in front of the user.
 *
 * Note this is a *display* concern. Whether an appointment is upcoming is
 * decided by comparing `startsAt` to the current instant (see
 * `utils/appointments.js`), never by comparing calendar dates.
 */
export const todayISO = () => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

/** Initials for the avatar fallback: "Dr. Ananya Rao" -> "AR" */
export const initials = (name = "") => {
  const cleaned = String(name)
    .replace(/^dr\.?\s+/i, "")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

export const titleCase = (s = "") =>
  String(s)
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** "in-progress" -> "In Progress" */
export const label = (s = "") => titleCase(String(s).replace(/-/g, " "));

/** Deterministic pastel colour from any string (avatar fallback). */
export const colorFrom = (seed = "") => {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const palette = [
    "#2563eb",
    "#7c3aed",
    "#059669",
    "#dc2626",
    "#d97706",
    "#0891b2",
    "#db2777",
    "#4f46e5",
  ];
  return palette[Math.abs(hash) % palette.length];
};

/**
 * Whether a wall-clock time on a given calendar date has passed.
 *
 * NOT for appointment timing. It compares two strings the clinic and the browser
 * each rendered in their own timezone, which is the class of bug that made
 * `todayISO` return yesterday during the first hours of an IST user's day.
 * Whether an appointment has started is `hasStarted()` in utils/appointments.js,
 * which compares absolute instants via the server's `startsAt`.
 *
 * Kept for genuinely textual cases (a clinic opening time, say).
 */
export const isPast = (iso, time = "23:59") =>
  new Date(`${iso}T${time}`) < new Date();

/** Merge conditional class names. */
export const cx = (...parts) => parts.filter(Boolean).join(" ").trim();
