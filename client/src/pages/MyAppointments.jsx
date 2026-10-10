import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { useToast } from "../context/ToastContext.jsx";
import {
  Alert,
  EmptyState,
  Loading,
  Modal,
  StatusBadge,
  Tabs,
} from "../components/ui.jsx";
import {
  currency,
  formatDay,
  formatTime,
  isPast,
  relativeDay,
  todayISO,
} from "../utils/format";

/* Statuses that can still be acted on. Check-in moves an appointment to
   "in-progress", so that is included here. */
const LIVE = ["scheduled", "confirmed", "in-progress"];

export default function MyAppointments() {
  const toast = useToast();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("upcoming");

  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelReason, setCancelReason] = useState("");
  const [busy, setBusy] = useState(false);

  const [moveTarget, setMoveTarget] = useState(null);
  const [moveSlots, setMoveSlots] = useState([]);
  const [moveSlot, setMoveSlot] = useState(null);
  const [moveDate, setMoveDate] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.appointments();
      setAppointments(res.appointments || []);
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

  /* ---------------- split into buckets ---------------- */
  const today = todayISO();
  const upcoming = appointments
    .filter(
      (a) =>
        a.date >= today &&
        LIVE.includes(a.status) &&
        !isPast(a.date, a.startTime),
    )
    .sort((x, y) =>
      x.date === y.date
        ? x.startTime.localeCompare(y.startTime)
        : x.date.localeCompare(y.date),
    );
  const past = appointments.filter((a) => !upcoming.includes(a));

  const shown =
    tab === "upcoming" ? upcoming : tab === "past" ? past : appointments;

  /* ---------------- cancel ---------------- */
  const confirmCancel = async () => {
    if (!cancelTarget) return;
    setBusy(true);
    try {
      await api.cancel(
        cancelTarget.id,
        cancelReason.trim() || "Cancelled by patient",
      );
      toast.success("Appointment cancelled");
      setCancelTarget(null);
      setCancelReason("");
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- reschedule ---------------- */
  const openMove = async (appt) => {
    setMoveTarget(appt);
    setMoveSlot(null);
    setBusy(true);
    try {
      const res = await api.doctorSlots(appt.doctorId);
      setMoveSlots(res.slots.filter((s) => s.status === "available"));
      const firstDate = res.dates.find((d) =>
        res.slots.some((s) => s.date === d && s.status === "available"),
      );
      setMoveDate(firstDate || res.dates[0]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmMove = async () => {
    if (!moveTarget || !moveSlot) return;
    setBusy(true);
    try {
      await api.reschedule(moveTarget.id, moveSlot.id);
      toast.success("Appointment rescheduled");
      setMoveTarget(null);
      setMoveSlot(null);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Has this appointment's slot started?
   *
   * The API refuses check-in until the slot begins (the documented rule that
   * closes Phase 0 finding D-B4), so the button is gated the same way. Comparing
   * the local date is not enough: an appointment later today is both "today" and
   * "not started yet", and offering the button produced a guaranteed 400.
   *
   * Falls back to true when `startsAt` is absent, so a payload without the field
   * does not hide the button entirely.
   */
  const hasStarted = (appt) => {
    if (!appt?.startsAt) return true;
    return new Date(appt.startsAt).getTime() <= Date.now();
  };

  const checkIn = async (appt) => {
    setBusy(true);
    try {
      const res = await api.checkIn(appt.id);
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

  if (loading) return <Loading label="Loading your appointments…" />;

  const slotsForMoveDate = moveSlots.filter((s) => s.date === moveDate);

  return (
    <div className="page">
      <div className="container stack">
        <div className="page-head">
          <h1>My appointments</h1>
          <p>Track status, reschedule or cancel your bookings.</p>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <Tabs
          tabs={[
            { key: "upcoming", label: "Upcoming", count: upcoming.length },
            { key: "past", label: "History", count: past.length },
            { key: "all", label: "All", count: appointments.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        {shown.length === 0 ? (
          <div className="card">
            <EmptyState
              icon="📅"
              title={
                tab === "upcoming"
                  ? "No upcoming appointments"
                  : "Nothing here yet"
              }
              message={
                tab === "upcoming"
                  ? "Book with a specialist to see it here."
                  : "Your appointment history will appear here."
              }
              action={
                tab === "upcoming" ? (
                  <Link to="/doctors" className="btn btn-primary btn-sm">
                    Find a doctor
                  </Link>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="stack">
            {shown.map((a) => {
              const actionable = LIVE.includes(a.status) && a.date >= today;
              return (
                <div key={a.id} className="card card-pad">
                  <div
                    className="row row-wrap"
                    style={{ alignItems: "flex-start" }}
                  >
                    <div
                      className="center"
                      style={{
                        width: 60,
                        flexShrink: 0,
                        padding: "0.45rem 0",
                        background: "var(--brand-50)",
                        borderRadius: 10,
                      }}
                    >
                      <div className="tiny muted bold">
                        {formatDay(a.date).split(",")[0]}
                      </div>
                      <div
                        className="bold"
                        style={{ fontSize: "1.15rem", lineHeight: 1.1 }}
                      >
                        {formatDay(a.date).split(" ")[1]}
                      </div>
                      <div className="tiny muted">
                        {formatDay(a.date).split(" ")[2]}
                      </div>
                    </div>

                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div className="row row-wrap" style={{ gap: "0.45rem" }}>
                        <strong>{a.doctorName}</strong>
                        <StatusBadge status={a.status} />
                        {a.mode === "video" && (
                          <span className="badge badge-violet">Video</span>
                        )}
                        {a.queuePosition && (
                          <span className="badge badge-info">
                            Queue #{a.queuePosition}
                          </span>
                        )}
                      </div>
                      <div className="small muted">
                        {a.specialtyName} · {a.facilityName}
                      </div>
                      <div className="small">
                        {formatTime(a.startTime)} · {currency(a.fee)} ·{" "}
                        <span className="muted">{relativeDay(a.date)}</span>
                      </div>
                      {a.reason && (
                        <div className="tiny muted" style={{ marginTop: 4 }}>
                          Reason: {a.reason}
                        </div>
                      )}
                      {a.status === "cancelled" && a.cancelReason && (
                        <div
                          className="tiny"
                          style={{ color: "var(--danger)", marginTop: 4 }}
                        >
                          Cancelled: {a.cancelReason}
                        </div>
                      )}
                    </div>

                    {actionable && (
                      <div className="stack-sm" style={{ minWidth: 150 }}>
                        {a.date === today && hasStarted(a) && (
                          <button
                            type="button"
                            className="btn btn-success btn-sm btn-block"
                            onClick={() => checkIn(a)}
                            disabled={busy || a.status === "in-progress"}
                          >
                            {a.status === "in-progress"
                              ? a.queuePosition
                                ? `In queue #${a.queuePosition}`
                                : "Checked in"
                              : "Check in"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm btn-block"
                          onClick={() => openMove(a)}
                          disabled={busy}
                        >
                          Reschedule
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm btn-block"
                          onClick={() => setCancelTarget(a)}
                          disabled={busy}
                          style={{ color: "var(--danger)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ---------------- cancel modal ---------------- */}
      <Modal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title="Cancel appointment"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setCancelTarget(null)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={confirmCancel}
              disabled={busy}
            >
              {busy ? "Cancelling…" : "Yes, cancel"}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="small">
            Cancelling with <strong>{cancelTarget?.doctorName}</strong> on{" "}
            <strong>{formatDay(cancelTarget?.date)}</strong> at{" "}
            <strong>{formatTime(cancelTarget?.startTime)}</strong>.
          </p>
          <div className="field">
            <label className="label" htmlFor="cancel-reason">
              Reason (optional)
            </label>
            <textarea
              id="cancel-reason"
              className="textarea"
              placeholder="Let the doctor know why…"
              maxLength={300}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>
          <Alert tone="info">
            The slot is released back to the doctor and you&apos;ll be notified.
          </Alert>
        </div>
      </Modal>

      {/* ---------------- reschedule modal ---------------- */}
      <Modal
        open={Boolean(moveTarget)}
        onClose={() => setMoveTarget(null)}
        title="Reschedule appointment"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setMoveTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmMove}
              disabled={busy || !moveSlot}
            >
              {busy ? "Updating…" : "Confirm new time"}
            </button>
          </>
        }
      >
        <div className="stack">
          <p className="small">
            Currently <strong>{formatDay(moveTarget?.date)}</strong> at{" "}
            <strong>{formatTime(moveTarget?.startTime)}</strong> with{" "}
            <strong>{moveTarget?.doctorName}</strong>.
          </p>

          <div className="row" style={{ gap: "0.4rem", overflowX: "auto" }}>
            {[...new Set(moveSlots.map((s) => s.date))].map((d) => (
              <button
                key={d}
                type="button"
                className={`btn btn-sm ${moveDate === d ? "btn-primary" : "btn-secondary"}`}
                onClick={() => {
                  setMoveDate(d);
                  setMoveSlot(null);
                }}
              >
                {formatDay(d)}
              </button>
            ))}
          </div>

          <div className="row row-wrap" style={{ gap: "0.4rem" }}>
            {slotsForMoveDate.length === 0 ? (
              <p className="small muted">No open slots on this day.</p>
            ) : (
              slotsForMoveDate.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`btn btn-sm ${
                    moveSlot?.id === s.id ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => setMoveSlot(s)}
                >
                  {formatTime(s.startTime)}
                </button>
              ))
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
