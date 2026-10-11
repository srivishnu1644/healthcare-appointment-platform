import { useCallback, useEffect, useRef, useState } from "react";

import api from "../api/client";

const EMPTY_SLOTS = [];
const EMPTY_DATES = [];

/**
 * useDoctorSlots — the single way the UI reads a doctor's bookable slots.
 *
 * Used by the booking panel on a doctor profile and by the reschedule picker on
 * MyAppointments. Both previously hand-rolled the same fetch-and-keep state,
 * which is how the two drifted apart.
 *
 * STALE RESPONSES
 * ---------------
 * Same ticket-based guard as `useAppointments`: switching `doctorId` while a
 * request is in flight discards the old reply instead of letting it overwrite
 * the new doctor's slots, and a reply that arrives after unmount is dropped.
 * That matters here because slots are fetched per doctor — a slow reply for the
 * previous doctor would otherwise render the wrong calendar under the right name.
 *
 * @param {string|number|null} doctorId  whose slots to load. `null` fetches
 *   nothing, so a component can hold an id that is not chosen yet.
 * @param {object} [params] query parameters forwarded to `api.doctorSlots`,
 *   e.g. `{ status: "available", futureOnly: true }`.
 * @param {{enabled?: boolean}} [options] set `enabled: false` to defer loading
 *   until some other condition is met (for example until a modal opens).
 * @returns {{slots: object[], dates: string[], data: object|null,
 *   loading: boolean, error: string|null, refresh: Function}}
 */
export function useDoctorSlots(doctorId, params, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Params and the doctor id are read through refs so `load` stays
  // referentially stable: the value is taken at call time and staleness is
  // handled by the ticket counter, not by rebuilding the callback.
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const doctorIdRef = useRef(doctorId);
  doctorIdRef.current = doctorId;

  const queryKey = JSON.stringify(params ?? {});
  const ticket = useRef(0);
  const active = Boolean(doctorId) && enabled;

  const load = useCallback(async () => {
    const id = doctorIdRef.current;
    if (!id) return;
    const mine = (ticket.current += 1);
    setLoading(true);
    try {
      // `undefined` and `null` are not interchangeable here: the query-string
      // helper defaults on `undefined` but throws on `null`, so normalise
      // before the call rather than making every caller remember.
      const res = await api.doctorSlots(id, paramsRef.current ?? undefined);
      if (mine !== ticket.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (mine !== ticket.current) return;
      setError(err?.message || "Could not load availability");
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
    // Keyed on the query only. Changing doctorId is handled by the effect
    // below, which bumps the ticket before calling this again.
  }, [queryKey]);

  useEffect(() => {
    if (!active) {
      // Nothing to load (yet). Drop slots from a previous doctor so a closed
      // modal does not leave the old calendar on screen.
      ticket.current += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    load();
    // Invalidates anything still in flight for the previous doctor, and any
    // response that arrives after this component goes away.
    return () => {
      ticket.current += 1;
    };
  }, [active, doctorId, queryKey, load]);

  const refresh = useCallback(() => load(), [load]);

  return {
    // Stable empty references, so a consumer memoising on them is not
    // invalidated on every render while data is still absent.
    slots: data?.slots || EMPTY_SLOTS,
    dates: data?.dates || EMPTY_DATES,
    data,
    loading,
    error,
    refresh,
  };
}

export default useDoctorSlots;