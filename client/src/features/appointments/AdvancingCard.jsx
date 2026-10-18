import { useEffect, useRef, useState } from "react";

import { cx } from "../../utils/format";

/**
 * AdvancingCard — an appointment card that reacts to its own status change.
 *
 * WHY A WRAPPER AND NOT A PROP
 * ----------------------------
 * "Did this appointment's status just change?" is per-item state, and the two
 * places that need the answer both render a LIST, so the comparison has to live
 * in a component. Calling a hook inside `.map()` would break the rules of hooks,
 * and threading an `onChange` callback back out of the list would mean both call
 * sites keeping their own bookkeeping. A tiny component that takes the stage and
 * owns the comparison keeps that knowledge in one place.
 *
 * WHY IT IS NOT ON MOUNT
 * ----------------------
 * The first render has no previous stage, so there is nothing to travel FROM.
 * Treating mount as an advance would fire the whole animation on every page load
 * for every card at once, which is noise rather than feedback.
 *
 * WHY THIS COMPARES VALUES AND NOT A "HAVE I RUN" FLAG
 * ---------------------------------------------------
 * A `useRef(false)` "seen" flag is the obvious way to skip the first pass, and
 * it is wrong. `main.jsx` renders the app inside `React.StrictMode`, which
 * double-invokes effects in development: the first pass consumes the flag and
 * returns, the second pass then finds it already set and animates. Every card
 * on the page would pop its status, flash its rail and stagger its buttons on
 * every load — in dev only, which is the worst kind of bug to chase.
 *
 * Holding the PREVIOUS STAGE VALUE instead is inert under a double invoke: both
 * passes read the same value and neither animates, because nothing changed.
 * Only a genuine transition gets past the guard.
 *
 * @param {string} stage        the appointment's current status
 * @param {string} [className]  the caller's own classes (card, glass-card, …)
 */
function useStageAdvance(stage) {
  // Seeded with the first stage, so mount compares equal and stays quiet.
  const previous = useRef(stage);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (previous.current === stage) return undefined;
    previous.current = stage;
    setAdvanced(true);
    // Longer than the longest animation it triggers (~900ms), so the class is
    // still present when the final frame plays and the card returns to rest
    // cleanly rather than snapping back mid-fade.
    const timer = setTimeout(() => setAdvanced(false), 950);
    return () => clearTimeout(timer);
  }, [stage]);

  return advanced;
}

export default function AdvancingCard({ stage, className, children }) {
  const advanced = useStageAdvance(stage);
  return (
    <div
      className={cx(
        "appt-card",
        stage && `appt-status-${stage}`,
        advanced && "appt-advance",
        className,
      )}
    >
      {children}
    </div>
  );
}
