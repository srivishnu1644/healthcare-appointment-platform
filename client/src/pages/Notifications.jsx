import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, Loading, StatusBadge, Alert, Spinner } from "../components/ui.jsx";
import SwipeableRow from "../components/ui/SwipeableRow.jsx";
import UndoBar from "../components/ui/UndoBar.jsx";
import { useNotifications } from "../context/NotificationsContext.jsx";
import { useToast } from "../context/ToastContext.jsx";
import { formatDateTime, cx } from "../utils/format";

/**
 * Keyed by the events the server actually writes.
 *
 * The previous table was keyed by `booked`, `reminder`, `cancelled` and so on,
 * while every message the server sends is named `appointment_booked`,
 * `appointment_reminder`, `appointment_cancelled`. Nothing ever matched, so every
 * notification in the app rendered the same fallback bell - the list looked
 * uniform because the icons were broken, not because the messages were alike.
 */
const EVENT_ICON = {
  appointment_booked: "\u2705",
  appointment_reminder: "\u23F0",
  appointment_rescheduled: "\u{1F504}",
  appointment_cancelled: "\u274C",
  appointment_checked_in: "\u{1F6CF}",
  queue_called: "\u{1F44C}",
  appointment_completed: "\u{1F389}",
  status_update: "\u{1F4CC}",
};

/** A friendlier label than the raw event name in the badge. */
const EVENT_LABEL = {
  appointment_booked: "Confirmed",
  appointment_reminder: "Reminder",
  appointment_rescheduled: "Rescheduled",
  appointment_cancelled: "Cancelled",
  appointment_checked_in: "Checked in",
  queue_called: "Called",
  appointment_completed: "Completed",
  status_update: "Status update",
};

/**
 * How each event should be READ, not just labelled.
 *
 * A confirmation and a cancellation are both "your appointment changed" but they
 * are not the same news, and a list that renders both in the same grey gives the
 * user no way to triage it at a glance. This is the cheapest possible triage
 * affordance — a coloured dot and a weight on the subject — and it costs
 * nothing to maintain because the tone lives beside the icon it belongs to.
 */
const EVENT_TONE = {
  appointment_booked: "success",
  appointment_rescheduled: "info",
  appointment_cancelled: "danger",
  appointment_completed: "success",
  appointment_checked_in: "info",
  queue_called: "brand",
  appointment_reminder: "warning",
  status_update: "neutral",
};

/**
 * How long a removed row holds its slot open.
 *
 * Must match `--swipe-exit` in the stylesheet. It is a number in two places
 * because a `transitionend` listener would couple the page to a specific
 * property, and would not fire at all if the tab is in the background when the
 * transition ends — leaving the row stranded on screen.
 */
const ROW_EXIT_MS = 240;

/** Delay between rows in a bulk clear. Enough to read as a wave, not a queue. */
const EXIT_STAGGER_MS = 26;
/** Past this many rows the wave stops growing and the whole list clears together. */
const EXIT_STAGGER_MAX = 14;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the staggered collapse of `count` rows takes. */
const staggerFor = (count) =>
  Math.min(count, EXIT_STAGGER_MAX) * EXIT_STAGGER_MS + ROW_EXIT_MS;

/**
 * Group the list into the buckets a reader actually thinks in.
 *
 * A flat reverse-chronological list of 40 messages forces the user to read dates
 * to answer "what is new?". Bucketing by recency answers it before they open a
 * single row, and the section headers double as a progress bar for the backlog.
 */
const buildGroups = (list) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 6);

  const buckets = new Map([
    ["Today", []],
    ["Yesterday", []],
    ["Earlier this week", []],
    ["Older", []],
  ]);
  const older = buckets.get("Older");

  for (const n of list) {
    const t = new Date(n.createdAt).getTime();
    if (!Number.isFinite(t)) {
      older.push(n);
      continue;
    }
    if (t >= startOfToday.getTime()) buckets.get("Today").push(n);
    else if (t >= yesterday.getTime()) buckets.get("Yesterday").push(n);
    else if (t >= weekAgo.getTime()) buckets.get("Earlier this week").push(n);
    else older.push(n);
  }

  return [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
};

