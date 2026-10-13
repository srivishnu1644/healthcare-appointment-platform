import { useEffect, useState } from "react";
import api from "../../api/client";
import {
  Alert,
  EmptyState,
  Loading,
  ProgressBar,
  Stat,
} from "../../components/ui.jsx";
import { currency, formatDay, num } from "../../utils/format";

/** Minimal inline sparkline — avoids pulling a chart library. */
function Sparkline({ points = [], height = 46 }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = 100 / (points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * step;
      const y = height - (p.value / max) * (height - 6) - 3;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
    >
      <path
        d={path}
        fill="none"
        stroke="var(--brand-600)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    api
      .adminOverview()
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <Loading label="Loading analytics…" />;
  if (error) {
    return (
      <div className="page">
        <div className="container">
          <Alert tone="danger">
            {error}{" "}
            <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
              Retry
            </button>
          </Alert>
        </div>
      </div>
    );
  }

  const {
    kpis = {},
    counts = {},
    trend = [],
    bySpecialty = [],
    topDoctors = [],
    // Operations, added in Phase 12: is the clinic running RIGHT NOW, rather than
    // how it trended. These arrive on the same overview rather than needing three
    // more round trips before the page can answer the obvious question.
    queue = {},
    notifications = {},
    scheduler = null,
  } = data;

  return (
    <div className="page">
      <div className="container stack-lg">
        <div className="page-head row-between">
          <div>
            <h1 style={{ marginBottom: "0.15rem" }}>Platform overview</h1>
            <p className="small muted">
              Appointments, utilisation and no-show analytics.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={load}
          >
            Refresh
          </button>
        </div>

        {/* ---- live operations ---- */}
        <div className="grid grid-4">
          <Stat
            label="In waiting rooms"
            value={num(queue.waiting ?? 0)}
            sub={`${num(queue.rooms ?? 0)} room(s) open`}
          />
          <Stat
            label="In consultation"
            value={num(queue.inConsultation ?? 0)}
            sub={
              queue.oldestWaitingAt
                ? `oldest waiting ${new Date(queue.oldestWaitingAt).toLocaleTimeString()}`
                : "nobody waiting"
            }
          />
          <Stat
            label="Notifications (24h)"
            value={num(notifications.last24h ?? 0)}
            sub={`${num(notifications.unread ?? 0)} unread in total`}
          />
          <Stat
            label="Outbox"
            value={num(notifications.deliveries?.queued ?? 0)}
            sub={
              scheduler?.running
                ? `timer on · every ${scheduler.intervalMinutes} min`
                : "timer off"
            }
            tone={(notifications.deliveries?.queued ?? 0) > 0 ? "warning" : undefined}
          />
        </div>

        {scheduler && (
          <Alert tone={scheduler.lastError ? "warning" : "info"}>
            <span className="small">
              Background passes: <strong>{scheduler.running ? "running" : "stopped"}</strong>
              {scheduler.enabled ? "" : " (disabled by configuration)"}
              {" · "}
              {scheduler.lastRun
                ? `last reminder sweep ${scheduler.lastRun.processed ?? 0} sent`
                : "no reminder sweep recorded yet"}
              {" · "}
              {scheduler.lastDrain
                ? `last outbox drain ${scheduler.lastDrain.processed ?? 0} delivered`
                : "no drain recorded yet"}
              . {scheduler.note}
            </span>
          </Alert>
        )}

        {/* primary KPIs */}
        <div className="grid grid-4">
          <Stat
            label="Total appointments"
            value={num(kpis.totalAppointments)}
            sub={`${num(kpis.upcoming)} upcoming`}
          />
          <Stat
            label="Completed"
            value={num(kpis.completed)}
            sub={`${num(kpis.todayCount)} today`}
          />
          <Stat
            label="Cancelled"
            value={num(kpis.cancelled)}
            sub={`${kpis.cancelRate ?? 0}% of total`}
            tone="danger"
          />
          <Stat
            label="No-shows"
            value={num(kpis.noShow)}
            sub={`${kpis.noShowRate ?? 0}% of total`}
            tone="warning"
          />
        </div>

        <div className="split">
          <div className="stack">
            {/* trend */}
            <div className="card">
              <div className="card-head">
                <h3>Appointment trend</h3>
                <span className="small muted">last {trend.length} days</span>
              </div>
              <div className="card-body">
                {trend.length ? (
                  <>
                    <Sparkline
                      points={trend.map((t) => ({ value: t.appointments }))}
                      height={70}
                    />
                    <div
                      className="row row-wrap tiny muted"
                      style={{ gap: "0.9rem", marginTop: "0.5rem" }}
                    >
                      <span>
                        <span
                          className="dot"
                          style={{ color: "var(--brand-600)" }}
                        />{" "}
                        appointments{" "}
                        {trend.reduce((s, t) => s + t.appointments, 0)}
                      </span>
                      <span>
                        <span
                          className="dot"
                          style={{ color: "var(--success)" }}
                        />{" "}
                        completed {trend.reduce((s, t) => s + t.completed, 0)}
                      </span>
                      <span>
                        <span
                          className="dot"
                          style={{ color: "var(--danger)" }}
                        />{" "}
                        cancelled {trend.reduce((s, t) => s + t.cancelled, 0)}
                      </span>
                      <span>
                        <span
                          className="dot"
                          style={{ color: "var(--warning)" }}
                        />{" "}
                        no-show {trend.reduce((s, t) => s + t.noShow, 0)}
                      </span>
                    </div>
                  </>
                ) : (
                  <EmptyState icon="📈" title="Not enough data" />
                )}
              </div>
            </div>

            {/* by specialty */}
            <div className="card">
              <div className="card-head">
                <h3>By specialty</h3>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Specialty</th>
                      <th className="right">Total</th>
                      <th className="right">Completed</th>
                      <th className="right">Cancelled</th>
                      <th className="right">No-show</th>
                      <th style={{ width: 130 }}>Utilisation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySpecialty.map((s) => (
                      <tr key={s.specialty}>
                        <td className="bold">{s.specialty}</td>
                        <td className="right">{s.total}</td>
                        <td
                          className="right"
                          style={{ color: "var(--success)" }}
                        >
                          {s.completed}
                        </td>
                        <td
                          className="right"
                          style={{ color: "var(--danger)" }}
                        >
                          {s.cancelled}
                        </td>
                        <td
                          className="right"
                          style={{ color: "var(--warning)" }}
                        >
                          {s.noShow}
                        </td>
                        <td>
                          <div className="row" style={{ gap: "0.4rem" }}>
                            <div style={{ flex: 1 }}>
                              <ProgressBar
                                value={s.utilization}
                                tone={
                                  s.utilization > 80
                                    ? "danger"
                                    : s.utilization > 50
                                      ? "warning"
                                      : "success"
                                }
                              />
                            </div>
                            <span className="tiny muted nowrap">
                              {s.utilization}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* top doctors */}
            <div className="card">
              <div className="card-head">
                <h3>Top doctors</h3>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Doctor</th>
                      <th>Specialty</th>
                      <th className="right">Completed</th>
                      <th className="right">Rating</th>
                      <th className="right">Revenue</th>
                      <th className="right">No-show</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topDoctors.map((d) => (
                      <tr key={d.doctorId}>
                        <td className="bold">{d.name}</td>
                        <td className="muted">{d.specialtyName}</td>
                        <td className="right">{d.completed}</td>
                        <td className="right">⭐ {d.rating}</td>
                        <td className="right">{currency(d.revenue)}</td>
                        <td className="right">{d.noShow}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* sidebar */}
          <div className="stack sticky-side">
            <div className="card card-pad stack-sm">
              <h4 style={{ margin: 0 }}>Platform</h4>
              {[
                ["Doctors", counts.doctors],
                ["Facilities", counts.facilities],
                ["Services", counts.services],
                ["Specialties", counts.specialties],
                ["Patients", counts.users],
              ].map(([k, v]) => (
                <div key={k} className="row-between small">
                  <span className="muted">{k}</span>
                  <strong>{num(v ?? 0)}</strong>
                </div>
              ))}
            </div>

            <div className="card card-pad stack-sm">
              <h4 style={{ margin: 0 }}>Capacity</h4>
              <div className="stack-sm">
                <div className="row-between small">
                  <span className="muted">Slot utilisation</span>
                  <strong>{kpis.slotUtilization ?? 0}%</strong>
                </div>
                <ProgressBar
                  value={kpis.slotUtilization}
                  tone={(kpis.slotUtilization ?? 0) > 80 ? "danger" : "success"}
                />
              </div>
              <div className="divider" />
              <div className="row-between small">
                <span className="muted">Open slots</span>
                <strong>{num(counts.openSlotCount ?? 0)}</strong>
              </div>
              <div className="row-between small">
                <span className="muted">Total upcoming slots</span>
                <strong>{num(counts.upcomingSlotCount ?? 0)}</strong>
              </div>
              <div className="divider" />
              <div className="row-between small">
                <span className="muted">Active patients</span>
                <strong>{num(kpis.activePatients ?? 0)}</strong>
              </div>
              <div className="row-between small">
                <span className="muted">Revenue</span>
                <strong>{currency(kpis.revenue ?? 0)}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
