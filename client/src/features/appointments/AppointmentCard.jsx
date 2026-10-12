import { Link } from "react-router-dom";

import { StatusBadge } from "../../components/ui.jsx";
import {
  currency,
  dayNum,
  formatTime,
  monthShort,
  relativeDay,
  weekdayShort,
} from "../../utils/format";

/* ------------------------------------------------------------------ *
 *  AppointmentCard — one appointment, as a row.                        *
 *                                                                       *
 *  Extracted in Phase 7 (task 7.8) because the same block of markup —     *
 *  date chip, doctor, badges, specialty, time — was written twice: once in *
 *  MyAppointments and once on the patient dashboard.                     *
 *                                                                       *
 *  WHAT THIS COMPONENT DELIBERATELY DOES NOT OWN                         *
 *  -------------------------------------------------------               *
 *  * It never calls the API. Booking, rescheduling, cancelling and        *
 *    check-in stay with the page, which already owns those modals and    *
 *    their error handling. Actions arrive as a `node` and are rendered   *
 *    as given.                                                           *
 *  * It holds no appointment rules. Whether an appointment can be        *
 *    rescheduled, cancelled or checked in is decided by the caller using  *
 *    the shared predicates in utils/appointments.js; this component only  *
 *    displays what it is told.                                           *
 *  * It renders no links of its own accord. A caller may pass `to`, in which
 *    case the doctor name becomes a link to a route that caller has confirmed
 *    exists — the component never invents a destination.                   *
 *                                                                       *
 *  It renders the inner row only. The caller owns the surrounding         *
 *  container, so the same row works inside a `card card-pad` on the       *
 *  appointments page and bare inside a card body on the dashboard.        *
 * ------------------------------------------------------------------ */

const MODE_LABEL = { video: "Video", "in-person": "In person" };

/** Calendar chip. `full` adds the month, which the appointments page shows. */
function DateChip({ iso, full }) {
  return (
    <div
      className="center"
      style={{
        width: full ? 60 : 46,
        flexShrink: 0,
        padding: full ? "0.45rem 0" : "0.3rem 0",
        background: "var(--brand-50)",
        borderRadius: 10,
      }}
    >
      <div className="tiny muted bold">{weekdayShort(iso)}</div>
      <div
        className="bold"
        style={{ lineHeight: full ? 1.1 : 1.05, fontSize: full ? "1.15rem" : "1rem" }}
      >
        {dayNum(iso)}
      </div>
      {full && <div className="tiny muted">{monthShort(iso)}</div>}
    </div>
  );
}

/**
 * @param {object} appointment  an item from the GET /appointments projection.
 * @param {"compact"|"full"} [variant]
 *   `full`   — the appointments page: month on the chip, facility, fee,
 *              relative day, reason and cancellation reason.
 *   `compact`— the dashboard's recent list: time and specialty, with the
 *              date usually supplied through `trailing`.
 * @param {React.ReactNode} [actions]   right-hand action column, supplied by
 *   the caller. Renders nothing when omitted, so a read-only list needs no
 *   special-casing.
 * @param {React.ReactNode} [trailing]  right-hand meta shown on the last line.
 * @param {string} [to]  when given, the doctor name becomes a real link to
 *   this route. A link rather than an onClick on the whole row, because the
 *   row also contains buttons: wrapping the card in a click handler would make
 *   every button inside it ambiguous to click and unreachable by keyboard.
 */
export function AppointmentCard({
  appointment,
  variant = "full",
  actions = null,
  trailing = null,
  to = null,
}) {
  if (!appointment) return null;

  const full = variant === "full";
  const a = appointment;

  return (
    <div className="row row-wrap" style={{ alignItems: "flex-start" }}>
      <DateChip iso={a.date} full={full} />

      <div style={{ flex: 1, minWidth: full ? 220 : 160 }}>
        <div className="row row-wrap" style={{ gap: "0.45rem" }}>
          {to ? (
            <Link to={to} className="bold truncate" style={{ color: "inherit" }}>
              {a.doctorName}
            </Link>
          ) : (
            <strong className="truncate">{a.doctorName}</strong>
          )}
          <StatusBadge status={a.status} />
          {a.mode === "video" && <span className="badge badge-violet">Video</span>}
          {/* Where this patient is in the waiting room, and nothing about
              anyone else. `queuePosition` is the place in the LINE, so a patient
              already with the doctor has none and shows a state instead. */}
          {a.queuePosition ? (
            <span className="badge badge-info">Queue #{a.queuePosition}</span>
          ) : a.queueState === "in-consultation" ? (
            <span className="badge badge-info">In consultation</span>
          ) : null}
        </div>

        {full ? (
          <>
            <div className="small muted">
              {a.specialtyName}
              {a.facilityName ? ` · ${a.facilityName}` : ""}
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
          </>
        ) : (
          <div className="small muted truncate">
            {formatTime(a.startTime)} · {a.specialtyName}
          </div>
        )}
      </div>

      {trailing && (
        <div className="tiny muted nowrap" style={{ marginLeft: "auto" }}>
          {trailing}
        </div>
      )}

      {actions}
    </div>
  );
}

export { MODE_LABEL };
export default AppointmentCard;