import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cx } from "../../utils/format";

/**
 * SwipeableRow — a list row that can be pushed aside to act on it.
 *
 * WHY THE GESTURE IS IMPERATIVE
 * -----------------------------
 * The first version drove the drag with React state: `setOffset` on every
 * `pointermove`. Measured against a real pointer, the row came out at HALF the
 * pointer's speed and started seven frames late:
 *
 *     pointer  -6 -12 -18 -24 -30 -36 -42 -48 -54 -60 -66 -72 -78 -84
 *     row       0   0   0   0   0   0   0 -12 -12 -18 -18 -18 -24 -24 -30
 *
 * Every move re-rendered every row in the list, and the browser coalesced the
 * events it could not paint in time, so the row was always several frames behind
 * the finger — the single most common way a swipe gesture feels broken.
 *
 * So the drag writes `transform` straight to the node, at most once per frame,
 * and React is told only about the OUTCOME. A gesture has exactly one commit
 * point, and it is the release.
 *
 * WHY IT SPRINGS
 * --------------
 * The snap is a real spring carrying the release velocity into the animation,
 * not a fixed-duration transition. A flick that moves a long way in a short time
 * continues travelling after the finger leaves the glass, and a fixed curve
 * cannot be right for both a slow drag that barely passed the threshold and a
 * hard flick that went past it by a mile.
 *
 * WHY THERE IS NO SECOND TAP
 * --------------------------
 * The action fires as the finger lifts. A confirm step here would ask for two
 * gestures to do one thing, and people learn to fire the first swipe blindly —
 * which is worse than either trusting the swipe or confirming it, because it
 * teaches the confirm to mean nothing. What makes a swipe safe to act on
 * immediately is not a dialog: it is that the destructive outcome is reversible,
 * which the caller guarantees with a timed undo, and that the threshold is past
 * the point of no return rather than a few pixels.
 *
 * The row is thrown in the direction of the flick, and further the harder it was
 * thrown, so the row reads as leaving under its own momentum rather than being
 * switched off. The action itself stays a real `<button>`, reachable by mouse
 * and by keyboard, for anyone who is not swiping at all.
 */

/** Travel needed to reveal an action. Comfortably past a 44px thumb. */
const REVEAL = 104;
/** Below this the row is at rest and nothing is revealed. */
const EPSILON = 6;
/** Projection time for a flick: ~2 frames at 120Hz. */
const PROJECT_MS = 16;

/** Spring constants. ζ ≈ 0.93 — just under critical, so it settles with a hint of overshoot. */
const STIFFNESS = 420;
const DAMPING = 38;

const clamp = (value) => Math.max(-REVEAL, Math.min(value, REVEAL));

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * Run a damped spring from `from` to `to`, starting at `velocity` px/ms.
 *
 * The timestep is CLAMPED rather than trusted. A backgrounded tab hands back one
 * enormous delta when it is resumed; an unclamped spring integrates that and
 * explodes off the screen.
 */
