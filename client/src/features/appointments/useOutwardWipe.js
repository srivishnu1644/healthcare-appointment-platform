import { useCallback, useRef } from "react";

/**
 * Replays an outward horizontal wipe on whichever `.appt-btn` was clicked.
 *
 * WHY A CLICK-CAPTURE HANDLER INSTEAD OF CSS `:active`
 * ----------------------------------------------------
 * `:active` is only true while the pointer is held down, so the sweep would be
 * cut short by however briefly the button was tapped - a fast click would show
 * a third of the wipe and snap back. This runs the FULL sweep on the click
 * itself, so the motion reads the same on a 40ms tap and a 400ms press.
 *
 * WHY DELEGATION
 * -------------
 * The buttons are siblings in a list and their own onClick handlers already do
 * the real work (fire a request, open a modal). Attaching the effect to the
 * CONTAINER and resolving the target from the event keeps that separate, so
 * neither call site has to remember to call this and neither existing handler
 * has to change.
 *
 * WHY THE CLASS IS REMOVED BEFORE IT IS RE-ADDED
 * ----------------------------------------------
 * Clicking the same button twice in a row must replay the animation. Re-adding
 * a class that is already present is a no-op and the sweep would fire only
 * once. Removing it, forcing layout with a reflow read, then re-adding it
 * guarantees a fresh animation every time.
 *
 * @returns {Function} an `onClickCapture` handler for the group container
 */
export function useOutwardWipe() {
  // Keyed by element so two different buttons can be mid-wipe at once, and so
  // a rapid second click on the same one cancels only its own pending reset.
  const timers = useRef(new Map());

  return useCallback((event) => {
    const button = event.target.closest?.(".appt-btn");
    if (!button) return;

    button.classList.remove("is-wiping");
    void button.offsetWidth; // reflow, so the re-add starts a new animation
    button.classList.add("is-wiping");

    const pending = timers.current.get(button);
    if (pending) clearTimeout(pending);

    // Comfortably longer than the wipe itself (340ms), so the overlay always
    // reaches full width before it is reset.
    timers.current.set(
      button,
      setTimeout(() => {
        button.classList.remove("is-wiping");
        timers.current.delete(button);
      }, 420),
    );
  }, []);
}

export default useOutwardWipe;
