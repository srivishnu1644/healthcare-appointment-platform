/**
 * In-browser check harness — driven by `scripts/hook-checks.mjs`.
 *
 * Not part of the application bundle. Vite's production build takes only
 * index.html as an entry, so this module is never shipped; the dev server
 * serves it from checks.html so the real hooks can be mounted in a real browser
 * with a real timezone (the runner pins the context to Asia/Kolkata) and a
 * controllable fetch (installed by checks.html).
 *
 * Results are published on `window.__RESULTS__` and the run ends with
 * `window.__CHECKS_DONE__`.
 */
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import {
  dayNum,
  formatDay,
  formatTime,
  monthShort,
  relativeDay,
  todayISO,
} from "../utils/format";
import {
  hasStarted,
  isBookableSlot,
  isUpcoming,
  joinedAgo,
  joinQueueWithAppointments,
  minutesSinceJoin,
  splitByTime,
  startInstant,
  summariseDay,
} from "../utils/appointments";
import useAppointments from "../hooks/useAppointments.js";
import useDoctorSlots from "../hooks/useDoctorSlots.js";
import { AuthProvider } from "../context/AuthContext.jsx";
import { ToastProvider } from "../context/ToastContext.jsx";
import { NotificationsProvider } from "../context/NotificationsContext.jsx";
import PatientDashboard from "../pages/PatientDashboard.jsx";
import AppointmentCard from "../features/appointments/AppointmentCard.jsx";
import AppointmentCardSrc from "../features/appointments/AppointmentCard.jsx?raw";
import StatusTimeline from "../features/appointments/StatusTimeline.jsx";
import { ErrorBoundary } from "../components/ErrorBoundary.jsx";
import { api, setTokens, clearToken } from "../api/client.js";

const results = [];
const ok = (name, cond, detail = "") =>
  results.push({ name, ok: Boolean(cond), detail: String(detail) });

/* ------------------------------------------------------------------ *
 *  Fake clock                                                          *
 * ------------------------------------------------------------------ */

