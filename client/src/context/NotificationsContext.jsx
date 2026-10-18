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

  /* ------------------------------------------------------------------ *
   *  Removal                                                           *
   *                                                                     *
   *  Removal is a local edit first and a server write second, for the  *
   *  same reason markOne is: the header badge and this page read the    *
   *  same state, so a row that vanished from the list but still counted *
   *  as unread would be lying to the user. The catch re-reads the whole *
   *  list rather than patching the one row, because the count the      *
   *  server owns cannot be un-decremented reliably.                     *
   * ------------------------------------------------------------------ */

  /**
   * A mirror of the committed state.
   *
   * `setData(updater)` does NOT run the updater before returning: React evaluates
   * it eagerly only as an optimisation, and defers to the render pass whenever
   * the queue already holds an update. Anything that reads what the updater saw
   * straight after the call — which is how a removal gets hold of the row it
   * removed, so "Undo" has something to put back — would be reading a variable
   * that is still `null`. This ref always holds the last committed value, so the
   * read is both correct and explicit about where it came from.
   */
  const committed = useRef(EMPTY);
  useEffect(() => {
    committed.current = data;
  }, [data]);

  /**
   * Remove ONE notification.
   *
   * Returns the removed row, so the caller can offer a precise undo and can hold
   * the row on screen for the length of its exit animation. Returns null when
   * there was nothing to remove — including on failure, which is the signal for
   * the page to NOT show an undo bar, because undoing something that was never
   * removed would be a lie.
   */
  const removeOne = useCallback(
    async (id) => {
      const removed = committed.current.notifications.find((n) => n.id === id);
      if (!id || !removed) return null;
      setData((prev) => ({
        ...prev,
        unread: removed.read ? prev.unread : Math.max(0, (prev.unread || 1) - 1),
        notifications: prev.notifications.filter((n) => n.id !== id),
      }));
      try {
        await api.removeNotification(id);
        return removed;
      } catch (err) {
        setError(err?.message || "Could not remove that notification");
        await load({ quiet: true });
        return null;
      }
    },
    [load],
  );

  /**
   * Remove many. `scope: "read"` clears only what is already read.
   *
   * The rows are captured from committed state before the write so an undo can
   * put the exact previous list back. `ok: false` means nothing was removed —
   * either there was nothing in scope, or the write failed and the list has
   * been re-read — and the caller must not offer an undo for it.
   */
  const removeAll = useCallback(
    async ({ scope = "all" } = {}) => {
      const current = committed.current.notifications;
      const snapshot =
        scope === "read" ? current.filter((n) => n.read) : current;
      if (!snapshot.length) return { removed: [], scope, ok: false };
      const keep = scope === "read" ? current.filter((n) => !n.read) : [];
      setData((prev) => ({
        ...prev,
        notifications: keep,
        unread: keep.filter((n) => !n.read).length,
      }));
      try {
        await api.removeNotifications({ scope });
        return { removed: snapshot, scope, ok: true };
      } catch (err) {
        setError(err?.message || "Could not clear your notifications");
        await load({ quiet: true });
        return { removed: [], scope, ok: false };
      }
    },
    [load],
  );

  /**
   * Put back everything that was just removed.
   *
   * The server endpoint restores by USER, not by id — undoing "clear all" cannot
   * enumerate the rows it removed without the client having kept the list, and
   * the endpoint deliberately takes no ids to trust. So the rows to restore are
   * passed in from the snapshot, and `restore()` only fills the gap optimistically
   * while the write is in flight.
   */
  const restore = useCallback(
    async (rowsToRestore = []) => {
      if (!rowsToRestore.length) return false;
      setData((prev) => {
        const known = new Set(prev.notifications.map((n) => n.id));
        const missing = rowsToRestore.filter((n) => !known.has(n.id));
        if (!missing.length) return prev;
        const merged = [...missing, ...prev.notifications].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        );
        return {
          ...prev,
          notifications: merged,
          unread: merged.filter((n) => !n.read).length,
        };
      });
      try {
        await api.restoreNotifications();
        return true;
      } catch (err) {
        setError(err?.message || "Could not restore those notifications");
        await load({ quiet: true });
        return false;
      }
    },
    [load],
  );

  /**
   * Put ONE row back.
   *
   * The optimistic reinsert is what the user sees; the server write behind it is
   * the one that decides whether it stays. `markOne` cannot be reused for this:
   * it PATCHes read state, and a dismissed row that was never read would come
   * back looking read.
   */
  const restoreOne = useCallback(
    async (row) => {
      if (!row) return false;
      setData((prev) => {
        if (prev.notifications.some((n) => n.id === row.id)) return prev;
        const merged = [row, ...prev.notifications].sort(
          (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
        );
        return {
          ...prev,
          notifications: merged,
          unread: merged.filter((n) => !n.read).length,
        };
      });
      try {
        await api.restoreNotification(row.id);
        return true;
      } catch (err) {
        setError(err?.message || "Could not restore that notification");
        await load({ quiet: true });
        return false;
      }
    },
    [load],
  );

  const [marking, setMarking] = useState(null);

  /**
   * Mark ONE notification read.
   *
   * Optimistic like markAllRead, for the same reason: the header badge reads the
   * same state, so waiting for a round trip would leave the number visibly stale
   * while the row claimed to have been actioned. On failure the whole list is
   * re-read, so the UI cannot drift away from the database.
   *
   * `marking` holds the id in flight rather than a boolean, so one row can show
   * a spinner without every row doing so.
   */
  /**
   * Set ONE notification's read state, in either direction.
   *
   * Optimistic like markAllRead, for the same reason: the header badge reads the
   * same state, so waiting for a round trip would leave the number visibly stale
   * while the row claimed to have been actioned. On failure the whole list is
   * re-read, so the UI cannot drift away from the database.
   *
   * The count is adjusted BY THE DIRECTION rather than decremented blindly.
   * Un-reading a message puts it back in the unread pile, so the badge has to go
   * UP; the old unconditional `-1` would have quietly swallowed it.
   *
   * `marking` holds the id in flight rather than a boolean, so one row can show
   * a spinner without every row doing so.
   */
  const setRead = useCallback(
    async (id, read) => {
      if (!id || marking === id) return;
      const before = data;
      setMarking(id);
      setData((prev) => ({
        ...prev,
        unread: read
          ? Math.max(0, (prev.unread || 0) - 1)
          : (prev.unread || 0) + 1,
        notifications: prev.notifications.map((n) =>
          n.id === id
            ? {
                ...n,
                read,
                readAt: read ? n.readAt ?? new Date().toISOString() : null,
              }
            : n,
        ),
      }));
      try {
        await api.markNotificationRead(id, read);
      } catch (err) {
        setData(before);
        setError(
          err?.message ||
            (read
              ? "Could not mark that notification read"
              : "Could not mark that notification unread"),
        );
      } finally {
        setMarking(null);
      }
    },
    [data, marking],
  );

  /** Mark ONE notification read. The common direction, named for callers. */
  const markOne = useCallback((id) => setRead(id, true), [setRead]);

  /**
   * Flip ONE notification's read state, whichever way it currently is.
   *
   * This is what the swipe gesture calls, and it reads the CURRENT state rather
   * than being told: two swipes in quick succession must mean "read, then
   * unread" even though the second one is answered before the first write has
   * landed.
   */
  const toggleRead = useCallback(
    (id) => {
      const row = committed.current.notifications.find((n) => n.id === id);
      return setRead(id, !row?.read);
    },
    [setRead],
  );

  const value = useMemo(
    () => ({
      notifications: data.notifications || [],
      unread: data.unread || 0,
      channels: data.channels || {},
      loading,
      error,
      reload: load,
      markAllRead,
      markOne,
      toggleRead,
      marking,
      removeOne,
      removeAll,
      restore,
      restoreOne,
    }),
    [
      data,
      loading,
      error,
      load,
      markAllRead,
      markOne,
      toggleRead,
      removeOne,
      removeAll,
      restore,
      restoreOne,
    ],
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