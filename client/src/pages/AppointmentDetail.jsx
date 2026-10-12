import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import api from "../api/client";
import { useToast } from "../context/ToastContext.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  SkeletonList,
  StatusBadge,
} from "../components/ui.jsx";
import AppointmentCard from "../features/appointments/AppointmentCard.jsx";
import StatusTimeline from "../features/appointments/StatusTimeline.jsx";
import {
  CancelModal,
  RescheduleModal,
} from "../features/appointments/AppointmentModals.jsx";
import { hasStarted, LIVE_STATUSES } from "../utils/appointments";
import {
  colorFrom,
  currency,
  formatDay,
  formatDateTime,
  formatTime,
  relativeDay,
  todayISO,
} from "../utils/format";

/* ------------------------------------------------------------------ *
 *  AppointmentDetail — /appointments/:id                               *
 *                                                                       *
 *  Everything on this page comes from the endpoint that already existed:  *
 *  GET /api/appointments/:id returns                                    *
 *                                                                       *
 *    { appointment, doctor, facility, history, wait }                   *
 *                                                                       *
 *  No new endpoint, no invented field. The server decides access (owner,  *
 *  treating doctor or admin) and returns 404 for anything the caller may  *
 *  not see, so this page never has to guess.                             *
 *                                                                       *
 *  `wait` is only returned to the parties, so it is absent for a stranger; *
 *  the queue block is rendered only when the API actually sent one.        *
 *  The list projection's `queuePosition` is always null, which is why the  *
 *  position here is read from `wait`, never from `appointment`.           *
 * ------------------------------------------------------------------ */

const MODE_LABEL = { video: "Video consultation", "in-person": "In person" };