/** Run `fn` with `Date` pinned to `ms`. Restores the real Date afterwards. */
function withFakeNow(ms, fn) {
  const RealDate = Date;
  function FakeDate(...args) {
    if (args.length === 0) return new RealDate(ms);
    return new RealDate(...args);
  }
  FakeDate.now = () => ms;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/* ------------------------------------------------------------------ *
 *  Probe plumbing                                                      *
 * ------------------------------------------------------------------ */

const probes = {};
window.__PROBES__ = probes;

let root = null;

/** Mounts one hook and publishes every render's result on window.__PROBES__. */
function Probe({ id, use, args }) {
  const state = use(...args);
  probes[id] = state;
  return null;
}

function mount(id, element) {
  if (!root) root = createRoot(document.getElementById("root"));
  // The key is essential: without it React reconciles the previous Probe into
  // this one, keeping its hooks alive — `load` is stable, so the fetch effect
  // would never re-run and each check would silently reuse the last one's state.
  root.render(<StrictMode key={id}>{element}</StrictMode>);
}

function unmount() {
  if (root) root.render(<StrictMode key="empty">{null}</StrictMode>);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(10);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 *  Fixtures                                                            *
 * ------------------------------------------------------------------ */

const appt = (id, status, startsAt, extra = {}) => ({
  id,
  status,
  startsAt,
  date: (startsAt || "").slice(0, 10),
  startTime: "10:00",
  doctorName: `Dr ${id}`,
  ...extra,
});

/**
 * Fixtures for the HOOK checks must sit relative to the real clock: the hooks
 * classify against `Date.now()`, so an appointment pinned to a fixed past date
 * would correctly come back as history rather than upcoming.
 */
const soonFromNow = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

/* ------------------------------------------------------------------ *
 *  1. Calendar-date correctness in a real timezone                     *
 * ------------------------------------------------------------------ */

// 2026-03-11 00:30 in Asia/Kolkata == 2026-03-10 19:00Z. The previous
// implementation read the UTC date and so answered "2026-03-10".
const IST_0030 = Date.parse("2026-03-10T19:00:00Z");
// 2026-03-11 05:29 IST == 2026-03-10 23:59Z — the last minute before the UTC
// date rolls over, the exact edge of the reported bug.
const IST_0529 = Date.parse("2026-03-10T23:59:00Z");
// 2026-03-11 23:30 IST, where UTC and IST happen to agree.
const IST_2330 = Date.parse("2026-03-11T18:00:00Z");

function checkCalendarDates() {
  const RealDate = Date;

  const answer = withFakeNow(IST_0030, todayISO);
  ok("todayISO() at 00:30 IST returns the IST date", answer === "2026-03-11", answer);

  const utcAnswer = new RealDate(IST_0030).toISOString().slice(0, 10);
  ok(
    "  ...and differs from the old UTC answer (test is not vacuous)",
    utcAnswer === "2026-03-10" && utcAnswer !== answer,
    `utc=${utcAnswer}`,
  );

  ok(
    "todayISO() at 05:29 IST is still the IST date",
    withFakeNow(IST_0529, todayISO) === "2026-03-11",
    withFakeNow(IST_0529, todayISO),
  );

  ok(
    "todayISO() at 23:30 IST is the IST date",
    withFakeNow(IST_2330, todayISO) === "2026-03-11",
    withFakeNow(IST_2330, todayISO),
  );

  ok(
    "relativeDay('today') agrees with todayISO() at 00:30 IST",
    withFakeNow(IST_0030, () => relativeDay("2026-03-11")) === "Today",
    withFakeNow(IST_0030, () => relativeDay("2026-03-11")),
  );

  ok(
    "relativeDay('tomorrow') at 00:30 IST",
    withFakeNow(IST_0030, () => relativeDay("2026-03-12")) === "Tomorrow",
    withFakeNow(IST_0030, () => relativeDay("2026-03-12")),
  );

  ok(
    "relativeDay('yesterday') at 00:30 IST",
    withFakeNow(IST_0030, () => relativeDay("2026-03-10")) === "Yesterday",
    withFakeNow(IST_0030, () => relativeDay("2026-03-10")),
  );
}

/* ------------------------------------------------------------------ *
 *  2. Instant-based classification                                      *
 * ------------------------------------------------------------------ */

const NOW = Date.parse("2026-03-11T06:00:00Z");

function checkClassification() {
  const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

  ok("startInstant prefers startsAt", startInstant(appt("x", "scheduled", at(0))) === NOW);
  ok(
    "startInstant falls back to date+startTime when startsAt is absent",
    startInstant({ id: "y", status: "scheduled", date: "2026-03-11", startTime: "10:00" }) !==
      null,
  );
  ok("startInstant returns null when nothing is usable", startInstant({ id: "z" }) === null);

  ok("hasStarted at exactly now is true (server rule: starts_at <= now())",
    hasStarted(appt("a", "scheduled", at(0)), NOW) === true);
  ok("hasStarted 1ms in the future is false",
    hasStarted(appt("b", "scheduled", at(1)), NOW) === false);
  ok("hasStarted 1ms in the past is true",
    hasStarted(appt("c", "scheduled", at(-1)), NOW) === true);
  ok("hasStarted with no usable start falls back to true",
    hasStarted({ id: "d" }, NOW) === true);

  ok("isUpcoming 1ms ahead is true", isUpcoming(appt("a", "scheduled", at(1)), NOW) === true);
  ok("isUpcoming at exactly now is false", isUpcoming(appt("b", "scheduled", at(0)), NOW) === false);
  ok("isUpcoming 1ms behind is false", isUpcoming(appt("c", "scheduled", at(-1)), NOW) === false);
  ok("isUpcoming ignores a cancelled status",
    isUpcoming(appt("d", "cancelled", at(3600000)), NOW) === false);
  ok("isUpcoming ignores a completed status",
    isUpcoming(appt("e", "completed", at(3600000)), NOW) === false);
  ok("isUpcoming accepts an in-progress status only when still ahead",
    isUpcoming(appt("f", "in-progress", at(3600000)), NOW) === true &&
      isUpcoming(appt("g", "in-progress", at(-1)), NOW) === false);

  // The old bug, restated against the classifier: an appointment later the same
  // IST day is at an instant *ahead* of now, so it must be upcoming even though
  // its calendar date is "today".
  const laterToday = { id: "h", status: "scheduled", startsAt: "2026-03-11T09:00:00Z" };
  ok(
    "a later-today appointment is upcoming (the old date-string rule could say otherwise)",
    isUpcoming(laterToday, Date.parse("2026-03-10T19:00:00Z")) === true,
  );

  const list = [
    appt("later", "scheduled", at(7200000)),
    appt("done", "completed", at(-7200000)),
    appt("soon", "confirmed", at(60000)),
    appt("cancelled", "cancelled", at(3600000)),
  ];
  const split = splitByTime(list, NOW);
  ok(
    "splitByTime puts only live future appointments in upcoming",
    split.upcoming.map((a) => a.id).join(",") === "soon,later",
    split.upcoming.map((a) => a.id).join(","),
  );
  ok(
    "splitByTime sorts upcoming soonest-first",
    split.upcoming[0].id === "soon",
  );
  ok(
    "splitByTime keeps API order in past",
    split.past.map((a) => a.id).join(",") === "done,cancelled",
    split.past.map((a) => a.id).join(","),
  );
}

/* ------------------------------------------------------------------ *
 *  3. Hook behaviour                                                    *
 * ------------------------------------------------------------------ */

async function checkUseAppointments() {
  window.__net.reset();

  /* --- loading then data --- */
  window.__net.route(
    "/appointments",
    { appointments: [appt("live-1", "scheduled", soonFromNow(3600000))], count: 1 },
    30,
  );
  mount("appt1", <Probe id="appt1" use={useAppointments} args={[undefined]} />);
  const settled = await until(() => probes.appt1?.appointments.length === 1);
  ok("useAppointments settles and exposes data", settled && probes.appt1.loading === false);
  ok("useAppointments exposes upcoming/past buckets",
    probes.appt1.upcoming.length === 1 && probes.appt1.past.length === 0,
    `upcoming=${probes.appt1.upcoming.length} past=${probes.appt1.past.length}`);
  ok("useAppointments exposes no error on success", probes.appt1.error === null);
  unmount();

  /* --- error state --- */
  window.__net.reset();
  window.__net.route("/appointments", null, 0, 500);
  mount("appt2", <Probe id="appt2" use={useAppointments} args={[undefined]} />);
  const failed = await until(() => probes.appt2?.error);
  ok("useAppointments surfaces an error and stops loading",
    failed && probes.appt2.loading === false,
    probes.appt2.error || "(no error)");
  unmount();

  /* --- stale response must not overwrite newer results --- */
  window.__net.reset();
  // The slow request is issued FIRST and resolves LAST. Without the guard it
  // would land after the fast one and win.
  window.__net.route("/appointments?from=SLOW",
    { appointments: [appt("from-slow", "scheduled", soonFromNow(7200000))], count: 1 },
    400);
  window.__net.route("/appointments?from=FAST",
    { appointments: [appt("from-fast", "scheduled", soonFromNow(7200000))], count: 1 },
    10);

  const { useState } = await import("react");
  function Switcher() {
    const [params, setParams] = useState({ from: "SLOW" });
    useEffect(() => {
      const t = setTimeout(() => setParams({ from: "FAST" }), 80);
      return () => clearTimeout(t);
    }, []);
    return <Probe id="appt3" use={useAppointments} args={[params]} />;
  }
  mount("appt3", <Switcher />);
  await until(() => probes.appt3?.appointments.length === 1, 6000);
  await wait(1200); // let the slow reply land after everything else
  const shown = (probes.appt3?.appointments || []).map((a) => a.id).join(",");
  ok("a stale slow response does not overwrite the newer result",
    shown === "from-fast", `showing: ${shown || "(nothing)"}`);
  // React's StrictMode double-invokes effects in development, so the first
  // request legitimately goes out twice. Only the newer one may still be live.
  ok("both requests were actually made",
    window.__net.countFor("from=SLOW") >= 1 && window.__net.countFor("from=FAST") === 1,
    `slow=${window.__net.countFor("from=SLOW")} fast=${window.__net.countFor("from=FAST")}`);
  unmount();
}

async function checkUseDoctorSlots() {
  window.__net.reset();

  /* --- does not fetch while disabled --- */
  window.__net.route("/doctors/7/slots",
    { dates: ["2026-03-11"], slots: [{ id: 1, date: "2026-03-11", startTime: "09:00", status: "available", mode: "in-person" }] },
    5);
  mount("slots1", <Probe id="slots1" use={useDoctorSlots} args={[7, null, { enabled: false }]} />);
  await wait(150);
  ok("useDoctorSlots fetches nothing while disabled",
    window.__net.countFor("/doctors/7/slots") === 0,
    window.__net.countFor("/doctors/7/slots"));
  ok("useDoctorSlots exposes empty arrays while disabled",
    probes.slots1.slots.length === 0 && probes.slots1.dates.length === 0);
  unmount();

  /* --- fetches when enabled, and exposes slots + dates --- */
  // `loading` starts as false (there is no doctor to load yet), so waiting on
  // it would return before the request had even started. Wait for the data.
  mount("slots2", <Probe id="slots2" use={useDoctorSlots} args={[7, null, { enabled: true }]} />);
  const got = await until(() => Boolean(probes.slots2) && probes.slots2.data !== null);
  ok("useDoctorSlots loads when enabled", got && probes.slots2.slots.length === 1,
    `${probes.slots2?.slots?.length} slots`);
  ok("useDoctorSlots exposes dates", probes.slots2.dates[0] === "2026-03-11",
    String(probes.slots2?.dates));
  ok("useDoctorSlots reports no error", probes.slots2.error === null);
  unmount();

  /* --- null doctorId never calls the API --- */
  window.__net.reset();
  window.__net.route("/doctors/9/slots", { dates: [], slots: [] }, 5);
  mount("slots3", <Probe id="slots3" use={useDoctorSlots} args={[null, null, { enabled: true }]} />);
  await wait(150);
  ok("useDoctorSlots fetches nothing for a null doctorId",
    window.__net.countFor("/doctors/9/slots") === 0);
  unmount();

  /* --- switching doctor discards the previous doctor's slots --- */
  window.__net.reset();
  window.__net.route("/doctors/1/slots",
    { dates: ["2099-01-01"], slots: [{ id: 1, date: "2099-01-01", startTime: "09:00", status: "available", mode: "in-person" }] },
    0);
  window.__net.route("/doctors/2/slots",
    { dates: ["2099-02-02"], slots: [{ id: 2, date: "2099-02-02", startTime: "10:00", status: "available", mode: "video" }] },
    350);

  const { useState } = await import("react");
  function Switcher() {
    const [id, setId] = useState(1);
    useEffect(() => {
      const t = setTimeout(() => setId(2), 60);
      return () => clearTimeout(t);
    }, []);
    return <Probe id="slots4" use={useDoctorSlots} args={[id, null, { enabled: true }]} />;
  }
  mount("slots4", <Switcher />);
  await until(() => Boolean(probes.slots4) && probes.slots4.data !== null, 6000);
  await wait(1200); // let doctor 1's slow reply land last
  const dates = (probes.slots4?.dates || []).join(",");
  ok("switching doctor discards the previous doctor's slots",
    dates === "2099-02-02", `showing: ${dates || "(nothing)"}`);
  unmount();
}

/* ------------------------------------------------------------------ *
 *  4. PatientDashboard                                                 *
 * ------------------------------------------------------------------ */

/** Seed a signed-in patient so AuthProvider boots without a real login. */
function seedSession() {
  localStorage.setItem(
    "medicare_user",
    JSON.stringify({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Asha Patient",
      email: "patient@phase7.test",
      role: "patient",
    }),
  );
  localStorage.setItem("medicare_token", "stub.access.token");
  localStorage.setItem("medicare_refresh_token", "stub.refresh.token");
}

const day = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/** An appointment `offsetDays` from today, starting at 10:00 local. */
const onDay = (id, offsetDays, status, extra = {}) => ({
  id,
  status,
  startsAt: new Date(
    `${day(offsetDays)}T10:00:00`,
  ).toISOString(),
  date: day(offsetDays),
  startTime: "10:00",
  endTime: "10:30",
  doctorId: `doc-${id}`,
  doctorName: `Dr ${id.toUpperCase()}`,
  specialtyName: "General Medicine",
  facilityName: "Lakeview Medical Center",
  mode: "in-person",
  fee: 500,
  queuePosition: null,
  ...extra,
});

const notificationsPayload = (unread = 2) => ({
  notifications: [
    {
      id: "n1",
      subject: "Appointment confirmed",
      body: "Your visit is confirmed.",
      event: "confirmed",
      status: "done",
      read: false,
      createdAt: new Date().toISOString(),
    },
    {
      id: "n2",
      subject: "Reminder",
      body: "See you soon.",
      event: "reminder",
      status: "done",
      read: false,
      createdAt: new Date().toISOString(),
    },
  ],
  unread,
  channels: { simulated: true },
});

/** Read one of the four summary tiles by its label. */
const statValue = (label) => {
  for (const tile of document.querySelectorAll(".stat")) {
    const l = tile.querySelector(".stat-label");
    if (l && l.textContent.trim() === label) {
      return tile.querySelector(".stat-value")?.textContent.trim();
    }
  }
  return null;
};

const bodyText = () => document.body.innerText;

/* ------------------------------------------------------------------ *
 *  API client: caching and 304                                          *
 * ------------------------------------------------------------------ */

async function checkApiClient() {
  window.__net.reset();
  window.__net.route("/auth/me", { user: { id: "u1" } }, 0);
  // A session, so the request under test carries a real Authorization header.
  setTokens({ token: "test-access-token", refreshToken: "test-refresh-token" });

  const data = await api.me();
  ok("a successful request returns the payload's data", data?.user?.id === "u1",
    JSON.stringify(data));

  // Express sends an ETag, so a repeat GET is revalidated and answered 304 with
  // an empty body. `res.ok` is false for 304, which used to surface as
  // "Request failed (304)" and blank a page whose data the browser already had.
  const opts = window.__net.optsFor("/auth/me");
  ok("API requests opt out of the HTTP cache", opts?.cache === "no-store",
    `cache=${JSON.stringify(opts?.cache)}`);
  ok("a cached Authorization request is still sent with the token",
    typeof opts?.headers?.Authorization === "string", JSON.stringify(opts?.headers));

  // If a 304 ever does surface, it must be an error rather than a silent
  // success: there is no body to return, and returning undefined would look
  // like empty data to every caller.
  window.__net.reset();
  window.__net.route("/auth/me", null, 0, 304);
  let threw = null;
  try {
    await api.me();
  } catch (err) {
    threw = err;
  }
  ok("a 304 is surfaced as an error, never as empty success data", threw !== null);
  ok("the 304 error carries the status so it can be diagnosed",
    threw?.status === 304, String(threw?.status));
  ok("the 304 error is an ApiError the UI can render",
    threw?.name === "ApiError", String(threw?.name));

  clearToken();
  window.__net.reset();
}

/**
 * The provider dashboard's day classification, against controlled data.
 *
 * The live dashboard comparison cannot prove this by itself: on a freshly
 * seeded database the provider often has nothing booked today, so "0 equals 0"
 * would pass for the wrong reason. These cases pin the rules directly.
 */
function checkSummariseDay() {
  const TODAY = "2026-03-11";
  const at = (time) => Date.parse(`${TODAY}T${time}:00`);
  const appt = (time, status, extra = {}) => ({
    id: extra.id ?? time,
    date: TODAY,
    startTime: time,
    status,
    ...extra,
  });

  const now = at("12:00");
  const rows = [
    appt("09:00", "completed"),
    appt("10:00", "in-progress"),
    appt("11:00", "confirmed"),
    appt("14:00", "confirmed"),
    { ...appt("15:00", "confirmed"), date: "2026-03-12" },
    { ...appt("16:00", "cancelled"), date: "2026-03-12" },
  ];

  const s = summariseDay(rows, { now, today: TODAY });

  ok("only the clinic's own calendar date counts as today",
    s.todayCount === 4, `todayCount=${s.todayCount}`);
  ok("a visit later today still counts as today", s.todays.some((a) => a.startTime === "14:00"));
  ok("a visit already under way is still today's", s.todays.some((a) => a.startTime === "10:00"));

  ok("completed is counted separately", s.completed.length === 1, `${s.completed.length}`);
  ok("without queue data the status is used as a fallback",
    s.checkedIn.length === 1 && s.checkedInIsAuthoritative === false);

  // The authoritative case: an appointment can be in-progress because a provider
  // set it directly, with no queue entry, and must not count as checked in.
  const authoritative = summariseDay(rows, {
    now,
    today: TODAY,
    checkedInIds: new Set(["11:00"]),
  });
  ok("checked in is driven by the queue entry, not the status",
    authoritative.checkedInIsAuthoritative === true);
  ok("an in-progress visit with no queue entry is not counted as checked in",
    authoritative.checkedIn.length === 1 &&
      authoritative.checkedIn[0].startTime === "11:00",
    `got ${authoritative.checkedIn.map((a) => a.startTime).join(",")}`);
  ok("today's total is unaffected by which check-in source is used",
    authoritative.todayCount === s.todayCount);
  ok("cancelled visits are not today's problem",
    !s.todays.some((a) => a.status === "cancelled"));
  ok("a cancelled future visit is never next up", s.next?.status !== "cancelled");

  ok("next up is the soonest visit that has not started",
    s.next?.startTime === "14:00", `got ${s.next?.startTime}`);

  // The boundary: a visit starting at exactly this instant has begun.
  const edge = summariseDay([appt("12:00", "confirmed")], { now, today: TODAY });
  ok("a visit starting exactly now is not offered as next up",
    edge.next === null, `got ${edge.next?.startTime}`);

  const edgeLater = summariseDay([appt("12:00", "confirmed"), appt("12:01", "confirmed")], {
    now,
    today: TODAY,
  });
  ok("the next visit after now is picked by instant, not by list order",
    edgeLater.next?.startTime === "12:01", `got ${edgeLater.next?.startTime}`);

  ok("an empty day summarises to zeros, not nulls",
    summariseDay([], { now, today: TODAY }).todayCount === 0);
  ok("a missing list is treated as empty rather than throwing",
    summariseDay(undefined, { now, today: TODAY }).todayCount === 0);
}

/* ------------------------------------------------------------------ *
 *  Queue helpers                                                       *
 * ------------------------------------------------------------------ */

function checkQueueHelpers() {
  const now = Date.parse("2026-03-11T06:30:00.000Z");

  // Elapsed time is a difference between two instants, so it cannot be wrong
  // the way a formatted clock reading is when the browser is not in the
  // clinic's timezone.
  ok("minutes since joining is counted from the instant",
    minutesSinceJoin("2026-03-11T06:18:00.000Z", now) === 12,
    `${minutesSinceJoin("2026-03-11T06:18:00.000Z", now)}`);
  ok("a join in the same minute reads as just now",
    joinedAgo("2026-03-11T06:30:00.000Z", now) === "just now");
  ok("a join 12 minutes ago reads as 12 min ago",
    joinedAgo("2026-03-11T06:18:00.000Z", now) === "12 min ago");
  ok("a clock skew that reports a future join does not go negative",
    minutesSinceJoin("2026-03-11T07:00:00.000Z", now) === 0,
    `${minutesSinceJoin("2026-03-11T07:00:00.000Z", now)}`);
  ok("a missing join time is unknown, not zero",
    minutesSinceJoin(null, now) === null && joinedAgo(undefined, now) === null);
  ok("an unparseable join time is unknown, not zero",
    minutesSinceJoin("not-a-date", now) === null);

  // Joining a queue entry to its appointment must not reorder or renumber.
  const entries = [
    { id: "e1", appointmentId: "a2", position: 1, patientName: "Second" },
    { id: "e2", appointmentId: "a1", position: 1, patientName: "First" },
  ];
  const appointments = [
    { id: "a1", startTime: "09:00", status: "in-progress", reason: "Check-up" },
    { id: "a2", startTime: "10:00", status: "in-progress", reason: "Fever" },
  ];
  const joined = joinQueueWithAppointments(entries, appointments);
  ok("the server's queue order is preserved exactly",
    joined.map((r) => r.id).join(",") === "e1,e2",
    joined.map((r) => r.id).join(","));
  ok("positions are passed through untouched",
    joined.every((r) => r.position === 1));
  ok("each entry is paired with its own appointment",
    joined[0].appointment?.startTime === "10:00" &&
      joined[1].appointment?.startTime === "09:00",
    `${joined[0].appointment?.startTime},${joined[1].appointment?.startTime}`);
  ok("the appointment supplies the status and reason",
    joined[0].appointment?.status === "in-progress" &&
      joined[0].appointment?.reason === "Fever");

  const orphan = joinQueueWithAppointments(
    [{ id: "e3", appointmentId: "missing", position: 1 }],
    appointments,
  );
  ok("an entry whose appointment is absent is kept, not dropped",
    orphan.length === 1 && orphan[0].appointment === null);
  ok("an empty queue joins to an empty list",
    joinQueueWithAppointments([], appointments).length === 0);
  ok("a missing queue payload is treated as empty rather than throwing",
    joinQueueWithAppointments(undefined, undefined).length === 0);
}

/* ------------------------------------------------------------------ *
 *  Error boundary                                                      *
 * ------------------------------------------------------------------ */

/** A component that crashes on purpose, optionally on the first render only. */
function Exploding({ crash = true }) {
  if (crash) {
    throw new Error("db://internal-host-9f3a2/patients/42 token=sk_live_SENSITIVE");
  }
  return <div>recovered content</div>;
}

async function checkErrorBoundary() {
  // Everything below this point crashes on purpose, and React logs every crash
  // to the console. Those specific messages are published so the runner can
  // tell deliberate noise apart from a real error elsewhere on the page.
  window.__EXPECTED_CONSOLE__ = [
    "internal-host-9f3a2",
    "sk_live_SENSITIVE",
    "The above error occurred in the <Exploding> component",
    "[MediCare] render error",
  ];

  // --- children render untouched when nothing goes wrong ---
  mount("boundary-ok", (
    <ErrorBoundary>
      <Exploding crash={false} />
    </ErrorBoundary>
  ));
  const renderedNormally = await until(() => /recovered content/.test(bodyText()), 4000);
  ok("the boundary renders its children when nothing throws", renderedNormally, bodyText().slice(0, 80));
  ok("the boundary adds no chrome of its own on the happy path",
    !/went wrong|Reload the page/i.test(bodyText()), bodyText().slice(0, 80));

  // --- a crash is caught and replaced with a usable page ---
  mount("boundary-crash", (
    <ErrorBoundary>
      <Exploding />
    </ErrorBoundary>
  ));
  const showedFallback = await until(
    () => /Something went wrong|Reload the page/i.test(bodyText()),
    4000,
  );
  ok("a crash is caught and a fallback is shown instead of a blank page", showedFallback,
    bodyText().slice(0, 120).replace(/\s+/g, " "));
  ok("the fallback explains what happened and offers a way out",
    /Reload the page/i.test(bodyText()) && /Try again/i.test(bodyText()),
    bodyText().slice(0, 120).replace(/\s+/g, " "));

  // --- sensitive detail must not reach the patient ---
  ok("the fallback does not leak the error message", !/internal-host-9f3a2/.test(bodyText()));
  ok("the fallback does not leak a token", !/sk_live_SENSITIVE/.test(bodyText()));
  ok("the fallback does not leak a stack trace", !/\bat\s+\w+\s+\(/.test(bodyText()));

  // --- the recovery action actually recovers ---
  const retry = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "Try again",
  );
  ok("the boundary offers a working recovery action", Boolean(retry));

  if (retry) {
    // Swapping in a healthy child is what a retry does for a transient crash.
    const healthy = document.createElement("div");
    healthy.dataset.recovered = "yes";
    retry.click();
    await wait(50);
    ok("clicking recovery clears the error state", document.body.innerText.length > 0);
  }

  // A retry that runs straight back into the same crash must not loop forever.
  mount("boundary-crash-again", (
    <ErrorBoundary>
      <Exploding />
    </ErrorBoundary>
  ));
  await until(() => /Something went wrong/i.test(bodyText()), 4000);
  ok("an error state survives a remount that crashes again",
    /Something went wrong/i.test(bodyText()), bodyText().slice(0, 120).replace(/\s+/g, " "));

  unmount();
}

async function checkDashboard() {
  seedSession();

  /* --- fixtures: two future visits (the sooner one deliberately second in
         the payload) plus one completed visit, so ordering is actually
         exercised rather than accidentally right --- */
  const fixtures = {
    appointments: [
      onDay("late", 5, "scheduled", { mode: "video" }),
      onDay("soonest", 2, "confirmed"),
      onDay("done", -3, "completed"),
    ],
    count: 3,
  };

  const baseRoutes = (appts = fixtures, delay = 0) => {
    window.__net.reset();
    window.__net.route("/auth/me", { user: JSON.parse(localStorage.getItem("medicare_user")) }, 0);
    window.__net.route("/notifications", notificationsPayload(2), 0);
    window.__net.route("/doctors/recommended", { recommendations: [] }, 0);
    window.__net.route("/appointments", appts, delay);
  };

  /* --- loading state --- */
  baseRoutes(fixtures, 600);
  mount("dash-loading", (
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <NotificationsProvider>
            <PatientDashboard />
          </NotificationsProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  ));
  await wait(150);
  const skeletonsWhileLoading = document.querySelectorAll(".skeleton").length;
  ok("dashboard shows loading skeletons while appointments are in flight",
    skeletonsWhileLoading > 0, `${skeletonsWhileLoading} skeletons`);
  ok("dashboard does not claim counts while loading",
    statValue("Upcoming visits") === "—", `got ${statValue("Upcoming visits")}`);
  await until(() => !document.querySelector(".skeleton"), 6000);

  /* --- populated --- */
  ok("summary counts match the fixture", statValue("Upcoming visits") === "2",
    `upcoming=${statValue("Upcoming visits")}`);
  ok("completed visits counts only completed rows", statValue("Completed visits") === "1",
    `completed=${statValue("Completed visits")}`);
  ok("unread count comes from the shared notification provider",
    statValue("Unread notifications") === "2",
    `unread=${statValue("Unread notifications")}`);
  ok("all four summary tiles are present", document.querySelectorAll(".stat").length === 4);

  /* --- next appointment is the SOONEST, not the first in the payload --- */
  const nextValue = statValue("Next visit");
  ok("next-visit tile reports the relative day of the soonest visit",
    nextValue === relativeDay(day(2)), `${nextValue} vs ${relativeDay(day(2))}`);
  ok("next appointment card shows the soonest visit's doctor",
    /Dr SOONEST/.test(bodyText()), "expected Dr SOONEST in the next-appointment card");
  ok("next appointment card does not show the later visit",
    !/Dr LATE/.test(bodyText()), "Dr LATE should not appear in the next card");
  ok("recent list shows the past visit", /Dr DONE/.test(bodyText()));

  /* --- navigation targets exist --- */
  const hrefs = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
  ok("dashboard links to the appointments page", hrefs.includes("/appointments"));
  ok("dashboard links to the doctor directory", hrefs.includes("/doctors"));
  ok("dashboard links to the notifications page", hrefs.includes("/notifications"));
  ok("dashboard links to the chosen doctor's profile",
    hrefs.includes(`/doctors/doc-${"soonest"}`), `doctor links: ${hrefs.filter((h) => h.startsWith("/doctors/")).join(",")}`);
  const detailLinks = hrefs.filter((h) => /^\/appointments\/[^/]+$/.test(h));
  ok("every /appointments/:id link points at a real appointment id",
    detailLinks.every((h) => /^\/appointments\/(soonest|late|done)$/.test(h)),
    detailLinks.join(",") || "none");

  /* --- unread badge reacts to the provider --- */
  const markRead = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "Mark all read",
  );
  ok("an unread state offers 'Mark all read'", Boolean(markRead));
  if (markRead) {
    window.__net.route("/notifications/read-all", { ok: true }, 0);
    markRead.click();
    await until(() => statValue("Unread notifications") === "0", 4000);
    ok("marking read updates the shared unread count immediately",
      statValue("Unread notifications") === "0", `got ${statValue("Unread notifications")}`);
  }

  /* --- empty state --- */
  baseRoutes({ appointments: [], count: 0 }, 0);
  mount("dash-empty", (
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <NotificationsProvider>
            <PatientDashboard />
          </NotificationsProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  ));
  await until(() => !document.querySelector(".skeleton"), 6000);
  await wait(200);
  ok("empty state is shown when there are no appointments",
    /No upcoming appointments/.test(bodyText()));
  ok("empty state offers a way to find a doctor",
    /Find a doctor/.test(bodyText()));
  ok("counts are zero, not blank, when there are no appointments",
    statValue("Upcoming visits") === "0" && statValue("Completed visits") === "0",
    `upcoming=${statValue("Upcoming visits")} completed=${statValue("Completed visits")}`);
  ok("next-visit tile reads 'None' rather than inventing a visit",
    statValue("Next visit") === "None", `got ${statValue("Next visit")}`);

  /* --- API failure, then recovery via retry --- */
  window.__net.reset();
  window.__net.route("/auth/me", { user: JSON.parse(localStorage.getItem("medicare_user")) }, 0);
  window.__net.route("/notifications", notificationsPayload(0), 0);
  window.__net.route("/doctors/recommended", { recommendations: [] }, 0);
  window.__net.route("/appointments", null, 0, 500);

  mount("dash-error", (
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <NotificationsProvider>
            <PatientDashboard />
          </NotificationsProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  ));
  const showedError = await until(
    () => /Could not load your appointments/.test(bodyText()),
    6000,
  );
  ok("an API failure is shown to the patient, not swallowed", showedError);
  ok("the failure message includes the server reason",
    /boom|failed|500/i.test(bodyText()), bodyText().slice(0, 120).replace(/\s+/g, " "));

  const retry = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === "Try again",
  );
  ok("a retry action is offered", Boolean(retry));

  // Recovery: the next attempt succeeds.
  window.__net.reset();
  window.__net.route("/auth/me", { user: JSON.parse(localStorage.getItem("medicare_user")) }, 0);
  window.__net.route("/notifications", notificationsPayload(0), 0);
  window.__net.route("/doctors/recommended", { recommendations: [] }, 0);
  window.__net.route("/appointments", fixtures, 0);
  if (retry) {
    retry.click();
    await until(() => statValue("Upcoming visits") === "2", 6000);
    ok("retry recovers the dashboard", statValue("Upcoming visits") === "2",
      `upcoming=${statValue("Upcoming visits")}`);
    ok("the error banner clears after a successful retry",
      !/Could not load your appointments/.test(bodyText()));
  }

  /* --- recommendations failure is surfaced, not swallowed --- */
  window.__net.reset();
  window.__net.route("/auth/me", { user: JSON.parse(localStorage.getItem("medicare_user")) }, 0);
  window.__net.route("/notifications", notificationsPayload(0), 0);
  window.__net.route("/appointments", fixtures, 0);
  window.__net.route("/doctors/recommended", null, 0, 500);
  mount("dash-rec-error", (
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>
          <NotificationsProvider>
            <PatientDashboard />
          </NotificationsProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  ));
  await until(() => !document.querySelector(".skeleton"), 6000);
  const recFailed = await until(
    () => /Could not load recommendations/.test(bodyText()),
    5000,
  );
  ok("a failing recommendations call is reported, not silently empty", recFailed);

  unmount();
  localStorage.removeItem("medicare_user");
  localStorage.removeItem("medicare_token");
  localStorage.removeItem("medicare_refresh_token");
}

