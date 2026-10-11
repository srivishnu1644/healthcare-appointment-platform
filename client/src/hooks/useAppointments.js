import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import api from "../api/client";
import { splitByTime } from "../utils/appointments";

/**
 * useAppointments — the single way patient screens read appointments.
 *
 * Replaces the copy-pasted `load()` + `useState` + `useEffect` triple that used
 * to appear in the dashboard and in MyAppointments. Every call goes through
 * `api.appointments`, so no component talks to the network directly and there is
 * one place to change if the endpoint ever moves.
 *
 * STALE RESPONSES
 * ---------------
 * Changing `params` while a request is in flight used to be a race: whichever
 * response landed last won, so a slow reply for the old parameters could
 * overwrite a fast reply for the new ones. Every request now takes a ticket
 * from a counter, and a response may only write state while its ticket is still
 * the newest. The effect cleanup bumps the same counter, which also means a
 * response arriving after unmount is discarded instead of calling setState on an
 * unmounted component.
 *
 * TIMING
 * ------
 * `upcoming` and `past` are split by absolute instant via `splitByTime`, using
 * the server's `startsAt`. Nothing here compares calendar date strings, so a
 * browser in a non-UTC timezone cannot misfile an appointment.
 *
 * @param {object} [params] query parameters forwarded to `api.appointments`,
 *   e.g. `{ status, from, to }`. A new object with the same contents will not
 *   trigger a refetch; only a change in contents will.
 * @returns {{appointments: object[], upcoming: object[], past: object[],
 *   count: number, loading: boolean, error: string|null, refresh: Function}}
 */
export function useAppointments(params) {
  const [appointments, setAppointments] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Params are read through a ref so that `load` stays referentially stable
  // across renders even when a caller passes an inline object literal.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const queryKey = JSON.stringify(params ?? {});

  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = (ticket.current += 1);
    setLoading(true);
    try {
      const res = await api.appointments(paramsRef.current ?? undefined);
      // A newer request has been issued, or we are unmounted: drop this reply.
      if (mine !== ticket.current) return;
      const list = res?.appointments || [];
      setAppointments(list);
      setCount(typeof res?.count === "number" ? res.count : list.length);
      setError(null);
    } catch (err) {
      if (mine !== ticket.current) return;
      setError(err?.message || "Could not load appointments");
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [queryKey]);

  useEffect(() => {
    load();
    // Invalidate anything still in flight for the previous parameters, and any
    // response that arrives after this component goes away.
    return () => {
      ticket.current += 1;
    };
  }, [load]);

  const { upcoming, past } = useMemo(
    () => splitByTime(appointments),
    [appointments],
  );

  const refresh = useCallback(() => load(), [load]);

  return {
    appointments,
    upcoming,
    past,
    count,
    loading,
    error,
    refresh,
  };
}

export default useAppointments;