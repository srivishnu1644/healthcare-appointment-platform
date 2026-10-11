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

const NotificationsContext = createContext(null);

const EMPTY = { notifications: [], unread: 0, channels: {} };
const POLL_MS = 30000;

/**
 * NotificationsProvider — the single owner of notification state.
 *
 * WHY A PROVIDER AND NOT A HOOK
 * ------------------------------
 * `useNotifications` used to be called from three places (the app shell, the
 * patient dashboard and the notifications page). Each call built its own
 * `useState`, so those were three unrelated copies of the same data and three
 * independent 30-second pollers firing at once. A hook shared by several
 * components shares no state with any of them — that is the whole point of
 * component-local state.
 *
 * Lifting it into a provider makes one copy: one poller, one unread count, and
 * marking everything read on the notifications page now updates the header bell
 * immediately instead of up to 30 seconds later when the shell happens to poll
 * again.
 *
 * Mounted inside <AuthProvider> because it polls only while someone is signed
 * in, and refetches whenever the signed-in user changes.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const ticket = useRef(0);

  const load = useCallback(async ({ quiet = false } = {}) => {
    // Signed-out visitors have nothing to fetch - skip so we do not spam 401s.
    if (!getToken()) {
      ticket.current += 1;
      setData(EMPTY);
      setLoading(false);
      return;
    }
    const mine = (ticket.current += 1);
    if (!quiet) setLoading(true);
    try {
      const res = await api.notifications();
      if (mine !== ticket.current) return;
      setData({
        notifications: res.notifications || [],
        unread: res.unread || 0,
        channels: res.channels || {},
      });
      setError(null);
    } catch (err) {
      if (mine !== ticket.current) return;
      setError(err?.message || "Could not load notifications");
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, []);

  // Initial load, and a reload whenever the signed-in identity changes (or is
  // lost), so the badge is right the moment a session starts or ends.
  const userId = user?.id ?? null;
  useEffect(() => {
    load();
    return () => {
      ticket.current += 1;
    };
  }, [load, userId]);

  // One poller for the whole app, only while signed in.
  const signedIn = Boolean(user);
  useEffect(() => {
    if (!signedIn) return undefined;
    const id = setInterval(() => load({ quiet: true }), POLL_MS);
    return () => clearInterval(id);
  }, [signedIn, load]);

  const markAllRead = useCallback(async () => {
    // Optimistic: flip local state so every consumer — the header bell
    // included — drops the badge immediately.
    setData((prev) => ({
      ...prev,
      unread: 0,
      notifications: prev.notifications.map((n) => ({ ...n, read: true })),
    }));
    try {
      await api.markNotificationsRead();
    } catch (err) {
      setError(err?.message || "Could not mark notifications read");
      load({ quiet: true });
    }
  }, [load]);

  const value = useMemo(
    () => ({
      notifications: data.notifications || [],
      unread: data.unread || 0,
      channels: data.channels || {},
      loading,
      error,
      reload: load,
      markAllRead,
    }),
    [data, loading, error, load, markAllRead],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

/**
 * Read the shared notification state. Safe to call from any component at any
 * depth: it subscribes to the one copy rather than fetching its own.
 */
export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotifications must be used inside <NotificationsProvider>");
  }
  return ctx;
}

export default NotificationsContext;