/**
 * Thin fetch wrapper around the Express API.
 *
 * Session model
 * -------------
 * Two tokens, with different jobs:
 *   * the ACCESS token is short-lived and sent on every request;
 *   * the REFRESH token is long-lived, sent only to /auth/refresh and
 *     /auth/logout, and is rotated on every use.
 *
 * When an access token expires the server says so with `TOKEN_EXPIRED`. That is
 * the one error worth reacting to: `request` transparently refreshes once and
 * replays the original call, so callers never have to think about it.
 *
 * Single-flight refresh
 * ---------------------
 * Several requests can discover an expired token at the same moment. They MUST
 * not each call /auth/refresh: the server rotates on every refresh and treats a
 * replayed token as theft, revoking the whole family. So the first caller
 * performs the refresh and every other caller waits on the same promise. This is
 * not an optimisation - without it, a page making six parallel requests would
 * sign the user out.
 */

const BASE = import.meta.env.VITE_API_URL || "/api";

const ACCESS_KEY = "bookmydoc_token";
const REFRESH_KEY = "bookmydoc_refresh_token";

class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 *  Token storage                                                      *
 * ------------------------------------------------------------------ */

export const getToken = () => localStorage.getItem(ACCESS_KEY);
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);

export const setTokens = ({ token, refreshToken }) => {
  if (token) localStorage.setItem(ACCESS_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
};

export const clearToken = () => {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem("bookmydoc_user");
};

/** Called when a refresh fails for good, so the app can drop to the login screen. */
let onSessionLost = () => {};
export const setSessionLostHandler = (fn) => {
  onSessionLost = typeof fn === "function" ? fn : () => {};
};

/* ------------------------------------------------------------------ *
 *  Refresh                                                            *
 * ------------------------------------------------------------------ */

/** The in-flight refresh, so concurrent callers share one attempt. */
let refreshInFlight = null;

const performRefresh = async () => {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new ApiError("No session", 401, "NO_SESSION");

  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!res.ok || payload?.success === false) {
    // The refresh token is spent, revoked or rejected. There is nothing to
    // retry, so the session is over.
    clearToken();
    onSessionLost();
    throw new ApiError(
      payload?.message || "Your session has ended",
      res.status,
      payload?.error?.code,
    );
  }

  setTokens(payload.data);
  return payload.data;
};

/**
 * Refresh the session, coalescing concurrent callers onto one request.
 * @returns {Promise<{token: string}>}
 */
