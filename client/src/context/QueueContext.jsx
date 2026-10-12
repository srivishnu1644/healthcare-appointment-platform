/**
 * Live waiting-room state, shared by every component that shows a queue.
 *
 * WHY A PROVIDER AND NOT A HOOK
 * ------------------------------
 * The doctor dashboard and a patient's appointment view can both be on screen,
 * and both need the same room. `useState` inside a hook is component-local, so
 * two components would each build their own copy of the data AND each start
 * their own 5-second poller. That is the duplicate-poller bug the notifications
 * provider was written to avoid, and the same reasoning applies here.
 *
 * So there is ONE poller for the whole app, owned here, and components read the
 * state it holds.
 *
 * POLLING, AND WHY IT IS THIS WAY
 * -------------------------------
 * The queue only changes when somebody checks in, the doctor calls somebody, or
 * a visit ends — a handful of events across a clinic day. An SSE stream would
 * mean a long-lived connection per browser tab, per-connection authorization,
 * and a replay story for reconnects, none of which this project has. A
 * five-second poll over a handful of rows is cheaper and far easier to reason
 * about.
 *
 * Three rules make a poll safe rather than a source of flicker:
 *   1. it only runs while the tab is VISIBLE, so a background tab costs nothing;
 *   2. it never overlaps itself — an in-flight request defers the next tick;
 *   3. responses carry a ticket, and a response whose ticket is stale (because
 *      something newer already landed) is discarded rather than rendered.
 *
 * The last one matters because the queue can also be refreshed by hand, or after
 * a mutation. Without it, a slow poll response could overwrite a fresher one.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import api, { getToken } from "../api/client";
import { useAuth } from "./AuthContext.jsx";
import { todayISO } from "../utils/format";

const QueueContext = createContext(null);

/** How often the room is re-read while the tab is visible. */
const POLL_MS = 5000;

const EMPTY = {
  doctorId: null,
  clinicDate: null,
  total: 0,
  waitingCount: 0,
  waiting: 0,
  averageWaitMinutes: 0,
  activeConsultation: null,
  entries: [],
};

export const waitingPatients = (room) =>
  (room?.entries ?? []).filter((e) => e.state === "waiting");

export function QueueProvider({ children }) {
  const { user } = useAuth();
  const [room, setRoom] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Monotonic ticket: only the newest response may write state.
  const ticket = useRef(0);
  // Set while a request is in flight, so a tick cannot start a second one.
  const inFlight = useRef(false);

  const doctorId = user?.role === "doctor" ? (user.doctor?.id ?? null) : null;
  const signedIn = Boolean(user);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      // Only a provider has a waiting room. Everyone else gets nothing to poll,
      // which also stops the poller firing 401s after a sign-out.
      if (!doctorId || !getToken()) {
        ticket.current += 1;
        setRoom(EMPTY);
        setLoading(false);
        setError(null);
        return;
      }
      if (inFlight.current) return;
      inFlight.current = true;
      const mine = (ticket.current += 1);
      if (!quiet) setLoading(true);
      try {
        const res = await api.queue({ doctorId, date: todayISO() });
        // A newer request already landed: this one is stale, drop it.
        if (mine !== ticket.current) return;
        setRoom({
          ...EMPTY,
          ...res,
          waitingCount: res?.waitingCount ?? res?.waiting ?? 0,
        });
        setError(null);
      } catch (err) {
        if (mine !== ticket.current) return;
        setError(err?.message || "Could not load the waiting room");
      } finally {
        inFlight.current = false;
        if (mine === ticket.current) setLoading(false);
      }
    },
    [doctorId],
  );

  // Initial load, and a reset whenever the signed-in identity changes (or goes
  // away), so one provider's room is never shown to another.
  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
    };
  }, [load, signedIn]);

  // One poller for the whole app, only while signed in as a provider and only
  // while the tab is actually visible.
  useEffect(() => {
    if (!doctorId) return undefined;
    let timer = null;

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) {
        // Skip this round rather than cancel-and-restart, so the interval keeps
        // a simple, predictable cadence.
      } else {
        await load({ quiet: true });
      }
      timer = setTimeout(tick, POLL_MS);
    };

    timer = setTimeout(tick, POLL_MS);

    // Coming back to the tab: re-read at once instead of waiting out the
    // interval, so the room is not stale for up to five seconds after a return.
    const onVisible = () => {
      if (!document.hidden) load({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [doctorId, load]);

  /**
   * Re-read now and report what happened, so a caller can refresh after a
   * mutation without knowing how polling works.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ quiet: true });
      return true;
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const value = useMemo(
    () => ({
      room,
      loading,
      error,
      refreshing,
      refresh,
      reload: load,
      waitingPatients: waitingPatients(room),
    }),
    [room, loading, error, refreshing, refresh, load],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

export const useQueue = () => useContext(QueueContext);