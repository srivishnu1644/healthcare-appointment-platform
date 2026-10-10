import { useCallback, useEffect, useState } from "react";
import api, { getToken } from "../api/client";

const EMPTY = { notifications: [], unread: 0, channels: {} };

/**
 * Shared unread-notification counter.
 *
 * The header bell and the notifications page both need this, so it lives in one
 * hook. Pass `poll` to enable periodic refresh (used on the patient home page).
 */
export function useNotifications({ poll = false, interval = 30000 } = {}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    // Signed-out visitors have nothing to fetch - skip so we do not spam 401s.
    if (!getToken()) {
      setData(EMPTY);
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const res = await api.notifications();
      setData(res);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!poll) return undefined;
    const id = setInterval(() => load({ quiet: true }), interval);
    return () => clearInterval(id);
  }, [poll, interval, load]);

  const markAllRead = useCallback(async () => {
    // Optimistic: flip local state so the badge drops immediately.
    setData((prev) => ({
      ...prev,
      unread: 0,
      notifications: prev.notifications.map((n) => ({ ...n, read: true })),
    }));
    try {
      await api.markNotificationsRead();
    } catch (err) {
      setError(err.message);
      load({ quiet: true });
    }
  }, [load]);

  return {
    notifications: data.notifications || [],
    unread: data.unread || 0,
    channels: data.channels || {},
    loading,
    error,
    reload: load,
    markAllRead,
  };
}

export default useNotifications;
