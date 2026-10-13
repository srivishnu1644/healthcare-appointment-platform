import { EmptyState, Loading, StatusBadge, Alert } from "../components/ui.jsx";
import { useNotifications } from "../context/NotificationsContext.jsx";
import { formatDateTime, cx } from "../utils/format";

/**
 * Keyed by the events the server actually writes.
 *
 * The previous table was keyed by `booked`, `reminder`, `cancelled` and so on,
 * while every message the server sends is named `appointment_booked`,
 * `appointment_reminder`, `appointment_cancelled`. Nothing ever matched, so every
 * notification in the app rendered the same fallback bell - the list looked
 * uniform because the icons were broken, not because the messages were alike.
 */
const EVENT_ICON = {
  appointment_booked: "\u2705",
  appointment_reminder: "\u23F0",
  appointment_rescheduled: "\u{1F504}",
  appointment_cancelled: "\u274C",
  appointment_checked_in: "\u{1F6CF}",
  queue_called: "\u{1F44C}",
  appointment_completed: "\u{1F389}",
  status_update: "\u{1F4CC}",
};

/** A friendlier label than the raw event name in the badge. */
const EVENT_LABEL = {
  appointment_booked: "Confirmed",
  appointment_reminder: "Reminder",
  appointment_rescheduled: "Rescheduled",
  appointment_cancelled: "Cancelled",
  appointment_checked_in: "Checked in",
  queue_called: "Called",
  appointment_completed: "Completed",
  status_update: "Status update",
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
    markOne,
    marking,
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

        <div role="list" aria-label="Notification history">
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
                role="listitem"
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
                      <span className="badge badge-brand">
                        {EVENT_LABEL[n.event] ?? n.event}
                      </span>
                      <StatusBadge status={n.status} />
                      {n.channel && <span>via {n.channel}</span>}
                      {n.email && <span>· {n.email}</span>}
                    </div>
                  </div>
                  {!n.read ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm nowrap"
                      onClick={() => markOne(n.id)}
                      disabled={marking === n.id}
                      title="Mark this notification as read"
                    >
                      {marking === n.id ? "…" : "Mark read"}
                    </button>
                  ) : (
                    <span className="tiny muted nowrap" title="Read">
                      Read
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
