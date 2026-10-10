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
  ProgressBar,
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

const STATUS_ACTIONS = {
  scheduled: ["confirmed", "cancelled", "no-show"],
  confirmed: ["in-progress", "cancelled", "no-show"],
  "in-progress": ["completed", "no-show"],
};

export default function ProviderDashboard() {
  const { user } = useAuth();
  const toast = useToast();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("today");
  const [busy, setBusy] = useState(false);

  const [genOpen, setGenOpen] = useState(false);
  const [genDate, setGenDate] = useState(todayISO());
  const [genTimes, setGenTimes] = useState("09:00\n09:30\n10:00\n10:30");
  const [genMode, setGenMode] = useState("in-person");

  const load = useCallback(async () => {
    try {
      const res = await api.mySchedule();
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

  if (loading) return <Loading label="Loading your schedule…" />;

  if (error || !data?.doctor) {
    return (
      <div className="page">
        <div className="container">
          <Alert tone="danger">
            {error || "No provider profile linked to this account"}
          </Alert>
        </div>
      </div>
    );
  }

  const { doctor, slots, summary } = data;
  const todaysSlots = slots.filter((s) => s.date === today);

  const setSlotStatus = async (slot, status) => {
    setBusy(true);
    try {
      await api.updateSlot(doctor.id, slot.id, { status });
      toast.success(`Slot ${status}`);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (appt, status) => {
    setBusy(true);
    try {
      await api.changeStatus(appt.id, status, `Marked ${status} by doctor`);
      toast.success(`Appointment ${status}`);
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
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
    const actions = STATUS_ACTIONS[a.status] || [];
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
          {actions.length > 0 && (
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
                  onClick={() => changeStatus(a, s)}
                  disabled={busy}
                >
                  {label(s)}
                </button>
              ))}
            </div>
          )}
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

        {/* KPIs */}
        <div className="grid grid-4">
          <Stat
            label="Today"
            value={buckets.today.length}
            sub={`${todaysSlots.length} slots`}
          />
          <Stat
            label="Open slots"
            value={todaysSlots.filter((s) => s.status === "available").length}
            sub="today"
          />
          <Stat
            label="Utilisation"
            value={`${summary?.utilizationPercent ?? 0}%`}
            sub="today"
          />
          <Stat
            label="Upcoming"
            value={buckets.upcoming.length}
            sub="future appointments"
          />
        </div>

        {/* today's slot strip */}
        <div className="card">
          <div className="card-head">
            <h3>Today's slots</h3>
            <span className="small muted">{formatDay(today)}</span>
          </div>
          <div className="card-body">
            {todaysSlots.length === 0 ? (
              <EmptyState
                icon="🗓️"
                title="No slots today"
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
                {todaysSlots.map((s) => (
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
