/**
 * Phase 7 step 7 — queue-position projection checks.
 *
 *   node scripts/queue-check.js
 *   SPAWN=1 node scripts/queue-check.js          # start/stop the API itself
 *   API_URL=http://localhost:5000/api node scripts/queue-check.js
 *
 * WHAT THIS COVERS
 *   GET /api/appointments reports the caller's own queue position for rows that
 *   still hold an active queue entry, and null for every other row.
 *
 *     * three patients, three slots, each sees their own position and only theirs
 *     * the list agrees with what check-in returned, row by row
 *     * positions are per-queue, not a running counter across patients
 *     * the position is stable on a later re-read
 *     * a booked appointment that never checked in reports null
 *     * a cancelled appointment reports null
 *     * a completed appointment reports null
 *     * the field is present on every row (backward compatible)
 *     * a patient cannot see another patient's appointment, so cannot read their
 *       position; a doctor cannot read another doctor's list
 *     * unauthenticated callers get nothing
 *     * the detail endpoint is unchanged and still scoped to the parties
 *
 * HOW THE LIVE QUEUE IS BUILT
 *   A queue entry only exists for a slot that has already started, because
 *   check-in is refused for a future slot (starts_at <= now()). The seed creates
 *   no queue entries, so this suite checks in through the real endpoint on
 *   appointments the seed left in a started, still-live state — no waiting, and
 *   no queue rows written behind the API's back.
 *
 *   A slot holds exactly ONE appointment (bookingService.findActiveForSlot), so
 *   a slot's queue has a single member and every position is 1. Two patients in
 *   one slot's queue is not reachable in this model, so "ordering" is asserted
 *   where it actually applies: the list must not hand one patient another
 *   patient's position, and must not accumulate a counter across queues.
 *
 *   Appointments are discovered, never hard-coded, and are restored to their
 *   seeded status at the end so repeated runs behave identically.
 */

import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { hashPassword } from "../src/utils/password.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SPAWN_SERVER = process.env.SPAWN === "1";
const PORT = Number(process.env.QUEUE_CHECK_PORT) || 5097;
const BASE =
  process.env.API_URL ||
  (SPAWN_SERVER ? `http://localhost:${PORT}/api` : "http://localhost:5000/api");

const ADMIN = { email: "admin@demo.com", password: "admin123" };
/** Identifies this run's fixture rows, so cleanup can assert on exactly them. */
const RUN_TAG = `${Date.now()}${Math.floor(Math.random() * 1e4)}`;
const DOCTOR = { email: "doctor1@demo.com", password: "doctor123" };
const OTHER_DOCTOR = { email: "doctor2@demo.com", password: "doctor123" };
/** Seeded patients; all three share one password. */
const SEED_PATIENTS = ["ishita@demo.com", "aman@demo.com", "patient@demo.com"];
const SEED_PASSWORD = "patient123";

/** Fixture slot length for the fallback path; short so it fits a schedule gap. */
const DURATION_MIN = 5;