const springTo = (from, to, velocity, onFrame, onDone) => {
  let x = from;
  let v = velocity;
  let last = performance.now();

  const step = (now) => {
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    const a = -STIFFNESS * (x - to) - DAMPING * v;
    v += a * dt;
    x += v * dt;
    if (Math.abs(x - to) < 0.4 && Math.abs(v) < 12) {
      onFrame(to);
      onDone();
      return;
    }
    onFrame(x);
    requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
};

export default function SwipeableRow({
  children,
  leftAction,
  rightAction,
  exiting = false,
  exitDelay = 0,
  className,
}) {
  const rowRef = useRef(null);
  const bodyRef = useRef(null);
  const drag = useRef(null);
  const paintFrame = useRef(0);
  const settleFrame = useRef(0);
  const offset = useRef(0);
  // Mirrors the committed state for the gesture, which reads it synchronously
  // during a drag that React has not re-rendered for yet.
  const committed = useRef({ side: null, velocity: 0 });

  const [open, setOpen] = useState(false);
  const [openSide, setOpenSide] = useState(null);
  // A frame behind `exiting`: measured first, collapsed on the next one.
  const [collapsing, setCollapsing] = useState(false);

  /* ---------------- painting ---------------- */

  /**
   * Write the drag to the DOM. One style write, two class flips, two custom
   * properties carrying the reveal progress and the travel.
   */
  const paint = useCallback((x) => {
    const row = rowRef.current;
    const body = bodyRef.current;
    if (!row || !body) return;
    offset.current = x;
    body.style.transform = `translate3d(${x}px, 0, 0)`;
    row.classList.toggle("swipe-row-showing-start", x > EPSILON);
    row.classList.toggle("swipe-row-showing-end", x < -EPSILON);
    row.style.setProperty("--action-progress", Math.min(Math.abs(x) / REVEAL, 1).toFixed(3));
    // Published for the parallax: the card's CONTENT trails the card by a
    // fraction of its travel, so a slid row does not present its text sliced off
    // mid-word at the edge.
    row.style.setProperty("--swipe-x", `${x.toFixed(1)}px`);
  }, []);

  /** Coalesce pointer moves to one write per frame. */
  const schedulePaint = useCallback(
    (x) => {
      offset.current = x;
      if (paintFrame.current) return;
      paintFrame.current = requestAnimationFrame(() => {
        paintFrame.current = 0;
        paint(offset.current);
      });
    },
    [],
  );

  const stopPainting = useCallback(() => {
    if (paintFrame.current) {
      cancelAnimationFrame(paintFrame.current);
      paintFrame.current = 0;
    }
  }, []);

  const springBackTo = useCallback(
    (to, velocity = 0, onDone) => {
      stopPainting();
      const from = offset.current;
      if (prefersReducedMotion() || from === to) {
        paint(to);
        onDone?.();
        return;
      }
      settleFrame.current = requestAnimationFrame(() => {
        springTo(from, to, velocity, paint, () => onDone?.());
      });
    },
    [paint, stopPainting],
  );

  /** Return to rest without running anything. */
  const close = useCallback(() => {
    setOpen(false);
    setOpenSide(null);
    committed.current = { side: null, velocity: 0 };
    springBackTo(0);
  }, [springBackTo]);

  /* ---------------- the gesture ---------------- */

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    // Never start a drag on the action itself: a tap on "Remove" must remove,
    // not begin a drag that then swallows the click.
    if (event.target.closest(".swipe-actions")) return;
    stopPainting();
    drag.current = {
      id: event.pointerId,
      startX: event.clientX,
      startOffset: offset.current,
      decided: false,
      lastX: event.clientX,
      lastT: performance.now(),
      velocity: 0,
    };
  };

  const onPointerMove = (event) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    const delta = event.clientX - d.startX;

    if (!d.decided) {
      // 4px of slop, so a click with a slightly shaky hand still reads as a
      // click and only a clearly sideways intent starts a drag.
      if (Math.abs(delta) < 4) return;
      d.decided = true;
      rowRef.current?.classList.add("swipe-row-dragging");
      rowRef.current?.setPointerCapture?.(event.pointerId);
      return;
    }

    // Velocity is measured here rather than read off `event.velocityX`, which is
    // a non-standard Chromium-only field: it is `undefined` elsewhere, and
    // `undefined * 16` is NaN, which compares false against every threshold.
    const now = performance.now();
    const elapsed = now - d.lastT;
    if (elapsed > 0) {
      // Smoothed, so one jittery final sample cannot decide the outcome.
      d.velocity = d.velocity * 0.7 + ((event.clientX - d.lastX) / elapsed) * 0.3;
      d.lastX = event.clientX;
      d.lastT = now;
    }

    schedulePaint(clamp(d.startOffset + delta));
  };

  /** End the drag. Returns the drag record — which holds the release velocity,
   *  so it has to be read before `drag.current` is cleared. */
  const release = (event) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return null;
    drag.current = null;
    rowRef.current?.classList.remove("swipe-row-dragging");
    return d.decided ? d : null;
  };

  const onPointerUp = (event) => {
    const d = release(event);
    if (!d) return;
    const projected = offset.current + d.velocity * PROJECT_MS;
    const commitAt = REVEAL * 0.45;
    const current = committed.current;

    let side = null;
    if (current.side) {
      // Already acted on or already revealed: this drag is a correction. Come to
      // rest short of the halfway mark and the row closes; pass it and it stays.
      const keep = current.side === "end" ? -REVEAL * 0.5 : REVEAL * 0.5;
      if (current.side === "end" && projected <= keep) side = "end";
      else if (current.side === "start" && projected >= keep) side = "start";
    } else if (projected <= -commitAt && rightAction) {
      side = "end";
    } else if (projected >= commitAt && leftAction) {
      side = "start";
    }

    if (!side) {
      close();
      return;
    }

    committed.current = { side, velocity: d.velocity };
    setOpen(true);
    setOpenSide(side);

    const action = side === "end" ? rightAction : leftAction;
    // A removal has already begun by the time this runs — the row is on its way
    // out, so the spring must not fight it. Anything else returns to rest, and
    // the release velocity carries into that return so the row does not stop
    // dead under the finger. The OPEN state is dropped only once the row has
    // landed: keeping it for the duration is what lets the action's lock-in
    // flash play, and dropping it late would otherwise leave the row flagged open
    // — its actions clickable, and announced to a screen reader, with nothing
    // on screen to press.
    if (action.dismissOnCommit) {
      setOpen(false);
      setOpenSide(null);
      springBackTo(side === "end" ? -REVEAL : REVEAL, d.velocity);
    } else {
      springBackTo(0, d.velocity, () => {
        setOpen(false);
        setOpenSide(null);
      });
    }
    action.onTrigger?.({ side, velocity: d.velocity });
  };

  const onPointerCancel = (event) => {
    if (!release(event)) return;
    // An interrupted drag returns to whatever was committed, not to a guess.
    const current = committed.current;
    if (!current.side) {
      springBackTo(0);
      return;
    }
    springBackTo(current.side === "end" ? -REVEAL : REVEAL);
  };

  /* ---------------- dismissal ---------------- */

  // An open row is a disclosure: a click anywhere else, or Escape, closes it. Or
  // a page fills up with rows that are all half-swiped.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!rowRef.current?.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // Cancel anything in flight when the row goes away, so a spring cannot keep
  // writing to a node that is no longer mounted.
  useEffect(
    () => () => {
      if (paintFrame.current) cancelAnimationFrame(paintFrame.current);
      if (settleFrame.current) cancelAnimationFrame(settleFrame.current);
    },
    [],
  );

  /* ---------------- the exit ---------------- */

  /**
   * Measure the row, then collapse it — on a separate frame.
   *
   * The gap below has to close for the list to look continuous, and the only
   * animatable way to close it is `max-height`, which needs a LENGTH to start
   * from: `none` cannot be interpolated to `0`. Two details make that work:
   *
   *   * The CARD is measured, not the row — React commits the exiting class
   *     before this effect runs, and the row's own `max-height` is already 0 by
   *     then, so measuring the row here returns 0 and nothing animates.
   *   * The collapse is applied a frame later, so the browser has actually
   *     observed that starting value before being given a target.
   *
   * The throw distance comes from the release velocity recorded at commit, so a
   * hard flick sends the row much further than a slow one that just crossed the
   * threshold.
   */
  useLayoutEffect(() => {
    if (!exiting) {
      setCollapsing(false);
      return undefined;
    }
    if (bodyRef.current) {
      bodyRef.current.style.transform = "";
      rowRef.current?.style.setProperty(
        "--exit-height",
        `${bodyRef.current.offsetHeight}px`,
      );
      rowRef.current?.style.setProperty(
        "--throw",
        String(Math.min(Math.abs(committed.current.velocity), 2.4).toFixed(2)),
      );
    }
    const frame = requestAnimationFrame(() => setCollapsing(true));
    // A backgrounded tab gets no animation frames, so the collapse would never
    // be applied and the row would sit on screen for ever.
    const fallback = setTimeout(() => setCollapsing(true), 80);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  }, [exiting]);

  /* ---------------- render ---------------- */

  const hasLeft = Boolean(leftAction);
  const hasRight = Boolean(rightAction);

  return (
    <div
      ref={rowRef}
      className={cx(
        "swipe-row",
        open && "swipe-row-open",
        openSide === "start" && "swipe-row-open-start",
        openSide === "end" && "swipe-row-open-end",
        exiting && "swipe-row-exiting",
        collapsing && "swipe-row-collapsing",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        // The stagger for a bulk clear. Per row, so a list of forty collapses as
        // a wave rather than as one block.
        "--exit-delay": `${Math.max(0, exitDelay)}ms`,
      }}
    >
      {/*
        The actions sit behind the row and are uncovered as it moves. Buttons
        rather than decoration, so the action is reachable by keyboard and
        announced by a screen reader — the gesture is the fast path, not the only
        path.
      */}
      {(hasLeft || hasRight) && (
        <div className="swipe-actions">
          {hasLeft && (
            <button
              type="button"
              className={cx(
                "swipe-action",
                `swipe-action-${leftAction.tone || "neutral"}`,
                "swipe-action-start",
              )}
              onClick={(event) => {
                event.stopPropagation();
                leftAction.onTrigger?.({ side: "start", velocity: 0 });
              }}
              tabIndex={openSide === "start" ? 0 : -1}
              aria-hidden={openSide !== "start"}
            >
              <span className="swipe-action-icon" aria-hidden="true">
                {leftAction.icon}
              </span>
              <span className="swipe-action-label">{leftAction.label}</span>
            </button>
          )}
          {hasRight && (
            <button
              type="button"
              className={cx(
                "swipe-action",
                `swipe-action-${rightAction.tone || "neutral"}`,
                "swipe-action-end",
              )}
              onClick={(event) => {
                event.stopPropagation();
                rightAction.onTrigger?.({ side: "end", velocity: 0 });
              }}
              tabIndex={openSide === "end" ? 0 : -1}
              aria-hidden={openSide !== "end"}
            >
              <span className="swipe-action-icon" aria-hidden="true">
                {rightAction.icon}
              </span>
              <span className="swipe-action-label">{rightAction.label}</span>
            </button>
          )}
        </div>
      )}

      <div className="swipe-body" ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}