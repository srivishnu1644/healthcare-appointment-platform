import { useEffect, useMemo, useState } from "react";

import api from "../../api/client";
import { useToast } from "../../context/ToastContext.jsx";
import { Alert, Modal, Spinner } from "../../components/ui.jsx";
import useDoctorSlots from "../../hooks/useDoctorSlots.js";
import { isBookableSlot } from "../../utils/appointments";
import { formatDay, formatTime } from "../../utils/format";

/* ------------------------------------------------------------------ *
 *  AppointmentModals — cancel and reschedule, shared by the list and    *
 *  the detail page.                                                     *
 *                                                                       *
 *  Extracted in Phase 7 (Step 5) so the detail page could offer the same *
 *  actions without a second copy of this logic. The behaviour is exactly  *
 *  what MyAppointments.jsx did before the extraction.                    *
 *                                                                       *
 *  WHAT LIVES HERE AND WHAT DOES NOT                                     *
 *  -------------------------------------------------------             *
 *  Here: the form state, the API call, the toast, and the slot fetch.    *
 *  NOT here: any appointment rule. Whether an appointment may be         *
 *  cancelled or rescheduled at all is the CALLER's decision — these       *
 *  components assume they were handed an appointment worth acting on and *
 *  let the server have the final say. Every refusal still comes back as   *
 *  an error toast exactly as before.                                     *
 *                                                                       *
 *  `onDone` is how the caller learns something changed, so it can refresh *
 *  its own list. No shared state, no refetching behind the caller's back. *
 * ------------------------------------------------------------------ */

/**
 * Cancel an appointment. Mirrors the previous inline modal.
 * @param {object|null} appointment  null closes the dialog
 * @param {Function} onClose         called when it closes, with or without change
 * @param {Function} [onDone]        called after a successful cancellation
 */
export function CancelModal({ appointment, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Reset the form each time a different appointment is opened.
  useEffect(() => {
    if (appointment) {
      setReason("");
      setError(null);
    }
  }, [appointment?.id]);

  const submit = async () => {
    if (!appointment) return;
    setBusy(true);
    setError(null);
    try {
      await api.cancel(
        appointment.id,
        reason.trim() || "Cancelled by patient",
      );
      toast.success("Appointment cancelled");
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err.message);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(appointment)}
      onClose={onClose}
      title="Cancel appointment"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "Cancelling…" : "Yes, cancel"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Cancelling with <strong>{appointment?.doctorName}</strong> on{" "}
          <strong>{formatDay(appointment?.date)}</strong> at{" "}
          <strong>{formatTime(appointment?.startTime)}</strong>.
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
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Alert tone="info">
          The slot is released back to the doctor and you&apos;ll be notified.
        </Alert>
      </div>
    </Modal>
  );
}

/**
 * Move an appointment to a different slot. Mirrors the previous inline modal.
 */
export function RescheduleModal({ appointment, onClose, onDone }) {
  const toast = useToast();
  const [slot, setSlot] = useState(null);
  const [date, setDate] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const {
    slots: allSlots,
    loading,
    error: slotsError,
  } = useDoctorSlots(appointment?.doctorId, {
    status: "available",
    futureOnly: true,
  });

  // The picker used to derive its dates from the raw slot list, which included
  // seven days of already-past availability that the API then rejected with
  // SLOT_IN_PAST. Asking the server for `futureOnly` and re-checking on
  // `startsAt` removes them before the patient can choose one.
  //
  // The appointment's own slot is excluded too: moving an appointment to the
  // slot it already occupies is not a change.
  const openSlots = useMemo(
    () =>
      allSlots.filter(
        (s) => isBookableSlot(s) && s.id !== appointment?.slotId,
      ),
    [allSlots, appointment?.slotId],
  );

  const dates = useMemo(
    () => [...new Set(openSlots.map((s) => s.date))],
    [openSlots],
  );

  // Default to the first date with an open slot, and keep the patient's choice
  // when the list refreshes.
  useEffect(() => {
    if (!dates.length) return;
    if (date && dates.includes(date)) return;
    setDate(dates[0]);
  }, [dates, date]);

  useEffect(() => {
    if (appointment) {
      setSlot(null);
      setDate(null);
      setError(null);
    }
  }, [appointment?.id]);

  const slotsForDate = openSlots.filter((s) => s.date === date);

  const submit = async () => {
    // Guarded again in the handler: a double click must not send two moves.
    if (!appointment || !slot || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reschedule(appointment.id, slot.id);
      toast.success("Appointment rescheduled");
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err.message);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(appointment)}
      onClose={onClose}
      title="Reschedule appointment"
      /* Opaque panel: this dialog is mostly a wall of small time buttons, and
         on the shared glass those sat on a tint of whatever was behind the
         dialog, which made the selected one hard to pick out. */
      variant="solid"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || loading || !slot}
          >
            {busy ? "Updating…" : "Confirm new time"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Currently <strong>{formatDay(appointment?.date)}</strong> at{" "}
          <strong>{formatTime(appointment?.startTime)}</strong> with{" "}
          <strong>{appointment?.doctorName}</strong>.
        </p>

        {error && <Alert tone="danger">{error}</Alert>}

        {loading ? (
          <div
            className="row"
            style={{ justifyContent: "center", padding: "1.25rem" }}
          >
            <Spinner large />
          </div>
        ) : slotsError ? (
          <Alert tone="danger">{slotsError}</Alert>
        ) : (
          <>
            <div className="row" style={{ gap: "0.4rem", overflowX: "auto" }}>
              {dates.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`btn btn-sm ${
                    date === d ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => {
                    setDate(d);
                    setSlot(null);
                  }}
                >
                  {formatDay(d)}
                </button>
              ))}
            </div>

            <div className="row row-wrap" style={{ gap: "0.4rem" }}>
              {slotsForDate.length === 0 ? (
                <p className="small muted">No open slots on this day.</p>
              ) : (
                slotsForDate.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`btn btn-sm ${
                      slot?.id === s.id ? "btn-primary" : "btn-secondary"
                    }`}
                    aria-pressed={slot?.id === s.id}
                    onClick={() => setSlot(s)}
                  >
                    {formatTime(s.startTime)}
                  </button>
                ))
              )}
            </div>

            {/* The chosen replacement, stated plainly before anything is sent. */}
            {slot && (
              <Alert tone="info">
                Moving to <strong>{formatDay(slot.date)}</strong> at{" "}
                <strong>{formatTime(slot.startTime)}</strong>
                {slot.endTime ? ` – ${formatTime(slot.endTime)}` : ""} ·{" "}
                {slot.mode === "video" ? "Video consultation" : "In person"}.
              </Alert>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default { CancelModal, RescheduleModal };