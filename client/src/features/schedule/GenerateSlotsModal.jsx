/* ------------------------------------------------------------------ *
 *  GenerateSlotsModal — "Add appointment slots"                       *
 * ------------------------------------------------------------------ *
 *  WHAT THIS IS FOR
 *  A provider publishes availability by naming the times they will see
 *  patients on one day. This dialog collects that.
 *
 *  WHY IT IS NOT A TEXTAREA
 *  It used to be, and it asked a doctor to type a wall of "09:00\n09:30\n…".
 *  That pushed every mistake to the server: a "9am" or a forgotten comma was
 *  discovered on submit, as a toast, next to a field the doctor had already
 *  looked away from. The server still validates - it is the authority - but
 *  nothing malformed should be reachable here in the first place.
 *
 *  So times are CHIPS: a grid of valid clock times at the chosen duration,
 *  toggled with a click, plus a native time input for the odd ones outside
 *  the grid. There is no way to express a time the API would refuse.
 *
 *  WHAT LIVES HERE AND WHAT DOES NOT
 *  Here: form state, the duration/mode presets, the live "what am I about to
 *  create" summary, and validation.
 *  NOT here: the request, the toast, or the refresh. `onSubmit` hands the
 *  payload to the page, which owns all three - the same split
 *  AppointmentModals uses, and for the same reason.
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Modal, Spinner, StatusBadge } from "../../components/ui.jsx";
import { formatDay, formatTime, relativeDay, todayISO, cx } from "../../utils/format";
import api from "../../api/client";
import { useToast } from "../../context/ToastContext.jsx";

/** The server's own time rule, mirrored so bad input cannot be typed. */
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Minutes past midnight, so times compare and step without string maths. */
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};
const hhmmOf = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
    mins % 60,
  ).padStart(2, "0")}`;

/**
 * The minus that removes a slot on its own, drawn rather than typed so it
 * inherits `currentColor` and matches the rest of the icon set.
 */
function MinusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

/** Names what the bulk footer is about to do, so the button is not the only
    carrier of "this is destructive". */
function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/** The window the chip grid offers. Anything outside it is still reachable
    through the manual time input — this is a shortcut, not a limit. */
const GRID_FROM = 8 * 60; // 08:00
const GRID_TO = 21 * 60; //  21:00

/** Offered as one-click fills. Each covers the usual shape of a clinic day. */
const PRESETS = [
  { key: "morning", label: "Morning", from: 9 * 60, to: 13 * 60 },
  { key: "afternoon", label: "Afternoon", from: 14 * 60, to: 18 * 60 },
  { key: "evening", label: "Evening", from: 18 * 60, to: 21 * 60 },
];

const DURATIONS = [15, 20, 30, 45, 60];

const MODES = [
  { key: "in-person", label: "In person" },
  { key: "video", label: "Video" },
];

/** The four 30-minute slots the old textarea opened with. */
const DEFAULT_TIMES = ["09:00", "09:30", "10:00", "10:30"];

/**
 * The server's own ceiling on one remove request, mirrored so the bulk button
 * explains the limit instead of letting it arrive as a refusal.
 *
 * A single day comfortably fits under it, so this is a guard rather than a
 * number the provider will meet in practice. The request is all-or-nothing, so
 * it is NOT worked around by sending the selection in batches: that would turn
 * "nothing was removed" into "half of it was".
 */
const MAX_SLOTS_PER_DELETE = 100;

/** Every grid step at this duration, e.g. 30 → 08:00, 08:30, … */
const gridTimesFor = (duration) => {
  const out = [];
  for (let m = GRID_FROM; m <= GRID_TO; m += duration) out.push(hhmmOf(m));
  return out;
};

const sortTimes = (list) =>
  [...new Set(list)].sort((a, b) => minutesOf(a) - minutesOf(b));

/** `iso` shifted by whole days, as "YYYY-MM-DD". Local arithmetic, like
    `todayISO`, so it never slips across midnight the way UTC would. */
const shiftDays = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(dt.getDate()).padStart(2, "0")}`;
};

