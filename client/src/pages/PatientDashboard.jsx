import { useMemo } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../context/AuthContext.jsx";
import { useNotifications } from "../context/NotificationsContext.jsx";
import useAppointments from "../hooks/useAppointments.js";
import AppointmentCard from "../features/appointments/AppointmentCard.jsx";
import SymptomChecker from "../components/SymptomChecker.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  SkeletonList,
  Stat,
  StatusBadge,
} from "../components/ui.jsx";
import {
  colorFrom,
  currency,
  dayNum,
  formatDay,
  formatTime,
  num,
  relativeDay,
  weekdayShort,
} from "../utils/format";

/* ------------------------------------------------------------------ *
 *  PatientDashboard — the patient's landing screen, at "/dashboard".   *
 *                                                                       *
 *  Everything here is assembled from endpoints that already existed:      *
 *                                                                       *
 *    * GET /appointments      via useAppointments(), which owns loading,     *
 *      error and the upcoming/past split. The split compares the server's     *
 *      `startsAt` against the current instant — never calendar-date strings — *
 *      so the browser's timezone cannot misfile an appointment.              *
 *    * GET /notifications     via the shared NotificationsProvider. This page *
 *      reads that one copy; it does not start a poller of its own.            *
 *                                                                       *
 *  NOTHING INVENTED. There is no queue position in the list projection and  *
 *  no meeting URL anywhere in the API, so neither is shown. There is no      *
 *  check-in button here either: the next appointment is by definition in the *
 *  future (`isUpcoming` requires startsAt > now), and the API only accepts a *
 *  check-in once the slot has started, so such a button could never enable.  *
 *  Check-in lives on the appointments page, which owns it.                  *
 * ------------------------------------------------------------------ */

const MODE_LABEL = { video: "Video consultation", "in-person": "In person" };

/**
 * Large calendar chip for the next-appointment hero card.
 *
 * Deliberately NOT shared. The row shared by the two appointment lists lives in
 * features/appointments/AppointmentCard.jsx; folding this larger presentation
 * into it would mean a variant with exactly one caller.
 */
function DateChip({ iso }) {
  const big = true;
  return (
    <div
      className="center"
      style={{
        width: big ? 66 : 46,
        flexShrink: 0,
        padding: big ? "0.5rem 0" : "0.3rem 0",
        background: "var(--brand-50)",
        borderRadius: 10,
      }}
    >
      <div className="tiny muted bold">{weekdayShort(iso)}</div>
      <div
        className="bold"
        style={{ lineHeight: 1.05, fontSize: big ? "1.4rem" : "1rem" }}
      >
        {dayNum(iso)}
      </div>
    </div>
  );
}

