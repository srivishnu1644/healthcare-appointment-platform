import { useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { useToast } from "../context/ToastContext.jsx";
import useAppointments from "../hooks/useAppointments.js";
import {
  Alert,
  EmptyState,
  Loading,
  Tabs,
} from "../components/ui.jsx";
import AppointmentCard from "../features/appointments/AppointmentCard.jsx";
import {
  CancelModal,
  RescheduleModal,
} from "../features/appointments/AppointmentModals.jsx";
import { hasStarted, LIVE_STATUSES } from "../utils/appointments";
import { todayISO } from "../utils/format";

export default function MyAppointments() {
  const toast = useToast();
  const {
    appointments,
    upcoming,
    past,
    loading,
    error,
    refresh: load,
  } = useAppointments();
  const [tab, setTab] = useState("upcoming");

  // Which appointment each shared modal is acting on. The modals themselves
  // live in features/appointments and are used by the detail page too.
  const [cancelTarget, setCancelTarget] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const shown =
    tab === "upcoming" ? upcoming : tab === "past" ? past : appointments;

  // Only the two places that genuinely compare a *calendar date* use this.
  // "Upcoming"/"History" come from the hook's instant-based split instead.
  const today = todayISO();

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
              // This page owns the rules: which appointments can still be acted
              // on, and when check-in is offered. The card only displays them.
              const actionable = LIVE_STATUSES.includes(a.status) && a.date >= today;
              return (
                <div key={a.id} className="card card-pad">
                  <AppointmentCard
                    appointment={a}
                    variant="full"
                    to={`/appointments/${a.id}`}
                    actions={(
                      <>
                        <Link
                          to={`/appointments/${a.id}`}
                          className="btn btn-ghost btn-sm btn-block"
                        >
                          View details
                        </Link>
                        {actionable ? (
                          <div className="stack-sm">
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
                              onClick={() => setMoveTarget(a)}
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
                        ) : null}
                      </>
                    )}
                  />
                </div>
              );
            })}
          </div>
        )}
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