export default function GenerateSlotsModal({
  open,
  onClose,
  onSubmit,
  busy = false,
  /**
   * The day to open on. The page passes the day its schedule card is showing,
   * so "add more slots" continues where the provider already is instead of
   * jumping back to today. Anything before today is not offered as a date.
   */
  initialDate,
  /**
   * Slots already published on the date currently in the form, when the caller
   * happens to know them. Purely advisory: a chip struck through is a time the
   * server has already refused to duplicate, but the page only has the schedule
   * for the day it is showing. The server remains the authority and the toast
   * still reports every skip.
   */
  existingSlots = [],
  /**
   * Whose slots this is. Delete mode fetches the selected day's list itself, so
   * it needs the id rather than trusting the page's copy of the card's day.
   * Without it the dialog is read-only: add works, delete is offered but
   * refuses, and that is said plainly rather than failing on click.
   */
  doctorId = null,
  /** Called after slots have actually been removed, so the page can refresh. */
  onDeleted,
}) {
  const [date, setDate] = useState(() => todayISO());
  const [times, setTimes] = useState(() => []);
  const [duration, setDuration] = useState(30);
  const [mode, setMode] = useState("in-person");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(null);

  /* ------------------------------------------------------------------ *
   *  Delete mode                                                       *
   * ------------------------------------------------------------------ *
   *  A toggle rather than a second dialog: both jobs are "change which
   *  times exist on this day", and putting them in one place means one date
   *  picker and one list of what is already published instead of two.
   *
   *  TWO WAYS TO REMOVE, BOTH ALWAYS VISIBLE
   *  "Take that 09:30 off" and "clear this whole afternoon" are different
   *  intents and different mistakes to make, so they get different controls
   *  rather than one control and a confirm step in front of it:
   *
   *    the MINUS on a row — removes that slot straight away.
   *    the CARD itself    — selects; the footer then removes the whole
   *                         selection as one request.
   *
   *  The single-slot path deliberately asks nothing. A provider who aimed at
   *  a minus has already made the decision, and being asked to confirm it is
   *  what makes a dialog feel slow. The bulk path asks once, in the footer,
   *  because there the cost of being wrong scales with the selection - which
   *  is why nothing on screen is removed before that footer button is pressed.
   * ------------------------------------------------------------------ */
  const [deleting, setDeleting] = useState(false);
  /**
   * Slot ids selected for a bulk delete. Bounded to the day on screen:
   * `pickDate` clears it, because an id belongs to the day it was read on.
   */
  const [marked, setMarked] = useState([]);
  const [daySlots, setDaySlots] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState(null);
  /** Bulk delete in flight - the whole selection is one request. */
  const [deletingBusy, setDeletingBusy] = useState(false);
  /**
   * The slot whose own minus is in flight, held as an id so that slot's
   * button can show the wait while the rest of the list stays live. One at a
   * time on purpose: a second click mid-flight would race two removes against
   * the same list.
   */
  const [removingId, setRemovingId] = useState(null);

  const toast = useToast();

  const today = todayISO();

  /**
   * The day's published slots, fetched for delete mode only.
   *
   * `existingSlots` (what the page passes) is the schedule card's day and
   * nothing more, so it cannot answer "what is on the 24th" when the card is
   * showing the 17th. Deleting is destructive and must act on a list read
   * fresh, so this refetches per date rather than trusting a prop.
   */
  useEffect(() => {
    if (!open || !deleting || !doctorId) {
      setDaySlots(null);
      setDayError(null);
      return undefined;
    }
    let cancelled = false;
    setDayLoading(true);
    api
      .doctorSlots(doctorId, { date })
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
  }, [open, deleting, doctorId, date]);

  const gridTimes = useMemo(() => gridTimesFor(duration), [duration]);

  /**
   * Times already published on a given day.
   *
   * Keyed by day rather than computed once for `date`, because every setter
   * that changes the selection also has to know what is already there for the
   * day being moved to.
   */
  const takenOn = useCallback(
    (iso) =>
      new Set(
        existingSlots
          .filter((s) => s?.date === iso)
          .map((s) => String(s.startTime ?? "").slice(0, 5)),
      ),
    [existingSlots],
  );

  const taken = useMemo(() => takenOn(date), [takenOn, date]);

  /**
   * `existingSlots` as a ref, for the reset effect below.
   *
   * That effect must run on the OPEN transition and on nothing else, but it
   * needs the caller's slot list to seed itself. Taking it as a dependency made
   * it hostage to the caller's array identity: the provider page builds its
   * list with an inline `.filter()`, so every render of that page handed over a
   * new array, re-ran the reset, and wiped `deleting` — which is why deleting a
   * slot threw the provider straight back out into the add form, and why
   * opening delete mode could bounce them out again a moment later.
   *
   * The ref reads whatever is current at the moment the dialog opens and is
   * invisible to the dependency list, so no render of the page can restart it.
   */
  const existingSlotsRef = useRef(existingSlots);
  useEffect(() => {
    existingSlotsRef.current = existingSlots;
  });

  /**
   * What the dialog is showing at this instant.
   *
   * Both remove paths write back into `daySlots` after an `await`. If the
   * provider changed date - or left delete mode - while a request was in the
   * air, that write lands on a screen it no longer describes, and the worst
   * case is a refusal restoring one day's slots onto another's. Compared
   * through a ref, because the handler's closure still holds the values from
   * the moment it was clicked.
   */
  const viewRef = useRef({ date, deleting });
  useEffect(() => {
    viewRef.current = { date, deleting };
  }, [date, deleting]);

  /** Did this request stay on the screen it was made from? */
  const stillOn = (day, mode) =>
    viewRef.current.date === day && viewRef.current.deleting === mode;

  /**
   * Reopening starts from a clean sheet. Keeping the last entry would mean a
   * second visit silently resubmits a day the doctor has already published.
   *
   * The seed drops times the doctor already has that day. Those chips are
   * rendered disabled, so a default that was still selected would be a chip the
   * provider could see counted in the preview but could not remove — a dead
   * end.
   *
   * Deps are deliberately ONLY what "which open is this?" is made of. Anything
   * that changes identity without changing the answer — the caller's slot list
   * above all — would re-run a reset that clears `deleting` and `daySlots`,
   * and would throw the provider out of delete mode without them asking.
   */
  useEffect(() => {
    if (!open) return;
    const day = initialDate && initialDate >= today ? initialDate : today;
    const already = new Set(
      (existingSlotsRef.current ?? [])
        .filter((s) => s?.date === day)
        .map((s) => String(s.startTime ?? "").slice(0, 5)),
    );
    setDate(day);
    setTimes(DEFAULT_TIMES.filter((t) => !already.has(t)));
    setDuration(30);
    setMode("in-person");
    setDraft("");
    setError(null);
    setDeleting(false);
    setMarked([]);
    setDaySlots(null);
    setDayError(null);
  }, [open, initialDate, today]);

  /**
   * The grid plus anything selected that the grid does not contain.
   *
   * A manual time outside 08:00–21:00 would otherwise be selected with nothing
   * on screen to unselect it, so it joins the chips as one more option.
   */
  const chips = useMemo(() => {
    const set = new Set(gridTimes);
    times.forEach((t) => set.add(t));
    return [...set].sort((a, b) => minutesOf(a) - minutesOf(b));
  }, [gridTimes, times]);

  const selected = useMemo(() => sortTimes(times), [times]);

  /**
   * Grid times a preset would fill.
   *
   * Published times are left out for the same reason the seed drops them: a
   * preset must not be able to select a chip that cannot be clicked off.
   */
  const presetTimes = useCallback(
    (preset) =>
      gridTimes.filter(
        (t) =>
          minutesOf(t) >= preset.from &&
          minutesOf(t) < preset.to &&
          !taken.has(t),
      ),
    [gridTimes, taken],
  );

  /**
 * The selection as stretches of back-to-back times.
 *
 * The summary used to read "first start – last start plus a slot", which is
 * true only when the picked times run into one another. Pick 19:00, 19:30 and
 * 21:00 at 30 minutes, leave 20:00 and 20:30 out, and it announced cover
 * through 9:30 PM — claiming 20:00 and 20:30, which is the opposite of what
 * leaving them out means. A clinic day is most often two sittings with a break
 * in it, so a gap is the normal case and the old text was wrong whenever there
 * was one.
 *
 * A run closes when the next pick does not start exactly where the previous
 * slot ended. That also breaks on an overlap, or on a manual time that is off
 * the grid step (19:00 then 19:15 at 30 minutes), which is correct: those two
 * do not cover 19:00–19:45 with nothing in between.
 *
 * Stored as `[startMinutes, endMinutes]`, the second already carrying the last
 * slot's end, so the display never has to re-derive it.
 */
const runs = useMemo(() => {
  const out = [];
  let from = null;
  let lastStart = 0;
  for (const t of selected) {
    const m = minutesOf(t);
    if (from === null) {
      from = lastStart = m;
    } else if (m - lastStart === duration) {
      lastStart = m;
    } else {
      out.push([from, lastStart + duration]);
      from = lastStart = m;
    }
  }
  if (from !== null) out.push([from, lastStart + duration]);
  return out;
}, [selected, duration]);

/** Spelled out rather than folded into one span, so the text cannot imply
    cover the provider has not selected. Capped, because a day of scattered
    manual times would otherwise run to a paragraph. */
const MAX_RUNS_SHOWN = 3;

/** What will be created, restated in words before anything is sent. */
  const summary = useMemo(() => {
    if (!selected.length) return null;
    return {
      count: selected.length,
      stretches: runs
        .slice(0, MAX_RUNS_SHOWN)
        .map(([a, b]) => `${formatTime(hhmmOf(a))} – ${formatTime(hhmmOf(b))}`)
        .join(", "),
      hidden: Math.max(0, runs.length - MAX_RUNS_SHOWN),
    };
  }, [selected, runs]);

  const toggleTime = (t) =>
    setTimes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );

  /**
   * Presets FILL rather than toggle-add.
   *
   * "Add every morning slot" is the common intent; a second click is treated as
   * "no mornings", and anything already picked outside the window survives. This
   * replaces the textarea wholesale, which is what the doctor did by hand before.
   */
  const applyPreset = (preset) => {
    const inWindow = presetTimes(preset);
    setTimes((prev) => {
      const outside = prev.filter(
        (t) => minutesOf(t) < preset.from || minutesOf(t) >= preset.to,
      );
      const alreadyExact = inWindow.every((t) => prev.includes(t));
      return sortTimes(alreadyExact ? outside : [...outside, ...inWindow]);
    });
  };

  /** Which presets the current selection already covers exactly. */
  const activePresets = useMemo(
    () =>
      PRESETS.filter((p) => {
        const want = presetTimes(p);
        return want.length > 0 && want.every((t) => times.includes(t));
      }).map((p) => p.key),
    [presetTimes, times],
  );

  const addDraft = () => {
    const t = String(draft).trim().slice(0, 5);
    if (!TIME_RE.test(t)) {
      setError("Pick a time first, or choose one from the grid above.");
      return;
    }
    if (taken.has(t)) {
      setError(`${formatTime(t)} already exists on ${formatDay(date)}.`);
      return;
    }
    setTimes((prev) => sortTimes([...prev, t]));
    setDraft("");
    setError(null);
  };

  const submit = () => {
    if (!selected.length) {
      setError("Choose at least one time.");
      return;
    }
    setError(null);
    onSubmit?.({ date, times: selected, duration, mode });
  };

  const pickDate = (iso) => {
    setDate(iso);
    // Same invariant as the seed: a time published on the day being moved to
    // cannot be created there, and its chip is not clickable, so leaving it
    // selected would strand it.
    setTimes((prev) => prev.filter((t) => !takenOn(iso).has(t)));
    // A selected slot id belongs to the day it was read on. Carrying them to
    // another day would send ids that are no longer on screen under Delete.
    setMarked([]);
    setError(null);
  };

  /**
   * Slots that can actually be removed.
   *
   * `isDeletable`, not `isBooked`: the appointments foreign key is ON DELETE
   * RESTRICT, so a slot whose only appointment was cancelled is not booked but
   * is still undeletable. The server refuses those; showing them as removable
   * would just move the failure to the moment of submitting.
   */
  const removableOnDay = useMemo(
    () => (daySlots ?? []).filter((s) => s.isDeletable !== false),
    [daySlots],
  );

  /**
   * Selected ids the list no longer contains.
   *
   * A refetch - this dialog's own, or a stale answer landing after a delete -
   * can retire a slot that was already selected. The count in the footer is
   * then a lie, and pressing Delete would send ids that are not there.
   */
  useEffect(() => {
    if (!daySlots) return;
    const live = new Set(daySlots.map((s) => s.id));
    setMarked((prev) =>
      prev.some((id) => !live.has(id))
        ? prev.filter((id) => live.has(id))
        : prev,
    );
  }, [daySlots]);

  /**
   * Whether every removable slot on this day is already selected. Derived
   * rather than stored, so it cannot fall out of step with `marked` after a
   * delete - the same trick `activePresets` uses in add mode.
   *
   * Locked slots are excluded from "all": a day where only 09:00 and 09:30 can
   * be removed should not offer to "select all" over slots it cannot remove.
   */
  const allMarked = useMemo(
    () =>
      removableOnDay.length > 0 &&
      removableOnDay.every((s) => marked.includes(s.id)),
    [removableOnDay, marked],
  );

  const toggleMark = (id) =>
    setMarked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const toggleMarkAll = () =>
    setMarked(allMarked ? [] : removableOnDay.map((s) => s.id));

  /**
   * One minus, one slot, one request - no confirm step.
   *
   * The row leaves the list before the request resolves and is put back if the
   * server refuses, because the decision has already been made by aiming at a
   * minus: a second of dead air in which nothing appears to happen would read
   * as a broken button. The snapshot restores exactly what was there, so a
   * refusal leaves the day as it was rather than as a re-read happened to see
   * it.
   *
   * An all-or-nothing refusal is why the rollback is the whole list rather
   * than a re-read: if this call refused, the other removals in the same
   * response would not have been applied either.
   */
  const removeOne = async (slot) => {
    if (removingId || deletingBusy || slot.isDeletable === false) return;
    const day = date;
    const snapshot = daySlots;
    setRemovingId(slot.id);
    setError(null);
    setMarked((prev) => prev.filter((x) => x !== slot.id));
    setDaySlots((prev) => (prev ?? []).filter((s) => s.id !== slot.id));
    try {
      const res = await api.deleteSlots(doctorId, [slot.id]);
      const n = res.deletedCount ?? 0;
      if (n > 0) {
        toast.success(`${formatTime(slot.startTime)} deleted`);
        onDeleted?.();
      } else if (stillOn(day, true)) {
        // Removed nothing and said so. Re-read rather than keep our guess.
        const fresh = await api.doctorSlots(doctorId, { date: day });
        if (stillOn(day, true)) setDaySlots(fresh.slots ?? []);
        toast.error("That slot could not be removed.");
      }
    } catch (err) {
      // Only un-remove it if it is still the row the provider is looking at.
      if (stillOn(day, true)) setDaySlots(snapshot);
      toast.error(err.message);
    } finally {
      setRemovingId(null);
    }
  };

  const enterDelete = () => {
    setDeleting(true);
    setMarked([]);
    setError(null);
    setDraft("");
  };

  /** "Done" is now only ever the way out - removal is on the minus and on the
      footer bar, so this button has nothing left to commit. */
  const leaveDelete = () => {
    setDeleting(false);
    setMarked([]);
    setDaySlots(null);
    setDayError(null);
    setError(null);
  };

  /**
   * The selection, as one request.
   *
   * Kept in delete mode afterwards on purpose: taking six slots off an
   * afternoon is rarely the whole errand, and dropping back into the add form
   * would make the second pass a re-navigation. "Done" is the way out.
   *
   * A refusal changes nothing at all, so the selection stays exactly as it was
   * and the provider can see which slot was in the way rather than re-selecting
   * forty others to find out again.
   */
  const deleteMarked = async () => {
    if (!marked.length || deletingBusy || removingId) return;
    if (marked.length > MAX_SLOTS_PER_DELETE) {
      setError(
        `That is ${marked.length} slots. Remove ${MAX_SLOTS_PER_DELETE} or fewer at a time.`,
      );
      return;
    }
    const day = date;
    setDeletingBusy(true);
    setError(null);
    try {
      const res = await api.deleteSlots(doctorId, marked);
      const n = res.deletedCount ?? 0;
      toast.success(n === 1 ? "1 slot deleted" : `${n} slots deleted`);
      // Refetched so the list shows what actually survived, and so a slot the
      // server did not remove is visible rather than silently gone from view.
      const fresh = await api.doctorSlots(doctorId, { date: day });
      if (!stillOn(day, true)) return;
      setDaySlots(fresh.slots ?? []);
      setMarked([]);
      onDeleted?.();
    } catch (err) {
      // All-or-nothing: a rejection removed nothing, so the selection stays put
      // and the provider can see exactly which slot is in the way.
      if (stillOn(day, true)) setError(err.message);
    } finally {
      setDeletingBusy(false);
    }
  };

  /** Today and tomorrow, because those are the days that are actually in play. */
  const tomorrowISO = useMemo(() => shiftDays(today, 1), [today]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={deleting ? "Remove appointment slots" : "Add appointment slots"}
      footer={
        deleting ? (
          /* ---------------- delete mode footer ----------------
              Rebuilt around the fact that removing is no longer a single
              button. Two stacked zones:

                1. a full-width confirm bar, present only while something is
                   selected. It spans the footer so a red "Delete 6 slots" can
                   never be read as the neighbouring "Done" - which is exactly
                   the ambiguity of the old one-row footer, where a left-aligned
                   destructive button sat next to a right-aligned count.
                2. the navigation row: what the mode is doing on the left, and
                   Cancel / Done on the right where the primary action lives in
                   every other dialog in the app.

              Nothing is removed until the bar's button is pressed, so its
              presence is the confirmation - there is no second dialog and no
              modal-in-modal asking about a dialog. */
          <div className="slotgen-delfoot">
            {marked.length > 0 && (
              <div className="slotgen-delfoot-bar">
                <TrashIcon />
                <span className="slotgen-delfoot-bar-text">
                  {marked.length} slot{marked.length === 1 ? "" : "s"} selected
                  <span className="slotgen-delfoot-bar-hint">
                    Removing them is immediate and cannot be undone.
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={deleteMarked}
                  disabled={
                    deletingBusy ||
                    removingId !== null ||
                    marked.length > MAX_SLOTS_PER_DELETE
                  }
                  title={
                    marked.length > MAX_SLOTS_PER_DELETE
                      ? `The server accepts ${MAX_SLOTS_PER_DELETE} ids per request`
                      : undefined
                  }
                >
                  {deletingBusy
                    ? "Deleting…"
                    : `Delete ${marked.length} slot${
                        marked.length === 1 ? "" : "s"
                      }`}
                </button>
              </div>
            )}

            <div className="slotgen-delfoot-row">
              {/* Silent unless something is actually happening. How the two
                  controls work is legible from the controls themselves, and a
                  standing instruction here only crowded the buttons towards
                  the middle of the footer. What is left is the two states a
                  provider could not infer from a still screen. */}
              <span className="small muted" aria-live="polite">
                {removingId !== null
                  ? "Removing that slot…"
                  : marked.length > 0
                    ? "Press Done to go back without removing anything."
                    : null}
              </span>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                disabled={deletingBusy || removingId !== null}
              >
                Cancel
              </button>

              {/* Back to adding. Green rather than brand: "Done" reads as
                  finishing something, not as the destructive partner to the
                  red button above it. */}
              <button
                type="button"
                className="btn btn-primary"
                onClick={leaveDelete}
                disabled={deletingBusy || removingId !== null}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Left-aligned: this is the entry to the other half of the dialog,
                not the alternative to the primary action on the right. */}
            <button
              type="button"
              className="btn btn-sm slotgen-del-toggle"
              onClick={enterDelete}
              disabled={busy || !doctorId}
              title={
                !doctorId
                  ? "Deleting needs to know whose schedule this is"
                  : undefined
              }
            >
              Delete slots
            </button>

            <div className="spacer" />

            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !selected.length}
            >
              {busy
                ? "Creating…"
                : selected.length
                  ? `Create ${selected.length} slot${selected.length === 1 ? "" : "s"}`
                  : "Create slots"}
            </button>
          </>
        )
      }
    >
      <div className="stack">
        {deleting ? (
          /* ---------------- delete mode ----------------
              The date picker stays: which day to clear is half the decision.
              Everything about *adding* is hidden rather than disabled, so
              there is no way to read the two modes as one form. */
          <>
            <div className="field">
              <label className="label" htmlFor="g-date-del">
                Date
              </label>
              <div className="slotgen-quick">
                <input
                  id="g-date-del"
                  type="date"
                  className="input slotgen-fill"
                  value={date}
                  min={today}
                  onChange={(e) => e.target.value && pickDate(e.target.value)}
                />
                <button
                  type="button"
                  className={`btn btn-sm ${
                    date === today ? "btn-primary" : "btn-secondary"
                  }`}
                  aria-pressed={date === today}
                  onClick={() => pickDate(today)}
                >
                  Today
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${
                    date === tomorrowISO ? "btn-primary" : "btn-secondary"
                  }`}
                  aria-pressed={date === tomorrowISO}
                  onClick={() => pickDate(tomorrowISO)}
                >
                  Tomorrow
                </button>
              </div>
            </div>

            <div className="field">
              <div className="row-between" style={{ marginBottom: "0.15rem" }}>
                <span className="label" id="g-del-label" style={{ margin: 0 }}>
                  Published on {formatDay(date)}
                </span>

                {/* Select-all belongs beside the list it acts on, not in the
                    footer: the footer's job is to commit or back out. */}
                {removableOnDay.length > 0 && (
                  <div className="slotgen-delseltools">
                    <button
                      type="button"
                      className="slotgen-selbtn"
                      onClick={toggleMarkAll}
                      disabled={deletingBusy || removingId !== null}
                    >
                      {allMarked ? "Clear selection" : "Select all"}
                    </button>
                  </div>
                )}
              </div>

              {dayLoading ? (
                <div className="row" style={{ padding: "1rem 0" }}>
                  <Spinner />
                  <span className="small muted">Loading that day's slots…</span>
                </div>
              ) : dayError ? (
                <Alert tone="danger">{dayError}</Alert>
              ) : !daySlots?.length ? (
                <Alert tone="info">
                  No slots on this day, so there is nothing to remove.
                </Alert>
              ) : (
                <>
                  <div
                    className="slotgen-dellist"
                    role="group"
                    aria-labelledby="g-del-label"
                  >
                    {daySlots.map((s) => {
                      const on = marked.includes(s.id);
                      const locked = s.isDeletable === false;
                      const removing = removingId === s.id;
                      return (
                        <div
                          key={s.id}
                          className={cx(
                            "slotgen-delchip",
                            on && "slotgen-delchip-marked",
                            locked && "slotgen-delchip-locked",
                            removing && "slotgen-delchip-busy",
                          )}
                        >
                          {/* The card body only SELECTS. It is its own button
                              rather than a <label>/input pair because the
                              whole interaction is already two buttons on a
                              row, and a hidden checkbox would add a third
                              focus stop for no gain. */}
                          <button
                            type="button"
                            className="slotgen-delchip-main"
                            aria-pressed={on}
                            disabled={locked || deletingBusy || removing}
                            onClick={() => toggleMark(s.id)}
                            title={
                              locked
                                ? "This slot has an appointment against it — cancel that first"
                                : on
                                  ? `Keep ${formatTime(s.startTime)}`
                                  : `Select ${formatTime(s.startTime)}`
                            }
                          >
                            <span className="small bold nowrap">
                              {formatTime(s.startTime)}
                            </span>
                            <StatusBadge status={s.status} />
                            <span className="tiny muted nowrap">
                              {s.mode === "video" ? "Video" : "Clinic"}
                            </span>
                          </button>

                          {/* The minus REMOVES, on its own, immediately. It is a
                              separate control from the card on purpose: the two
                              mean different things, and "I want this one gone"
                              should not have to be expressed as a selection the
                              provider then has to go and confirm. */}
                          <button
                            type="button"
                            className="slotgen-delchip-x"
                            disabled={
                              locked || deletingBusy || removingId !== null
                            }
                            onClick={() => removeOne(s)}
                            title={
                              locked
                                ? "This slot has an appointment against it — cancel that first"
                                : `Remove ${formatTime(s.startTime)} now`
                            }
                            aria-label={`Remove slot at ${formatTime(s.startTime)}`}
                          >
                            <MinusIcon />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
        {/* ---------------- date ---------------- */}
        <div className="field">
          <label className="label" htmlFor="g-date">
            Date
          </label>
          {/* The picker and its two shortcuts share one row: they are three ways
              to answer the same question, and stacking them made the dialog
              taller than it needed to be. */}
          <div className="slotgen-quick">
            <input
              id="g-date"
              type="date"
              className="input slotgen-fill"
              value={date}
              min={today}
              onChange={(e) => e.target.value && pickDate(e.target.value)}
            />
            <button
              type="button"
              className={`btn btn-sm ${
                date === today ? "btn-primary" : "btn-secondary"
              }`}
              aria-pressed={date === today}
              onClick={() => pickDate(today)}
            >
              Today
            </button>
            <button
              type="button"
              className={`btn btn-sm ${
                date === tomorrowISO ? "btn-primary" : "btn-secondary"
              }`}
              aria-pressed={date === tomorrowISO}
              onClick={() => pickDate(tomorrowISO)}
            >
              Tomorrow
            </button>
          </div>
          <div className="slotgen-hint">
            {formatDay(date)} · {relativeDay(date)}
            {taken.size > 0
              ? ` · ${taken.size} slot${taken.size === 1 ? "" : "s"} already published`
              : ""}
          </div>
        </div>

        {/* ---------------- times ----------------
            A <span> not a <label>: the chips are a `role="group"` of buttons,
            which is not a labelable element, so `htmlFor` would dangle. The
            group is named by `aria-labelledby` instead — same pattern as the
            Slot length and Mode fields below. */}
        <div className="field">
          <div className="row-between">
            <span className="label" id="g-times-label" style={{ margin: 0 }}>
              Times
            </span>
            <div className="slotgen-seg" role="group" aria-label="Fill presets">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className="slotgen-seg-btn"
                  aria-pressed={activePresets.includes(p.key)}
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="slotgen-grid"
            role="group"
            aria-labelledby="g-times-label"
            aria-description={`Start times on ${formatDay(
              date,
            )}, every ${duration} minutes`}
          >
            {chips.map((t) => {
              const on = selected.includes(t);
              const isTaken = taken.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  className="slotgen-chip"
                  aria-pressed={on}
                  disabled={isTaken}
                  title={
                    isTaken
                      ? `${formatTime(t)} is already published`
                      : `${formatTime(t)} – ${formatTime(hhmmOf(minutesOf(t) + duration))}`
                  }
                  onClick={() => toggleTime(t)}
                >
                  {t}
                </button>
              );
            })}
          </div>

          <div className="slotgen-quick">
            <input
              type="time"
              className="input slotgen-narrow"
              value={draft}
              step={300}
              aria-label="Another start time"
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addDraft();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={addDraft}
              disabled={!draft}
            >
              + Add time
            </button>
          </div>

          <div className="slotgen-hint">
            {selected.length
              ? `${selected.length} selected · ${formatTime(selected[0])} – ${formatTime(
                  hhmmOf(minutesOf(selected[selected.length - 1]) + duration),
                )}`
              : "Pick one or more times, or fill a preset."}
          </div>
        </div>

        {/* ---------------- duration ---------------- */}
        <div className="field">
          <span className="label" id="g-duration-label">
            Slot length
          </span>
          <div
            className="slotgen-seg"
            role="group"
            aria-labelledby="g-duration-label"
          >
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                className="slotgen-seg-btn"
                aria-pressed={duration === d}
                onClick={() => setDuration(d)}
              >
                {d} min
              </button>
            ))}
          </div>
          <div className="slotgen-hint">
            The grid above re-steps to match, so changing this does not silently
            drop a time you had picked.
          </div>
        </div>

        {/* ---------------- mode ---------------- */}
        <div className="field">
          <span className="label" id="g-mode-label">
            Mode
          </span>
          <div
            className="slotgen-seg"
            role="group"
            aria-labelledby="g-mode-label"
          >
            {MODES.map((m) => (
              <button
                key={m.key}
                type="button"
                className="slotgen-seg-btn"
                aria-pressed={mode === m.key}
                onClick={() => setMode(m.key)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="slotgen-hint">
            Applies to every slot created here.
          </div>
        </div>

        {/* ---------------- preview ----------------
            Appears only once there is something to preview. The empty state
            said nothing the screen did not already show: the grid is all
            unselected, and the hint under it already says to pick a time. */}
        {summary && (
          <div aria-live="polite">
            <div className="slotgen-summary">
              <div className="center">
                <div className="slotgen-summary-n">{summary.count}</div>
                <div className="slotgen-summary-label">
                  slot{summary.count === 1 ? "" : "s"}
                </div>
              </div>
              <div className="slotgen-summary-body">
                <div className="small bold">{formatDay(date)}</div>
                {/* One `start – end` per stretch of back-to-back times, so a
                    break in the day reads as a break here too. */}
                <div className="small slotgen-summary-times">
                  {summary.stretches}
                  {summary.hidden > 0
                    ? ` +${summary.hidden} more`
                    : ""}
                </div>
                <div className="tiny muted">
                  {duration} min each ·{" "}
                  {MODES.find((m) => m.key === mode)?.label}
                </div>
              </div>
            </div>
          </div>
        )}
          </>
        )}

        {/* Outside the branch: a refusal from `deleteMarked` or `removeOne`
            lands here, and the provider needs to read it while still looking
            at the selection that caused it. */}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}