export default function PatientDashboard() {
  const { user } = useAuth();
  const { notifications, unread, markAllRead } = useNotifications();

  const {
    appointments,
    upcoming,
    past,
    loading: appointmentsLoading,
    error: appointmentsError,
    refresh: reloadAppointments,
  } = useAppointments();

  /* ---------------- derived figures ---------------- */
  // Only genuinely completed visits. A booked or scheduled appointment is not
  // a completed visit and is never counted as one here.
  const completedCount = useMemo(
    () => appointments.filter((a) => a.status === "completed").length,
    [appointments],
  );
  const cancelledCount = useMemo(
    () => appointments.filter((a) => a.status === "cancelled").length,
    [appointments],
  );

  // `upcoming` is already sorted soonest-first by the hook.
  const next = upcoming[0] || null;
  // `past` keeps the API's own order, which is newest-first.
  const recent = past.slice(0, 4);

  const loading = appointmentsLoading;
  const firstName = String(user?.name || "").split(" ")[0];

  const subtitle = loading
    ? "Loading your appointments…"
    : next
      ? `Your next visit is ${relativeDay(next.date).toLowerCase()}.`
      : "You have no upcoming appointments.";

  return (
    <div className="page page-glass-bg">
      <div className="container stack-lg">
        {/* ---------------- welcome ---------------- */}
        <div className="glass-panel row-between">
          <div>
          <h1 style={{ marginBottom: "0.15rem" }}>Dashboard</h1>
          <p className="small muted" style={{ margin: 0 }}>
            Welcome back, {firstName || "there"} — {subtitle}
          </p>
          </div>
          <button
            type="button"
            className="btn btn-glass btn-sm hide-sm"
            onClick={reloadAppointments}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {/* API failure for appointments: say so, and offer a way out. */}
        {appointmentsError && (
          <Alert tone="danger" title="Could not load your appointments">
            {appointmentsError}
            <div style={{ marginTop: "0.65rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={reloadAppointments}
              >
                Try again
              </button>
            </div>
          </Alert>
        )}

        {/* ---------------- summary ---------------- */}
        <div className="grid grid-4">
          <div className="glass-stat" title="Upcoming appointments">
            <div className="stat-label">Upcoming</div>
            <div className="num">{loading ? "—" : num(upcoming.length)}</div>
            <div className="stat-sub">{loading ? "" : upcoming.length === 1 ? "1 booked" : `${num(upcoming.length)} booked`}</div>
          </div>
          <div className="glass-stat" title="Next visit">
            <div className="stat-label">Next visit</div>
            <div className="num" style={{ fontSize: "1.15rem" }}>{loading ? "—" : next ? relativeDay(next.date) : "None"}</div>
            <div className="stat-sub">{loading ? "" : next ? next.doctorName : "Book a slot to get started"}</div>
          </div>
          <div className="glass-stat" title="Completed visits">
            <div className="stat-label">Completed</div>
            <div className="num">{loading ? "—" : num(completedCount)}</div>
            <div className="stat-sub">{loading ? "" : cancelledCount ? `${num(cancelledCount)} cancelled` : "All time"}</div>
          </div>
          <div className="glass-stat" title="Unread notifications">
            <div className="stat-label">Unread</div>
            <div className="num">{loading ? "—" : num(unread)}</div>
            <div className="stat-sub">{loading ? "" : unread ? "Tap a notification to read it" : "You're all caught up"}</div>
          </div>
        </div>

        <div className="split">
          <div className="stack">
            {/* ---------------- next appointment ---------------- */}
            <div className="glass-card card">
              <div className="card-head">
                <h3>Next appointment</h3>
                {next && <StatusBadge status={next.status} />}
              </div>
              <div className="card-body stack">
                {loading && <SkeletonList rows={2} height={56} />}

                {!loading && !next && (
                  <EmptyState
                    icon="📅"
                    title="No upcoming appointments"
                    message="Browse verified specialists and book an in-person or video visit."
                    action={
                      <Link to="/doctors" className="btn btn-primary btn-sm">
                        Find a doctor
                      </Link>
                    }
                  />
                )}

                {!loading && next && (
                  <>
                    <div
                      className="row row-wrap"
                      style={{ gap: "0.9rem", alignItems: "flex-start" }}
                    >
                      <DateChip iso={next.date} />
                      <div style={{ flex: 1, minWidth: 210 }}>
                        <div
                          className="row row-wrap"
                          style={{ gap: "0.4rem", alignItems: "center" }}
                        >
                          <h4 style={{ margin: 0 }}>{next.doctorName}</h4>
                          <span
                            className={
                              next.mode === "video"
                                ? "badge badge-violet"
                                : "badge badge-info"
                            }
                          >
                            {MODE_LABEL[next.mode] || "In person"}
                          </span>
                        </div>
                        <div className="small muted">
                          {next.specialtyName}
                          {next.facilityName ? ` · ${next.facilityName}` : ""}
                        </div>
                        <div className="small" style={{ marginTop: "0.3rem" }}>
                          <strong>
                            {formatTime(next.startTime)}
                            {next.endTime ? ` – ${formatTime(next.endTime)}` : ""}
                          </strong>{" "}
                          · {formatDay(next.date)} · {relativeDay(next.date)}
                        </div>
                        {next.reason && (
                          <div className="tiny muted" style={{ marginTop: "0.25rem" }}>
                            Reason: {next.reason}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="row row-wrap" style={{ gap: "0.5rem" }}>
                      <Link
                        to={`/appointments/${encodeURIComponent(next.id)}`}
                        className="btn btn-primary btn-sm"
                      >
                        Manage appointment
                      </Link>
                      <Link
                        to={`/doctors/${encodeURIComponent(next.doctorId)}`}
                        className="btn btn-secondary btn-sm"
                      >
                        View doctor
                      </Link>
                      {next.fee ? (
                        <span className="small muted">
                          Consultation fee {currency(next.fee)}
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ---------------- recent appointments ---------------- */}
            <div className="glass-card card">
              <div className="card-head">
                <h3>Recent appointments</h3>
                <Link to="/appointments" className="btn btn-ghost btn-sm">
                  View all →
                </Link>
              </div>
              <div className="card-body stack-sm">
                {loading && <SkeletonList rows={3} height={48} />}

                {!loading && recent.length === 0 && (
                  <EmptyState
                    icon="🗂️"
                    title="No past appointments yet"
                    message="Completed and cancelled visits will appear here."
                  />
                )}

                {!loading &&
                  recent.map((a) => (
                    <AppointmentCard
                      key={a.id}
                      appointment={a}
                      variant="compact"
                      to={`/appointments/${encodeURIComponent(a.id)}`}
                      trailing={
                        <>
                          {formatDay(a.date)} · {relativeDay(a.date)}
                        </>
                      }
                    />
                  ))}
              </div>
            </div>

            {/* ---------------- recent activity ---------------- */}
            {notifications.length > 0 && (
              <div className="glass-card card">
                <div className="card-head">
                  <h3>Recent activity</h3>
                  <div className="row" style={{ gap: "0.4rem" }}>
                    {unread > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={markAllRead}
                      >
                        Mark all read
                      </button>
                    )}
                    <Link to="/notifications" className="btn btn-ghost btn-sm">
                      All →
                    </Link>
                  </div>
                </div>
                <div className="card-body stack-sm">
                  {notifications.slice(0, 4).map((n) => (
                    <div
                      key={n.id}
                      className="row"
                      style={{ alignItems: "flex-start" }}
                    >
                      <span
                        className="dot"
                        style={{
                          marginTop: 7,
                          color: n.read
                            ? "var(--gray-300)"
                            : "var(--brand-600)",
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="small bold">{n.subject}</div>
                        <div className="tiny muted">{n.body}</div>
                      </div>
                      <StatusBadge status={n.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ---------------- sidebar ---------------- */}
          <div className="stack sticky-side">
            <div
              className="glass-card card card-pad stack-sm"
              style={{
                background:
                  "linear-gradient(135deg, var(--brand-700), var(--brand-900))",
                color: "#fff",
              }}
            >
              <h4 style={{ margin: 0, color: "#fff" }}>Need to see a doctor?</h4>
              <p
                className="small"
                style={{ margin: 0, color: "var(--brand-100)" }}
              >
                Browse verified specialists, check live availability and book
                in-person or video visits.
              </p>
              <Link
                to="/doctors"
                className="btn btn-primary btn-block"
                style={{ marginTop: "0.35rem" }}
              >
                🔍 Find a doctor
              </Link>
            </div>

            <div className="glass-card card card-pad stack-sm">
              <h4 style={{ margin: 0 }}>Quick actions</h4>
              <Link to="/appointments" className="btn btn-secondary btn-block">
                📅 My appointments
              </Link>
              <Link to="/notifications" className="btn btn-secondary btn-block">
                🔔 Notifications
              </Link>
              <Link to="/profile" className="btn btn-secondary btn-block">
                👤 My profile
              </Link>
            </div>

            <SymptomChecker />
          </div>
        </div>
      </div>
    </div>
  );
}