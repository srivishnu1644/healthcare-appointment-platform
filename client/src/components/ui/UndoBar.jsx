import { useEffect, useRef, useState } from "react";

import { cx } from "../../utils/format";

/**
 * UndoBar — the safety net under every destructive gesture on this page.
 *
 * WHY A DEDICATED BAR AND NOT A TOAST
 * -----------------------------------
 * `useToast()` renders text and nothing else: no action, no timer, no way to
 * tell whether the window is nearly gone. This is the control that makes
 * "slide to remove" safe to ship at all — the user swipes, the row is gone
 * immediately (no modal, no second tap, no lag), and the thing they may want
 * back stays recoverable for five seconds.
 *
 * Those five seconds are shown, not implied: the bar drains left to right, so
 * the moment undo disappears is a thing the user watched happen rather than a
 * thing that happened to them.
 *
 * A11y notes, since this is the part that is easy to get wrong:
 *   * `role="status"` + `aria-live="polite"` announces the outcome without
 *     stealing focus mid-gesture.
 *   * `role="timer"` + `aria-live="off"` on the drain keeps a 60Hz CSS animation
 *     from being read as a stream of updates.
 *   * The Undo button is real focusable focus. A gesture-only affordance is
 *     invisible to a keyboard user; this is their way in.
 */
export default function UndoBar({ message, detail, onUndo, onExpire, duration = 6000 }) {
  const [leaving, setLeaving] = useState(false);
  const timers = useRef([]);

  const clear = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  // A new action replaces the previous one outright rather than queueing. Two
  // bars means two undo buttons, and the second one silently commits the first
  // action's removal — which is exactly the surprise this bar exists to prevent.
  useEffect(() => {
    if (!message) return undefined;
    setLeaving(false);
    const expire = setTimeout(() => setLeaving(true), duration - 260);
    const done = setTimeout(() => onExpire?.(), duration);
    timers.current = [expire, done];
    return clear;
  }, [message, duration, onExpire]);

  if (!message) return null;

  const undo = () => {
    clear();
    onUndo?.();
  };

  return (
    <div
      className={cx("undo-bar", leaving && "undo-bar-leaving")}
      role="status"
      aria-live="polite"
    >
      <span className="undo-bar-icon" aria-hidden="true">
        🗑
      </span>
      <div className="undo-bar-text">
        <strong className="undo-bar-message">{message}</strong>
        {detail && <span className="undo-bar-detail">{detail}</span>}
      </div>
      <button type="button" className="undo-bar-cta" onClick={undo}>
        Undo
      </button>
      <span className="undo-bar-track" role="timer" aria-live="off" aria-hidden="true">
        <span className="undo-bar-fill" style={{ animationDuration: `${duration}ms` }} />
      </span>
    </div>
  );
}