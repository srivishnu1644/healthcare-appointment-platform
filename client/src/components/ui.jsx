import { cx, initials } from "../utils/format";

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
 * ------------------------------------------------------------------ */
export function Modal({ open, onClose, title, children, footer, size }) {
  if (!open) return null;

  // Close on backdrop click + Escape.
  const onKey = (e) => {
    if (e.key === "Escape") onClose?.();
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={onKey}
      role="presentation"
    >
      <div
        className={cx("modal", size === "lg" && "modal-lg")}
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