const refreshSession = () => {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

/* ------------------------------------------------------------------ *
 *  Request                                                            *
 * ------------------------------------------------------------------ */

/**
 * Send a request, refreshing once if the access token has expired.
 *
 * @param {string} path
 * @param {object} opts
 * @param {boolean} opts.auth      attach the bearer token (default true)
 * @param {boolean} opts._retried  internal: prevents an infinite refresh loop
 */
const request = async (
  path,
  { method = "GET", body, auth = true, _retried = false } = {},
) => {
  const headers = { "Content-Type": "application/json" };
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      // Never let the browser cache or revalidate an API response.
      //
      // Express emits an ETag for every JSON body, so a repeat GET of the same
      // URL (revisiting /notifications, say) is revalidated and the server
      // answers 304 with an empty body. `res.ok` is false for 304, so the
      // client raised "Request failed (304)" on a perfectly healthy response,
      // and the affected page rendered an error for data the browser actually
      // already held. These endpoints are live data behind an Authorization
      // header, so storing them serves no purpose; skipping the cache removes
      // the revalidation entirely rather than papering over the empty body.
      cache: "no-store",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(
      "Cannot reach the server. Is the API running on port 5000?",
      0,
      "NETWORK_ERROR",
    );
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  // An expired access token is recoverable: get a new one and replay the call
  // once. Anything else is surfaced to the caller unchanged.
  if (
    !_retried &&
    res.status === 401 &&
    payload?.error?.code === "TOKEN_EXPIRED" &&
    getRefreshToken()
  ) {
    await refreshSession();
    return request(path, { method, body, auth, _retried: true });
  }

  if (!res.ok || payload?.success === false) {
    throw new ApiError(
      payload?.message || `Request failed (${res.status})`,
      res.status,
      payload?.error?.code,
      payload?.error?.details,
    );
  }

  return payload?.data;
};

/* ------------------------------------------------------------------ *
 *  Query string helper                                                *
 * ------------------------------------------------------------------ */
const qs = (params = {}) => {
  const usable = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  if (!usable.length) return "";
  return `?${new URLSearchParams(usable).toString()}`;
};

/* ------------------------------------------------------------------ *
 *  Endpoints                                                          *
 * ------------------------------------------------------------------ */
export const api = {
  // --- auth ---
  login: (email, password) =>
    request("/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    }),
  register: (payload) =>
    request("/auth/register", { method: "POST", body: payload, auth: false }),
  me: () => request("/auth/me"),
  updateProfile: (payload) =>
    request("/auth/me", { method: "PATCH", body: payload }),
  /** Validate the access token and report the live session. */
  session: () => request("/auth/session"),
  /**
   * End the session server-side.
   *
   * Fire-and-forget about its own outcome: local state is cleared either way,
   * and a user who asked to sign out must end up signed out even if the network
   * call fails.
   */
  logout: async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return { ok: true, revoked: 0 };
    try {
      return await request("/auth/logout", {
        method: "POST",
        body: { refreshToken },
        auth: false,
      });
    } catch {
      return { ok: true, revoked: 0 };
    }
  },

  // --- discovery ---
  /** @param {{search?: string}} [params] */
  specialties: (params) => request(`/doctors/specialties${qs(params)}`),
  /** Accepts the opaque id or the human-readable slug. */
  specialty: (idOrSlug) => request(`/doctors/specialties/${idOrSlug}`),
  services: () => request("/doctors/services"),
  service: (id) => request(`/doctors/services/${id}`),
  facilities: (params) => request(`/doctors/facilities${qs(params)}`),
  facility: (id) => request(`/doctors/facilities/${id}`),
  /** Filters: search, specialty, facilityId, city, language, maxFee, minRating,
   *  mode, acceptingOnly, sort, limit, offset. */
  doctors: (params) => request(`/doctors${qs(params)}`),
  recommended: (params) => request(`/doctors/recommended${qs(params)}`),
  doctor: (id) => request(`/doctors/${id}`),
  doctorServices: (id) => request(`/doctors/${id}/services`),
  doctorSlots: (id, params) => request(`/doctors/${id}/slots${qs(params)}`),
  doctorSlot: (id, slotId) => request(`/doctors/${id}/slots/${slotId}`),

  /**
   * Availability for a doctor. Without `range` this is a single summary;
   * `?range=true&days=14` returns one row per date for a booking calendar.
   */
  doctorAvailability: (id, params) =>
    request(`/doctors/${id}/availability${qs(params)}`),

  // --- provider ---
  mySchedule: (params) => request("/doctors/me/schedule" + qs(params)),
  updateSlot: (doctorId, slotId, payload) =>
    request(`/doctors/${doctorId}/slots/${slotId}`, {
      method: "PATCH",
      body: payload,
    }),
  generateSlots: (doctorId, payload) =>
    request(`/doctors/${doctorId}/slots`, { method: "POST", body: payload }),

  /**
   * Remove published slots, by id.
   *
   * Ids rather than a date, because a day holds many slots and the provider has
   * usually picked a few. All-or-nothing: if any slot still carries an
   * appointment the whole call is refused with `SLOT_HAS_APPOINTMENT` and
   * nothing is removed, so a caller must not treat a rejection as partial.
   */
  deleteSlots: (doctorId, slotIds) =>
    request(`/doctors/${doctorId}/slots`, {
      method: "DELETE",
      body: { slotIds },
    }),

  // --- appointments ---
  appointments: (params) => request(`/appointments${qs(params)}`),
  appointment: (id) => request(`/appointments/${id}`),
  book: (payload) =>
    request("/appointments", { method: "POST", body: payload }),
  reschedule: (id, slotId) =>
    request(`/appointments/${id}/reschedule`, {
      method: "PATCH",
      body: { slotId },
    }),
  cancel: (id, reason) =>
    request(`/appointments/${id}/cancel`, {
      method: "PATCH",
      body: { reason },
    }),
  changeStatus: (id, status, note) =>
    request(`/appointments/${id}/status`, {
      method: "PATCH",
      body: { status, note },
    }),
  checkIn: (id) => request(`/appointments/${id}/check-in`, { method: "POST" }),

  // --- notifications ---
  notifications: () => request("/notifications"),
  markNotificationsRead: () =>
    request("/notifications/read-all", { method: "PATCH" }),
  /**
   * Set one notification's read state.
   *
   * `read` is not decoration: the swipe gesture TOGGLES, so a row that is
   * already read is sent back to the unread pile. It is sent explicitly rather
   * than left to the server to infer, so two rapid swipes on one row mean what
   * the user did rather than what the row happened to be at the time.
   */
  markNotificationRead: (id, read = true) =>
    request(`/notifications/${id}/read`, { method: "PATCH", body: { read } }),
  /**
   * Dismiss one notification (the slide-to-remove gesture).
   *
   * DELETE at the wire level because that is what the user means, but the
   * server only stamps `deleted_at` — the row is recoverable, which is what
   * makes the undo in the UI honest rather than decorative.
   */
  removeNotification: (id) => request(`/notifications/${id}`, { method: "DELETE" }),
  /**
   * Dismiss many at once. `scope: "read"` clears only what has already been
   * read, which is the everyday case and is offered alongside the full clear.
   */
  removeNotifications: (params) =>
    request(`/notifications${qs(params)}`, { method: "DELETE" }),
  /** Undo for `removeNotification`. */
  restoreNotification: (id) =>
    request(`/notifications/${id}/restore`, { method: "POST" }),
  /** Undo for `removeNotifications`. */
  restoreNotifications: () =>
    request("/notifications/restore-all", { method: "POST" }),
  runReminderSweep: () =>
    request("/notifications/reminders/sweep", { method: "POST" }),

  // --- ai ---
  triage: (payload) => request("/ai/triage", { method: "POST", body: payload }),
  aiProvider: () => request("/ai/provider", { auth: false }),
  // The assistant. `info` is public - it describes limits and suggestions and
  // discloses nothing about the caller - so it is fetched without a token, which
  // means the page can render its shell before sign-in state has settled.
  assistantInfo: () => request("/ai/assist", { auth: false }),
  assistantAsk: (question) =>
    request("/ai/assist", { method: "POST", body: { question } }),

  // --- admin ---
  adminOverview: () => request("/admin/overview"),
  adminDoctors: (params) => request(`/admin/doctors${qs(params)}`),
  adminUpdateDoctor: (id, payload) =>
    request(`/admin/doctors/${id}`, { method: "PATCH", body: payload }),
  adminFacilities: () => request("/admin/facilities"),
  adminCreateFacility: (payload) =>
    request("/admin/facilities", { method: "POST", body: payload }),
  adminUpdateFacility: (id, payload) =>
    request(`/admin/facilities/${id}`, { method: "PATCH", body: payload }),
  adminServices: () => request("/admin/services"),
  adminPatients: () => request("/admin/patients"),
  adminNotifications: (params) => request(`/admin/notifications${qs(params)}`),
  // Phase 12: the cross-clinic operational views.
  adminAppointments: (params) => request(`/admin/appointments${qs(params)}`),
  adminQueue: (params) => request(`/admin/queue${qs(params)}`),
  adminAvailability: (id, params) =>
    request(`/admin/doctors/${id}/availability${qs(params)}`),
  adminScheduler: () => request("/admin/scheduler"),
};

export default api;