export default function AppointmentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);

  const [cancelTarget, setCancelTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const res = await api.appointment(id);
      setData(res);
    } catch (err) {
      // 404 means no such appointment; 403 means it exists but is not this
      // patient's (or not this doctor's). Neither is recoverable by retrying,
      // so both render the same "not available" state. Everything else is a
      // genuine failure and keeps its retry.
      if (err?.status === 404 || err?.status === 403) setNotFound(true);
      else setError(err?.message || "Could not load this appointment");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const appointment = data?.appointment || null;

  /* ---------------- what the patient may do here ---------------- *
   * The same gate MyAppointments uses, so availability is identical
   * on both screens. The server still has the final say on every call. */
  const today = todayISO();
  const actionable = Boolean(
    appointment &&
      LIVE_STATUSES.includes(appointment.status) &&
      appointment.date >= today,
  );
  const canCheckIn = Boolean(
    actionable && appointment.date === today && hasStarted(appointment),
  );

  /* ---------------- queue ---------------- *
   * Shown only when the API returned a wait block AND the visit has not
   * finished: a "you are next" label on a completed visit would mislead. */
  const wait = data?.wait || null;
  const showQueue = Boolean(
    wait && appointment && LIVE_STATUSES.includes(appointment.status),
  );

  const doctor = data?.doctor || null;
  const facility = data?.facility || null;

  /* ---------------- check in ---------------- */
  const checkIn = async () => {
    if (!appointment) return;
    setBusy(true);
    try {
      const res = await api.checkIn(appointment.id);
      const pos = res?.queuePosition ?? res?.appointment?.queuePosition;
      const label = res?.estimatedWaitLabel;
      toast.success(
        [pos ? `Queue position #${pos}` : "Checked in", label]
          .filter(Boolean)
          .join(" — "),
      );
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- not found / error ---------------- */
  if (loading) {
    return (
      <div className="page">
        <div className="container stack" style={{ maxWidth: 820 }}>
          <SkeletonList rows={4} height={72} />
          <span className="sr-only" role="status">
            Loading appointment
          </span>
        </div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="page">
        <div className="container" style={{ maxWidth: 820 }}>
          <div className="card">
            <EmptyState
              icon="🔒"
              title="Appointment not available"
              message="This appointment does not exist, or it is not yours to view."
              action={
                <Link to="/appointments" className="btn btn-primary btn-sm">
                  Back to my appointments
                </Link>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (error || !appointment) {
    return (
      <div className="page">
        <div className="container" style={{ maxWidth: 820 }}>
          <Alert tone="danger" title="Could not load this appointment">
            {error || "Something went wrong."}
            <div style={{ marginTop: "0.65rem" }} className="row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={load}
              >
                Try again
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate("/appointments")}
              >
                Back to appointments
              </button>
            </div>
          </Alert>
        </div>
      </div>
    );
  }

  const rows = [
    ["Date", `${formatDay(appointment.date)} · ${relativeDay(appointment.date)}`],
    ["Time", `${formatTime(appointment.startTime)}${
      appointment.endTime ? ` – ${formatTime(appointment.endTime)}` : ""
    }`],
    ["Mode", MODE_LABEL[appointment.mode] || "In person"],
    ["Status", null],
    ["Consultation fee", appointment.fee ? currency(appointment.fee) : null],
    ["Booked on", formatDateTime(appointment.createdAt)],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <div className="page">
      <div className="container stack" style={{ maxWidth: 900 }}>
        {/* ---------------- header ---------------- */}
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate("/appointments")}
            style={{ marginBottom: "0.5rem" }}
          >
            ← Back to appointments
          </button>
          <div className="page-head" style={{ marginBottom: 0 }}>
            <div className="row-between row-wrap" style={{ gap: "0.75rem" }}>
              <div>
                <h1 style={{ marginBottom: "0.15rem" }}>Appointment details</h1>
                <p className="small muted" style={{ margin: 0 }}>
                  {formatDay(appointment.date)} at{" "}
                  {formatTime(appointment.startTime)} ·{" "}
                  {relativeDay(appointment.date)}
                </p>
              </div>
              <StatusBadge status={appointment.status} />
            </div>
          </div>
        </div>

        <div className="split">
          <div className="stack">
            {/* ---------------- status timeline ---------------- */}
            <div className="card">
              <div className="card-head">
                <h3>Status history</h3>
                <span className="tiny muted">
                  {(data.history || []).length} event
                  {(data.history || []).length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="card-body">
                <StatusTimeline history={data.history} />
              </div>
            </div>

            {/* ---------------- details ---------------- */}
            <div className="card">
              <div className="card-head">
                <h3>Visit details</h3>
              </div>
              <div className="card-body stack">
                <div className="stack-sm">
                  {rows.map(([label, value]) => (
                    <div
                      key={label}
                      className="row-between"
                      style={{ gap: "1rem" }}
                    >
                      <span className="small muted nowrap">{label}</span>
                      <span className="small" style={{ textAlign: "right" }}>
                        {label === "Status" ? (
                          <StatusBadge status={appointment.status} />
                        ) : (
                          value
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                {appointment.reason && (
                  <div className="divider" style={{ margin: 0 }} />
                )}
                {appointment.reason && (
                  <div className="small">
                    <strong>Reason for visit:</strong> {appointment.reason}
                  </div>
                )}
                {appointment.symptoms && (
                  <div className="small muted">
                    <strong>Symptoms:</strong> {appointment.symptoms}
                  </div>
                )}
                {appointment.status === "cancelled" && appointment.cancelReason && (
                  <Alert tone="danger">
                    Cancelled on {formatDateTime(appointment.cancelledAt)} —{" "}
                    {appointment.cancelReason}
                  </Alert>
                )}
                {appointment.checkedInAt && (
                  <Alert tone="info">
                    Checked in at {formatDateTime(appointment.checkedInAt)}.
                  </Alert>
                )}
                {appointment.completedAt && (
                  <Alert tone="success">
                    Completed at {formatDateTime(appointment.completedAt)}.
                  </Alert>
                )}
              </div>
            </div>
          </div>

          {/* ---------------- sidebar ---------------- */}
          <div className="stack sticky-side">
            {/* actions */}
            <div className="card card-pad stack-sm">
              <h4 style={{ margin: 0 }}>Actions</h4>

              {actionable ? (
                <>
                  {canCheckIn && (
                    <button
                      type="button"
                      className="btn btn-success btn-block"
                      onClick={checkIn}
                      disabled={busy || appointment.status === "in-progress"}
                    >
                      {appointment.status === "in-progress"
                        ? "Checked in"
                        : "Check in"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-block"
                    onClick={() => setMoveTarget(appointment)}
                    disabled={busy}
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-block"
                    onClick={() => setCancelTarget(appointment)}
                    disabled={busy}
                    style={{ color: "var(--danger)" }}
                  >
                    Cancel appointment
                  </button>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  {LIVE_STATUSES.includes(appointment.status)
                    ? "This visit can no longer be changed."
                    : "This appointment is closed, so it can no longer be changed."}
                </p>
              )}

              <Link to="/appointments" className="btn btn-ghost btn-block">
                All my appointments
              </Link>
            </div>

            {/* queue — only when the API sent one for a live visit */}
            {showQueue && (
              <div className="card card-pad stack-sm">
                <h4 style={{ margin: 0 }}>Queue</h4>
                {wait.queuePosition ? (
                  <div className="small">
                    Your position:{" "}
                    <strong>#{wait.queuePosition}</strong>
                  </div>
                ) : appointment?.queueState === "in-consultation" ? (
                  // In the room, so there is no place in the line to show. The
                  // server sends the state precisely so this is not blank.
                  <div className="small">
                    With the doctor now
                  </div>
                ) : null}
                {wait.estimatedWaitLabel && (
                  <div className="small muted">
                    {wait.estimatedWaitLabel}
                  </div>
                )}
              </div>
            )}

            {/* doctor */}
            {doctor && (
              <div className="card card-pad stack-sm">
                <h4 style={{ margin: 0 }}>Doctor</h4>
                <div className="row" style={{ gap: "0.6rem" }}>
                  <Avatar
                    name={doctor.name}
                    color={doctor.imageColor || colorFrom(doctor.name)}
                    size="sm"
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="small bold truncate">{doctor.name}</div>
                    <div className="tiny muted truncate">
                      {doctor.specialtyName}
                    </div>
                  </div>
                </div>
                {doctor.qualification && (
                  <div className="tiny muted">{doctor.qualification}</div>
                )}
                <Link
                  to={`/doctors/${doctor.id}`}
                  className="btn btn-secondary btn-block btn-sm"
                >
                  View doctor profile
                </Link>
              </div>
            )}

            {/* facility */}
            {facility && (
              <div className="card card-pad stack-sm">
                <h4 style={{ margin: 0 }}>Facility</h4>
                <div className="small bold">{facility.name}</div>
                {facility.address && (
                  <div className="tiny muted">{facility.address}</div>
                )}
                {facility.city && (
                  <div className="tiny muted">{facility.city}</div>
                )}
                {facility.openHours && (
                  <div className="tiny muted">{facility.openHours}</div>
                )}
                {facility.phone && (
                  <div className="tiny muted">{facility.phone}</div>
                )}
              </div>
            )}

            {/* the same shared row used by both appointment lists */}
            <div className="card card-pad">
              <h4 style={{ margin: "0 0 0.5rem" }}>Summary</h4>
              <AppointmentCard appointment={appointment} variant="full" />
            </div>
          </div>
        </div>
      </div>

      <CancelModal
        appointment={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onDone={load}
      />
      <RescheduleModal
        appointment={moveTarget}
        onClose={() => setMoveTarget(null)}
        onDone={load}
      />
    </div>
  );
}