export default function Notifications() {
  const {
    notifications,
    unread,
    channels,
    loading,
    error,
    reload,
    markAllRead,
    markOne,
    toggleRead,
    marking,
    removeOne,
    removeAll,
    restore,
    restoreOne,
  } = useNotifications();
  const toast = useToast();

  /* ---------------- filter ---------------- */
  // Filtering a 40-row list by hand is the whole reason this is not just a
  // delete button: "unread" is the only slice most people ever want, and it is
  // the slice the badge is already counting.
  const [filter, setFilter] = useState("all");

  /* ---------------- removal + undo ---------------- */
  const [pendingUndo, setPendingUndo] = useState(null);
  // Set while the "clear all" confirm popover is open.
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const confirmRef = useRef(null);
  const triggerRef = useRef(null);
  const holdTimers = useRef(new Map());

  /**
   * Rows that are mid-exit, kept alive locally for the length of the animation.
   *
   * The removal itself is optimistic — the row leaves the shared state the
   * instant it is dismissed, which is what makes the header badge drop at the
   * same moment. But an optimistic removal REMOVES the row, and a row that is
   * no longer rendered has nothing to animate: the exit would be a single frame
   * and the list would jump instead of closing. So the page keeps its own copy
   * of each departing row for the duration, renders it with the exiting class,
   * and drops it when the animation is over.
   *
   * The clock lives here rather than in the row for the same reason: the row's
   * own timer would be cancelled by the unmount that follows the write.
   */
  const [held, setHeld] = useState([]);

  const hold = useCallback((row, delay = 0) => {
    setHeld((prev) => [...prev.filter((h) => h.row.id !== row.id), { row, delay }]);
    const timer = setTimeout(
      () => {
        holdTimers.current.delete(row.id);
        setHeld((prev) => prev.filter((h) => h.row.id !== row.id));
      },
      // The extra frame is the one SwipeableRow waits before it applies the
      // collapse; without it the row is dropped a frame or two before the
      // animation finishes, and the last couple of pixels vanish.
      ROW_EXIT_MS + delay + 32,
    );
    holdTimers.current.set(row.id, timer);
  }, []);

  /** Drop a hold immediately — the row never got to animate out. */
  const release = useCallback((id) => {
    clearTimeout(holdTimers.current.get(id));
    holdTimers.current.delete(id);
    setHeld((prev) => prev.filter((h) => h.row.id !== id));
  }, []);

  // Nothing to un-hold once the page is gone.
  useEffect(
    () => () => {
      holdTimers.current.forEach(clearTimeout);
      holdTimers.current.clear();
    },
    [],
  );

  /**
   * Everything on screen: the live rows, plus any still animating out.
   *
   * The live copy always wins the merge, so undoing a removal while its row is
   * still animating restores one row rather than rendering it twice.
   */
  const rows = useMemo(() => {
    const liveIds = new Set(notifications.map((n) => n.id));
    const departing = held.filter((h) => !liveIds.has(h.row.id)).map((h) => h.row);
    return [...departing, ...notifications].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );
  }, [notifications, held]);

  /** Is this row currently animating out, and how late is it in the stagger? */
  const holdOf = useCallback(
    (id) => {
      if (notifications.some((n) => n.id === id)) return null;
      return held.find((h) => h.row.id === id) || null;
    },
    [notifications, held],
  );

  const visible = useMemo(() => {
    if (filter === "unread") return rows.filter((n) => !n.read);
    if (filter === "read") return rows.filter((n) => n.read);
    return rows;
  }, [rows, filter]);

  const groups = useMemo(() => buildGroups(visible), [visible]);

  // Flat position of every visible row, so the exit stagger follows the reading
  // order rather than restarting at each group heading.
  const exitIndex = useMemo(() => {
    const index = new Map();
    visible.forEach((n, i) => index.set(n.id, i));
    return index;
  }, [visible]);

  // Counts come from the LIVE list: a row that is animating away has already
  // been removed, and the tabs must not keep counting it for 240ms.
  const readTotal = notifications.filter((n) => n.read).length;

  /* ---------------- the two delete paths ---------------- */

  /**
   * One row, dismissed.
   *
   * Held open for the exit animation, then handed to the shared state, which
   * removes it optimistically and writes it through. The write is soft, so
   * nothing is lost while the row animates away, and if it fails the context
   * re-reads the list — at which point the row is back and its hold is dropped.
   */
  const handleRemove = useCallback(
    async (n) => {
      hold(n);
      const removed = await removeOne(n.id);
      if (!removed) {
        release(n.id);
        toast.error("Could not remove that notification");
        return;
      }
      setPendingUndo({
        kind: "one",
        rows: [removed],
        message: "Notification removed",
      });
    },
    [hold, release, removeOne, toast],
  );

  /**
   * A bulk clear.
   *
   * Every row is set exiting at once and staggered, and the WRITE waits for the
   * animation. Waiting is safe here and nowhere else, because this is a soft
   * delete: the rows are still in the database the whole time the animation
   * plays, so a tab closed mid-animation loses nothing — the rows are simply
   * still there next time. The opposite order (delete, then animate) would
   * animate rows that had already stopped existing.
   */
  const runBulkClear = useCallback(
    async (scope, { message }) => {
      setConfirming(false);
      const count = scope === "read" ? readTotal : notifications.length;
      if (!count) {
        toast.error(
          scope === "read" ? "You have no read notifications" : "Nothing to remove",
        );
        return;
      }
      setClearing(true);
      await wait(staggerFor(count) + 32);
      const result = await removeAll({ scope });
      setClearing(false);
      if (!result.ok) {
        toast.error(
          scope === "read"
            ? "Could not clear your read notifications"
            : "Could not remove your notifications",
        );
        return;
      }
      if (!result.removed.length) return;
      setPendingUndo({
        kind: "many",
        rows: result.removed,
        message: message(result.removed.length),
      });
    },
    [notifications.length, readTotal, removeAll, toast],
  );

  const handleClearRead = useCallback(
    () =>
      runBulkClear("read", {
        message: (n) => `Cleared ${n} read notification${n === 1 ? "" : "s"}`,
      }),
    [runBulkClear],
  );

  const handleClearAll = useCallback(
    () =>
      runBulkClear("all", {
        message: (n) => `Removed ${n} notification${n === 1 ? "" : "s"}`,
      }),
    [runBulkClear],
  );

  const undo = useCallback(() => {
    const snapshot = pendingUndo;
    if (!snapshot) return;
    setPendingUndo(null);
    if (snapshot.kind === "one") restoreOne(snapshot.rows[0]);
    else restore(snapshot.rows);
  }, [pendingUndo, restore, restoreOne]);

  /* ---------------- confirm popover ---------------- */
  // Focus moves into the popover on open and returns to the button that opened
  // it on close, so a keyboard user is never left tabbing into the page behind
  // a dialog that is still on screen. Escape and an outside click both close it.
  useEffect(() => {
    if (!confirming) return undefined;
    const confirmButton = confirmRef.current?.querySelector("[data-confirm]");
    confirmButton?.focus();

    const onKey = (event) => {
      if (event.key === "Escape") {
        setConfirming(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (event) => {
      if (
        !confirmRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        setConfirming(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [confirming]);

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    triggerRef.current?.focus();
  }, []);

  if (loading) return <Loading label="Loading notifications…" />;

  const FILTERS = [
    { key: "all", label: "All", count: notifications.length },
    { key: "unread", label: "Unread", count: unread },
    { key: "read", label: "Read", count: readTotal },
  ];

  return (
    <div className="page page-glass-bg">
      <div className="container stack-lg" style={{ maxWidth: 780 }}>
        {/* ---------------- header ---------------- */}
        <div className="glass-panel notif-head">
          <div className="notif-head-text">
            <h1 style={{ marginBottom: "0.15rem" }}>Notifications</h1>
            <p className="small muted" style={{ margin: 0 }}>
              {unread > 0
                ? `You have ${unread} unread message${unread === 1 ? "" : "s"}.`
                : "You're all caught up."}
            </p>
          </div>

          <div className="notif-head-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={reload}
              disabled={clearing}
            >
              Refresh
            </button>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={markAllRead}
              disabled={unread === 0}
            >
              Mark all read
            </button>

            {/* The destructive action is behind a two-click confirm anchored to
                itself. A centred modal would be heavier and slower for a thing
                that undo can already rescue. */}
            <div className="notif-clear-anchor">
              <button
                ref={triggerRef}
                type="button"
                className="btn btn-ghost btn-sm notif-clear-trigger"
                onClick={() => setConfirming((v) => !v)}
                disabled={notifications.length === 0}
                aria-haspopup="dialog"
                aria-expanded={confirming}
              >
                Remove all
              </button>

              {confirming && (
                <div
                  ref={confirmRef}
                  className="confirm-popover"
                  role="dialog"
                  aria-label="Confirm removing notifications"
                >
                  <p className="confirm-popover-title">
                    Remove {notifications.length} notification
                    {notifications.length === 1 ? "" : "s"}?
                  </p>
                  <p className="confirm-popover-body tiny muted">
                    You can undo this for a few seconds afterwards.
                  </p>
                  <div className="confirm-popover-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={closeConfirm}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      data-confirm
                      onClick={handleClearAll}
                    >
                      Remove all
                    </button>
                  </div>

                  {/* The everyday case gets its own escape hatch. "Remove
                      everything, including the two I have not read yet" is
                      almost never what someone wants at 9pm; offering only that
                      makes the useful action the dangerous one. */}
                  {readTotal > 0 && (
                    <>
                      <hr className="confirm-popover-rule" />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm confirm-popover-alt"
                        onClick={handleClearRead}
                      >
                        Clear the {readTotal} read one{readTotal === 1 ? "" : "s"} instead
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="row row-wrap small muted" style={{ gap: "0.75rem" }}>
          <span>
            Channels: <strong>{channels?.sms ? "SMS" : ""}</strong>
            {channels?.sms && channels?.email ? " + " : ""}
            <strong>{channels?.email ? "Email" : ""}</strong>
          </span>
          {channels?.simulated && (
            <span className="badge badge-warning">
              Simulated — no external provider configured
            </span>
          )}
        </div>

        {/* ---------------- filters ---------------- */}
        <div
          className="tabs"
          role="tablist"
          aria-label="Filter notifications"
          onKeyDown={(event) => {
            const order = FILTERS.map((f) => f.key);
            const i = order.indexOf(filter);
            if (event.key === "ArrowRight") {
              setFilter(order[Math.min(i + 1, order.length - 1)]);
              event.preventDefault();
            }
            if (event.key === "ArrowLeft") {
              setFilter(order[Math.max(i - 1, 0)]);
              event.preventDefault();
            }
          }}
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={cx("tab", filter === f.key && "tab-active")}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="badge" style={{ marginLeft: "0.4rem" }}>
                {f.count}
              </span>
            </button>
          ))}
        </div>

        {/* ---------------- list ---------------- */}
        <div role="list" aria-label="Notification history">
          {visible.length === 0 ? (
            <div className="glass-card card">
              <EmptyState
                icon={filter === "unread" ? "✓" : "🔔"}
                title={
                  filter === "unread"
                    ? "No unread notifications"
                    : filter === "read"
                      ? "No read notifications"
                      : "No notifications yet"
                }
                message={
                  filter === "unread"
                    ? "You're all caught up."
                    : filter === "read"
                      ? "Nothing you have read yet will show up here."
                      : "Booking or changing an appointment will notify you here."
                }
              />
            </div>
          ) : (
            <div className="stack-sm">
              {groups.map((group) => (
                <section key={group.label} className="notif-group">
                  <h2 className="notif-group-title">
                    {group.label}
                    <span className="notif-group-count">{group.items.length}</span>
                  </h2>
                  <div className="stack-sm">
                    {group.items.map((n) => (
                      <NotificationRow
                        key={n.id}
                        n={n}
                        held={holdOf(n.id)}
                        clearing={clearing}
                        exitDelay={(exitIndex.get(n.id) ?? 0) * EXIT_STAGGER_MS}
                        marking={marking === n.id}
                        onMarkRead={markOne}
                        onToggleRead={toggleRead}
                        onRemove={() => handleRemove(n)}
                      />
                    ))}
                  </div>
                </section>
              ))}

              {/* A one-time affordance. Swipe is invisible until you know it
                  exists, and a permanent hint on every row would be noise. */}
              <p className="tiny muted notif-hint">
                Tip: swipe a row left to remove it, right to toggle read and unread.
              </p>
            </div>
          )}
        </div>
      </div>

      <UndoBar
        message={pendingUndo?.message}
        // The subject, for a single removal — it is the only way to tell what
        // "Undo" refers to. A bulk clear already carries its count in the
        // message, and repeating it underneath reads as a stutter.
        detail={pendingUndo?.kind === "one" ? pendingUndo.rows[0]?.subject : undefined}
        onUndo={undo}
        onExpire={() => setPendingUndo(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  One row                                                           *
 * ------------------------------------------------------------------ */
function NotificationRow({ n, held, clearing, exitDelay, marking, onMarkRead, onToggleRead, onRemove }) {
  const tone = EVENT_TONE[n.event] || "neutral";

  // The right-swipe action is a TOGGLE, the way it is in a mail client: swipe
  // right on something you have not read and it becomes read; swipe right on
  // something you have and it goes back to unread. Both the label and the colour
  // follow the row's state — a button that offers "Read" on a row that is
  // already read is the one way to get this wrong.
  const toggleAction = n.read
    ? { icon: "●", label: "Unread", tone: "brand" }
    : { icon: "✓", label: "Read", tone: "success" };

  return (
    <SwipeableRow
      className="notif-row"
      exiting={Boolean(held) || clearing}
      // A row held on its own exits immediately; a row caught in a bulk clear
      // waits its turn in the stagger.
      exitDelay={held ? 0 : exitDelay}
      leftAction={{ ...toggleAction, onTrigger: () => onToggleRead(n.id) }}
      rightAction={{
        icon: "🗑",
        label: "Remove",
        // The row is already leaving by the time this runs, so it must not spring
        // back to rest underneath the exit. It is thrown the rest of the way in
        // the direction of the flick instead.
        dismissOnCommit: true,
        tone: "danger",
        onTrigger: onRemove,
      }}
    >
      <div
        className={cx(
          "glass-card card card-pad notif-card",
          n.read ? "notif-card-read" : "notif-card-unread",
        )}
      >
        <div className="row notif-card-top" style={{ alignItems: "flex-start" }}>
          <span
            className={cx("notif-dot", `notif-dot-${tone}`)}
            aria-hidden="true"
          />

          <div className="notif-card-body">
            <div className="row-between notif-card-head" style={{ gap: "0.5rem" }}>
              <strong className={cx("small", !n.read && "bold")}>{n.subject}</strong>
              <span className="tiny muted nowrap notif-time">
                {formatDateTime(n.createdAt)}
              </span>
            </div>

            <p className="small muted notif-text">{n.body}</p>

            <div className="row row-wrap tiny muted notif-meta">
              <span className={cx("badge", tone !== "neutral" && `badge-${tone}`)}>
                {EVENT_LABEL[n.event] ?? n.event}
              </span>
              <StatusBadge status={n.status} />
              {n.channel && <span>via {n.channel}</span>}
              {n.email && <span>· {n.email}</span>}
            </div>
          </div>

          {/* The swipe has a real button beside it. Swipe is an accelerator for
              a pointer; this is the control itself, and it is what a keyboard
              or a screen reader actually operates. Present on every row,
              reading or not — the gesture toggles, so the button toggles. */}
          <div className="notif-card-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon notif-action"
              onClick={() => (n.read ? onToggleRead(n.id) : onMarkRead(n.id))}
              disabled={marking}
              title={n.read ? "Mark as unread" : "Mark as read"}
              aria-label={`Mark "${n.subject}" as ${n.read ? "unread" : "read"}`}
              aria-pressed={!n.read}
            >
              {marking ? <Spinner /> : toggleAction.icon}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon notif-action notif-action-danger"
              onClick={onRemove}
              title="Remove notification"
              aria-label={`Remove notification "${n.subject}"`}
            >
              🗑
            </button>
          </div>
        </div>
      </div>
    </SwipeableRow>
  );
}