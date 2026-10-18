import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { useAuth } from "../context/AuthContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import {
  Alert,
  Avatar,
  EmptyState,
  Loading,
  Stat,
  StatusBadge,
  Tabs,
} from "../components/ui.jsx";
import {
  colorFrom,
  currency,
  cx,
  formatDay,
  formatTime,
  label,
  relativeDay,
  todayISO,
} from "../utils/format";

import {
  LIVE_STATUSES,
  byStartAscending,
  startInstant,
  summariseDay,
} from "../utils/appointments";

/**
 * A stable stand-in for "no slots", so the memos below have something to
 * compare against before the schedule has loaded. A fresh `[]` written inline
 * would be a new array on every render, which is the exact thing those memos
 * exist to stop.
 */
const EMPTY_SLOTS = [];
import AdvancingCard from "../features/appointments/AdvancingCard.jsx";
import useOutwardWipe from "../features/appointments/useOutwardWipe.js";
import GenerateSlotsModal from "../features/schedule/GenerateSlotsModal.jsx";

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
 * One place to decide what is OFFERED and how it is submitted, so every row of
 * the appointment list behaves the same way. `className` tags the bar for the
 * stage-advance stagger and `onClickCapture` carries the outward wipe — which is
 * why the effect is delegated from here instead of being folded into the
 * per-status `onChange`, whose job is the request, not the feedback.
 *
 * Every transition wears the same `appt-btn` fill. The old green / glassy /
 * red split is gone: it read as three competing materials, and the destructive
 * ones are still the ones a provider reaches for deliberately, on a row that is
 * already unambiguous about what clicking will do.
 */