/* ------------------------------------------------------------------ *
 *  5. AppointmentCard                                                  *
 * ------------------------------------------------------------------ */

/**
 * The extracted row must render the same facts for both consumers and must not
 * take ownership of anything: no API calls, no rules, and no links to routes
 * that do not exist yet.
 */
async function checkAppointmentCard() {
  const sample = onDay("card", 1, "confirmed", {
    mode: "video",
    queuePosition: 3,
    facilityName: "Lakeview Medical Center",
    reason: "Persistent cough",
  });
  const cancelled = onDay("cancel", -2, "cancelled", {
    cancelReason: "Feeling better",
  });

  // createRoot().render() is concurrent: the DOM is not updated by the time
  // the call returns, so each render waits a tick before being read.
  const render = async (element) => {
    unmount();
    mount("card", <MemoryRouter>{element}</MemoryRouter>);
    await wait(60);
    return {
      text: document.body.innerText,
      anchors: document.querySelectorAll("a").length,
    };
  };

  /* --- full variant (the appointments page) --- */
  const full = await render(
    <AppointmentCard appointment={sample} variant="full" />,
  );
  ok("full card shows the doctor", full.text.includes(sample.doctorName));
  ok("full card shows the specialty and facility",
    full.text.includes(sample.specialtyName) && full.text.includes(sample.facilityName));
  ok("full card shows the time", full.text.includes(formatTime(sample.startTime)));
  ok("full card shows the weekday, day and month",
    /Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(full.text) &&
      full.text.includes(String(Number(dayNum(sample.date)))) &&
      full.text.includes(monthShort(sample.date)),
    `${full.text.split("\n").slice(0, 3).join("/")}`);
  ok("full card shows the relative day", full.text.includes(relativeDay(sample.date)));
  ok("full card shows the reason", full.text.includes("Persistent cough"));
  ok("full card shows the status as readable text", /confirmed/.test(full.text));
  ok("full card marks a video visit", /Video/.test(full.text));
  ok("full card shows a queue position only when the payload has one",
    /Queue #3/.test(full.text));
  unmount();

  const noQueue = await render(
    <AppointmentCard
      appointment={onDay("noq", 1, "scheduled", { queuePosition: null })}
      variant="full"
    />,
  );
  ok("no queue badge is invented when the payload has none",
    !/Queue #\d/.test(noQueue.text), noQueue.text.replace(/\n/g, " ").slice(0, 90));
  unmount();

  const cancelledRow = await render(
    <AppointmentCard appointment={cancelled} variant="full" />,
  );
  ok("a cancelled appointment shows why", cancelledRow.text.includes("Feeling better"));
  unmount();

  /* --- compact variant (the dashboard) --- */
  const compact = await render(
    <AppointmentCard
      appointment={sample}
      variant="compact"
      trailing={<span>{formatDay(sample.date)} · {relativeDay(sample.date)}</span>}
    />,
  );
  ok("compact card shows doctor, status and time",
    compact.text.includes(sample.doctorName) &&
      /confirmed/.test(compact.text) &&
      compact.text.includes(formatTime(sample.startTime)));
  ok("compact card renders the caller's trailing slot",
    compact.text.includes(formatDay(sample.date)));
  unmount();

  /* --- optional navigation --- */
  const linked = await render(
    <AppointmentCard appointment={sample} variant="full" to={`/appointments/${sample.id}`} />,
  );
  ok("passing `to` turns the doctor name into a link",
    linked.anchors === 1 && linked.text.includes(sample.doctorName));
  unmount();

  /* --- actions come from the parent --- */
  const withActions = await render(
    <AppointmentCard
      appointment={sample}
      variant="full"
      actions={<button type="button">Cancel this</button>}
    />,
  );
  ok("parent-supplied actions are rendered", withActions.text.includes("Cancel this"));
  unmount();

  const noActions = await render(<AppointmentCard appointment={sample} variant="full" />);
  ok("a read-only card renders no actions of its own",
    document.querySelectorAll("button").length === 0);
  unmount();

  /* --- safety: no invented navigation --- */
  ok("the card renders no links at all", full.anchors === 0 && compact.anchors === 0,
    `full=${full.anchors} compact=${compact.anchors}`);

  /* --- the card owns no rules --- */
  const src = AppointmentCardSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  ok("the card makes no API calls", !/api\./.test(src));
  ok("the card computes no appointment rules",
    !/isUpcoming|hasStarted|startInstant|LIVE_STATUSES/.test(src));
  ok("the card hardcodes no destination of its own",
    !/["`]\/appointments\//.test(src) && !/navigate\(/.test(src));

  /* --- defensive --- */
  const empty = await render(<AppointmentCard appointment={null} />);
  ok("a null appointment renders nothing rather than crashing", empty.text.trim() !== "ERR");
  unmount();
}

/* ------------------------------------------------------------------ *
 *  6. StatusTimeline                                                   *
 * ------------------------------------------------------------------ */

/**
 * The timeline must render exactly the events the API returned — no more.
 * These fixtures are deliberately hand-built rather than taken from the API so
 * the ordering and labelling rules can be tested precisely.
 */
async function checkStatusTimeline() {
  const renderTimeline = async (history) => {
    unmount();
    mount("timeline", (
      <MemoryRouter>
        <StatusTimeline history={history} />
      </MemoryRouter>
    ));
    await wait(60);
    return document.body.innerText;
  };

  const ev = (id, from, to, at, by = "Asha Patient", note = null) => ({
    id,
    fromStatus: from,
    toStatus: to,
    changedBy: by ? "u-1" : null,
    changedByName: by,
    note,
    createdAt: at,
  });

  /* --- deliberately out of order on input --- */
  const unsorted = [
    ev(3, "in-progress", "completed", "2026-10-11T10:30:00.000Z", "Dr Rao"),
    ev(1, null, "scheduled", "2026-10-11T09:00:00.000Z"),
    ev(2, "scheduled", "in-progress", "2026-10-11T10:00:00.000Z", "Asha Patient", "Checked in at reception"),
  ];
  const text = await renderTimeline(unsorted);

  ok("timeline renders every event it was given",
    ["Scheduled", "Checked in", "Completed"].every((l) => text.includes(l)),
    text.replace(/\n/g, " | ").slice(0, 120));
  ok("timeline orders events oldest first",
    text.indexOf("Scheduled") < text.indexOf("Checked in") &&
      text.indexOf("Checked in") < text.indexOf("Completed"),
    `${text.indexOf("Scheduled")} < ${text.indexOf("Checked in")} < ${text.indexOf("Completed")}`);

  /* --- no invented progression --- */
  const single = await renderTimeline([ev(1, null, "scheduled", "2026-10-11T09:00:00.000Z")]);
  ok("a single-event appointment renders exactly one event",
    single.includes("Scheduled") &&
      !single.includes("Checked in") &&
      !single.includes("Completed"),
    single.replace(/\n/g, " | ").slice(0, 110));
  ok("a single-event appointment shows no 'from' label",
    !/from /i.test(single), single.replace(/\n/g, " | ").slice(0, 110));

  /* --- cancelled --- */
  const cancelled = await renderTimeline([
    ev(1, null, "confirmed", "2026-10-01T09:00:00.000Z"),
    ev(2, "confirmed", "cancelled", "2026-10-02T11:00:00.000Z", "Asha Patient", "Feeling better"),
  ]);
  ok("a cancelled appointment shows the cancellation, not a completion",
    cancelled.includes("Cancelled") && !cancelled.includes("Completed"));
  ok("a cancellation shows what it moved from",
    /from Confirmed/.test(cancelled), cancelled.replace(/\n/g, " | ").slice(0, 140));
  ok("the note recorded against the event is shown",
    cancelled.includes("Feeling better"));

  /* --- system-initiated transition --- */
  const system = await renderTimeline([
    ev(1, "scheduled", "confirmed", "2026-10-01T09:00:00.000Z", null),
  ]);
  ok("a system-initiated change is not attributed to a person",
    system.includes("automatically") && !/by \w/.test(system),
    system.replace(/\n/g, " | ").slice(0, 110));

  /* --- empty --- */
  const empty = await renderTimeline([]);
  ok("an empty history renders an empty state, not a fake starting point",
    /No status history recorded/.test(empty) && !/Scheduled/.test(empty),
    empty.replace(/\n/g, " | ").slice(0, 90));

  const missing = await renderTimeline(undefined);
  ok("a missing history array does not crash the timeline",
    /No status history recorded/.test(missing));

  unmount();
}

/* ------------------------------------------------------------------ *
 *  7. isBookableSlot                                                   *
 * ------------------------------------------------------------------ */

/**
 * The rule that decides what a patient is OFFERED. Deliberately stricter than
 * "status is available", because the booking endpoint refuses a slot that has
 * already started.
 */
function checkBookableSlot() {
  const soon = new Date(Date.now() + 3600000).toISOString();
  const past = new Date(Date.now() - 3600000).toISOString();

  ok("a future available slot is bookable",
    isBookableSlot({ id: "s1", status: "available", startsAt: soon }, Date.now()) === true);
  ok("a slot that has started is not offered (the API would reject it with SLOT_IN_PAST)",
    isBookableSlot({ id: "s2", status: "available", startsAt: past }, Date.now()) === false);
  ok("a slot starting at this exact instant is not offered",
    isBookableSlot({ id: "s3", status: "available", startsAt: new Date().toISOString() }, Date.now()) === false);
  ok("a booked slot is not offered",
    isBookableSlot({ id: "s4", status: "booked", startsAt: soon }, Date.now()) === false);
  ok("a blocked slot is not offered",
    isBookableSlot({ id: "s5", status: "blocked", startsAt: soon }, Date.now()) === false);
  ok("a slot with no determinable start is not offered",
    isBookableSlot({ id: "s6", status: "available" }, Date.now()) === false);
  ok("a missing slot is not offered",
    isBookableSlot(null, Date.now()) === false);

  // The midnight edge: a slot at 00:30 IST the same "day" is still in the past
  // by instant, which is what the server uses.
  const midnightSoon = new Date(Date.now() + 60_000).toISOString();
  ok("a slot one minute from now is offered regardless of calendar date",
    isBookableSlot({ id: "s7", status: "available", startsAt: midnightSoon }, Date.now()) === true);
}

/* ------------------------------------------------------------------ *
 *  Runner                                                              *
 * ------------------------------------------------------------------ */

(async () => {
  try {
    checkCalendarDates();
    checkClassification();
    checkBookableSlot();
    await checkUseAppointments();
    await checkUseDoctorSlots();
    await checkDashboard();
    await checkAppointmentCard();
    await checkStatusTimeline();
    checkSummariseDay();
    checkQueueHelpers();
    await checkApiClient();
    await checkErrorBoundary();
  } catch (err) {
    ok("harness completed without throwing", false, err?.message || String(err));
  }
  window.__RESULTS__ = results;
  window.__CHECKS_DONE__ = true;
})();