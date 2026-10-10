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

/** "in 3 days" / "2 days ago" / "today" */
export const relativeDay = (iso) => {
  if (!iso) return "";
  const target = new Date(`${iso}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 0) return `in ${diff} days`;
  return `${Math.abs(diff)} days ago`;
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

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

export const isPast = (iso, time = "23:59") =>
  new Date(`${iso}T${time}`) < new Date();

/** Merge conditional class names. */
export const cx = (...parts) => parts.filter(Boolean).join(" ").trim();