function StatusActions({ appointment, onChange, busy, disabled, className, onClickCapture }) {
  const actions = STATUS_ACTIONS[appointment.status] || [];
  if (actions.length === 0) return null;
  return (
    <div
      className={cx("row row-wrap", className)}
      style={{ gap: "0.35rem" }}
      onClickCapture={onClickCapture}
    >
      {actions.map((s) => (
        <button
          key={s}
          type="button"
          className="btn appt-btn btn-sm"
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

  // Replays the outward wipe on whichever transition was clicked.
  const onWipe = useOutwardWipe();

  // The date whose slots the schedule card is showing. It follows today until
  // the provider picks another, so the initial paint costs no extra request.
  const [dayDate, setDayDate] = useState(todayISO());
  const [daySlots, setDaySlots] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState(null);
  const [dayRetry, setDayRetry] = useState(0);


  // The slot dialog owns its own form state (date, times, length, mode), so
  // all this page keeps is whether it is open.
  const [genOpen, setGenOpen] = useState(false);

  // The session already carries the provider record, so the schedule needs no
  // second request to resolve it.
  const doctorId = user?.doctor?.id ?? null;

  const load = useCallback(async () => {
    const day = todayISO();
    try {
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
   * harness so it can be exercised against controlled data. No `checkedInIds`
   * is passed: check-in lives in the waiting room, which this page no longer
   * renders, so `checkedIn` is not read here.
   */
  const overview = useMemo(
    () => summariseDay(data?.appointments || [], { today }),
    [data, today],
  );

  /**
   * Memoised because this array is handed to the slot dialog as
   * `existingSlots`, and an inline `.filter()` gave it a new identity on every
   * render. The dialog keys its open/close reset on that prop, and that reset
   * clears `deleting` — so a plain re-render was enough to bounce the provider
   * out of delete mode and back into the add form. It also re-rendered every
   * row of the schedule card below for nothing.
   *
   * Above the early returns, because they are hooks and the two returns below
   * are conditional: a hook called after them would be skipped whenever the
   * page took the loading or error branch, and React would throw on the change
   * in hook count. `EMPTY_SLOTS` rather than `?? []` so the no-data render
   * still hands the memo a stable array to compare against.
   */
  const scheduleSlots = data?.slots ?? EMPTY_SLOTS;
  const todaysSlots = useMemo(
    () => scheduleSlots.filter((s) => s.date === today),
    [scheduleSlots, today],
  );
  // Today's slots arrive with the schedule call; any other date is fetched
  // separately, so no request is made until the provider picks a day.
  const shownSlots = useMemo(
    () => (dayDate === today ? todaysSlots : (daySlots ?? EMPTY_SLOTS)),
    [dayDate, today, todaysSlots, daySlots],
  );

  if (loading) return <Loading label="Loading your schedule…" />;

  if (error || !data?.doctor) {
    return (
      <div className="page page-glass-bg">
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

  const { doctor } = data;
  const shownDate = dayDate;
  const isToday = dayDate === today;

  /**
   * Re-read everything after slots changed, optionally landing the strip on a
   * particular day first.
   *
   * One rule, because there were two copies of it and they had already drifted:
   * today's slots arrive with the schedule call, so any other day is a separate
   * request and has to be asked for again or the strip keeps showing the state
   * from before the change. Every mutation that can alter a slot's existence or
   * status routes through here.
   *
   * `focusDate` is passed rather than read, because a caller that has just
   * called `setDayDate` still sees the old value in this closure. When it
   * matches the day already showing, the retry counter is bumped instead: the
   * fetch effect keys off `dayDate`, so an unchanged date would never refetch.
   */
  const afterSlotsChanged = async (focusDate) => {
    const target = focusDate ?? dayDate;
    if (focusDate && focusDate !== dayDate) setDayDate(focusDate);
    else if (focusDate) setDayRetry((n) => n + 1);

    await load();

    const shown = focusDate ?? dayDate;
    if (shown !== todayISO() && doctorId) {
      const fresh = await api.doctorSlots(doctorId, { date: shown });
      setDaySlots(fresh.slots ?? []);
    }
  };

  const setSlotStatus = async (slot, status) => {
    setBusy(true);
    try {
      await api.updateSlot(doctor.id, slot.id, { status });
      toast.success(`Slot ${status}`);
      await afterSlotsChanged();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
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
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyAppt(null);
    }
  };



  /**
   * Publish availability.
   *
   * The payload comes straight from the dialog, which can only produce times
   * the API accepts. The re-check below is kept anyway: the server is the
   * authority, and this handler is the one place the payload is shaped for the
   * wire, so it is the right place for the guard.
   */
  const generateSlots = async ({ date, times, duration, mode }) => {
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
        date,
        times,
        duration,
        mode,
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
      // Land on the day that was just filled, so the provider can see the
      // result rather than an unchanged strip.
      await afterSlotsChanged(date);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const renderAppt = (a) => {
    return (
      <AdvancingCard key={a.id} stage={a.status} className="card card-pad">
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
            className="appt-btn-group appt-actions-inline"
            onClickCapture={onWipe}
          />
        </div>
      </AdvancingCard>
    );
  };

  return (
    <div className="page page-glass-bg">
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
          <div className="grid grid-3">
            <Stat
              label="Appointments"
              value={overview.todayCount}
              sub={`${overview.liveCount} still live`}
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

        {/* One clinic day at a time; `dayDate` picks which. */}
        <div className="card">
          <div className="card-head">
            <h3>Schedule</h3>
            <div className="row row-wrap" style={{ gap: "0.75rem" }}>
              {/* Two things keep the date control inside its own box.
                  `nowrap` is deliberately absent: this line is the widest thing
                  in the header, and pinning it to one row pushed the card past
                  a phone's viewport. And the input opts out of `.input`'s
                  `width: 100%` - that percentage resolves against the label's
                  content box, so the field came out as wide as the label while
                  still starting after the "Date " text, spilling out both sides
                  and painting over the counts beside it. */}
              <label className="small muted" htmlFor="schedule-date">
                Date{" "}
                <input
                  id="schedule-date"
                  type="date"
                  className="input"
                  value={dayDate}
                  onChange={(e) => setDayDate(e.target.value || todayISO())}
                  style={{ width: "auto", marginLeft: "0.35rem" }}
                />
              </label>
              {/* No `nowrap` here either: the same width argument applies. */}
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

      {/* Generate slots.

          `shownSlots` is handed over so the dialog can strike through times
          this doctor has already published. It is only the day the schedule
          card happens to be showing, which is why the server's skip report
          still matters. */}
      <GenerateSlotsModal
        open={genOpen}
        onClose={() => setGenOpen(false)}
        onSubmit={generateSlots}
        busy={busy}
        initialDate={dayDate}
        existingSlots={shownSlots}
        doctorId={doctorId}
        onDeleted={afterSlotsChanged}
      />
    </div>
  );
}
