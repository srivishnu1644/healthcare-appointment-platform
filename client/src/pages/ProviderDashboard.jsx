import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  Loading,
  Modal,
  Stat,
  StatusBadge,
  Tabs,
} from "../components/ui.jsx";
import {
  colorFrom,
  currency,
  formatDay,
  formatTime,
  label,
  relativeDay,
  todayISO,
} from "../utils/format";

import {
  LIVE_STATUSES,
  byStartAscending,
  joinedAgo,
  joinQueueWithAppointments,
  startInstant,
  summariseDay,
} from "../utils/appointments";
import { useQueue, waitingPatients } from "../context/QueueContext.jsx";

/**
 * Clock time of an absolute instant, for "called at 2:05 PM".
 *
 * `new Date(instant)` plus the browser's own clock, so it is correct in whatever
 * zone the browser is in. The preview this replaced sliced the ISO string
 * (`joinedAt.slice(11, 16)`), which is the UTC time of day and was silently
 * wrong for any clinic outside UTC.
 */
const formatClock = (instant) => {
  if (!instant) return "";
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return "";
  return formatTime(
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  );
};

/**
 * Mirrors `ALLOWED_TRANSITIONS` in server/src/services/bookingService.js, which
 * is the single source of truth for every status change in the system.
 *
 * The server validates regardless, so this only decides what is OFFERED. It is
 * kept in step deliberately: the previous copy omitted `scheduled -> in-progress`,
 * so the dashboard refused to show a transition the API accepts, and a terminal
 * status must offer nothing.
 */
const STATUS_ACTIONS = {
  scheduled: ["confirmed", "in-progress", "cancelled", "no-show"],
  confirmed: ["in-progress", "cancelled", "no-show"],
  "in-progress": ["completed", "cancelled", "no-show"],
  completed: [],
  cancelled: [],
  "no-show": [],
};

/**
 * The status buttons for one appointment.
 *
 * Shared by the appointment list and the queue so both offer exactly what
 * `STATUS_ACTIONS` allows, with one disabled rule and one submit path.
 */
function StatusActions({ appointment, onChange, busy, disabled }) {
  const actions = STATUS_ACTIONS[appointment.status] || [];
  if (actions.length === 0) return null;
  return (
    <div className="row row-wrap" style={{ gap: "0.35rem" }}>
      {actions.map((s) => (
        <button
          key={s}
          type="button"
          className={`btn btn-sm ${
            s === "completed"
              ? "btn-success"
              : s === "cancelled" || s === "no-show"
                ? "btn-ghost"
                : "btn-secondary"
          }`}
          style={
            s === "cancelled" || s === "no-show"
              ? { color: "var(--danger)" }
              : undefined
          }
          onClick={() => onChange(appointment, s)}
          disabled={disabled || busy}
        >
          {label(s)}
        </button>
      ))}
    </div>
  );
}

