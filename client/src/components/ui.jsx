import { useState } from "react";
import { cx, initials } from "../utils/format";
import { doctorPhotoUrl } from "../utils/doctorPhotos.js";

/* ------------------------------------------------------------------ *
 *  Badge — status pill                                              *
 * ------------------------------------------------------------------ */
const STATUS_TONE = {
  scheduled: "brand",
  confirmed: "success",
  completed: "success",
  "in-progress": "info",
  cancelled: "danger",
  "no-show": "warning",
  available: "success",
  blocked: "gray",
  booked: "brand",
  checkedin: "info",
  urgent: "danger",
  emergency: "danger",
  routine: "success",
  high: "warning",
  moderate: "brand",
  low: "success",
  sent: "success",
  simulated: "gray",
  failed: "danger",
  pending: "warning",
};

export function StatusBadge({ status, children, className }) {
  const tone = STATUS_TONE[status] || "gray";
  return (
    <span
      className={cx("badge", tone !== "gray" && `badge-${tone}`, className)}
    >
      {children ?? (status ? String(status).replace(/-/g, " ") : "—")}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 *  Avatar — initials on a colour derived from the name             *
 * ------------------------------------------------------------------ */
export function Avatar({ name, color, size = "", className }) {
  return (
    <span
      className={cx("avatar", size && `avatar-${size}`, className)}
      style={{ background: color || undefined }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 *  DoctorPhoto — portrait with an initials fallback                *
 *                                                                    *
 *  The photo is decorative, never the identity: if the remote image   *
 *  fails (offline, blocked, removed upstream) the initials avatar    *
 *  renders instead, so the UI never shows a broken image.            *
 * ------------------------------------------------------------------ */
export function DoctorPhoto({ doctor, size = "", className, width = 256 }) {
  const [failed, setFailed] = useState(false);
  const src = doctorPhotoUrl(doctor, width);
  if (!src || failed) {
    return (
      <Avatar
        name={doctor?.name}
        color={doctor?.imageColor}
        size={size}
        className={className}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cx("avatar", size && `avatar-${size}`, className)}
      style={{ objectFit: "cover" }}
      title={doctor?.name}
    />
  );
}

/* ------------------------------------------------------------------ *
 *  Empty state                                                       *
 * ------------------------------------------------------------------ */
export function EmptyState({ icon = "📭", title, message, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      {title && <h4 style={{ marginBottom: "0.25rem" }}>{title}</h4>}
      {message && <p className="small">{message}</p>}
      {action && <div style={{ marginTop: "0.9rem" }}>{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Loading states                                                    *
 * ------------------------------------------------------------------ */
export function Spinner({ large }) {
  return <span className={cx("spinner", large && "spinner-lg")} />;
}

export function Loading({ label: text = "Loading…" }) {
  return (
    <div className="loading-full">
      <Spinner large />
      <span className="small">{text}</span>
    </div>
  );
}

export function SkeletonCard({ height = 120 }) {
  return <div className="skeleton" style={{ height }} />;
}

export function SkeletonList({ rows = 3, height = 44 }) {
  return (
    <div className="stack-sm">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Stat tile                                                         *
 * ------------------------------------------------------------------ */
export function Stat({ label: text, value, sub, tone }) {
  return (
    <div className="stat">
      <div className="stat-label">{text}</div>
      <div
        className="stat-value"
        style={tone ? { color: `var(--${tone})` } : undefined}
      >
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Progress bar                                                      *
 * ------------------------------------------------------------------ */
export function ProgressBar({ value = 0, tone }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="bar">
      <div
        className={cx("bar-fill", tone && `bar-fill-${tone}`)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Modal                                                             *
 * ------------------------------------------------------------------ *
 *  `variant="solid"` swaps the frosted panel for an opaque one and deepens
 *  the scrim behind it. It exists for the Reschedule dialog, which is a
 *  long list of small time buttons: on a translucent panel the page behind
 *  showed through the gaps between them and made the selected time hard to
 *  tell from the unselected ones. Opt-in, so the rest of the app keeps the
 *  shared glass treatment.
 * ------------------------------------------------------------------ */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size,
  variant,
}) {
  if (!open) return null;

  // Close on backdrop click + Escape.
  const onKey = (e) => {
    if (e.key === "Escape") onClose?.();
  };

  return (
    <div
      className={cx(
        "modal-backdrop",
        variant === "solid" && "modal-backdrop-solid",
      )}
      onClick={onClose}
      onKeyDown={onKey}
      role="presentation"
    >
      <div
        className={cx(
          "modal",
          size === "lg" && "modal-lg",
          variant === "solid" && "modal-solid",
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Tabs                                                              *
 * ------------------------------------------------------------------ */
export function Tabs({ tabs, active, onChange, className }) {
  return (
    <div className={cx("tabs", className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          className={cx("tab", active === t.key && "tab-active")}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="badge" style={{ marginLeft: "0.4rem" }}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Alert                                                             *
 * ------------------------------------------------------------------ */
export function Alert({ tone = "info", title, children }) {
  const icon = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    danger: "⛔",
  }[tone];
  return (
    <div className={`alert alert-${tone}`}>
      <span aria-hidden="true">{icon}</span>
      <div style={{ flex: 1 }}>
        {title && <strong style={{ display: "block" }}>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export default {
  StatusBadge,
  Avatar,
  DoctorPhoto,
  EmptyState,
  Spinner,
  Loading,
  SkeletonCard,
  SkeletonList,
  Stat,
  ProgressBar,
  Modal,
  Tabs,
  Alert,
};
