import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { Avatar, StatusBadge, EmptyState, Spinner, Alert } from "./ui.jsx";
import { useToast } from "../context/ToastContext.jsx";
import {
  currency,
  dayNum,
  formatDay,
  formatTime,
  relativeDay,
  weekdayShort,
  cx,
} from "../utils/format";

/* ------------------------------------------------------------------ *
 *  DoctorCard — used on home + directory                            *
 * ------------------------------------------------------------------ */
export function DoctorCard({ doctor, showMatch }) {
  return (
    <div className="card card-hover card-pad stack-sm">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Avatar name={doctor.name} color={doctor.imageColor} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row row-wrap" style={{ gap: "0.4rem" }}>
            <strong className="truncate">{doctor.name}</strong>
            {showMatch && doctor.matchScore !== undefined && (
              <span className="badge badge-success">
                {Math.round(doctor.matchScore)}% match
              </span>
            )}
            {!doctor.isAcceptingNew && (
              <span className="badge">Not accepting</span>
            )}
          </div>
          <div className="small muted">{doctor.specialtyName}</div>
          <div className="tiny muted truncate">
            {doctor.facilityName} · {doctor.city}
          </div>
        </div>
      </div>

      <div className="row row-wrap small" style={{ gap: "0.75rem" }}>
        <span>
          ⭐ {doctor.rating} ({doctor.reviewCount})
        </span>
        <span className="muted">{doctor.experience} yrs exp</span>
        <span className="bold">{currency(doctor.consultationFee)}</span>
      </div>

      <div className="row" style={{ gap: "0.5rem" }}>
        <Link
          to={`/doctors/${doctor.id}`}
          className="btn btn-secondary btn-sm"
          style={{ flex: 1 }}
        >
          View profile
        </Link>
        <Link
          to={`/doctors/${doctor.id}?book=1`}
          className="btn btn-primary btn-sm"
          style={{ flex: 1 }}
        >
          Book now
        </Link>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  BookingPanel — date tabs + slot picker + confirm                  *
 * ------------------------------------------------------------------ */
export function BookingPanel({ doctorId, onBooked }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(null);
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("in-person");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async (selectedDate) => {
    try {
      const res = await api.doctorSlots(doctorId);
      setData(res);
      // Default to the first date that actually has availability.
      const firstOpen =
        selectedDate ||
        res.dates.find((d) =>
          res.slots.some((s) => s.date === d && s.status === "available"),
        ) ||
        res.dates[0];
      setDate(firstOpen);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId]);

  const slotsForDate = (data?.slots || []).filter((s) => s.date === date);
  const freeSlots = slotsForDate.filter((s) => s.status === "available");

  // Reset the picked slot whenever the date or mode changes.
  useEffect(() => setSlot(null), [date, mode]);

  const grouped = {
    "in-person": freeSlots.filter((s) => s.mode === "in-person"),
    video: freeSlots.filter((s) => s.mode === "video"),
  };

  const submit = async () => {
    if (!slot) return;
    setBusy(true);
    try {
      await api.book({ doctorId, slotId: slot.id, reason, mode: slot.mode });
      toast.success("Appointment booked — confirmation sent");
      setReason("");
      setSlot(null);
      await load(date);
      onBooked?.();
    } catch (err) {
      toast.error(err.message);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div
        className="row"
        style={{ justifyContent: "center", padding: "2rem" }}
      >
        <Spinner large />
      </div>
    );
  }

  if (error && !data) {
    return <Alert tone="danger">{error}</Alert>;
  }

  return (
    <div className="stack">
      {/* date selector */}
      <div
        className="row"
        style={{ gap: "0.4rem", overflowX: "auto", paddingBottom: 4 }}
      >
        {(data?.dates || []).map((d) => {
          const open = (data.slots || []).filter(
            (s) => s.date === d && s.status === "available",
          ).length;
          return (
            <button
              key={d}
              type="button"
              className={cx(
                "btn btn-sm",
                date === d ? "btn-primary" : "btn-secondary",
              )}
              style={{
                flexDirection: "column",
                gap: 0,
                minWidth: 74,
                padding: "0.45rem 0.5rem",
              }}
              onClick={() => setDate(d)}
              title={formatDay(d)}
            >
              <span style={{ fontSize: "0.66rem", opacity: 0.85 }}>
                {weekdayShort(d)}
              </span>
              <span style={{ fontWeight: 700 }}>{dayNum(d)}</span>
              <span style={{ fontSize: "0.62rem", opacity: 0.85 }}>
                {open} open
              </span>
            </button>
          );
        })}
      </div>

      {slotsForDate.length === 0 ? (
        <EmptyState
          icon="🗓️"
          title="No slots on this day"
          message="Pick another date to see availability."
        />
      ) : (
        <>
          <div className="row-between">
            <span className="small muted">
              {formatDay(date)} · {relativeDay(date)}
            </span>
            <span className="small bold">{freeSlots.length} available</span>
          </div>

          {["in-person", "video"]
            .filter((m) => grouped[m].length > 0)
            .map((m) => (
              <div key={m} className="stack-sm">
                <div
                  className="tiny muted bold"
                  style={{ textTransform: "uppercase" }}
                >
                  {m === "video" ? "Video consultation" : "In person"}
                </div>
                <div className="row row-wrap" style={{ gap: "0.4rem" }}>
                  {grouped[m].map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={cx(
                        "btn btn-sm",
                        slot?.id === s.id ? "btn-primary" : "btn-secondary",
                      )}
                      onClick={() => setSlot(s)}
                    >
                      {formatTime(s.startTime)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </>
      )}

      {/* confirm */}
      {slot && (
        <div
          className="stack-sm"
          style={{
            borderTop: "1px solid var(--gray-200)",
            paddingTop: "0.9rem",
          }}
        >
          <div className="alert alert-info">
            <span>📅</span>
            <div>
              <strong>
                {formatDay(slot.date)} at {formatTime(slot.startTime)}
              </strong>
              <div className="small">
                {slot.mode === "video" ? "Video consultation" : "In person"} ·{" "}
                {currency(slot.fee)}
              </div>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="reason">
              Reason for visit (optional)
            </label>
            <input
              id="reason"
              className="input"
              placeholder="e.g. Chest discomfort for 2 weeks"
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={submit}
            disabled={busy}
          >
            {busy ? <Spinner /> : "Confirm booking"}
          </button>
        </div>
      )}

      {/* already booked / blocked summary */}
      {slotsForDate.some((s) => s.status === "booked") && (
        <p className="tiny muted">
          {slotsForDate.filter((s) => s.status === "booked").length} slot(s)
          already taken.
        </p>
      )}
      {slotsForDate.some((s) => s.status === "blocked") && (
        <p className="tiny muted">
          {slotsForDate.filter((s) => s.status === "blocked").length} slot(s)
          blocked by the provider.
        </p>
      )}
    </div>
  );
}

export default DoctorCard;