export default function ProviderDashboard() {
  const { user } = useAuth();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("today");
  const [busy, setBusy] = useState(false);
  // Tracked per appointment so one row's transition cannot be submitted twice,
  // while the rest of the list stays usable.
  const [busyAppt, setBusyAppt] = useState(null);

  // The date whose slots the schedule card is showing. It follows today until
  // the provider picks another, so the initial paint costs no extra request.
  const [dayDate, setDayDate] = useState(todayISO());
  const [daySlots, setDaySlots] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState(null);
  const [dayRetry, setDayRetry] = useState(0);


  const [genOpen, setGenOpen] = useState(false);
  const [genDate, setGenDate] = useState(todayISO());
  const [genTimes, setGenTimes] = useState("09:00\n09:30\n10:00\n10:30");
  const [genMode, setGenMode] = useState("in-person");

  // The session already carries the provider record, so the schedule and the
  // queue are fetched together rather than one after the other.
  const doctorId = user?.doctor?.id ?? null;

  // One waiting room for the whole app: a single poller, a single copy of the
  // state, one error to retry. See QueueContext for why it is a provider rather
  // than a hook.
  const {
    room,
    loading: queueLoading,
    error: queueError,
    refreshing: queueRefreshing,
    refresh: queueRefresh,
    reload: queueReload,
  } = useQueue();
  const [calling, setCalling] = useState(false);

  // Queue entries carry no appointment time or status - the payload drops the
  // slot start it selects - so each is paired with the appointment this page
  // already fetched. Nothing is computed here; this only joins two payloads, and
  // `joinQueueWithAppointments` preserves the server's own order.
  const queueWaiting = useMemo(
    () =>
      joinQueueWithAppointments(waitingPatients(room), data?.appointments ?? []).map((entry) => ({
        ...entry,
        waited: joinedAgo(entry.joinedAt),
      })),
    [room, data],
  );

  // Whoever is in consultation, so the active card offers the same status
  // actions as every other row.
  const activeAppointment = useMemo(
    () =>
      (data?.appointments ?? []).find(
        (a) => a.id === room?.activeConsultation?.appointmentId,
      ) ?? null,
    [data, room],
  );

  const load = useCallback(async () => {
    const day = todayISO();
    try {
      // Only the schedule is fetched here. The waiting room belongs to
      // QueueContext, which already has a poller and its own error state;
      // fetching it again here would be a second copy of the same data.
      setData(await api.mySchedule({ date: day }));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [doctorId]);

  useEffect(() => {
    load();
  }, [load]);

  // Slots for a date other than the one the schedule call already returned.
  // Nothing is fetched for today: the schedule response already carries them.
  useEffect(() => {
    if (!doctorId || !data?.doctor) return;
    if (dayDate === todayISO()) {
      setDaySlots(null);
      setDayError(null);
      return;
    }
    let cancelled = false;
    setDayLoading(true);
    api
      .doctorSlots(doctorId, { date: dayDate })
      .then((res) => {
        if (cancelled) return;
        setDaySlots(res.slots ?? []);
        setDayError(null);
      })
      .catch((err) => {
        if (!cancelled) setDayError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDayLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doctorId, dayDate, dayRetry, data?.doctor]);

  const today = todayISO();

  const buckets = useMemo(() => {
    const appts = data?.appointments || [];
    return {
      today: appts.filter((a) => a.date === today),
      upcoming: appts.filter(
        (a) =>
          a.date > today &&
          !["cancelled", "completed", "no-show"].includes(a.status),
      ),
      past: appts.filter(
        (a) =>
          a.date < today ||
          ["completed", "cancelled", "no-show"].includes(a.status),
      ),
    };
  }, [data, today]);

  /**
   * Everything the overview needs for the current clinic day.
   *
   * The day classification itself lives in `summariseDay`, shared with the
   * harness so it can be exercised against controlled data. The waiting list is
   * rendered in the order the server returned it rather than re-sorted here.
   */
  const overview = useMemo(() => {
    // A queue entry is the authoritative record of a check-in. The appointment
    // status is not: a provider may set in-progress directly, which would count
    // a patient who never arrived.
    const checkedInIds = new Set(
      (room?.entries ?? [])
        .filter((e) => e.state === "waiting" || e.state === "in-consultation")
        .map((e) => e.appointmentId),
    );
    return summariseDay(data?.appointments || [], { today, checkedInIds });
  }, [data, room, today]);

  if (loading) return <Loading label="Loading your schedule…" />;

  if (error || !data?.doctor) {
    return (
      <div className="page">
        <div className="container stack">
          <Alert tone="danger">
            {error || "No provider profile linked to this account"}
          </Alert>
          {error && (
            <div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setLoading(true);
                  load();
                }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { doctor, slots } = data;
  const todaysSlots = slots.filter((s) => s.date === today);
  // Today's slots arrive with the schedule call; any other date is fetched
  // separately, so no request is made until the provider picks a day.
  const shownSlots = dayDate === today ? todaysSlots : (daySlots ?? []);
  const shownDate = dayDate;
  const isToday = dayDate === today;

  const setSlotStatus = async (slot, status) => {
    setBusy(true);
    try {
      await api.updateSlot(doctor.id, slot.id, { status });
      toast.success(`Slot ${status}`);
      await load();
      // A date other than today's is served by a separate call, so refresh it
      // too, or the card would keep showing the state from before the change.
      if (dayDate !== todayISO() && doctorId) {
        const fresh = await api.doctorSlots(doctorId, { date: dayDate });
        setDaySlots(fresh.slots ?? []);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Call the next waiting patient.
   *
   * Guarded in two places: `calling` disables the button, and the early return
   * covers a click that lands between the click and the re-render. The server is
   * idempotent too, so even a retry that got through returns the same patient
   * rather than skipping one.
   */
  const callNext = async () => {
    if (calling || !doctorId) return;
    setCalling(true);
    try {
      const res = await api.callNext({ doctorId, date: todayISO() });
      const name = res?.entry?.patientName ?? "the next patient";
      toast.success(
        res?.promoted ? `Called ${name}` : `${name} is already in consultation`,
      );
      // The mutation changed the room, so read it now rather than waiting for
      // the poller. The schedule is re-read too: a completed visit frees a slot.
      await Promise.all([load(), queueRefresh()]);
    } catch (err) {
      // A room that emptied between the poll and the click is a normal outcome,
      // not a failure worth alarming the provider about.
      if (err?.code === "NO_WAITING_PATIENT" || err?.status === 404) {
        toast.warning("Nobody is waiting");
        await queueRefresh();
      } else {
        toast.error(err?.message || "Could not call the next patient");
      }
    } finally {
      setCalling(false);
    }
  };

  const changeStatus = async (appt, status) => {
    // Guard the request itself, not only the buttons: a second click landing
    // between the click and the re-render must not send a duplicate.
    if (busyAppt === appt.id) return;
    setBusyAppt(appt.id);
    try {
      await api.changeStatus(appt.id, status, `Marked ${status} by doctor`);
      toast.success(`Appointment ${status}`);
      // A completed or cancelled visit changes the waiting room too, so both
      // are re-read rather than waiting for the poller.
      await Promise.all([load(), queueRefresh()]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyAppt(null);
    }
  };



  const generateSlots = async () => {
    const times = [
      ...new Set(
        genTimes
          .split(/[\n,]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].sort();

    if (!times.length) {
      toast.warning("Add at least one time");
      return;
    }

    // Checked here as well as on the server so a typo is caught before the
    // round trip. The server is still the authority: this only saves a request
    // and gives a message next to the field the provider is looking at.
    const malformed = times.filter((t) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t));
    if (malformed.length) {
      toast.warning(
        `Use 24-hour times like 09:30. Not valid: ${malformed.join(", ")}`,
      );
      return;
    }

    setBusy(true);
    try {
      const res = await api.generateSlots(doctor.id, {
        date: genDate,
        times,
        duration: 30,
        mode: genMode,
      });

      // `skipped` is a list of objects, each with the time and why it was
      // refused. Interpolating the array directly printed "[object Object]", so
      // the counts and the reasons are spelled out instead.
      const skipped = res.skipped ?? [];
      let message = `${res.createdCount ?? res.created?.length ?? 0} slot(s) created`;
      if (skipped.length) {
        const why = (reason) =>
          skipped
            .filter((s) => s.reason === reason)
            .map((s) => s.localTime ?? s.startTime ?? "?")
            .join(", ");
        const parts = [];
        if (why("duplicate")) parts.push(`${why("duplicate")} already existed`);
        if (why("overlaps")) {
          const n = skipped.filter((s) => s.reason === "overlaps").length;
          parts.push(`${why("overlaps")} overlap${n === 1 ? "s" : ""} another slot`);
        }
        message += `, skipped ${skipped.length}${parts.length ? ` (${parts.join("; ")})` : ""}`;
      }
      toast.success(message);

      setGenOpen(false);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const renderAppt = (a) => {
    return (
      <div key={a.id} className="card card-pad">
        <div className="row-between" style={{ alignItems: "flex-start" }}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Avatar
              name={a.patientName}
              color={colorFrom(a.patientName)}
              size="sm"
            />
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: "0.4rem" }}>
                <strong className="small">{a.patientName}</strong>
                <StatusBadge status={a.status} />
              </div>
              <div className="tiny muted">
                {formatDay(a.date)} · {formatTime(a.startTime)} ·{" "}
                {a.mode === "video" ? "Video" : "In person"}
                {a.queuePosition ? ` · Queue #${a.queuePosition}` : ""}
              </div>
              {a.reason && <div className="tiny muted">Reason: {a.reason}</div>}
              {a.symptoms && a.symptoms !== a.reason && (
                <div className="tiny muted">Notes: {a.symptoms}</div>
              )}
            </div>
          </div>
          <StatusActions
            appointment={a}
            onChange={changeStatus}
            busy={busy}
            disabled={busyAppt === a.id}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className="container stack">
        <div className="row-between">
          <div className="row">
            <Avatar name={doctor.name} color={doctor.imageColor} size="lg" />
            <div>
              <h1 style={{ marginBottom: 0 }}>{doctor.name}</h1>
              <p className="small muted" style={{ margin: 0 }}>
                {doctor.specialtyName} · {doctor.facilityName}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setGenOpen(true)}
          >
            + Add slots
          </button>
        </div>

        {/* Today's overview */}
        <section aria-labelledby="today-overview">
          <div className="row-between" style={{ marginBottom: "0.5rem" }}>
            <h2 id="today-overview" className="h3" style={{ margin: 0 }}>
              Today
            </h2>
            <span className="small muted">{formatDay(today)}</span>
          </div>
          <div className="grid grid-4">
            <Stat
              label="Appointments"
              value={overview.todayCount}
              sub={`${overview.liveCount} still live`}
            />
            <Stat
              label="Checked in"
              value={overview.checkedIn.length}
              sub="waiting or in the room"
            />
            <Stat
              label="Completed"
              value={overview.completed.length}
              sub="finished today"
            />
            <Stat
              label="Next up"
              value={
                overview.next
                  ? formatTime(overview.next.startTime)
                  : "None"
              }
              sub={
                overview.next
                  ? `${overview.next.patientName} · ${relativeDay(overview.next.date)}`
                  : "nothing scheduled ahead"
              }
            />
          </div>
        </section>

        {/* today's slot strip */}
        <div className="card">
          <div className="card-head">
            <h3>Schedule</h3>
            <div className="row row-wrap" style={{ gap: "0.75rem" }}>
              <label className="small muted nowrap" htmlFor="schedule-date">
                Date{" "}
                <input
                  id="schedule-date"
                  type="date"
                  className="input"
                  value={dayDate}
                  onChange={(e) => setDayDate(e.target.value || todayISO())}
                  style={{ marginLeft: "0.35rem" }}
                />
              </label>
              {/* No `nowrap`: this line is the widest thing in the header and
                  forcing it onto one row pushed the card past a phone's
                  viewport. */}
              <span className="small muted">
                {isToday ? "Today" : formatDay(shownDate)}:{" "}
                {shownSlots.filter((s) => s.status === "available").length} open ·{" "}
                {shownSlots.filter((s) => s.status === "booked").length} booked ·{" "}
                {shownSlots.filter((s) => s.status === "blocked").length} blocked
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setGenOpen(true)}
              >
                Manage slots
              </button>
            </div>
          </div>
          <div className="card-body">
            {dayLoading ? (
              <Loading label="Loading that day's slots…" />
            ) : dayError ? (
              <Alert tone="danger">
                {dayError}{" "}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setDayRetry((n) => n + 1)}
                >
                  Retry
                </button>
              </Alert>
            ) : shownSlots.length === 0 ? (
              <EmptyState
                icon="🗓️"
                title={isToday ? "No slots today" : "No slots on this day"}
                message="Add slots so patients can book with you."
                action={
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => setGenOpen(true)}
                  >
                    Add slots
                  </button>
                }
              />
            ) : (
              <div className="row row-wrap" style={{ gap: "0.4rem" }}>
                {shownSlots.map((s) => (
                  <div
                    key={s.id}
                    className="row"
                    style={{
                      gap: "0.35rem",
                      padding: "0.35rem 0.5rem 0.35rem 0.65rem",
                      border: "1px solid var(--gray-200)",
                      borderRadius: 8,
                    }}
                  >
                    <span className="small bold nowrap">
                      {formatTime(s.startTime)}
                    </span>
                    <StatusBadge status={s.status} />
                    <span className="tiny muted nowrap">
                      {s.mode === "video" ? "Video" : "Clinic"}
                    </span>
                    {s.status !== "booked" && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: "0.1rem 0.35rem" }}
                        title={
                          s.status === "available" ? "Block slot" : "Open slot"
                        }
                        onClick={() =>
                          setSlotStatus(
                            s,
                            s.status === "available" ? "blocked" : "available",
                          )
                        }
                        disabled={busy}
                      >
                        {s.status === "available" ? "🚫" : "✓"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Today's appointments */}
        <section className="card" aria-labelledby="today-appointments">
          <div className="card-head">
            <h3 id="today-appointments">Today's appointments</h3>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setTab("today");
                document
                  .getElementById("appointment-management")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              Manage appointments
            </button>
          </div>
          <div className="card-body">
            {overview.todayCount === 0 ? (
              <EmptyState
                icon="📅"
                title="No appointments today"
                message="When patients book your slots they will appear here."
              />
            ) : (
              <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {buckets.today
                  .slice()
                  .sort(byStartAscending)
                  .map((a) => (
                    <li
                      key={a.id}
                      className="row-between row-wrap"
                      style={{ gap: "0.5rem" }}
                    >
                      <div className="row" style={{ gap: "0.6rem", minWidth: 0 }}>
                        <span className="small bold nowrap">
                          {formatTime(a.startTime)}
                        </span>
                        <span className="nowrap" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                          {a.patientName}
                        </span>
                        <StatusBadge status={a.status} />
                      </div>
                      <span className="tiny muted nowrap">
                        {a.mode === "video" ? "Video" : "Clinic"}
                        {a.reason ? ` · ${a.reason}` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </section>

        {/*
          The waiting room, in the order the server returned it.

          The room is (doctor_id, clinic_date): patients hold separate
          appointment slots but wait for the same person, so their order comes
          from when they ARRIVED. `roomPosition` is computed by the server and
          renumbers itself when somebody leaves; it is never calculated here,
          and the legacy per-slot `position` is not used at all.

          The patient in consultation is reported separately rather than ranked,
          so "you are 2nd" never silently changes meaning when the doctor moves on.
        */}
        <section className="card" aria-labelledby="queue-panel">
          <div className="card-head">
            <h3 id="queue-panel">Queue</h3>
            <div className="row row-wrap" style={{ gap: "0.75rem" }}>
              <span className="small muted nowrap">
                {room.waitingCount} waiting
                {/* This is an ASSUMPTION, not a measurement: the API multiplies
                    the head count by a flat 15 minutes per patient. Labelled as
                    the assumption it is, so nobody reads it as how long the wait
                    actually is. A real estimate would need per-visit durations. */}
                {room.averageWaitMinutes
                  ? ` · ~${room.averageWaitMinutes} min if each visit is 15 min`
                  : ""}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={callNext}
                disabled={calling || queueLoading || queueError !== null}
                title={
                  queueError
                    ? "The waiting room could not be loaded"
                    : room.activeConsultation
                      ? "The current patient is still in consultation"
                      : "Call the next waiting patient"
                }
              >
                {calling ? "Calling…" : "Call next patient"}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={queueRefresh}
                disabled={queueRefreshing || calling}
              >
                {queueRefreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </div>
          <div className="card-body stack-sm">
            {queueError ? (
              <Alert tone="danger">
                {queueError}{" "}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={queueReload}
                  disabled={queueRefreshing}
                >
                  Retry
                </button>
              </Alert>
            ) : queueLoading && !room.clinicDate ? (
              <Loading label="Loading the waiting room…" />
            ) : (
              <>
                {room.activeConsultation && (
                  <div
                    className="card card-pad"
                    style={{ borderLeft: "3px solid var(--brand-500)" }}
                  >
                    <div className="row-between row-wrap" style={{ gap: "0.5rem" }}>
                      <div className="row row-wrap" style={{ gap: "0.6rem", minWidth: 0 }}>
                        <Avatar
                          name={room.activeConsultation.patientName}
                          color={colorFrom(room.activeConsultation.patientName)}
                          size="sm"
                        />
                        <div style={{ minWidth: 0 }}>
                          <div className="row row-wrap" style={{ gap: "0.4rem" }}>
                            <span className="tiny muted">In consultation</span>
                            <StatusBadge status="in-consultation" />
                          </div>
                          <strong className="small">
                            {room.activeConsultation.patientName ?? "Patient"}
                          </strong>
                          {room.activeConsultation.calledAt && (
                            <div className="tiny muted">
                              Called {formatClock(room.activeConsultation.calledAt)}
                            </div>
                          )}
                        </div>
                      </div>
                      {activeAppointment && (
                        <StatusActions
                          appointment={activeAppointment}
                          onChange={changeStatus}
                          busy={busy}
                          disabled={busyAppt === activeAppointment.id || calling}
                        />
                      )}
                    </div>
                  </div>
                )}

                {queueWaiting.length === 0 && !room.activeConsultation ? (
                  <EmptyState
                    icon="🕒"
                    title="Nobody is waiting"
                    message="Patients appear here once they check in."
                  />
                ) : queueWaiting.length === 0 ? (
                  <p className="tiny muted" style={{ margin: 0 }}>
                    Nobody else is waiting.
                  </p>
                ) : (
                  <ul
                    className="stack-sm"
                    style={{ listStyle: "none", margin: 0, padding: 0 }}
                  >
                    {queueWaiting.map((row) => (
                      <li
                        key={row.id}
                        className="row-between row-wrap"
                        style={{ gap: "0.5rem" }}
                      >
                        <div className="row row-wrap" style={{ gap: "0.6rem", minWidth: 0 }}>
                          <span className="small bold nowrap" title="Place in the line">
                            #{row.roomPosition}
                          </span>
                          <Avatar
                            name={row.patientName}
                            color={colorFrom(row.patientName)}
                            size="sm"
                          />
                          <div style={{ minWidth: 0 }}>
                            <div className="row row-wrap" style={{ gap: "0.4rem" }}>
                              <strong className="small">
                                {row.patientName ?? "Patient"}
                              </strong>
                              <StatusBadge status={row.state} />
                            </div>
                            <div className="tiny muted">
                              {row.appointment
                                ? `${formatTime(row.appointment.startTime)} · ${
                                    row.appointment.mode === "video" ? "Video" : "In person"
                                  }`
                                : "Appointment not in this schedule"}
                              {row.waited ? ` · waiting ${row.waited}` : ""}
                            </div>
                          </div>
                        </div>
                        {row.appointment && (
                          <StatusActions
                            appointment={row.appointment}
                            onChange={changeStatus}
                            busy={busy}
                            disabled={busyAppt === row.appointment.id || calling}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </section>

        <div id="appointment-management">
        <Tabs
          tabs={[
            { key: "today", label: "Today", count: buckets.today.length },
            {
              key: "upcoming",
              label: "Upcoming",
              count: buckets.upcoming.length,
            },
            { key: "past", label: "History", count: buckets.past.length },
          ]}
          active={tab}
          onChange={setTab}
        />

        <div className="stack-sm">
          {buckets[tab].length === 0 ? (
            <div className="card">
              <EmptyState
                icon="👥"
                title={`No ${tab} appointments`}
                message="Appointments will appear here as patients book."
              />
            </div>
          ) : (
            buckets[tab].map(renderAppt)
          )}
        </div>
      </div>
        </div>

      {/* generate slots modal */}
      <Modal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        title="Add appointment slots"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setGenOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={generateSlots}
              disabled={busy}
            >
              {busy ? "Creating…" : "Create slots"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="field">
            <label className="label" htmlFor="g-date">
              Date
            </label>
            <input
              id="g-date"
              type="date"
              className="input"
              value={genDate}
              min={todayISO()}
              onChange={(e) => setGenDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="g-times">
              Times (one per line, 24h format)
            </label>
            <textarea
              id="g-times"
              className="textarea"
              rows={5}
              value={genTimes}
              onChange={(e) => setGenTimes(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="g-mode">
              Mode
            </label>
            <select
              id="g-mode"
              className="select"
              value={genMode}
              onChange={(e) => setGenMode(e.target.value)}
            >
              <option value="in-person">In person</option>
              <option value="video">Video</option>
            </select>
          </div>
          <Alert tone="info">
            Duplicates are skipped automatically — existing times stay
            untouched.
          </Alert>
        </div>
      </Modal>
    </div>
  );
}
