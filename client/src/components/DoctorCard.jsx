import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import api from "../api/client";
import useDoctorSlots from "../hooks/useDoctorSlots.js";
import { DoctorPhoto, StatusBadge, EmptyState, Spinner, Alert } from "./ui.jsx";
import { isBookableSlot } from "../utils/appointments";
import { useAuth } from "../context/AuthContext.jsx";
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
export function DoctorCard({ doctor }) {
  return (
    <div className="card card-hover">
    <div className="doc-row" style={{ borderRadius: 14 }}>
      <DoctorPhoto doctor={doctor} size="lg" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row row-wrap" style={{ gap: "0.4rem" }}>
          <strong className="truncate">{doctor.name}</strong>
          {!doctor.isAcceptingNew && (
            <span className="badge">Not accepting</span>
          )}
        </div>
        <div className="small" style={{ color: "var(--brand-600)", fontWeight: 600 }}>{doctor.specialtyName}</div>
        <div className="tiny muted">
          ⭐ {doctor.rating} ({doctor.reviewCount} reviews)
        </div>
        <div className="tiny muted">
          🕐 {doctor.experience} yrs experience
        </div>
        <div className="tiny muted truncate">
          📍 {doctor.facilityName}{doctor.city ? `, ${doctor.city}` : ""}
        </div>
      </div>
      <div className="fee">
        <div className="bold">{currency(doctor.consultationFee)}</div>
        <div className="tiny muted" style={{ marginBottom: "0.5rem" }}>Consultation fee</div>
        <div className="stack-sm">
          <Link to={`/doctors/${encodeURIComponent(doctor.id)}?book=1`} className="btn btn-primary btn-sm btn-block">
            Book Appointment
          </Link>
          <Link to={`/doctors/${encodeURIComponent(doctor.id)}`} className="btn btn-ghost btn-sm btn-block">
            View profile
          </Link>
        </div>
      </div>
    </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  BookingPanel — date tabs + slot picker + review + confirmation       *
 *                                                                       *
 *  The review step existed before Phase 7; this improves it rather than   *
 *  replacing it: the summary now names the doctor, spells out the whole   *
 *  window, and shows the facility and fee. What changed most is around    *
 *  it, not inside it:                                                    *
 *                                                                       *
 *  * Availability is asked for as `status=available&futureOnly=true`, so  *
 *    the server does the filtering. The panel used to fetch every slot   *
 *    and filter on `status` alone, which let a slot that had already      *
 *    started be picked and then rejected by the API with SLOT_IN_PAST.    *
 *    `isBookableSlot` re-checks on the client using `startsAt`, as a      *
 *    second line of defence — it decides what is OFFERED, never what is    *
 *    ALLOWED.                                                            *
 *  * A success panel replaces the toast-only outcome, built from the       *
 *    appointment the API actually returned, with a link to it.           *
 *  * The confirm button is disabled while submitting and re-guarded in     *
 *    the handler, so a double click cannot create two bookings.           *
 *                                                                       *
 *  `doctor` is optional and only enriches the review text.                *
 * ------------------------------------------------------------------ */
export function BookingPanel({ doctorId, doctor, onBooked }) {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, booting } = useAuth();
  const { slots, loading, error, refresh } = useDoctorSlots(doctorId, {
    status: "available",
    futureOnly: true,
  });
  const [date, setDate] = useState(null);
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [bookError, setBookError] = useState(null);
  // The appointment the API actually created. Until this is set there is no
  // success state: nothing is shown as booked before the server says so.
  const [booked, setBooked] = useState(null);

  const bookable = useMemo(() => slots.filter((s) => isBookableSlot(s)), [slots]);
  const dates = useMemo(
    () => [...new Set(bookable.map((s) => s.date))].sort(),
    [bookable],
  );

  const slotsForDate = useMemo(
    () => bookable.filter((s) => s.date === date),
    [bookable, date],
  );

  // Default to the first date that actually has availability, and keep the
  // patient's choice when the calendar refreshes.
  useEffect(() => {
    if (!dates.length) return;
    if (date && dates.includes(date)) return;
    setDate(dates[0]);
  }, [dates, date]);

  // A picked slot belongs to the date it was picked from.
  useEffect(() => {
    setSlot((current) => (current && current.date === date ? current : null));
  }, [date]);

  const grouped = {
    "in-person": slotsForDate.filter((s) => s.mode === "in-person"),
    video: slotsForDate.filter((s) => s.mode === "video"),
  };

  const submit = async () => {
    // Re-checked here, not only on the button: a second click that lands while
    // the first request is in flight must not start a second booking.
    if (!slot || busy || booting) return;

    // Booking is the one action here that needs an account. A visitor is sent
    // to sign in — this page rides along in `from`, so login brings them
    // straight back — instead of walking into a 401 they cannot act on.
    if (!user) {
      toast.info("Please sign in to book an appointment");
      navigate("/login", { state: { from: location } });
      return;
    }

    setBusy(true);
    setBookError(null);
    try {
      const res = await api.book({
        doctorId,
        slotId: slot.id,
        reason,
        mode: slot.mode,
      });
      setBooked(res?.appointment || null);
      setReason("");
      setSlot(null);
      toast.success("Appointment booked");
      // Refresh so the slot list reflects what was just taken.
      await refresh();
      onBooked?.();
    } catch (err) {
      // A 401 here means the session ended under us and the request layer's
      // one refresh attempt was not enough. Signing in again is the only way
      // forward, so redirect rather than show an error with no action.
      if (err?.status === 401) {
        toast.info("Please sign in to book an appointment");
        navigate("/login", { state: { from: location } });
        return;
      }
      setBookError(err?.message || "Could not book this appointment");
      toast.error(err?.message || "Could not book this appointment");
      // A conflict means the slot list is stale; pull the current one so the
      // option that just failed is no longer offered.
      if (["SLOT_TAKEN", "PATIENT_CLASH", "SLOT_IN_PAST", "SLOT_BLOCKED"].includes(err?.code)) {
        await refresh();
        setSlot(null);
      }
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

  if (error && !slots.length) {
    return <Alert tone="danger">{error}</Alert>;
  }

  /* ---------------- booked ---------------- */
  if (booked) {
    return (
      <div className="stack">
        <Alert tone="success" title="Appointment booked">
          Your visit with {booked.doctorName} on{" "}
          <strong>{formatDay(booked.date)}</strong> at{" "}
          <strong>
            {formatTime(booked.startTime)}
            {booked.endTime ? ` – ${formatTime(booked.endTime)}` : ""}
          </strong>{" "}
          is confirmed.
          {booked.mode === "video" ? " It is a video consultation." : ""}
        </Alert>

        <div className="row row-wrap" style={{ gap: "0.5rem" }}>
          {booked.id && (
            <Link
              to={`/appointments/${encodeURIComponent(booked.id)}`}
              className="btn btn-primary btn-sm"
            >
              View appointment
            </Link>
          )}
          <Link to="/appointments" className="btn btn-secondary btn-sm">
            My appointments
          </Link>
          <Link to="/doctors" className="btn btn-ghost btn-sm">
            Find another doctor
          </Link>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            setBooked(null);
            setDate(null);
          }}
        >
          Book another slot
        </button>
      </div>
    );
  }

  /* ---------------- nothing available ---------------- */
  if (!dates.length) {
    return (
      <EmptyState
        icon="🗓️"
        title="No upcoming availability"
        message="This doctor has no open slots you can book right now. Check back later or find someone else."
        action={
          <Link to="/doctors" className="btn btn-primary btn-sm">
            Find a doctor
          </Link>
        }
      />
    );
  }

  return (
    <div className="stack">
      {/* date selector */}
      <div
        className="row"
        style={{ gap: "0.4rem", overflowX: "auto", paddingBottom: 4 }}
      >
        {dates.map((d) => {
          const open = bookable.filter((s) => s.date === d).length;
          return (
            <button
              key={d}
              type="button"
              className={cx(
                "btn btn-sm",
                date === d ? "btn-primary" : "btn-secondary",
              )}
              aria-pressed={date === d}
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
          title="No open slots on this day"
          message="Pick another date to see availability."
        />
      ) : (
        <>
          <div className="row-between">
            <span className="small muted">
              {formatDay(date)} · {relativeDay(date)}
            </span>
            <span className="small bold">
              {slotsForDate.length} available
            </span>
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
                <div
                  className="row row-wrap"
                  style={{ gap: "0.4rem" }}
                  role="group"
                  aria-label={
                    m === "video" ? "Video consultation slots" : "In-person slots"
                  }
                >
                  {grouped[m].map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className={cx(
                        "btn btn-sm",
                        slot?.id === s.id ? "btn-primary" : "btn-secondary",
                      )}
                      aria-pressed={slot?.id === s.id}
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

      {/* Kept OUTSIDE the review block on purpose. A conflict clears the
          selection (the slot is gone), and an error shown only while a slot is
          selected would vanish at the exact moment the patient needs to read it. */}
      {bookError && <Alert tone="danger">{bookError}</Alert>}

      {/* ---------------- review + confirm ---------------- */}
      {slot && (
        <div
          className="stack-sm"
          style={{
            borderTop: "1px solid var(--gray-200)",
            paddingTop: "0.9rem",
          }}
        >
          <div className="alert alert-info">
            <span aria-hidden="true">📅</span>
            <div>
              <strong>Review your appointment</strong>
              <dl
                className="small"
                style={{
                  margin: "0.35rem 0 0",
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "0.15rem 0.6rem",
                }}
              >
                <dt className="muted">Doctor</dt>
                <dd style={{ margin: 0 }}>
                  {doctor?.name || "Selected doctor"}
                  {doctor?.specialtyName ? (
                    <span className="muted"> · {doctor.specialtyName}</span>
                  ) : null}
                </dd>

                <dt className="muted">Date</dt>
                <dd style={{ margin: 0 }}>
                  {formatDay(slot.date)} · {relativeDay(slot.date)}
                </dd>

                <dt className="muted">Time</dt>
                <dd style={{ margin: 0 }}>
                  {formatTime(slot.startTime)}
                  {slot.endTime ? ` – ${formatTime(slot.endTime)}` : ""}
                </dd>

                <dt className="muted">Mode</dt>
                <dd style={{ margin: 0 }}>
                  {slot.mode === "video" ? "Video consultation" : "In person"}
                </dd>

                {doctor?.facilityName && (
                  <>
                    <dt className="muted">Facility</dt>
                    <dd style={{ margin: 0 }}>{doctor.facilityName}</dd>
                  </>
                )}

                {slot.fee ? (
                  <>
                    <dt className="muted">Fee</dt>
                    <dd style={{ margin: 0 }}>{currency(slot.fee)}</dd>
                  </>
                ) : null}
              </dl>
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
              maxLength={500}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={submit}
            disabled={busy || booting}
          >
            {busy ? (
              <>
                <Spinner /> Booking…
              </>
            ) : (
              "Confirm booking"
            )}
          </button>
          <p className="tiny muted" style={{ margin: 0 }}>
            The slot is held only once the booking is confirmed.
          </p>
        </div>
      )}
    </div>
  );
}
export default DoctorCard;
