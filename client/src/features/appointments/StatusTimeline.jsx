import { EmptyState, StatusBadge } from "../../components/ui.jsx";
import { formatDateTime } from "../../utils/format";

/* ------------------------------------------------------------------ *
 *  StatusTimeline — the REAL history of one appointment.               *
 *                                                                       *
 *  Data comes from GET /api/appointments/:id -> `history`, which is the  *
 *  appointment_status_history table:                                                   *
 *                                                                       *
 *    { id, fromStatus, toStatus, changedBy, changedByName, note,          *
 *      createdAt }                                                     *
 *                                                                       *
 *  `fromStatus` is null on the creation entry, and `changedBy` is null   *
 *  for system-initiated transitions. Both are shown honestly rather than *
 *  being smoothed over.                                                *
 *                                                                       *
 *  WHAT THIS DELIBERATELY DOES NOT DO                                   *
 *  -------------------------------------------------------             *
 *  It does not synthesise the usual journey. A booked appointment that   *
 *  has not been checked in has exactly one event and this renders one    *
 *  event. There is no greyed-out "Checked in" placeholder, because       *
 *  showing a step that never happened is a lie. An empty history renders  *
 *  an empty state, not an assumed starting point.                       *
 *                                                                       *
 *  It uses only existing CSS primitives; no stylesheet change.           *
 * ------------------------------------------------------------------ */

/** Plain-language label for a status value. */
const STATUS_LABEL = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  "in-progress": "Checked in",
  completed: "Completed",
  cancelled: "Cancelled",
  "no-show": "No-show",
};

const labelFor = (status) => STATUS_LABEL[status] || status || "—";

/**
 * @param {Array} history  the `history` array from the detail endpoint.
 */
export function StatusTimeline({ history }) {
  const events = Array.isArray(history) ? history : [];

  if (events.length === 0) {
    return (
      <EmptyState
        icon="🕓"
        title="No status history recorded"
        message="Nothing has been logged against this appointment yet."
      />
    );
  }

  // The API already orders by created_at, id. Sorting again keeps the display
  // correct if that ever changes; the id tie-break keeps same-instant events
  // in the order the database recorded them.
  const ordered = [...events].sort((a, b) => {
    const ta = Date.parse(a.createdAt || "") || 0;
    const tb = Date.parse(b.createdAt || "") || 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id || 0) - Number(b.id || 0);
  });

  return (
    <ol className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {ordered.map((e, i) => {
        const isLast = i === ordered.length - 1;
        const moved = Boolean(e.fromStatus) && e.fromStatus !== e.toStatus;
        return (
          <li
            key={e.id ?? `${e.createdAt}-${i}`}
            className="row"
            style={{ alignItems: "flex-start", gap: "0.75rem" }}
          >
            {/* marker + connector, drawn with a plain div so no CSS is needed */}
            <span
              aria-hidden="true"
              style={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                alignSelf: "stretch",
                flexShrink: 0,
                paddingTop: 5,
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  background: "var(--brand-600)",
                  boxShadow: "0 0 0 3px var(--brand-50)",
                  flexShrink: 0,
                }}
              />
              {!isLast && (
                <span
                  style={{
                    flex: 1,
                    width: 2,
                    marginTop: 4,
                    background: "var(--gray-200)",
                  }}
                />
              )}
            </span>

            <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : "0.35rem" }}>
              <div
                className="row row-wrap"
                style={{ gap: "0.45rem", alignItems: "center" }}
              >
                <strong className="small">{labelFor(e.toStatus)}</strong>
                {moved && (
                  <span className="tiny muted nowrap">
                    from {labelFor(e.fromStatus)}
                  </span>
                )}
                <StatusBadge status={e.toStatus} />
              </div>

              <div className="tiny muted">
                <time dateTime={e.createdAt}>{formatDateTime(e.createdAt)}</time>
                {e.changedByName ? ` · by ${e.changedByName}` : ""}
                {!e.changedByName && " · automatically"}
              </div>

              {e.note && <div className="tiny muted">{e.note}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default StatusTimeline;