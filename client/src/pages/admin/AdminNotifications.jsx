import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { useToast } from "../../context/ToastContext.jsx";
import {
  Alert,
  EmptyState,
  Loading,
  Spinner,
  Stat,
  StatusBadge,
} from "../../components/ui.jsx";
import { formatDateTime, num } from "../../utils/format";

const EVENT_ICON = {
  booked: "✅",
  confirmed: "✅",
  reminder: "⏰",
  rescheduled: "🔄",
  cancelled: "❌",
  completed: "🎉",
  "no-show": "⚠️",
};

export default function AdminNotifications() {
  const toast = useToast();
  const [data, setData] = useState({
    notifications: [],
    total: 0,
    sent: 0,
    simulated: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api.adminNotifications({ limit: 200 });
      setData(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runSweep = async () => {
    setBusy(true);
    try {
      const res = await api.runReminderSweep();
      const count = res?.sent ?? res?.count ?? res?.processed ?? 0;
      toast.success(`Sweep complete — ${count} reminder(s) processed`);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loading label="Loading notification log…" />;

  const events = [...new Set((data.notifications || []).map((n) => n.event))];
  const filtered = filter
    ? (data.notifications || []).filter((n) => n.event === filter)
    : data.notifications || [];

  return (
    <div className="page page-glass-bg">
      <div className="container stack">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Notification log</h1>
            <p className="small muted">
              Every SMS/email the platform generated, platform-wide.
            </p>
          </div>
          <div className="row" style={{ gap: "0.5rem" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={load}
            >
              Refresh
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={runSweep}
              disabled={busy}
            >
              {busy ? <Spinner /> : "Run reminder sweep"}
            </button>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="grid grid-3">
          <Stat label="Total notifications" value={num(data.total)} />
          <Stat label="Delivered" value={num(data.sent)} tone="success" />
          <Stat
            label="Simulated"
            value={num(data.simulated)}
            tone="warning"
            sub="no SMS/email provider configured"
          />
        </div>

        <Alert tone="info" title="Simulated delivery">
          Twilio and Resend keys are not configured, so notifications are logged
          here instead of being sent. Add keys in <code>server/.env</code> to
          send real messages.
        </Alert>

        <div className="row row-wrap" style={{ gap: "0.35rem" }}>
          <button
            type="button"
            className={`btn btn-sm ${!filter ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setFilter("")}
          >
            All ({data.notifications?.length ?? 0})
          </button>
          {events.map((e) => (
            <button
              key={e}
              type="button"
              className={`btn btn-sm ${filter === e ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setFilter(e)}
            >
              {e}
            </button>
          ))}
        </div>

        <div className="card">
          {filtered.length === 0 ? (
            <EmptyState icon="📨" title="No notifications logged" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Patient</th>
                    <th>Subject</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th className="right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => (
                    <tr key={n.id}>
                      <td>
                        <span className="nowrap">
                          {EVENT_ICON[n.event] || "🔔"} {n.event}
                        </span>
                      </td>
                      <td>{n.patientName}</td>
                      <td>
                        <div className="bold small">{n.subject}</div>
                        <div
                          className="tiny muted truncate"
                          style={{ maxWidth: 320 }}
                        >
                          {n.body}
                        </div>
                      </td>
                      <td className="muted">{n.channel}</td>
                      <td>
                        <div className="row" style={{ gap: "0.35rem" }}>
                          <StatusBadge status={n.status} />
                          {/* A patient swiping a message away does not un-send
                              it, and this screen is the record of what was
                              sent. So dismissed messages stay listed — flagged,
                              rather than quietly gone. */}
                          {n.deletedAt && <span className="badge">Dismissed</span>}
                        </div>
                      </td>
                      <td className="right muted nowrap">
                        {formatDateTime(n.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
