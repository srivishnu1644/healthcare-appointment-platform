import { createContext, useContext, useEffect, useMemo, useState } from "react";
import api, {
  setTokens,
  clearToken,
  getToken,
  getRefreshToken,
  setSessionLostHandler,
} from "../api/client";

const AuthContext = createContext(null);

const USER_KEY = "medicare_user";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const cached = localStorage.getItem(USER_KEY);
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  // Booting whenever a token exists, not just an access token: a page reload
  // after the access token expired still has a refresh token, and the session
  // is recoverable.
  const [booting, setBooting] = useState(
    Boolean(getToken() || getRefreshToken()),
  );

  const persistUser = (next) => {
    setUser(next);
    if (next) localStorage.setItem(USER_KEY, JSON.stringify(next));
    else localStorage.removeItem(USER_KEY);
  };

  // When a refresh fails for good - the refresh token was revoked, replayed or
  // expired - the api layer clears storage. Mirror that into React state so the
  // route guards see the user is gone and redirect to /login.
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
      localStorage.removeItem(USER_KEY);
    });
  }, []);

  // Restore the session on first paint so a revoked or expired session doesn't
  // render a broken app shell. `api.me()` transparently refreshes first if the
  // access token has expired, so this also covers "access token expired while the
  // tab was closed".
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getToken() && !getRefreshToken()) {
        setBooting(false);
        return;
      }
      try {
        const data = await api.me();
        if (cancelled) return;
        persistUser(data.user);
      } catch {
        if (cancelled) return;
        // Includes the case where the refresh itself failed: storage is already
        // cleared by then.
        clearToken();
        setUser(null);
      } finally {
        if (!cancelled) setBooting(false);
      }
    }

    restore();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount: later changes to `user` do not need to
    // re-trigger a session restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({
      user,
      booting,
      isAuthenticated: Boolean(user),
      role: user?.role ?? null,

      async login(email, password) {
        const data = await api.login(email, password);
        setTokens(data);
        persistUser(data.user);
        return data.user;
      },

      async register(payload) {
        const data = await api.register(payload);
        // Registration signs the user in, so a token pair is always present.
        if (data.token) {
          setTokens(data);
          persistUser(data.user);
        }
        return data;
      },

      async refresh() {
        try {
          const data = await api.me();
          persistUser(data.user);
          return data.user;
        } catch {
          return null;
        }
      },

      async updateProfile(patch) {
        const data = await api.updateProfile(patch);
        persistUser(data.user);
        return data.user;
      },

      async logout() {
        // End the session on the server first, so the refresh token cannot be
        // reused even if local storage is later restored from a backup. Local
        // state is cleared regardless of the outcome.
        await api.logout();
        clearToken();
        persistUser(null);
      },
    }),
    [user, booting],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export default AuthContext;