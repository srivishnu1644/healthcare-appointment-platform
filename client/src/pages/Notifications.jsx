import { EmptyState, Loading, StatusBadge, Alert } from "../components/ui.jsx";
import useNotifications from "../hooks/useNotifications.js";
import { formatDateTime, cx } from "../utils/format";

const EVENT_ICON = {
  booked: "✅",
  confirmed: "✅",
  reminder: "⏰",
  rescheduled: "🔄",
  cancelled: "❌",
  completed: "🎉",
  "no-show": "⚠️",
  created: "📅",
};

export default function Notifications() {
  const {
    notifications,
    unread,
    channels,
    loading,
    error,
    reload,
    markAllRead,
  } = useNotifications();

  if (loading) return <Loading label="Loading notifications…" />;

  return (
    <div className="page">
      <div className="container stack" style={{ maxWidth: 780 }}>
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Notifications</h1>
            <p className="small muted">
              Appointment updates sent to you automatically.
            </p>
          </div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={reload}
            >
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={markAllRead}
              disabled={unread === 0}
            >
              Mark all read
            </button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="row row-wrap small muted" style={{ gap: "0.75rem" }}>
          <span>
            Channels: <strong>{channels?.sms ? "SMS" : ""}</strong>
            {channels?.sms && channels?.email ? " + " : ""}
            <strong>{channels?.email ? "Email" : ""}</strong>
          </span>
          {channels?.simulated && (
            <span className="badge badge-warning">
              Simulated — no external provider configured
            </span>
          )}
        </div>

        {notifications.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="🔔"
              title="No notifications yet"
              message="Booking or changing an appointment will notify you here."
            />
          </div>
        ) : (
          <div className="stack-sm">
            {notifications.map((n) => (
              <div
                key={n.id}
                className={cx("card card-pad", !n.read && "border-brand")}
                style={!n.read ? { borderLeftWidth: 3 } : undefined}
              >
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <span style={{ fontSize: "1.1rem" }}>
                    {EVENT_ICON[n.event] || "🔔"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-between" style={{ gap: "0.5rem" }}>
                      <strong className="small">{n.subject}</strong>
                      <span className="tiny muted nowrap">
                        {formatDateTime(n.createdAt)}
                      </span>
                    </div>
                    <p className="small muted" style={{ margin: "0.2rem 0 0" }}>
                      {n.body}
                    </p>
                    <div
                      className="row row-wrap tiny muted"
                      style={{ gap: "0.6rem", marginTop: "0.35rem" }}
                    >
                      <span className="badge badge-brand">{n.event}</span>
                      <StatusBadge status={n.status} />
                      {n.channel && <span>via {n.channel}</span>}
                      {n.email && <span>· {n.email}</span>}
                    </div>
                  </div>
                  {!n.read && (
                    <span
                      className="dot"
                      style={{ color: "var(--brand-600)" }}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