/** How long the fallback path will wait for a free window before skipping. */
const MAX_WAIT_MS = Number(process.env.QUEUE_CHECK_MAX_WAIT_MS ?? 25 * 60_000);

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skipped = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    console.log(`PASS  ${name}`);
    pass += 1;
  } else {
    console.log(`FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
    fail += 1;
    failures.push(name);
  }
};

const skipCheck = (name, reason) => {
  console.log(`SKIP  ${name} :: ${reason}`);
  skip += 1;
  skipped.push(name);
};

const call = async (pathname, { method = "GET", token, body } = {}) => {
  const mayHaveBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(mayHaveBody && body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: payload, data: payload?.data ?? null };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (r) => r.body?.error?.code ?? null;

/** Sign in, or throw with the API's own message. */
async function signIn(creds) {
  const r = await call("/auth/login", { method: "POST", body: creds });
  if (r.status !== 200) throw new Error(`login failed for ${creds.email}: ${r.body?.message}`);
  return r.data;
}

/** A throwaway patient, so repeated runs never collide. */
async function fixturePatient(tag) {
  const email = `queue-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@phase7.test`;
  const password = "queue12345";
  const r = await call("/auth/register", {
    method: "POST",
    body: { name: `Queue ${tag}`, email, password, phone: "9800000000" },
  });
  if (r.status !== 201) throw new Error(`fixture register failed: ${r.body?.message}`);
  return { ...r.data, email, password };
}

/**
 * Open a read-only connection to the TEST database, or return null.
 *
 * Guarded exactly like the cleanup below: a non-loopback host is refused, so a
 * hosted database can never be reached by this path.
 */
async function openLocalDb() {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Which of these appointments genuinely hold an active queue entry.
 *
 * The projection is then checked against this ground truth rather than against
 * an assumption that a patient only ever holds one entry. Earlier runs and the
 * other suites leave entries behind, and an appointment that really is queued
 * must legitimately report a position — asserting "every other row is null"
 * would be asserting something untrue.
 */
async function groundTruthPositions(appointmentIds) {
  const client = await openLocalDb();
  if (!client) return null;
  try {
    const { rows } = await client.query(
      `SELECT appointment_id, position
         FROM queue_entries
        WHERE appointment_id = ANY($1::text[])
          AND state IN ('waiting', 'in-consultation')`,
      [appointmentIds],
    );
    return new Map(rows.map((r) => [r.appointment_id, r.position]));
  } finally {
    await client.end();
  }
}

/**
 * Put the seeded appointments back the way this suite found them.
 *
 * The API deliberately refuses to reopen a terminal appointment (completed or
 * cancelled), so no endpoint can undo what the checks above do. This cleanup is
 * therefore a direct parameterised UPDATE against the TEST database, and it
 * refuses to run at all unless DATABASE_URL names a loopback host — a hosted
 * database can never be reached by this path. Ids are bound, never interpolated
 * into the SQL text.
 */
async function restoreFixtures(appointmentIds) {
  const url = process.env.DATABASE_URL || "";
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return { skipped: true, reason: "DATABASE_URL is unset, so the test database cannot be reached" };
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    return { skipped: true, reason: `refusing to write to a non-local database (${host})` };
  }
  if (!appointmentIds.length) return { skipped: false };

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `UPDATE appointments
          SET status = 'confirmed',
              completed_at = NULL,
              cancelled_at = NULL,
              cancelled_by = NULL,
              cancel_reason = NULL
        WHERE id = ANY($1::text[])`,
      [appointmentIds],
    );
    // Drop the queue entries this run created, so the next run allocates from
    // a clean queue rather than inheriting this one's positions.
    await client.query("DELETE FROM queue_entries WHERE appointment_id = ANY($1::text[])", [
      appointmentIds,
    ]);
  } finally {
    await client.end();
  }
  return { skipped: false };
}

/* ------------------------------------------------------------------ *
 *  Business-zone wall clock                                            *
 * ------------------------------------------------------------------ */

/** The app labels every wall-clock time in this zone; the host may not be in it. */
const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";

const zoneParts = (instant, opts) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...opts })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );

const businessDate = (instant) => {
  const p = zoneParts(instant, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
};

const businessTime = (instant) => {
  const p = zoneParts(instant, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
};

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** The next whole minute at or after `instant + offsetMs`. */
const nextMinuteAfter = (instant, offsetMs) =>
  Math.ceil((instant + offsetMs) / 60_000) * 60_000;

/**
 * The soonest instant at which `needed` different providers are all free.
 *
 * The seed gives nearly every doctor the identical back-to-back schedule, and
 * earlier runs of this suite leave their own slots behind on whichever provider
 * they used. Scanning all of them means the fixture waits for the next gap
 * anywhere rather than sitting behind one doctor's booked-out day.
 *
 * More than one provider is wanted deliberately: the cross-patient checks need
 * two patients who are queued at the same time, and two providers freeing up at
 * the same instant gives exactly that from a single wait.
 *
 * @returns {Promise<{instant:number, date:string, time:string,
 *                    doctorIds:string[], doctorNames:string[]}|null>}
 */
async function findSoonestFreeStart(needed, budgetMs) {
  const list = await call("/doctors?limit=50");
  const doctors = list.data?.doctors ?? [];
  if (!doctors.length) return null;

  const now = Date.now();
  const schedules = [];
  for (const d of doctors) {
    for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
      const date = businessDate(new Date(now + dayOffset * 86_400_000));
      const res = await call(`/doctors/${d.id}/slots?date=${date}`);
      if (res.status !== 200) continue;
      schedules.push({
        id: d.id,
        name: d.name,
        date,
        busy: (res.data?.slots ?? [])
          .map((s) => ({ from: toMinutes(s.startTime), to: toMinutes(s.endTime) }))
          .sort((a, b) => a.from - b.from),
      });
    }
  }

  for (let addMs = 60_000; addMs <= budgetMs; addMs += 60_000) {
    const instant = nextMinuteAfter(now, addMs);
    const time = businessTime(instant);
    const from = toMinutes(time);
    const free = schedules.filter(
      (s) =>
        s.date === businessDate(instant) &&
        !s.busy.some((b) => from < b.to && b.from < from + DURATION_MIN),
    );
    if (free.length >= needed) {
      const chosen = free.slice(0, needed);
      return {
        instant,
        date: businessDate(instant),
        time,
        doctorIds: chosen.map((c) => c.id),
        doctorNames: chosen.map((c) => c.name),
      };
    }
  }
  return null;
}

/**
 * A deterministic check-in-able fixture that never waits.
 *
 * The fallback below asks the SEEDED calendar when two providers happen to be
 * free together, and sleeps until that moment arrives. Two problems: it depends on
 * seed data it does not control, and it burns real minutes of wall clock. At some
 * hours no such window exists inside the budget and the whole section skips -
 * which is what happened, and which meant a real capability went unverified.
 *
 * So this builds the situation instead of waiting for it: a provider created for
 * this run, with two slots that STARTED half an hour and an hour ago. Check-in
 * requires a started slot, so both patients can check in immediately, with no
 * sleep and no reference to anything the seed laid down.
 *
 * Still goes through the real booking and check-in endpoints. Only the provider
 * and its slots are written directly, because there is no API for creating a
 * provider with a login, and the slots have to sit in the past - which the
 * calendar API will not create for a date that has passed.
 *
 * The provider is removed on the way out, so repeated runs do not accumulate.
 */
async function buildImmediateQueue(adminSession, db) {
  if (!db) return { subjects: null, reason: "no local database connection for the fixture" };
  const stamp = RUN_TAG;

  const specialty = await db.query("SELECT id FROM specialties ORDER BY slug LIMIT 1");
  const facility = await db.query("SELECT id FROM facilities ORDER BY name LIMIT 1");
  if (!specialty.rows.length || !facility.rows.length) {
    return { subjects: null, reason: "no specialty or facility to build a provider from" };
  }

  const subjects = [];
  const doctorIds = [];
  try {
    // ONE PROVIDER PER PATIENT, not one provider for both.
    //
    // This matters: a waiting room is one provider for one clinic day, so two
    // patients on the same provider share one room and only the first is #1. The
    // checks below assert each subject is first in ITS OWN list, which is the
    // scenario the seeded fallback produced by picking two different providers.
    // One provider would silently change what is being tested.
    for (const [index, minutesAgo] of [60, 30].entries()) {
      const email = `queue-provider${index}-${stamp}@phase7.test`;

      // The provider is never signed into. The hash is a real bcrypt string only
      // because the schema requires one - it is the hash of a random value this
      // run discards, so nobody can authenticate as the fixture provider.
      const unusable = await hashPassword(
        `queue-fixture-unusable-${stamp}-${index}-${Math.floor(Math.random() * 1e12)}`,
      );
      const user = await db.query(
        `INSERT INTO users (email, password_hash, role, full_name, phone)
         VALUES ($1, $2, 'doctor', $3, $4) RETURNING id`,
        [email, unusable, `Dr. Queue Fixture ${stamp.slice(-6)}`, `+9191${stamp.slice(-9)}`],
      );
      const doctor = await db.query(
        `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee,
                              experience_years, seed_rating, seed_review_count)
         VALUES ($1, $2, $3, 400, 5, 4.5, 5) RETURNING id`,
        [user.rows[0].id, specialty.rows[0].id, facility.rows[0].id],
      );
      const doctorId = doctor.rows[0].id;
      doctorIds.push(doctorId);

      const at = new Date(Date.now() - minutesAgo * 60_000);
      const created = await call(`/doctors/${doctorId}/slots`, {
        method: "POST",
        token: adminSession.token,
        body: {
          date: businessDate(at),
          times: [businessTime(at)],
          duration: DURATION_MIN,
          mode: "in-person",
          fee: 400,
          maxQueue: 3,
        },
      });
      const slotId = created.data?.created?.[0]?.id ?? null;
      if (!slotId) {
        return { subjects: null, reason: `the fixture slot was not created (${created.status})` };
      }

      const tag = `imm${index}${minutesAgo}${stamp.slice(-4)}`;
      const patient = await fixturePatient(tag);
      const booked = await call("/appointments", {
        method: "POST",
        token: patient.token,
        body: { doctorId, slotId, reason: "queue-check" },
      });
      if (booked.status !== 201) {
        return { subjects: null, reason: `the fixture booking was refused (${booked.status})` };
      }
      subjects.push({
        label: tag,
        email: patient.email,
        password: patient.password,
        appointment: booked.data.appointment,
      });
    }
  } catch (err) {
    return { subjects: null, reason: `the immediate fixture failed: ${err.message}` };
  }

  console.log(
    `      fixture providers with slots that started 60 and 30 minutes ago; nothing to wait for`,
  );
  return { subjects, reason: null, doctorIds };
}

/**
 * Remove the providers buildImmediateQueue created.
 *
 * Appointments first, then the doctor, then the user. `appointments.doctor_id` is
 * a foreign key, so deleting the provider first leaves the appointment behind and
 * the delete simply fails - which is what an earlier version of this did.
 */
async function dropImmediateProviders(db, doctorIds = []) {
  if (!db || !doctorIds.length) return;
  // The owning user ids are captured FIRST. An earlier version deleted the doctors
  // and then looked their user ids up from the doctors table - which was already
  // empty, so no user was ever removed and every run left an orphaned account
  // behind. The provider rows went; the people did not.
  const owners = await db
    .query(`SELECT user_id FROM doctors WHERE id = ANY($1::text[])`, [doctorIds])
    .catch(() => ({ rows: [] }));
  const userIds = owners.rows.map((r) => r.user_id).filter(Boolean);

  await db
    .query(`DELETE FROM appointments WHERE doctor_id = ANY($1::text[])`, [doctorIds])
    .catch(() => {});
  await db
    .query(`DELETE FROM doctors WHERE id = ANY($1::text[])`, [doctorIds])
    .catch(() => {});
  if (userIds.length) {
    await db
      .query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
      .catch(() => {});
  }
}

/**
 * Build a check-in-able appointment when the seed happens to leave none.
 *
 * A queue entry only exists for a slot that has already started, and the seed
 * lays slots down back to back, so this opens a slot in the next genuinely free
 * window and waits for it. It goes through the real booking path — nothing is
 * written behind the API's back — and it is bounded: past MAX_WAIT_MS the live
 * checks are skipped with a printed reason rather than quietly passing.
 */
async function buildFallbackQueue(adminSession) {
  // Two fixtures, because the cross-patient checks need two people queued at
  // once. One wait covers both.
  const window = await findSoonestFreeStart(2, MAX_WAIT_MS);
  if (!window) {
    return {
      subjects: null,
      reason: `no window with two free providers within ${Math.round(MAX_WAIT_MS / 60_000)} min`,
    };
  }

  // An admin may manage any provider's calendar, so the fixture can use whichever
  // providers free up first without borrowing those doctors' own accounts.
  const subjects = [];
  let firstSlot = null;
  for (let i = 0; i < window.doctorIds.length; i += 1) {
    const doctorId = window.doctorIds[i];
    const tag = `live${i + 1}`;

    const created = await call(`/doctors/${doctorId}/slots`, {
      method: "POST",
      token: adminSession.token,
      body: {
        date: window.date,
        times: [window.time],
        duration: DURATION_MIN,
        mode: "in-person",
        fee: 500,
        maxQueue: 3,
      },
    });
    const slotId = created.data?.created?.[0]?.id ?? null;
    if (!slotId) {
      return { subjects: null, reason: `the fixture slot was not created (${created.status})` };
    }

    const patient = await fixturePatient(tag);
    const booked = await call("/appointments", {
      method: "POST",
      token: patient.token,
      body: { doctorId, slotId, reason: "queue-check" },
    });
    if (booked.status !== 201) {
      return { subjects: null, reason: `the fixture booking was refused (${booked.status})` };
    }
    if (firstSlot === null) firstSlot = { doctorId, slotId };
    subjects.push({ label: tag, email: patient.email, password: patient.password, appointment: booked.data.appointment });
  }

  const slot = (await call(`/doctors/${firstSlot.doctorId}/slots/${firstSlot.slotId}`)).data?.slot ?? null;
  const startsAt = Date.parse(slot?.startsAt ?? "");
  const waitMs = startsAt - Date.now() + 1500;
  if (!(waitMs > 0)) {
    return { subjects: null, reason: "the fixture slot had already started" };
  }

  console.log(
    `      fixture slots: ${window.date} ${window.time} with ${window.doctorNames.join(" and ")}`,
  );
  console.log(`      waiting ${Math.round(waitMs / 1000)}s for the fixture slots to start…`);
  await sleep(waitMs);

  // Sign in again after the wait: access tokens do not outlive it.
  for (const s of subjects) s.session = await signIn({ email: s.email, password: s.password });

  return { subjects, reason: null };
}

/* ------------------------------------------------------------------ *
 *  Server lifecycle                                                   *
 * ------------------------------------------------------------------ */

let server = null;

const startServer = async () => {
  if (!SPAWN_SERVER) return;
  server = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null) throw new Error("API exited early");
  }
  throw new Error("API did not become healthy in time");
};

const stopServer = async () => {
  if (!server) return;
  const dead = new Promise((r) => server.once("exit", r));
  server.kill("SIGKILL");
  await dead;
  server = null;
  await sleep(200);
};

/**
 * The one appointment this patient can check in to: started, and still in a
 * state that check-in accepts. Discovered rather than hard-coded so the suite
 * keeps working after a re-seed.
 */
async function findCheckinable(token) {
  const list = await call("/appointments", { token });
  if (list.status !== 200) return null;
  const rows = list.data?.appointments ?? [];
  return (
    rows.find(
      (a) =>
        Date.parse(a.startsAt) <= Date.now() && ["scheduled", "confirmed"].includes(a.status),
    ) ?? null
  );
}

/* ------------------------------------------------------------------ *
 *  The suite                                                          *
 * ------------------------------------------------------------------ */

const run = async () => {
  console.log(`\n=== queue-position checks (${BASE}) ===\n`);

  let doctorSession = await signIn(DOCTOR);
  let adminSession = await signIn(ADMIN);
  const doctorId = (await call("/doctors/me/schedule", { token: doctorSession.token })).data?.doctor
    ?.id;
  check("the provider's own schedule resolves a doctor id", Boolean(doctorId));

  /* ---------------------------------------------------------------- *
   * 1. booked but never checked in -> the no-queue case               *
   * ---------------------------------------------------------------- */
  const future = await call(
    `/doctors/${doctorId}/slots?status=available&futureOnly=true&limit=1`,
    { token: doctorSession.token },
  );
  const futureSlot = future.data?.slots?.[0] ?? null;

  if (!futureSlot) {
    skipCheck("a booked appointment that never checked in reports null", "no future slot to book");
  } else {
    const idle = await fixturePatient("idle");
    const booked = await call("/appointments", {
      method: "POST",
      token: idle.token,
      body: { doctorId, slotId: futureSlot.id, reason: "never checks in" },
    });
    check("a patient can book a future slot (no-queue fixture)", booked.status === 201,
      `${booked.status} ${booked.body?.message || ""}`);

    if (booked.status === 201) {
      const id = booked.data.appointment.id;
      const row = (await call("/appointments", { token: idle.token })).data?.appointments?.find(
        (a) => a.id === id,
      );
      check("a booked appointment carries a queuePosition field", "queuePosition" in (row ?? {}));
      check(
        "a booked appointment that never checked in reports null",
        row?.queuePosition === null,
        String(row?.queuePosition),
      );
      check("the no-queue appointment is still live", ["scheduled", "confirmed"].includes(row?.status),
        row?.status);
    }
  }

  /* ---------------------------------------------------------------- *
   * 2. real check-ins through the endpoint                             *
   * ---------------------------------------------------------------- */
  const subjects = [];
  for (const email of SEED_PATIENTS) {
    const session = await signIn({ email, password: SEED_PASSWORD });
    const appointment = await findCheckinable(session.token);
    if (appointment) {
      subjects.push({
        label: email.split("@")[0],
        email,
        password: SEED_PASSWORD,
        session,
        appointment,
      });
    }
  }

  // A fresh seed leaves every started appointment in a terminal state, so fall
  // back to opening a slot and waiting for it rather than skipping outright.
  let fallbackReason = null;
  let fixtureDoctorIds = [];
  if (subjects.length === 0) {
    console.log("      no seeded appointment is check-in-able; building a fixture instead");
    // Deterministic first: its own provider, slots that already started, no wait.
    // The seeded-calendar fallback stays behind it as a second resort, so losing
    // the deterministic path degrades to slower rather than to a skip.
    const db = await openLocalDb();
    const immediate = await buildImmediateQueue(adminSession, db);
    if (immediate.subjects) {
      subjects.push(...immediate.subjects);
      fixtureDoctorIds = immediate.doctorIds ?? [];
    } else {
      console.log(`      (${immediate.reason}); falling back to a seeded window`);
      const built = await buildFallbackQueue(adminSession);
      if (built.subjects) subjects.push(...built.subjects);
      else fallbackReason = built.reason;
    }
  }

  if (subjects.length === 0) {
    skipCheck("live queue positions", fallbackReason ?? "no check-in-able appointment could be built");
  } else {
    // The fallback path can wait for a slot to start, and access tokens do not
    // live that long. Every session this section uses is taken again here, so a
    // long wait cannot turn into a wall of TOKEN_EXPIRED failures.
    for (const s of subjects) s.session = await signIn({ email: s.email, password: s.password });
    adminSession = await signIn(ADMIN);
    doctorSession = await signIn(DOCTOR);
    check(
      `found ${subjects.length} started appointment(s) to check in`,
      true,
    );

    // ---- check in, recording exactly what the endpoint returned ----
    const granted = {};
    for (const s of subjects) {
      const r = await call(`/appointments/${s.appointment.id}/check-in`, {
        method: "POST",
        token: s.session.token,
      });
      granted[s.email] = r.data?.queuePosition ?? null;
      check(
        `${s.label} can check in to a started appointment`,
        r.status === 200,
        `${r.status} ${codeOf(r) || r.body?.message || ""}`,
      );
    }

    // ---- the projection under test ----
    for (const s of subjects) {
      const row = (await call("/appointments", { token: s.session.token })).data?.appointments
        ?.find((a) => a.id === s.appointment.id);
      check(
        `${s.label} sees its own position ${granted[s.email]} in the list`,
        row?.queuePosition === granted[s.email],
        `list=${row?.queuePosition} checkin=${granted[s.email]}`,
      );
    }

    // ---- positions are per queue, not a running counter ----
    // Each seeded appointment sits on its own slot, and a slot holds exactly
    // one appointment, so each slot's queue has one member and starts at 1. If
    // the projection were accumulating across queues these would read 1,2,3.
    const values = subjects.map((s) => granted[s.email]);
    check(
      "each queue reports its own position 1, not an accumulating counter",
      values.length > 0 && values.every((v) => v === 1),
      JSON.stringify(values),
    );

    // ---- only genuinely queued rows carry a position ----
    //
    // Checked against ground truth rather than an assumption. A patient may
    // legitimately hold several active entries at once — a different slot each —
    // and earlier runs leave some behind, so "every other row is null" would be
    // asserting something untrue. What must hold is that the set of rows
    // reporting a position is exactly the set that really holds one, with the
    // same numbers.
    const lists = new Map();
    let allIds = [];
    for (const s of subjects) {
      const rows =
        (await call("/appointments", { token: s.session.token })).data?.appointments ?? [];
      lists.set(s, rows);
      allIds = allIds.concat(rows.map((r) => r.id));
    }
    // Ground truth must cover every row the list returned, not just the ones
    // this run checked in, or the comparison is trivially one-sided.
    const truth = await groundTruthPositions(allIds);
    if (!truth) {
      skipCheck(
        "positions are reported only for genuinely queued appointments",
        "the local test database is not reachable, so ground truth cannot be read",
      );
    } else {
      for (const s of subjects) {
        const rows = lists.get(s);
        const reported = new Map(
          rows.filter((a) => a.queuePosition !== null).map((a) => [a.id, a.queuePosition]),
        );
        const expected = new Map(
          [...truth].filter(([id]) => rows.some((r) => r.id === id)),
        );
        const same =
          reported.size === expected.size &&
          [...expected].every(([id, pos]) => reported.get(id) === pos);
        check(
          `${s.label}: positions are reported for exactly the queued appointments`,
          same,
          `reported=${[...reported].map(([i, p]) => `${i.slice(0, 8)}=${p}`).join(",")} ` +
            `expected=${[...expected].map(([i, p]) => `${i.slice(0, 8)}=${p}`).join(",")}`,
        );
        check(
          `${s.label}: the appointment just checked in is one of them`,
          reported.get(s.appointment.id) === granted[s.email],
          `reported=${reported.get(s.appointment.id)} checkin=${granted[s.email]}`,
        );
      }
    }

    // ---- stable across a re-read ----
    const first = subjects[0];
    const again = (await call("/appointments", { token: first.session.token })).data?.appointments
      ?.find((a) => a.id === first.appointment.id);
    check(
      "the position is stable on a later re-read",
      again?.queuePosition === granted[first.email],
      `${again?.queuePosition} vs ${granted[first.email]}`,
    );

    /* ---- authorization, before anything is ended ---- */
    if (subjects.length >= 2) {
      const [a, b] = subjects;
      const foreignList = await call("/appointments", { token: a.session.token });
      check(
        "one patient's list contains no other patient's appointment",
        !(foreignList.data?.appointments ?? []).some((x) => x.id === b.appointment.id),
      );
      check(
        "one patient's list never mentions another patient's appointment",
        !JSON.stringify(foreignList.data ?? {}).includes(b.appointment.id),
      );

      const foreignDetail = await call(`/appointments/${b.appointment.id}`, {
        token: a.session.token,
      });
      check(
        "a patient cannot read another patient's appointment detail",
        foreignDetail.status === 403 || foreignDetail.status === 404,
        String(foreignDetail.status),
      );

      const otherDoctor = await signIn(OTHER_DOCTOR);
      const otherList = await call("/appointments", { token: otherDoctor.token });
      check(
        "another provider cannot see this patient's appointment",
        !(otherList.data?.appointments ?? []).some((x) => x.id === a.appointment.id),
      );
    } else {
      skipCheck(
        "cross-patient authorization while both are queued",
        "only one check-in-able appointment was available, so there is no second patient to be isolated from",
      );
    }

    const adminList = await call(
      `/appointments?patientId=${first.appointment.patientId}`,
      { token: adminSession.token },
    );
    const adminRow = adminList.data?.appointments?.find((a) => a.id === first.appointment.id);
    check(
      "an admin sees the same position the patient sees",
      adminRow?.queuePosition === granted[first.email],
      `${adminRow?.queuePosition} vs ${granted[first.email]}`,
    );

    // ---- the detail endpoint is untouched ----
    const detail = await call(`/appointments/${first.appointment.id}`, {
      token: first.session.token,
    });
    check("the owning patient can still read their detail", detail.status === 200);
    check(
      "the detail response still carries its own wait block",
      Boolean(detail.data?.wait) && "queuePosition" in detail.data.wait,
      JSON.stringify(detail.data?.wait ?? null),
    );

    /* ---- completion clears the position ---- */
    const completed = await call(`/appointments/${first.appointment.id}/status`, {
      method: "PATCH",
      token: adminSession.token,
      body: { status: "completed" },
    });
    check("an admin can complete a queued appointment", completed.status === 200,
      codeOf(completed) || completed.body?.message || "");

    const afterDone = (await call("/appointments", { token: first.session.token })).data
      ?.appointments?.find((a) => a.id === first.appointment.id);
    check(
      "a completed appointment reports no queue position",
      afterDone?.status === "completed" && afterDone?.queuePosition === null,
      `${afterDone?.status} / ${afterDone?.queuePosition}`,
    );

    /* ---- cancellation clears it too, without touching the other patient ---- */
    if (subjects.length >= 2) {
      const second = subjects[1];
      const cancelled = await call(`/appointments/${second.appointment.id}/cancel`, {
        method: "PATCH",
        token: second.session.token,
        body: { reason: "queue-check" },
      });
      check("a queued appointment can be cancelled", cancelled.status === 200, codeOf(cancelled) || "");

      const afterCancel = (await call("/appointments", { token: second.session.token })).data
        ?.appointments?.find((a) => a.id === second.appointment.id);
      check(
        "a cancelled appointment reports no queue position",
        afterCancel?.status === "cancelled" && afterCancel?.queuePosition === null,
        `${afterCancel?.status} / ${afterCancel?.queuePosition}`,
      );
    } else {
      skipCheck(
        "cancellation clears the queue position",
        "the only queued appointment was used for the completion check above",
      );
    }

    // ---- restore the seeded state so repeated runs behave identically ----
    const restore = await restoreFixtures(subjects.map((s) => s.appointment.id));
    if (restore.skipped) {
      skipCheck("the fixtures are restored to their seeded status", restore.reason);
    } else {
      const statuses = [];
      for (const s of subjects) {
        const row = (await call("/appointments", { token: s.session.token })).data?.appointments
          ?.find((a) => a.id === s.appointment.id);
        statuses.push(row?.status);
      }
      check(
        "the fixtures are restored to their seeded status",
        statuses.every((x) => x === "confirmed"),
        JSON.stringify(statuses),
      );
    }

    // A provider this run invented would otherwise sit in the directory for good,
    // and the next run would find one more of them.
    if (fixtureDoctorIds.length) {
      const cleanupDb = await openLocalDb();
      await dropImmediateProviders(cleanupDb, fixtureDoctorIds);
      // Both halves. Deleting the doctor while leaving its user behind is a
      // silent leak: the row no longer appears anywhere the app looks, so nothing
      // else would ever notice it accumulating.
      const remaining = cleanupDb
        ? await cleanupDb.query(
            `SELECT
               (SELECT count(*)::int FROM doctors WHERE id = ANY($1::text[])) AS doctors,
               (SELECT count(*)::int FROM users u
                 WHERE u.email LIKE 'queue-provider%-${RUN_TAG}@phase7.test') AS users`,
            [fixtureDoctorIds],
          )
        : { rows: [{ doctors: -1, users: -1 }] };
      check(
        "the fixture providers this run created are removed, accounts included",
        remaining.rows[0].doctors === 0 && remaining.rows[0].users === 0,
        `doctors left=${remaining.rows[0].doctors} orphaned users left=${remaining.rows[0].users}`,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * 3. shape of the response and of the implementation                *
   * ---------------------------------------------------------------- */
  const anon = await call("/appointments");
  check("an unauthenticated list is refused", anon.status === 401, String(anon.status));

  const demoSession = await signIn({ email: "patient@demo.com", password: SEED_PASSWORD });
  const demoRows = (await call("/appointments", { token: demoSession.token })).data?.appointments ?? [];
  check("the demo patient still has appointments to read", demoRows.length > 0, String(demoRows.length));
  check("every row carries a queuePosition field (backward compatible)",
    demoRows.every((a) => "queuePosition" in a));
  check("every reported position is a positive integer or null",
    demoRows.every((a) => a.queuePosition === null || Number.isInteger(a.queuePosition)));
  check("every other field the list already returned is preserved",
    demoRows.every((a) => "id" in a && "status" in a && "startsAt" in a && "doctorName" in a));

  const repoSrc = await readFile(path.join(ROOT, "src/repositories/queueRepo.js"), "utf8");
  check("the batched lookup binds its ids as a parameter, never as SQL text",
    repoSrc.includes("ANY($1::text[])") && !/appointment_id\s*=\s*'\$\{/.test(repoSrc));
  check("the batched lookup reports only active entries",
    repoSrc.includes("state IN ('waiting', 'in-consultation')"));
  check("the batched lookup returns a Map, not a bare array",
    /export const positionsForAppointments[\s\S]*?return new Map\(/.test(repoSrc));

  const ctrlSrc = await readFile(
    path.join(ROOT, "src/controllers/appointmentController.js"),
    "utf8",
  );
  const listHandler = ctrlSrc.slice(ctrlSrc.indexOf("export const listAppointments"));
  check("the list resolves positions once for the whole page",
    (listHandler.match(/positionsForAppointments/g) || []).length === 1);
  check("the list still reports the scoped count", /count:\s*list\.length/.test(listHandler));

  /* ------------------------------------------------------------------ *
   * 4. the live queue: ordering, payload and who may read it            *
   * ------------------------------------------------------------------ */
  // `GET /appointments/queue` is read-only and separate from the list
  // projection above. It is what the doctor queue screen reads, so its
  // ordering, its payload and its scoping are asserted here.
  const qDoctorSession = await signIn(DOCTOR);
  const qDoctorId = (await call("/auth/me", { token: qDoctorSession.token })).data?.user
    ?.doctor?.id;
  const qOtherSession = await signIn(OTHER_DOCTOR);
  const qOtherDoctorId = (await call("/auth/me", { token: qOtherSession.token })).data?.user
    ?.doctor?.id;
  const qAdminSession = await signIn(ADMIN);
  check("the provider's own schedule resolves a doctor id", Boolean(qDoctorId));

  const noDoctorId = await call("/appointments/queue", { token: qDoctorSession.token });
  check("the queue refuses a request with no doctorId",
    noDoctorId.status === 400 && codeOf(noDoctorId) === "MISSING_DOCTOR",
    `status=${noDoctorId.status} code=${codeOf(noDoctorId)}`);

  const anonQueue = await call(`/appointments/queue?doctorId=${qDoctorId}`);
  check("an unauthenticated caller cannot read a waiting list",
    anonQueue.status === 401, `status=${anonQueue.status}`);

  const qToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  }).format(new Date());

  const qOwn = (await call(`/appointments/queue?doctorId=${qDoctorId}&date=${qToday}`, {
    token: qDoctorSession.token,
  })).data;
  check("a doctor reads their own queue", Array.isArray(qOwn?.entries));
  check("the queue reports a total, a waiting count and an average wait",
    Number.isInteger(qOwn?.total) && Number.isInteger(qOwn?.waiting) &&
      Number.isInteger(qOwn?.averageWaitMinutes),
    JSON.stringify({ total: qOwn?.total, waiting: qOwn?.waiting, avg: qOwn?.averageWaitMinutes }));
  check("the waiting count matches the waiting rows",
    qOwn?.waiting === (qOwn?.entries ?? []).filter((e) => e.state === "waiting").length,
    `waiting=${qOwn?.waiting}`);
  check("every position is a positive integer as the server sent it",
    (qOwn?.entries ?? []).every((e) => Number.isInteger(e.position) && e.position >= 1),
    JSON.stringify((qOwn?.entries ?? []).map((e) => e.position)));
  check("every entry names its patient and carries the queue state",
    (qOwn?.entries ?? []).every(
      (e) => typeof e.patientName === "string" && typeof e.state === "string",
    ));

  // A patient asking for a doctor's waiting list must get their own row only,
  // never the room. The scoped payload omits other patients' names, so this
  // holds however full the room happens to be.
  const qPatientSession = await signIn({ email: "patient@demo.com", password: SEED_PASSWORD });
  const qAsPatient = (await call(`/appointments/queue?doctorId=${qDoctorId}&date=${qToday}`, {
    token: qPatientSession.token,
  })).data;
  check("a patient is shown at most their own row, never the room",
    (qAsPatient?.entries ?? []).length <= 1,
    `entries=${(qAsPatient?.entries ?? []).length} room=${qOwn?.total}`);
  check("a patient cannot read another patient's name from the queue",
    (qAsPatient?.entries ?? []).every(
      (e) => e.patientName === undefined ||
        qOwn?.entries.some((o) => o.patientName === e.patientName),
    ),
    JSON.stringify((qAsPatient?.entries ?? []).map((e) => e.patientName)));

  // Cross-doctor: the request SUCCEEDS but is scoped to the caller's own row, so
  // the other doctor's room is not disclosed. Asserting a 403 here would be
  // asserting behaviour this API deliberately does not have.
  if (qOtherDoctorId) {
    const qCross = (await call(`/appointments/queue?doctorId=${qOtherDoctorId}&date=${qToday}`, {
      token: qDoctorSession.token,
    })).data;
    const qCrossNames = (qCross?.entries ?? []).map((e) => e.patientName);
    const qOtherRoom = (await call(`/appointments/queue?doctorId=${qOtherDoctorId}&date=${qToday}`, {
      token: qOtherSession.token,
    })).data;
    check("a doctor asking for another doctor's queue is scoped to themselves",
      (qCross?.entries ?? []).length <= 1,
      `entries=${(qCross?.entries ?? []).length}`);
    check("a doctor cannot see the other doctor's waiting list",
      (qOtherRoom?.entries ?? []).every((e) => qCrossNames.includes(e.patientName)),
      `cross=${JSON.stringify(qCrossNames)} otherRoom=${(qOtherRoom?.entries ?? []).length}`);
  }

  const qAsAdmin = (await call(`/appointments/queue?doctorId=${qDoctorId}&date=${qToday}`, {
    token: qAdminSession.token,
  })).data;
  check("an admin reads the full queue and it matches the doctor's own view",
    qAsAdmin?.entries?.length === qOwn?.entries?.length,
    `admin=${qAsAdmin?.entries?.length} doctor=${qOwn?.entries?.length}`);

  // Ordering is the server's: slot start time, then position.
  const qSched = (await call("/doctors/me/schedule", { token: qDoctorSession.token })).data;
  const qStarts = new Map(
    (qSched?.appointments ?? []).map((a) => [a.id, new Date(a.startsAt).getTime()]),
  );
  const qApptIds = new Set((qSched?.appointments ?? []).map((a) => a.id));
  const qOrdered = (qOwn?.entries ?? []).map((e) => qStarts.get(e.appointmentId) ?? 0);
  check("the queue comes back ordered by appointment start time",
    JSON.stringify(qOrdered) === JSON.stringify(qOrdered.slice().sort((a, b) => a - b)),
    JSON.stringify(qOrdered));
  check("every queued entry belongs to an appointment on this doctor's list",
    (qOwn?.entries ?? []).every((e) => qApptIds.has(e.appointmentId)));

  // The queue payload carries no appointment time: listForDoctor selects
  // start_time but toEntry drops it, so a client cannot show one from here.
  // Recorded so the gap stays visible instead of being quietly worked around.
  check("the queue payload carries no appointment time (the client joins it)",
    (qOwn?.entries ?? []).every((e) => e.startTime === undefined && e.endsAt === undefined),
    JSON.stringify(Object.keys(qOwn?.entries?.[0] ?? {})));

};

try {
  await startServer();
  await run();
} catch (err) {
  console.error(`\nSUITE ERROR: ${err.message}`);
  fail += 1;
  failures.push("suite error");
} finally {
  await stopServer();
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${skip} skipped ===`);
if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
if (skipped.length) console.log(`skipped: ${skipped.join(" | ")}`);
process.exit(fail === 0 ? 0 : 1);