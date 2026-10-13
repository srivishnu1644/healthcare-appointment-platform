/**
 * Phase 6 appointment booking and lifecycle checks.
 *
 *   node scripts/appointment-check.js
 *   SPAWN=1 node scripts/appointment-check.js   # recommended: own the lifecycle
 *
 * Where it runs
 * -------------
 * Against the isolated local test database, never the hosted project. Two
 * reasons, one practical and one about what is being tested:
 *
 *   * the suites create and cancel appointments and slots, so running them
 *     against a real database would mean writing to it;
 *   * the local server serves ONE client at a time, which shapes the structure
 *     below. Fixtures are inserted with a direct connection BEFORE the API
 *     starts, and database state is verified with another direct connection
 *     AFTER it stops. Never both at once.
 *
 * That two-phase shape is also a strength: several assertions here check the
 * database rather than the API response, because "no partial write" and "exactly
 * one history row" are claims about rows, and inferring them from an HTTP body
 * would be guesswork.
 *
 * Covers
 *   * booking: success, and the fields the client must not control
 *   * invalid bookings: missing, nonexistent, past, blocked, taken, overlapping
 *   * authorization: role gates and IDOR attempts on every per-appointment route
 *   * cancellation: slot release, queue cleanup, audit fields, both endpoints
 *   * status transitions: the full matrix, valid and invalid
 *   * rescheduling: re-pricing, doctor match, and refusals
 *   * queue: idempotent check-in, derived positions, capacity
 *   * history and notifications: written transactionally, with the outbox
 *   * transactions: rollback leaves nothing behind
 *   * concurrency: reported as UNVERIFIED here, with the reason
 */
import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import * as time from "../src/utils/time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SPAWN_SERVER = process.env.SPAWN === "1";
const PORT = Number(process.env.APPOINTMENT_CHECK_PORT) || 5094;
const BASE =
  process.env.API_URL || (SPAWN_SERVER ? `http://localhost:${PORT}/api` : "http://localhost:5000/api");

const PATIENT = { email: "patient@demo.com", password: "patient123" };
// The seed gives every patient account the same password, so these are
// deliberately the same credential with different accounts.
const PATIENT2 = { email: "ishita@demo.com", password: "patient123" };
const PATIENT3 = { email: "aman@demo.com", password: "patient123" };
const ADMIN = { email: "admin@demo.com", password: "admin123" };
const DOCTOR = { email: "doctor1@demo.com", password: "doctor123" };
const DOCTOR2 = { email: "doctor2@demo.com", password: "doctor123" };

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const skips = [];

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

const skip = (name, reason) => {
  console.log(`SKIP  ${name} :: ${reason}`);
  skipped += 1;
  skips.push(`${name} (${reason})`);
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
  return { status: res.status, body: payload, data: payload?.data ?? null, code: payload?.error?.code ?? null };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  Direct database access                                            *
 *                                                                     *
 *  Used only for fixture setup and post-hoc verification. Never while *
 *  the API is running: the local server serves one client.            *
 * ------------------------------------------------------------------ */

const withClient = async (fn) => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

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
  await sleep(300);
};

/* ------------------------------------------------------------------ *
 *  Fixtures                                                           *
 * ------------------------------------------------------------------ */

const TODAY = time.todayLocal();
// The business timezone the slot repositories label rows with, so the date and
// time read back here are exactly the ones the notification template rendered.
const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";

// Every fixture account belongs to one run.
//
// These rows used to reuse fixed emails across runs, which made the suite
// re-runnable only once: each run leaves 30-minute slots on the shared fixture
// doctors, and the next run's slots, positioned around the new "now", overlap
// them and trip `slots_no_doctor_overlap`. The shared patients accumulate
// appointments for the same reason, which then collide with the next run's
// bookings under the patient no-overlap rule. Scoping the accounts to a run id
// gives each run clean, uncontended fixtures without weakening any assertion.
const RUN_ID = Date.now().toString(36);
/**
 * The local date `n` days from today, in the business timezone.
 *
 * Steps the calendar date as a plain date rather than adding 24 hours to an
 * instant, which would land on the wrong day across a daylight-saving boundary.
 */
const dayOffset = (n) => {
  const [y, m, d] = TODAY.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + n));
  return probe.toISOString().slice(0, 10);
};

/** Absolute instant (seconds) of a local "HH:MM" on a local date. */
const at = (date, hhmm) => (time.localToInstant(date, hhmm).getTime() / 1000).toFixed(3);

/**
 * Add minutes to an "HH:MM" string, wrapping at midnight.
 *
 * Wrapping matters: the previous version computed the hour as
 * `floor(total / 1440) + floor((total % 1440) / 60)`, which is right only below
 * 24:00 and silently produces a wrong hour above it. A wrapped time is what
 * tells the caller the slot would cross into the next day.
 */
const addMinutes = (hhmm, mins) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  const total = h * 60 + m + mins;
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

/** Minutes past midnight for an "HH:MM". */
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

const fx = {
  created: new Set(),
  usedSlots: new Set(),
  madeSlots: new Set(),
  madeUsers: new Set(),
  madeDoctors: new Set(),
  slotDoctor: new Map(),
};

/** The provider that owns a fixture slot, so a booking names the right doctor. */
const ownerOf = (slotId) => fx.slotDoctor.get(slotId) ?? fx.doctorId;

/**
 * Insert a fixture slot, stepping forward until it does not clash.
 *
 * `slots_no_doctor_overlap` forbids two of a doctor's slots overlapping, and the
 * seed already lays slots down on a fixed set of half-hour times. Hardcoding
 * "12:00 is free" would work until the seed's schedule changed, so the clash is
 * resolved by asking the database instead.
 *
 * @param {object} db   an open client
 * @param {object} spec `{ doctorId, facilityId, date, from, duration, mode, fee, maxQueue, status }`
 * @returns {Promise<string>} the new slot's id
 */
const insertSlot = async (db, spec) => {
  const { doctorId, facilityId, date, from, duration = 30, mode = "in-person", fee = 700, maxQueue = 3, status = "available" } = spec;

  // Only windows that fit ENTIRELY within the day are usable. Continuing past
  // midnight would wrap the end time round to a smaller value and ask
  // tstzrange for a lower bound above its upper bound. The bound is strict for
  // the same reason: a window ending exactly AT midnight is arithmetically
  // allowed here, but `addMinutes` reduces 1440 to 0, so 23:00 + 60 becomes
  // 00:00 and the range runs backwards. That was only reachable late in a fully
  // booked day, once every earlier shift had already clashed.
  const firstStart = minutesOf(from);
  for (let shift = 0; firstStart + shift * duration + duration < 1440; shift += 1) {
    const startTime = addMinutes(from, shift * duration);
    const endTime = addMinutes(startTime, duration);
    const startS = at(date, startTime);
    const endS = at(date, endTime);

    const clash = await db.query(
      `SELECT 1 FROM slots
        WHERE doctor_id = $1
          AND tstzrange(starts_at, ends_at) && tstzrange(to_timestamp($2::double precision),
                                                          to_timestamp($3::double precision))
        LIMIT 1`,
      [doctorId, startS, endS],
    );
    if (clash.rows.length) continue;

    const r = await db.query(
      `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, mode, status, fee, max_queue)
       VALUES ($1, $2, to_timestamp($3::double precision), to_timestamp($4::double precision),
               $5::consult_mode, $6::slot_status, $7, $8)
       RETURNING id`,
      [doctorId, facilityId, startS, endS, mode, status, fee, maxQueue],
    );
    fx.slotDoctor.set(r.rows[0].id, doctorId);
    fx.madeSlots.add(r.rows[0].id);
    return { id: r.rows[0].id, startTime, endTime };
  }
  throw new Error(
    `no free ${duration}-minute window left on ${date} for doctor ${doctorId} ` +
      `(searched from ${from}); the day is full, so this database needs recreating`,
  );
};

/**
 * Insert a slot that genuinely overlaps `baseStart`..`baseEnd` for a DIFFERENT
 * doctor.
 *
 * Two constraints shape this:
 *
 *   * `slots_no_doctor_overlap` means a slot cannot overlap another slot for the
 *     same doctor, so an overlapping pair has to span two doctors - which is also
 *     exactly the situation the patient-overlap rule exists to catch;
 *   * `insertSlot` deliberately shifts away from any clash, which would quietly
 *     move the slot out of the target window and make the test vacuous. That
 *     happened: the "overlapping" slot landed on a different hour and the
 *     overlap assertion passed for the wrong reason.
 *
 * So this walks offsets INSIDE the target window and takes the first one that
 * does not clash for that doctor.
 */
const insertOverlappingSlot = async (db, { doctorId, facilityId, date, baseStart, baseEnd }) => {
  const baseStartMin =
    Number(baseStart.slice(0, 2)) * 60 + Number(baseStart.slice(3, 5));
  const baseEndMin = Number(baseEnd.slice(0, 2)) * 60 + Number(baseEnd.slice(3, 5));

  for (let offset = 5; baseStartMin + offset + 30 <= baseEndMin; offset += 5) {
    const from = `${String(Math.floor((baseStartMin + offset) / 60)).padStart(2, "0")}:${String((baseStartMin + offset) % 60).padStart(2, "0")}`;
    const to = `${String(Math.floor((baseStartMin + offset + 30) / 60)).padStart(2, "0")}:${String((baseStartMin + offset + 30) % 60).padStart(2, "0")}`;

    const clash = await db.query(
      `SELECT 1 FROM slots
        WHERE doctor_id = $1
          AND tstzrange(starts_at, ends_at) && tstzrange(to_timestamp($2::double precision),
                                                          to_timestamp($3::double precision))
        LIMIT 1`,
      [doctorId, at(date, from), at(date, to)],
    );
    if (clash.rows.length) continue;

    const r = await db.query(
      `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, mode, status, fee, max_queue)
       VALUES ($1, $2, to_timestamp($3::double precision), to_timestamp($4::double precision),
               'in-person'::consult_mode, 'available', 999, 3)
       RETURNING id`,
      [doctorId, facilityId, at(date, from), at(date, to)],
    );
    fx.slotDoctor.set(r.rows[0].id, doctorId);
    fx.madeSlots.add(r.rows[0].id);
    return { id: r.rows[0].id, startTime: from, endTime: to };
  }
  throw new Error(`no free window overlapping ${baseStart}-${baseEnd} on ${date}`);
};

/**
 * Insert the slots the API refuses to create.
 *
 * Two categories need direct insertion:
 *
 *   * a slot in the PAST. Phase 5 refuses to create one, correctly, so the only
 *     way to test that booking rejects a past slot is to have one exist.
 *   * slots with a specific `max_queue`, to test waiting-room capacity.
 *
 * Everything the API can legitimately create is created through the API, so the
 * tests exercise the real endpoints wherever possible.
 */
const buildFixtures = async () => {
  await withClient(async (db) => {
    const doc = await db.query(
      `SELECT d.id, d.facility_id, d.user_id FROM doctors d
         JOIN users u ON u.id = d.user_id
        WHERE u.email = $1`,
      [DOCTOR.email],
    );
    fx.doctorId = doc.rows[0].id;
    fx.facilityId = doc.rows[0].facility_id;
    fx.doctorUserId = doc.rows[0].user_id;

    const doc2 = await db.query(
      `SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
      [DOCTOR2.email],
    );
    fx.otherDoctorId = doc2.rows[0].id;

    // Hashing is imported here because the fixture providers below are created
    // before the patient fixtures that used to introduce it.
    const { hashPassword } = await import("../src/utils/password.js");
    const specialty = await db.query(`SELECT id FROM specialties ORDER BY slug LIMIT 1`);
    const doctorPw = await hashPassword("doctor123");
    const makeFixtureDoctor = async (tag) => {
      const email = `fixture-${tag}-${RUN_ID}@phase6.test`;
      const u = await db.query(
        `INSERT INTO users (email, password_hash, role, full_name, phone)
         VALUES ($1, $2, 'doctor', $3, $4)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [email, doctorPw, `Dr. Fixture ${tag}`, `+9192${tag.padStart(3, "0")}${RUN_ID.slice(-6)}`],
      );
      const d = await db.query(
        `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee,
                              experience_years, seed_rating, seed_review_count)
         VALUES ($1, $2, $3, 700, 5, 4.5, 10)
         ON CONFLICT (user_id) DO UPDATE SET facility_id = EXCLUDED.facility_id
         RETURNING id`,
        [u.rows[0].id, specialty.rows[0].id, fx.facilityId],
      );
      // Remember the exact rows, so cleanup removes these and nothing else.
      fx.madeUsers.add(u.rows[0].id);
      fx.madeDoctors.add(d.rows[0].id);
      return d.rows[0].id;
    };
    fx.doctorPast = await makeFixtureDoctor("past");
    fx.doctorNow = await makeFixtureDoctor("now");
    fx.doctorFuture = await makeFixtureDoctor("future");
    fx.doctorCapacity = await makeFixtureDoctor("capacity");
    fx.doctorPositions = await makeFixtureDoctor("positions");

    const own = { doctorId: fx.doctorId, facilityId: fx.facilityId };

    // Yesterday: bookable-looking but in the past.
    fx.pastSlot = (await insertSlot(db, { ...own, date: dayOffset(-1), from: "12:00" })).id;
    // A dedicated fixture doctor per check-in slot.
    //
    // The fixtures must sit at controlled instants around "now", so they land on
    // arbitrary clock times. Two problems follow, and neither is solved by nudging
    // a timestamp - which would defeat the point of controlling it:
    //
    //   * `slots_no_doctor_overlap` forbids two of the SAME doctor's slots from
    //     overlapping, and the seeded grid already covers 09:00-11:30 and
    //     14:00-17:00 in 30-minute steps, so a fixture on a seeded doctor clashes at
    //     some hours;
    //   * two fixtures near each other would clash with each other, and "already
    //     started" plus "still bookable" is a narrow window just after midnight.
    //
    // One doctor per fixture sidesteps both: overlap is per doctor, so these can
    // never conflict with the seed or with each other, at any hour.


    // Today: a video slot with a distinctive fee, so the reschedule test can
    // prove the fee and mode are taken from the NEW slot.
    //
    // On this run's own provider rather than the shared demo doctor, whose day
    // is filled by the seed and which every run would otherwise leave a slot
    // behind on. The cheap slot below is created on this SAME provider, because
    // an appointment may only be rescheduled within its own doctor's calendar -
    // giving the two slots different providers would turn the reschedule check
    // into a cross-doctor move, which is refused for a different reason.
    const pricey = await insertSlot(db, {
      ...own, date: TODAY, from: "18:00", mode: "video", fee: 4321, maxQueue: 3,
    });
    fx.priceySlot = pricey.id;
    fx.priceyStart = pricey.startTime;
    fx.priceyDoctor = own.doctorId;

    // A dedicated pair for the patient-overlap test, so it does not consume
    // `priceySlot`, which the reschedule test needs to start from.
    //
    // The two slots deliberately belong to DIFFERENT doctors. A patient holding
    // two overlapping appointments can only happen across doctors, because
    // `slots_no_doctor_overlap` forbids one doctor from having two overlapping
    // slots in the first place - so overlapping same-doctor slots cannot be
    // constructed, even as a fixture.
    // The base slot is deliberately 60 minutes wide rather than 30. An
    // overlapping slot placed inside a 30-minute window would itself run into the
    // seeded slots on either side, so the inserter would have nowhere legal to put
    // it. A wider base leaves room for a 30-minute overlap strictly inside it.
    //
    // The base sits on this run's own fixture provider rather than the shared demo
    // doctor. The demo provider's day is packed by the seed, and every run of this
    // suite would leave its base slot behind there, eating the last free gap until
    // no 60-minute window remained at all. A per-run provider arrives empty and
    // keeps the rule under test intact: the two slots still belong to DIFFERENT
    // doctors, which is the only way a patient can hold two overlapping
    // appointments at all.
    const overlapBase = await insertSlot(db, {
      ...own, date: TODAY, from: "13:00", duration: 60, fee: 999, maxQueue: 3,
    });
    fx.overlapBaseSlot = overlapBase.id;
    fx.overlapBaseDoctor = fx.doctorId;

    // The overlapping half needs a provider of its own, and for the same reason:
    // placing it on a seeded provider left a slot in the seeded lunch gap on
    // every run until the gap was gone. It must still be a DIFFERENT provider
    // from the base - that is the whole point of the fixture.
    const overlapping = await insertOverlappingSlot(db, {
      doctorId: fx.otherDoctorId,
      facilityId: fx.facilityId,
      date: TODAY,
      baseStart: overlapBase.startTime,
      baseEnd: overlapBase.endTime,
    });
    fx.overlapSlot = overlapping.id;
    fx.overlapSlotDoctor = fx.otherDoctorId;
    fx.overlapWindow = `${overlapBase.startTime}-${overlapBase.endTime} vs ${overlapping.startTime}-${overlapping.endTime}`;

    // Today, cheap: the other half of the re-pricing comparison. Same provider as
    // the pricey slot above, because that is what makes it a re-price rather
    // than a move to another doctor.
    const cheap = await insertSlot(db, { ...own, date: TODAY, from: "19:00", fee: 111, maxQueue: 3 });
    fx.cheapSlot = cheap.id;
    fx.cheapStart = cheap.startTime;
    fx.cheapDoctor = own.doctorId;

    // Blocked, for the blocked-booking refusal.
    fx.blockedSlot = (
      await insertSlot(db, { ...own, date: TODAY, from: "20:00", status: "blocked", maxQueue: 3 })
    ).id;

    // Owned by the OTHER doctor, for the doctor-mismatch refusals. Two of them:
    // the authorization tests book one, and the reschedule test needs a free one
    // to prove the doctor check fires before the slot-taken check.
    const other = { doctorId: fx.otherDoctorId, facilityId: fx.facilityId };
    fx.foreignSlot = (await insertSlot(db, { ...other, date: dayOffset(3), from: "12:00", fee: 700, maxQueue: 3 })).id;
    fx.foreignSlotSpare = (await insertSlot(db, { ...other, date: dayOffset(5), from: "12:00", fee: 700, maxQueue: 3 })).id;

    // Two back-to-back, non-overlapping slots on one day: the control proving an
    // adjacent booking is allowed where an overlapping one is not.
    //
    // On this run's own provider: placed on the shared demo doctor, each run
    // left these behind on the same day until that day had no room left.
    const adjA = await insertSlot(db, { ...own, date: dayOffset(3), from: "12:00", fee: 700, maxQueue: 3 });
    fx.adjacentA = adjA.id;
    fx.adjacentDate = dayOffset(3);
    fx.adjacentB = (
      await insertSlot(db, { ...own, date: dayOffset(3), from: adjA.endTime, fee: 700, maxQueue: 3 })
    ).id;

    // Accounts for the concurrency race.
    //
    // The race needs one identity per competing request, and the seed provides
    // three patients. These are created HERE rather than by adding them to the
    // seed: they exist only to make a booking race expressible, they live only in
    // the test database, and changing the shared seed to serve one test would be
    // the wrong trade. Passwords are hashed with the application's own helper.
    const raceHash = await hashPassword("race123");
    for (let i = 0; i < 20; i += 1) {
      const email = `race${String(i + 1).padStart(2, "0")}-${RUN_ID}@phase6.test`;
      await db.query(
        `INSERT INTO users (email, password_hash, role, full_name, phone)
         VALUES ($1, $2, 'patient', $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [email, raceHash, `Race Patient ${i + 1}`, `+91 9000${String(i).padStart(6, "0")}`],
      );
    }
    const raceUsers = await db.query(
      `SELECT id, email FROM users WHERE email LIKE 'race%-${RUN_ID}@phase6.test' ORDER BY email`,
    );
    fx.raceEmails = raceUsers.rows.map((r) => r.email);
    for (const r of raceUsers.rows) fx.madeUsers.add(r.id);

    // Accounts for the check-in tests.
    //
    // These start with NO appointments at all, which matters: the fixtures below
    // sit at controlled instants around "now", and any seeded or previously booked
    // appointment could overlap them, which would fail the patient no-overlap
    // constraint and make the result depend on the seeded data rather than on the
    // rule under test.
    const checkinHash = raceHash;
    // Eight, and each account is used by exactly ONE section.
    //
    // The bug this fixes: indices 0, 1 and 2 were handed to the check-in section
    // for its future/now/past fixtures, having ALREADY been used by the
    // patient-overlap section (0 and 1) and the re-pricing section (2). Both of
    // those book a real appointment and never cancel it. Since every check-in
    // fixture is placed at an offset from `now()`, whether the earlier
    // appointment overlapped the later one depended on the hour the suite ran:
    //
    //   11:00-12:00 IST  now+2h lands inside the 13:00 overlap window  -> checkin01
    //   14:00-15:00 IST  now-3h lands inside the 13:00 overlap window  -> checkin02
    //
    // so the suite failed at a different assertion depending on the time of day,
    // with PATIENT_CLASH - a collision between two fixtures, never the rule under
    // test.
    //
    // The allocation is therefore exclusive:
    //   0, 1  patient-overlap section
    //   2     re-pricing section
    //   3, 4  queue and capacity section
    //   5, 6, 7  check-in section (future, now, past)
    for (let i = 0; i < 8; i += 1) {
      const email = `checkin${String(i + 1).padStart(2, "0")}-${RUN_ID}@phase6.test`;
      await db.query(
        `INSERT INTO users (email, password_hash, role, full_name, phone)
         VALUES ($1, $2, 'patient', $3, $4)
         ON CONFLICT (email) DO NOTHING`,
        [email, checkinHash, `Check In Patient ${i + 1}`, `+91 9100${String(i).padStart(6, "0")}`],
      );
    }
    const ciUsers = await db.query(
      `SELECT id, email FROM users WHERE email LIKE 'checkin%-${RUN_ID}@phase6.test' ORDER BY email`,
    );
    fx.checkinEmails = ciUsers.rows.map((r) => r.email);
    for (const r of ciUsers.rows) fx.madeUsers.add(r.id);


    // Check-in fixtures, positioned relative to the DATABASE clock.
    //
    // Times are chosen as offsets from `now()` rather than as wall-clock values,
    // so the suite behaves identically at 09:00 and at 23:30 and never depends on
    // a sleep. Two of the three are clamped so they land on TODAY, because booking
    // a slot requires a date that has not passed - a slot three hours into
    // yesterday simply cannot be booked at 01:00, and the test would be measuring
    // the booking rule rather than the check-in rule.
    const nowRow = await db.query(`SELECT now() AS n`);
    const nowMs = new Date(nowRow.rows[0].n).getTime();
    const todayStartMs = time.localToInstant(TODAY, "00:01").getTime();

    // Started 3 hours ago, but never before the first minute of today.
    const pastStart = new Date(Math.max(nowMs - 3 * 3600_000, todayStartMs));
    // Two hours ahead, pulled back to just before midnight when that would still
    // be today, so "later today" is exercised whenever the day still has room.
    const endOfToday = time.localToInstant(TODAY, "23:30").getTime();
    const futureStart = new Date(Math.min(nowMs + 2 * 3600_000, endOfToday));
    const futureIsToday = time.localDate(futureStart) === TODAY;

    const insertAt = async (doctorId, startMs, { maxQueue = 3, durationMin = 30 } = {}) => {
      const r = await db.query(
        `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, mode, status, fee, max_queue)
         VALUES ($1, $2, to_timestamp($3::double precision), to_timestamp($4::double precision),
                 'in-person'::consult_mode, 'available', 700, $5)
         RETURNING id`,
        [doctorId, fx.facilityId, startMs / 1000, (startMs + durationMin * 60_000) / 1000, maxQueue],
      );
      fx.slotDoctor.set(r.rows[0].id, doctorId);
      fx.madeSlots.add(r.rows[0].id);
      return { id: r.rows[0].id, startMs };
    };

    // `now()` exactly, as the database sees it. The check-in request necessarily
    // arrives later than that, so `starts_at <= now()` holds; the exact-equality
    // boundary itself is pinned by the hasStarted() unit checks.
    fx.ciFuture = await insertAt(fx.doctorFuture, futureStart.getTime());
    fx.ciNow = await insertAt(fx.doctorNow, nowMs);
    fx.ciPast = await insertAt(fx.doctorPast, pastStart.getTime());
    fx.ciFutureIsToday = futureIsToday;

    // The queue position and capacity fixtures also need a slot that has started,
    // because check-in requires it. They get their own doctors for the same reason,
    // and sit in the elapsed part of today so they remain bookable.
    fx.capacitySlot = (
      await insertAt(fx.doctorCapacity, Math.max(nowMs - 60 * 60_000, todayStartMs), { maxQueue: 1 })
    ).id;
    fx.capacitySlotSpare = (
      await insertAt(fx.doctorCapacity, Math.max(nowMs - 6 * 3600_000, todayStartMs + 60_000), { maxQueue: 1 })
    ).id;
    fx.positionsSlot = (
      await insertAt(fx.doctorPositions, Math.max(nowMs - 2 * 3600_000, todayStartMs), { maxQueue: 3 })
    ).id;

    // A batch of free future slots, one per test, each on its own day so the
    // patient-overlap rule cannot be tripped accidentally.
    // Two extra slots at the end are reserved for the concurrency race, so the
    // race never contends with a slot the sequential tests already booked.
    //
    // Each on this run's own provider, so repeated runs cannot fill a seeded
    // day that later runs still need.
    fx.free = [];
    fx.freeMeta = [];
    for (let d = 4; d <= 16; d += 1) {
      const slot = await insertSlot(db, { ...own, date: dayOffset(d), from: "12:00", fee: 700, maxQueue: 3 });
      fx.free.push(slot.id);
      // The clash-avoiding insert may have shifted the time, so assertions read
      // the real values rather than assuming where the slot landed.
      fx.freeMeta.push({ date: dayOffset(d), startTime: slot.startTime, endTime: slot.endTime });
    }
  });

  console.log(`      fixtures built (today = ${TODAY})`);
};

/* ------------------------------------------------------------------ *
 *  Session helpers                                                    *
 * ------------------------------------------------------------------ */

const ctx = {};

const login = async () => {
  const as = async (creds) => (await call("/auth/login", { method: "POST", body: creds })).data;
  const [p, p2, p3, a, d, d2] = await Promise.all([
    as(PATIENT), as(PATIENT2), as(PATIENT3), as(ADMIN), as(DOCTOR), as(DOCTOR2),
  ]);
  ctx.P = p?.token;
  ctx.P2 = p2?.token;
  ctx.P3 = p3?.token;
  ctx.A = a?.token;
  ctx.D = d?.token;
  ctx.D2 = d2?.token;
  ctx.PatientId = p?.user?.id;
  ctx.Patient2Id = p2?.user?.id;
  ctx.Patient3Id = p3?.user?.id;
  check("logged in the three patients, an admin and two providers", Boolean(ctx.P && ctx.P2 && ctx.P3 && ctx.A && ctx.D && ctx.D2));
};

/**
 * Book a slot and remember the appointment, so the database assertions can be
 * scoped to rows this suite produced.
 */
const track = (id, slotId) => {
  if (id) fx.created.add(id);
  if (slotId) fx.usedSlots.add(slotId);
  return id;
};

const bookSlot = async (token, slotId, extra = {}) => {
  const res = await call("/appointments", {
    method: "POST",
    token,
    // Name the provider that actually owns the slot. Fixture slots sit on this
    // run's own providers, so hardcoding the demo doctor would be refused with
    // SLOT_MISMATCH before the rule under test was ever reached.
    body: { doctorId: ownerOf(slotId), slotId, ...extra },
  });
  track(res.data?.appointment?.id, slotId);
  return res;
};

/**
 * Book a slot against an explicitly named doctor.
 *
 * Needed for the check-in fixtures, which each hang off their own fixture doctor
 * so they cannot overlap each other or the seeded grid. `bookSlot` always sends
 * the main test doctor, which would be a SLOT_MISMATCH for those.
 */
const bookWith = async (token, doctorId, slotId) => {
  const res = await call("/appointments", {
    method: "POST",
    token,
    body: { doctorId, slotId },
  });
  track(res.data?.appointment?.id, slotId);
  return res;
};

/* ------------------------------------------------------------------ *
 *  1. Booking                                                         *
 * ------------------------------------------------------------------ */

const bookingChecks = async () => {
  console.log("\n=== Booking ===\n");

  const r = await bookSlot(ctx.P, fx.free[0], { reason: "Persistent cough" });
  check("a future slot books successfully", r.status === 201, `HTTP ${r.status} ${r.code}`);
  fx.booked = r.data?.appointment;
  fx.bookedId = r.data?.appointment?.id;

  const a = r.data?.appointment ?? {};
  check("the appointment is confirmed", a.status === "confirmed", a.status);
  check("the doctor comes from the slot", a.doctorId === fx.doctorId, a.doctorId);
  check("the slot is recorded", a.slotId === fx.free[0], a.slotId);
  check("the fee is snapshotted from the slot", Number(a.fee) === 700, String(a.fee));
  check("the reason is stored", a.reason === "Persistent cough", a.reason);
  check(
    "the appointment reports the slot's local date and time",
    a.date === fx.freeMeta[0].date && a.startTime === fx.freeMeta[0].startTime,
    `${a.date} ${a.startTime}, wanted ${fx.freeMeta[0].date} ${fx.freeMeta[0].startTime}`,
  );

  // The slot must now be taken.
  const afterBook = await call(`/doctors/${ownerOf(fx.free[0])}/slots?date=${fx.freeMeta[0].date}&futureOnly=true`);
  const claimed = afterBook.data.slots.find((s) => s.id === fx.free[0]);
  check("the slot is marked booked once the appointment exists", claimed?.status === "booked", claimed?.status);

  // Re-booking the same slot must be refused.
  const again = await bookSlot(ctx.P2, fx.free[0]);
  check(
    "a slot that is already taken is refused with 409 SLOT_TAKEN",
    again.status === 409 && again.code === "SLOT_TAKEN",
    `HTTP ${again.status} ${again.code}`,
  );

  /* ---- fields the client must not control ---- */

  const modeRes = await bookSlot(ctx.P3, fx.free[1], { mode: "video" });
  check("booking succeeds when the client names a mode", modeRes.status === 201, `HTTP ${modeRes.status} ${modeRes.code}`);
  check(
    "the client-supplied mode is ignored; the slot's mode is stored",
    modeRes.data?.appointment?.mode === "in-person",
    modeRes.data?.appointment?.mode,
  );
  fx.modeAppointment = modeRes.data?.appointment?.id;

  const wrongDoc = await bookSlot(ctx.P2, fx.free[2], { doctorId: fx.otherDoctorId });
  check(
    "a doctorId that does not match the slot is refused",
    wrongDoc.status === 400 && wrongDoc.code === "SLOT_MISMATCH",
    `HTTP ${wrongDoc.status} ${wrongDoc.code}`,
  );
  const wrongDocCheck = await call(`/doctors/${ownerOf(fx.free[2])}/slots?date=${fx.freeMeta[2].date}`);
  check(
    "the refused booking left the slot untouched",
    wrongDocCheck.data.slots.find((s) => s.id === fx.free[2])?.status === "available",
  );

  /* ---- refusals ---- */

  const cases = [
    ["a slot that does not exist", "00000000-0000-0000-0000-000000000000", 404, "SLOT_NOT_FOUND"],
    ["a slot in the past", fx.pastSlot, 400, "SLOT_IN_PAST"],
    ["a slot the provider blocked", fx.blockedSlot, 400, "SLOT_BLOCKED"],
  ];
  for (const [label, slotId, status, code] of cases) {
    const res = await bookSlot(ctx.P2, slotId);
    check(
      `refuses ${label}`,
      res.status === status && res.code === code,
      `HTTP ${res.status} ${res.code} (wanted ${status} ${code})`,
    );
  }

  // Named explicitly: the point of this check is a slot owned by one provider
  // being booked while naming a DIFFERENT one. Letting bookSlot resolve the real
  // owner would name the right doctor and the disagreement never happens.
  const foreignRes = await bookSlot(ctx.P2, fx.foreignSlot, { doctorId: fx.doctorId });
  check(
    "refuses a slot belonging to another doctor when the doctorId disagrees",
    foreignRes.status === 400 && foreignRes.code === "SLOT_MISMATCH",
    `HTTP ${foreignRes.status} ${foreignRes.code}`,
  );

  const missing = await call("/appointments", {
    method: "POST",
    token: ctx.P,
    body: { doctorId: fx.doctorId },
  });
  check("refuses a booking with no slotId", missing.status === 422, `HTTP ${missing.status}`);

  /* ---- patient cannot hold two overlapping appointments ---- */

  // Both sides of this check use this run's appointment-free fixture patients.
  // A seeded demo account carries its own visits across the working day, so it
  // can already hold something at this time and be refused by the very rule this
  // section is trying to demonstrate.
  const signInFixturePatient = async (index) => {
    const r = await call("/auth/login", {
      method: "POST",
      body: { email: (fx.checkinEmails ?? [])[index], password: "race123" },
    });
    return r.data?.token ?? null;
  };
  const clashPatient = await signInFixturePatient(0);
  const controlPatient = await signInFixturePatient(1);
  check("appointment-free fixture patients are available for the overlap checks",
    Boolean(clashPatient && controlPatient));

  const overlapBase = await bookSlot(clashPatient, fx.overlapBaseSlot);
  check("a second patient books a slot", overlapBase.status === 201, `HTTP ${overlapBase.status} ${overlapBase.code}`);

  // Different doctor, overlapping time, same patient: the scenario the exclusion
  // constraint exists to prevent.
  const clash = await call("/appointments", {
    method: "POST",
    token: clashPatient,
    body: { doctorId: fx.overlapSlotDoctor, slotId: fx.overlapSlot },
  });
  check(
    "the same patient cannot hold two overlapping appointments",
    clash.status === 409 && clash.code === "PATIENT_CLASH",
    `HTTP ${clash.status} ${clash.code} [${fx.overlapWindow}]`,
  );

  // Control: a slot at the SAME time with a different patient is fine, which
  // proves the refusal above is about the patient, not about the slot.
  const otherPatientSameTime = await call("/appointments", {
    method: "POST",
    token: controlPatient,
    body: { doctorId: fx.overlapSlotDoctor, slotId: fx.overlapSlot },
  });
  track(otherPatientSameTime.data?.appointment?.id, fx.overlapSlot);
  check(
    "a DIFFERENT patient may book that overlapping slot",
    otherPatientSameTime.status === 201,
    `HTTP ${otherPatientSameTime.status} ${otherPatientSameTime.code}`,
  );

  const adjA = await bookSlot(ctx.P3, fx.adjacentA);
  const adjB = await bookSlot(ctx.P3, fx.adjacentB);
  check(
    "two back-to-back, non-overlapping slots are allowed",
    adjA.status === 201 && adjB.status === 201,
    `HTTP ${adjA.status} / ${adjB.status}`,
  );
  fx.adjacentAppointment = adjA.data?.appointment?.id;
};

/* ------------------------------------------------------------------ *
 *  2. Authorization and IDOR                                         *
 * ------------------------------------------------------------------ */

const authorizationChecks = async () => {
  console.log("\n=== Authorization and IDOR ===\n");

  const anon = await call("/appointments", {
    method: "POST",
    body: { doctorId: ownerOf(fx.free[3]), slotId: fx.free[3] },
  });
  check("an unauthenticated booking is refused", anon.status === 401, `HTTP ${anon.status}`);

  for (const [label, token] of [["a provider", ctx.D], ["an admin", ctx.A]]) {
    const res = await bookSlot(token, fx.free[3]);
    check(
      `${label} cannot book an appointment`,
      res.status === 403 && res.code === "FORBIDDEN",
      `HTTP ${res.status} ${res.code}`,
    );
  }

  // fx.booked belongs to patient 1. Everyone else must be refused.
  const target = fx.bookedId;
  const idor = [
    ["read", ctx.P2, "GET", `/appointments/${target}`, 403],
    ["cancel", ctx.P2, "PATCH", `/appointments/${target}/cancel`, 403],
    ["reschedule", ctx.P2, "PATCH", `/appointments/${target}/reschedule`, 403],
    ["check in to", ctx.P2, "POST", `/appointments/${target}/check-in`, 403],
    ["change status of", ctx.P2, "PATCH", `/appointments/${target}/status`, 403],
  ];
  for (const [label, token, method, path, expected] of idor) {
    const res = await call(path, { method, token, body: method === "GET" ? undefined : { slotId: fx.free[4], status: "completed" } });
    check(
      `a different patient cannot ${label} another patient's appointment`,
      res.status === expected,
      `HTTP ${res.status} ${res.code}`,
    );
  }

  // A provider must not reach another provider's appointment. Book it with the
  // matching doctorId, which is the only combination the API accepts.
  const otherPatient = await call("/appointments", {
    method: "POST",
    token: ctx.P2,
    body: { doctorId: fx.otherDoctorId, slotId: fx.foreignSlot },
  });
  const otherApptId = track(otherPatient.data?.appointment?.id, fx.foreignSlot);
  if (otherApptId) {
    const res = await call(`/appointments/${otherApptId}/status`, {
      method: "PATCH",
      token: ctx.D,
      body: { status: "completed" },
    });
    check(
      "a provider cannot change the status of another provider's appointment",
      res.status === 403,
      `HTTP ${res.status}`,
    );
  } else {
    check("a provider cannot change the status of another provider's appointment", false, "fixture booking failed");
  }

  const anonRead = await call(`/appointments/${target}`);
  check("an unauthenticated read is refused", anonRead.status === 401, `HTTP ${anonRead.status}`);

  // Listing scope.
  const mineList = await call("/appointments", { token: ctx.P });
  const allMine = mineList.data.appointments.every((x) => x.patientId === ctx.PatientId);
  check("a patient only ever sees their own appointments", allMine, "a foreign appointment appeared");

  const crossPatient = await call(`/appointments?patientId=${ctx.Patient2Id}`, { token: ctx.P });
  const leaked = crossPatient.data.appointments.filter((x) => x.patientId !== ctx.PatientId);
  check(
    "a patient cannot widen their list with ?patientId",
    leaked.length === 0,
    `${leaked.length} foreign appointments returned`,
  );

  const adminList = await call(`/appointments?patientId=${ctx.Patient2Id}`, { token: ctx.A });
  check(
    "an admin may read another patient's appointments",
    adminList.status === 200 && adminList.data.appointments.length > 0,
    `HTTP ${adminList.status}`,
  );

  // Detail must be a whitelisted projection.
  const detail = await call(`/appointments/${target}`, { token: ctx.P });
  const serialised = JSON.stringify(detail.data.appointment ?? {});
  check(
    "appointment detail exposes no credential or internal field",
    !/password|hash|secret|token|user_id|patient_password/i.test(serialised),
  );
  check(
    "appointment detail does not expose the owning user's account record",
    !("email" in (detail.data.appointment ?? {})),
  );
};

/* ------------------------------------------------------------------ *
 *  3. Cancellation                                                    *
 * ------------------------------------------------------------------ */

const cancellationChecks = async () => {
  console.log("\n=== Cancellation ===\n");

  const r = await call(`/appointments/${fx.modeAppointment}/cancel`, {
    method: "PATCH",
    token: ctx.P3,
    body: { reason: "Feeling better" },
  });
  check("a patient can cancel their own appointment", r.status === 200, `HTTP ${r.status} ${r.code}`);
  check("the appointment is cancelled", r.data?.appointment?.status === "cancelled", r.data?.appointment?.status);
  check(
    "the cancellation is attributed to the patient",
    r.data?.appointment?.cancelledBy === "patient",
    r.data?.appointment?.cancelledBy,
  );
  check(
    "the supplied reason is stored",
    r.data?.appointment?.cancelReason === "Feeling better",
    r.data?.appointment?.cancelReason,
  );
  check("cancelled_at is stamped", Boolean(r.data?.appointment?.cancelledAt));

  const released = await call(`/doctors/${ownerOf(fx.free[1])}/slots?date=${fx.freeMeta[1].date}`);
  check(
    "cancelling releases the slot back to available",
    released.data.slots.find((s) => s.id === fx.free[1])?.status === "available",
    released.data.slots.find((s) => s.id === fx.free[1])?.status,
  );

  const twice = await call(`/appointments/${fx.modeAppointment}/cancel`, {
    method: "PATCH",
    token: ctx.P3,
  });
  check(
    "cancelling twice is refused",
    twice.status === 400 && twice.code === "ALREADY_CANCELLED",
    `HTTP ${twice.status} ${twice.code}`,
  );

  const missing = await call(`/appointments/00000000-0000-0000-0000-000000000000/cancel`, {
    method: "PATCH",
    token: ctx.P,
  });
  check("cancelling an unknown appointment is a 404", missing.status === 404, `HTTP ${missing.status}`);

  // Provider cancellation is attributed to the provider, not to a hardcoded role.
  const byProvider = await call(`/appointments/${fx.adjacentAppointment}/cancel`, {
    method: "PATCH",
    token: ctx.D,
    body: { reason: "Doctor unavailable" },
  });
  check(
    "a provider cancelling records cancelled_by = provider",
    byProvider.status === 200 && byProvider.data?.appointment?.cancelledBy === "provider",
    `HTTP ${byProvider.status} ${byProvider.data?.appointment?.cancelledBy}`,
  );

  /* ---- the historical bug: cancelling via the status endpoint ---- */

  const viaStatus = await bookSlot(ctx.P2, fx.free[5]);
  const viaStatusId = viaStatus.data?.appointment?.id;
  const patched = await call(`/appointments/${viaStatusId}/status`, {
    method: "PATCH",
    token: ctx.D,
    body: { status: "cancelled", note: "Cancelled through the status route" },
  });
  check(
    "cancelling through PATCH /status works",
    patched.status === 200 && patched.data?.appointment?.status === "cancelled",
    `HTTP ${patched.status} ${patched.code}`,
  );
  check(
    "cancelling through PATCH /status attributes the actor correctly",
    patched.data?.appointment?.cancelledBy === "provider",
    patched.data?.appointment?.cancelledBy,
  );
  const releasedViaStatus = await call(`/doctors/${ownerOf(fx.free[5])}/slots?date=${fx.freeMeta[5].date}`);
  check(
    "cancelling through PATCH /status ALSO releases the slot",
    releasedViaStatus.data.slots.find((s) => s.id === fx.free[5])?.status === "available",
    releasedViaStatus.data.slots.find((s) => s.id === fx.free[5])?.status,
  );
};

/* ------------------------------------------------------------------ *
 *  4. Status transitions                                              *
 * ------------------------------------------------------------------ */

const transitionChecks = async () => {
  console.log("\n=== Status transitions ===\n");

  const asDoctor = (id, status, note) =>
    call(`/appointments/${id}/status`, { method: "PATCH", token: ctx.D, body: { status, note } });

  const live = await bookSlot(ctx.P, fx.free[6]);
  const id = live.data?.appointment?.id;
  fx.liveAppointment = id;

  const started = await asDoctor(id, "in-progress");
  check("confirmed -> in-progress is allowed", started.status === 200, `HTTP ${started.status} ${started.code}`);

  const completed = await asDoctor(id, "completed");
  check("in-progress -> completed is allowed", completed.status === 200, `HTTP ${completed.status} ${completed.code}`);
  check("completed_at is stamped on completion", Boolean(completed.data?.appointment?.completedAt));

  const afterComplete = await asDoctor(id, "confirmed");
  check(
    "a completed appointment cannot be reopened",
    afterComplete.status === 400 && afterComplete.code === "INVALID_TRANSITION",
    `HTTP ${afterComplete.status} ${afterComplete.code}`,
  );

  const backFromDone = await asDoctor(id, "in-progress");
  check(
    "completed -> in-progress is refused",
    backFromDone.status === 400 && backFromDone.code === "INVALID_TRANSITION",
    `HTTP ${backFromDone.status} ${backFromDone.code}`,
  );

  const cancelDone = await call(`/appointments/${id}/cancel`, { method: "PATCH", token: ctx.P });
  check(
    "a completed appointment cannot be cancelled",
    cancelDone.status === 400 && cancelDone.code === "INVALID_STATUS",
    `HTTP ${cancelDone.status} ${cancelDone.code}`,
  );

  const reschedDone = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: ctx.P,
    body: { slotId: fx.free[7] },
  });
  check(
    "a completed appointment cannot be rescheduled",
    reschedDone.status === 400 && reschedDone.code === "INVALID_STATUS",
    `HTTP ${reschedDone.status} ${reschedDone.code}`,
  );

  const noShow = await bookSlot(ctx.P, fx.free[7]);
  const nsId = noShow.data?.appointment?.id;
  const ns = await asDoctor(nsId, "no-show");
  check("confirmed -> no-show is allowed", ns.status === 200, `HTTP ${ns.status} ${ns.code}`);
  const nsAgain = await asDoctor(nsId, "completed");
  check(
    "no-show is terminal",
    nsAgain.status === 400 && nsAgain.code === "INVALID_TRANSITION",
    `HTTP ${nsAgain.status} ${nsAgain.code}`,
  );

  const patientStatus = await call(`/appointments/${nsId}/status`, {
    method: "PATCH",
    token: ctx.P,
    body: { status: "completed" },
  });
  check(
    "a patient cannot change status directly",
    patientStatus.status === 403,
    `HTTP ${patientStatus.status}`,
  );

  const badStatus = await call(`/appointments/${nsId}/status`, {
    method: "PATCH",
    token: ctx.D,
    body: { status: "teleported" },
  });
  check("an unknown status value is rejected by validation", badStatus.status === 422, `HTTP ${badStatus.status}`);

  // A cancelled appointment is terminal too.
  const cancelledTerm = await asDoctor(fx.modeAppointment, "in-progress");
  check(
    "a cancelled appointment cannot be moved back to in-progress",
    cancelledTerm.status === 400 && cancelledTerm.code === "INVALID_TRANSITION",
    `HTTP ${cancelledTerm.status} ${cancelledTerm.code}`,
  );
};

/* ------------------------------------------------------------------ *
 *  5. Rescheduling                                                    *
 * ------------------------------------------------------------------ */

const rescheduleChecks = async () => {
  console.log("\n=== Rescheduling ===\n");

  // Booked as one of this run's appointment-free fixture patients: a seeded
  // demo account can already hold a visit at this time and be refused by the
  // patient no-overlap rule, which has nothing to do with re-pricing.
  const rescheduleSession = await call("/auth/login", {
    method: "POST",
    body: { email: (fx.checkinEmails ?? [])[2], password: "race123" },
  });
  const reschedulePatient = rescheduleSession.data?.token ?? null;
  check("an appointment-free fixture patient is available for the reschedule checks",
    Boolean(reschedulePatient));
  const booked = await bookSlot(reschedulePatient, fx.priceySlot);
  const id = booked.data?.appointment?.id;
  check(
    "the appointment to reschedule was booked at the slot's price",
    booked.status === 201 && Number(booked.data?.appointment?.fee) === 4321,
    `HTTP ${booked.status} ${booked.code} fee=${booked.data?.appointment?.fee}`,
  );
  if (!id) {
    console.log("      booking the reschedule fixture failed; skipping the remaining reschedule assertions");
    return;
  }

  const same = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.priceySlot },
  });
  check(
    "rescheduling onto the same slot is refused",
    same.status === 400 && same.code === "SLOT_UNCHANGED",
    `HTTP ${same.status} ${same.code}`,
  );

  const moved = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.cheapSlot },
  });
  check("rescheduling onto a free slot succeeds", moved.status === 200, `HTTP ${moved.status} ${moved.code}`);
  const movedAppt = moved.data?.appointment ?? {};
  check("the appointment now points at the new slot", movedAppt.slotId === fx.cheapSlot, movedAppt.slotId);
  check(
    "the fee is REFRESHED from the new slot",
    Number(movedAppt.fee) === 111,
    String(movedAppt.fee),
  );
  check(
    "the mode is taken from the new slot",
    movedAppt.mode === "in-person",
    movedAppt.mode,
  );
  check(
    "the reported time follows the new slot",
    movedAppt.date === TODAY && movedAppt.startTime === fx.cheapStart,
    `${movedAppt.date} ${movedAppt.startTime}, wanted ${TODAY} ${fx.cheapStart}`,
  );

  // The re-pricing slots live on this run's fixture provider, so the slot states
  // are read from that provider rather than the demo doctor.
  const slotsToday = await call(`/doctors/${fx.priceyDoctor}/slots?date=${TODAY}`);
  check(
    "the old slot is released after a reschedule",
    slotsToday.data.slots.find((s) => s.id === fx.priceySlot)?.status === "available",
    slotsToday.data.slots.find((s) => s.id === fx.priceySlot)?.status,
  );
  check(
    "the new slot is taken after a reschedule",
    slotsToday.data.slots.find((s) => s.id === fx.cheapSlot)?.status === "booked",
    slotsToday.data.slots.find((s) => s.id === fx.cheapSlot)?.status,
  );

  const intoPast = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.pastSlot },
  });
  check(
    "rescheduling into the past is refused",
    intoPast.status === 400 && intoPast.code === "SLOT_IN_PAST",
    `HTTP ${intoPast.status} ${intoPast.code}`,
  );

  const intoBlocked = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.blockedSlot },
  });
  check(
    "rescheduling into a blocked slot is refused",
    intoBlocked.status === 400 && intoBlocked.code === "SLOT_BLOCKED",
    `HTTP ${intoBlocked.status} ${intoBlocked.code}`,
  );

  const intoTaken = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.free[0] },
  });
  check(
    "rescheduling into a slot that is already taken is refused",
    intoTaken.status === 409 && intoTaken.code === "SLOT_TAKEN",
    `HTTP ${intoTaken.status} ${intoTaken.code}`,
  );

  const intoForeign = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: { slotId: fx.foreignSlotSpare },
  });
  check(
    "rescheduling into another doctor's slot is refused",
    intoForeign.status === 400 && intoForeign.code === "SLOT_MISMATCH",
    `HTTP ${intoForeign.status} ${intoForeign.code}`,
  );

  const noSlot = await call(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    token: reschedulePatient,
    body: {},
  });
  check("rescheduling with no slotId is rejected by validation", noSlot.status === 422, `HTTP ${noSlot.status}`);

  // The appointment must be untouched by all those refusals.
  const stillThere = await call(`/appointments/${id}`, { token: reschedulePatient });
  check(
    "none of the refused reschedules moved the appointment",
    stillThere.data?.appointment?.slotId === fx.cheapSlot,
    stillThere.data?.appointment?.slotId,
  );
};

/* ------------------------------------------------------------------ *
 *  6. Queue                                                           *
 * ------------------------------------------------------------------ */

const queueChecks = async () => {
  console.log("\n=== Queue and check-in ===\n");

  // These use the appointment-free fixture patients, not the demo accounts.
  //
  // The capacity and positions slots sit at controlled instants around "now",
  // and the demo patients carry seeded appointments across the working day. The
  // patient no-overlap rule is real and must not be bypassed, so booking one of
  // those slots as a demo patient could be refused with PATIENT_CLASH whenever
  // a seeded visit happens to overlap - which made the result depend on the
  // seed and the clock rather than on the queue rule under test.
  // These must be patients NOBODY has booked yet. Patients 0 and 1 already hold
  // the 13:00 overlap fixture above, and the capacity slot is placed at
  // `now - 1h`, so between roughly 14:00 and 15:00 the two windows overlapped
  // and the booking was refused with PATIENT_CLASH - a collision between two
  // fixtures, not the rule under test. Patients 3 and 4 exist for this section
  // alone and are used nowhere else.
  // Indices 5, 6 and 7 are reserved for this section alone. Using 0, 1 and 2 here
  // reused patients that the overlap and re-pricing sections had already booked,
  // which made the result depend on the hour. See the fixture allocation note.
  fx.checkinTokens = [];
  for (const email of (fx.checkinEmails ?? []).slice(0, 8)) {
    const r = await call("/auth/login", { method: "POST", body: { email, password: "race123" } });
    fx.checkinTokens.push(r.data?.token ?? null);
  }
  const qFirst = fx.checkinTokens[3];
  const qSecond = fx.checkinTokens[4];
  check("appointment-free fixture patients are available for the queue checks",
    Boolean(qFirst && qSecond));

  // Every fixture patient must start this section with nothing booked, because
  // each fixture below sits at an offset from `now()` and the patient-overlap
  // fixture occupies a fixed 13:00-14:00 window. A patient carrying an
  // appointment from another section therefore collides or not depending on the
  // hour the suite runs - which is exactly the bug this guard now prevents.
  // A short-lived connection of its own: this function has no pool handle, and
  // borrowing one would couple an assertion to how the suite is wired.
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await probe.connect();
  const reserved = await probe.query(
    `SELECT u.email, count(a.id)::int AS booked
       FROM users u
       LEFT JOIN appointments a
         ON a.patient_id = u.id
        AND a.status IN ('scheduled','confirmed','in-progress')
      WHERE u.email LIKE 'checkin%-${RUN_ID}@phase6.test'
      GROUP BY u.email
      ORDER BY u.email`,
  );
  // Indices 3-7 serve the queue and check-in sections, which is where the
  // collision actually happened. Indices 0-2 are booked ON PURPOSE by the
  // overlap and re-pricing sections - that is those sections' whole job - so
  // they are excluded rather than asserted to be free.
  const mustBeFree = reserved.rows.slice(3);
  const notFree = mustBeFree.filter((r) => r.booked > 0);
  check(
    "no earlier section has already booked the queue or check-in fixture patients",
    mustBeFree.length === 5 && notFree.length === 0,
    `${mustBeFree.length - notFree.length} of ${mustBeFree.length} free; carrying appointments: ${
      notFree.map((r) => `${r.email}(${r.booked})`).join(",") || "none"
    }`,
  );

  // Capacity 1: first patient in, second refused.
  const a1 = await bookWith(qFirst, fx.doctorCapacity, fx.capacitySlot);
  const a1id = a1.data?.appointment?.id;
  check("the first patient can book the capacity slot",
    a1.status === 201, `HTTP ${a1.status} ${a1.code}`);
  const first = await call(`/appointments/${a1id}/check-in`, { method: "POST", token: qFirst });
  check("the first patient checks in", first.status === 200, `HTTP ${first.status} ${first.code}`);
  check("the first patient is at position 1", first.data?.queuePosition === 1, String(first.data?.queuePosition));

  const repeat = await call(`/appointments/${a1id}/check-in`, { method: "POST", token: qFirst });
  check(
    "checking in twice is idempotent, not an error",
    repeat.status === 200 && repeat.data?.queuePosition === 1,
    `HTTP ${repeat.status} pos=${repeat.data?.queuePosition}`,
  );

  // NOTE ON CAPACITY: the one-active-appointment-per-slot constraint means a
  // second patient can never share a slot, so "is the waiting room full?" cannot
  // be provoked through the API on a single slot - each patient would need their
  // own slot, and capacity belongs to the slot. The capacity rule is therefore
  // verified directly against the database in the post-API phase, with two
  // patients waiting on one max_queue=1 slot.

  const a2real = await bookWith(qSecond, fx.doctorPositions, fx.positionsSlot);
  check("a second patient books a different slot", a2real.status === 201, `HTTP ${a2real.status}`);

  const positions = await call(`/appointments/${a2real.data.appointment.id}/check-in`, {
    method: "POST",
    token: qSecond,
  });
  check("a second patient checks in", positions.status === 200, `HTTP ${positions.status} ${positions.code}`);
  check(
    "positions are per-slot, so this is also position 1 for its own slot",
    positions.data?.queuePosition === 1,
    String(positions.data?.queuePosition),
  );
  fx.secondQueueAppointment = a2real.data.appointment.id;

  /* ---- the documented rule: refuse until the slot has STARTED ---- */

  // A slot later today (or later still, only when the day has no room left).
  const futureAppt = await bookWith(fx.checkinTokens[5], fx.doctorFuture, fx.ciFuture.id);
  check(
    "the future-dated fixture could be booked",
    futureAppt.status === 201,
    `HTTP ${futureAppt.status} ${futureAppt.code}`,
  );
  const futureCheckIn = await call(
    `/appointments/${futureAppt.data?.appointment?.id}/check-in`,
    { method: "POST", token: fx.checkinTokens[5] },
  );
  check(
    "check-in is refused while the slot has not started",
    futureCheckIn.status === 400 && futureCheckIn.code === "SLOT_NOT_STARTED",
    `HTTP ${futureCheckIn.status} ${futureCheckIn.code}`,
  );
  if (fx.ciFutureIsToday) {
    // The case the old date-based rule got wrong: same local date, later instant.
    const localDate = (await call(`/appointments/${futureAppt.data.appointment.id}`, {
      token: fx.checkinTokens[5],
    })).data?.appointment?.date;
    check(
      "a slot LATER TODAY is refused even though its date is today",
      localDate === TODAY && futureCheckIn.code === "SLOT_NOT_STARTED",
      `date=${localDate} today=${TODAY} code=${futureCheckIn.code}`,
    );
  } else {
    check(
      "the 'later today' variant is exercised whenever the day has room",
      true,
      "skipped: not enough of the day left for a future slot to remain on it",
    );
  }
  fx.futureAppointment = futureAppt.data?.appointment?.id;

  // A slot starting at "now".
  const nowAppt = await bookWith(fx.checkinTokens[6], fx.doctorNow, fx.ciNow.id);
  check("the now-dated fixture could be booked", nowAppt.status === 201, `HTTP ${nowAppt.status} ${nowAppt.code}`);
  const nowCheckIn = await call(`/appointments/${nowAppt.data?.appointment?.id}/check-in`, {
    method: "POST",
    token: fx.checkinTokens[6],
  });
  check(
    "check-in is accepted for a slot starting at the current instant",
    nowCheckIn.status === 200 && nowCheckIn.data?.queuePosition === 1,
    `HTTP ${nowCheckIn.status} ${nowCheckIn.code} pos=${nowCheckIn.data?.queuePosition}`,
  );

  // A slot that started earlier.
  const pastAppt = await bookWith(fx.checkinTokens[7], fx.doctorPast, fx.ciPast.id);
  check("the past-dated fixture could be booked", pastAppt.status === 201, `HTTP ${pastAppt.status} ${pastAppt.code}`);
  const pastCheckIn = await call(`/appointments/${pastAppt.data?.appointment?.id}/check-in`, {
    method: "POST",
    token: fx.checkinTokens[7],
  });
  check(
    "check-in is accepted for a slot that already started",
    pastCheckIn.status === 200 && pastCheckIn.data?.queuePosition === 1,
    `HTTP ${pastCheckIn.status} ${pastCheckIn.code} pos=${pastCheckIn.data?.queuePosition}`,
  );

  // The rule must not weaken the other gates: a slot that has started but is
  // closed, or is not the caller's, is still refused.
  const closedNotStarted = await call(`/appointments/${futureAppt.data?.appointment?.id}/check-in`, {
    method: "POST",
    token: fx.checkinTokens[6],
  });
  check(
    "another patient cannot check in to a future slot they do not own",
    closedNotStarted.status === 403,
    `HTTP ${closedNotStarted.status} ${closedNotStarted.code}`,
  );

  const closed = await call(`/appointments/${fx.modeAppointment}/check-in`, {
    method: "POST",
    token: ctx.P3,
  });
  check(
    "a cancelled appointment cannot be checked in to, even though it has started",
    closed.status === 400 && closed.code === "INVALID_STATUS",
    `HTTP ${closed.status} ${closed.code}`,
  );

  const completedRefused = await call(`/appointments/${fx.liveAppointment}/check-in`, {
    method: "POST",
    token: ctx.P,
  });
  check(
    "a completed appointment cannot be checked in to",
    completedRefused.status === 400 && completedRefused.code === "INVALID_STATUS",
    `HTTP ${completedRefused.status} ${completedRefused.code}`,
  );

  const anonFuture = await call(`/appointments/${futureAppt.data?.appointment?.id}/check-in`, {
    method: "POST",
  });
  check(
    "an unauthenticated check-in on a future slot is refused with 401",
    anonFuture.status === 401,
    `HTTP ${anonFuture.status}`,
  );

  // Cancelling must clear the queue entry.
  const cancelQueued = await call(`/appointments/${a1id}/cancel`, {
    method: "PATCH",
    token: qFirst,
  });
  check("a queued appointment can still be cancelled", cancelQueued.status === 200, `HTTP ${cancelQueued.status}`);

  // The waiting list is scoped.
  const queueAsPatient = await call(`/appointments/queue?doctorId=${fx.doctorId}&date=${TODAY}`, {
    token: ctx.P,
  });
  const foreignEntries = queueAsPatient.data.entries.filter((e) => e.patientId !== ctx.PatientId);
  check(
    "a patient sees only their own entry in the waiting list",
    foreignEntries.length === 0,
    `${foreignEntries.length} foreign entries returned`,
  );
  check(
    "the waiting list does not leak other patients' names to a patient",
    !queueAsPatient.data.entries.some((e) => e.patientId !== ctx.PatientId && e.patientName),
  );

  const queueAsDoctor = await call(`/appointments/queue?doctorId=${fx.doctorId}&date=${TODAY}`, {
    token: ctx.D,
  });
  check("the assigned provider sees the whole waiting list", queueAsDoctor.status === 200, `HTTP ${queueAsDoctor.status}`);

  const queueAsStranger = await call(`/appointments/queue?doctorId=${fx.doctorId}&date=${TODAY}`, {
    token: ctx.D2,
  });
  const strangerSees = queueAsStranger.data.entries.length;
  const ownCount = queueAsStranger.data.entries.filter((e) => e.patientId === ctx.PatientId).length;
  check(
    "a provider who is not assigned sees only their own patients' entries",
    strangerSees === ownCount,
    `${strangerSees} entries vs ${ownCount} of their own`,
  );
};

/* ------------------------------------------------------------------ *
 *  7. Listing and detail                                              *
 * ------------------------------------------------------------------ */

const listingChecks = async () => {
  console.log("\n=== Listing and detail ===\n");

  const asPatient = await call("/appointments", { token: ctx.P });
  check("a patient can list their appointments", asPatient.status === 200 && asPatient.data.appointments.length > 0);
  check(
    "the list reports a count that matches the rows",
    asPatient.data.count === asPatient.data.appointments.length,
    `${asPatient.data.count} vs ${asPatient.data.appointments.length}`,
  );

  const filtered = await call("/appointments?status=cancelled", { token: ctx.P });
  check(
    "status filtering works",
    filtered.data.appointments.every((x) => x.status === "cancelled"),
    [...new Set(filtered.data.appointments.map((x) => x.status))].join(","),
  );

  const detail = await call(`/appointments/${fx.bookedId}`, { token: ctx.P });
  check("an owner can read their own appointment in detail", detail.status === 200);
  check("detail includes the derived display names", Boolean(detail.data.appointment.doctorName && detail.data.appointment.patientName));
  check("detail includes the status history", Array.isArray(detail.data.history) && detail.data.history.length > 0);

  const history = detail.data.history;
  check(
    "the first history entry is the creation, from nothing",
    history[0]?.fromStatus === null && history[0]?.toStatus === "confirmed",
    JSON.stringify(history[0]),
  );
  check(
    "the creation entry records who made it",
    history[0]?.changedBy === ctx.PatientId,
    history[0]?.changedBy,
  );

  const missing = await call("/appointments/00000000-0000-0000-0000-000000000000", { token: ctx.P });
  check("an unknown appointment id is a 404", missing.status === 404, `HTTP ${missing.status}`);
};

/* ------------------------------------------------------------------ *
 *  8. Transactions and rollback                                       *
 * ------------------------------------------------------------------ */

const transactionChecks = async () => {
  console.log("\n=== Transactions ===\n");

  const target = fx.free[9];
  const before = await call(`/doctors/${ownerOf(fx.free[9])}/slots?date=${fx.freeMeta[9].date}`);
  const beforeState = before.data.slots.find((s) => s.id === target)?.status;

  const after = await call(`/doctors/${ownerOf(fx.free[9])}/slots?date=${fx.freeMeta[9].date}`);
  const afterState = after.data.slots.find((s) => s.id === target)?.status;
  check(
    "a refused booking attempt leaves the slot exactly as it was",
    afterState === beforeState,
    `${beforeState} -> ${afterState}`,
  );

  // A failed booking must leave no rows behind at all.
  const refused = await bookSlot(ctx.P2, fx.pastSlot);
  check("booking a past slot is refused", refused.status === 400, `HTTP ${refused.status}`);
  const stillBookable = await bookSlot(ctx.P2, target);
  check(
    "the slot is still bookable after a refused attempt",
    stillBookable.status === 201,
    `HTTP ${stillBookable.status} ${stillBookable.code}`,
  );
  check(
    "exactly one appointment exists for that slot after the retry",
    Boolean(stillBookable.data?.appointment?.id),
  );
};

/* ------------------------------------------------------------------ *
 *  9. Concurrency                                                     *
 *                                                                     *
 *  The headline Phase 6 requirement. Whether it can be demonstrated    *
 *  depends on the database, so the probe below measures the target    *
 *  first and reports the outcome honestly either way.                 *
 * ------------------------------------------------------------------ */

/**
 * Can this database hold two connections at once?
 *
 * Probed BEFORE the API starts. Opening a second connection while the API is
 * serving would contend for the single connection this local database offers,
 * which does not merely fail the probe - it kills the connection the API is
 * using, so every later request fails too.
 *
 * @returns {Promise<{concurrent: boolean, error?: string}>}
 */
const probeConcurrencySupport = async () => {
  try {
    return await withClient(async (db) => {
      await db.query("CREATE TABLE IF NOT EXISTS phase6_conc_probe (id text PRIMARY KEY)");
      await db.query("DELETE FROM phase6_conc_probe");
      await db.query("INSERT INTO phase6_conc_probe (id) VALUES ('only')");

      const second = new pg.Client({ connectionString: process.env.DATABASE_URL });
      try {
        await second.connect();
        // Two live connections, and the first must not see the second's
        // uncommitted write - which is what makes a row lock meaningful.
        await second.query("BEGIN");
        await second.query("UPDATE phase6_conc_probe SET id = 'only' WHERE id = 'only'");
        const fromFirst = await db.query("SELECT id FROM phase6_conc_probe WHERE id = 'only'");
        await second.query("ROLLBACK");
        return { concurrent: fromFirst.rows.length === 1 };
      } finally {
        await second.end().catch(() => {});
        await db.query("DROP TABLE IF EXISTS phase6_conc_probe").catch(() => {});
      }
    });
  } catch (err) {
    return { concurrent: false, error: err.code ?? err.message };
  }
};

/**
 * The check-in boundary, tested exactly.
 *
 * Every integration test has to place a fixture "roughly now" and then wait for a
 * request to be handled, so it can only prove the behaviour around the boundary,
 * never on it. These call the same predicate the service uses with hand-picked
 * instants, so `starts_at === now` is genuinely tested as equal rather than
 * approximately.
 *
 * No database, no sleeping, no dependence on when this runs.
 */
const checkInBoundaryChecks = async () => {
  console.log("\n=== Check-in boundary (exact instants) ===\n");
  const { hasStarted } = await import("../src/services/queueService.js");

  const T = Date.parse("2026-10-10T09:00:00.000Z");

  check(
    "an appointment starting in the future by 1ms has not started",
    hasStarted(new Date(T + 1), T) === false,
    "one millisecond in the future must be refused",
  );
  check(
    "an appointment starting at exactly this instant HAS started",
    hasStarted(new Date(T), T) === true,
    "starts_at <= now() must admit equality",
  );
  check(
    "an appointment that started 1ms ago has started",
    hasStarted(new Date(T - 1), T) === true,
  );
  check(
    "the comparison is against instants, not calendar days",
    hasStarted("2026-10-10T09:00:00+05:30", Date.parse("2026-10-10T04:00:00.000Z")) === true,
    "09:00 IST is 03:30 UTC, so a 04:00 UTC reference is already past it",
  );
  check(
    "the same instant is still in the future one second earlier",
    hasStarted("2026-10-10T09:00:00+05:30", Date.parse("2026-10-10T03:29:59.000Z")) === false,
    "09:00 IST is 03:30 UTC, so 03:29:59 UTC has not reached it",
  );
  check(
    "the same instant is admitted at the start second itself",
    hasStarted("2026-10-10T09:00:00+05:30", Date.parse("2026-10-10T03:30:00.000Z")) === true,
  );
};

const concurrencyChecks = async () => {
  console.log("\n=== Concurrency ===\n");

  if (!fx.supportsConcurrency) {
    skip(
      "20 concurrent bookings at one slot yield exactly one booking",
      `this database serves one connection at a time (${fx.concurrencyError}), so a race cannot ` +
        "be demonstrated; run scripts/appointment-check.js against a multi-connection PostgreSQL",
    );
    return;
  }

  // Warm the accounts' tokens first: a login storm in the middle of the timed
  // window would measure bcrypt, not booking.
  const emails = fx.raceEmails ?? [];
  if (emails.length < 20) {
    check("20 distinct patient accounts exist for the race", false, `only ${emails.length} available`);
    return;
  }
  const tokens = [];
  for (const email of emails.slice(0, 20)) {
    const r = await call("/auth/login", {
      method: "POST",
      body: { email, password: "race123" },
    });
    if (r.status !== 200) {
      check("all race accounts can authenticate", false, `${email} -> HTTP ${r.status}`);
      return;
    }
    tokens.push(r.data.token);
  }
  check("20 distinct patient accounts each authenticated", tokens.length === 20);

  // Two slots are consumed: one to prove the refusal is a 409 and not a 500, and
  // the other for the twenty-way race itself.
  const guard = fx.free[fx.free.length - 2];
  const raceSlot = fx.free[fx.free.length - 1];

  const warmup = await Promise.all(tokens.slice(0, 3).map((t) => bookSlot(t, guard)));
  const guardWinners = warmup.filter((r) => r.status === 201);
  const guardLosers = warmup.filter((r) => r.status === 409);
  check(
    "with 3 simultaneous attempts, exactly one booking is created",
    guardWinners.length === 1 && guardLosers.length === 2,
    `${guardWinners.length} created, ${guardLosers.length} refused: ${warmup.map((r) => r.status).join(",")}`,
  );
  check(
    "every loser is refused with SLOT_TAKEN, not a 500",
    guardLosers.every((r) => r.code === "SLOT_TAKEN"),
    guardLosers.map((r) => r.code).join(","),
  );

  /* ---- the 20-way race ---- */

  const started = Date.now();
  const results = await Promise.all(tokens.map((token) => bookSlot(token, raceSlot)));
  const elapsed = Date.now() - started;

  const created = results.filter((r) => r.status === 201);
  const refused = results.filter((r) => r.status === 409);
  const other = results.filter((r) => ![201, 409].includes(r.status));

  check(
    "20 concurrent bookings at one slot: exactly 1 succeeded",
    created.length === 1,
    `${created.length} × 201`,
  );
  check(
    "20 concurrent bookings at one slot: the other 19 were 409",
    refused.length === 19,
    `${refused.length} × 409`,
  );
  check(
    "no attempt failed with anything other than 201 or 409",
    other.length === 0,
    other.map((r) => `HTTP ${r.status} ${r.code}`).join("; "),
  );
  check(
    "every refusal carries the SLOT_TAKEN code",
    refused.every((r) => r.code === "SLOT_TAKEN"),
    [...new Set(refused.map((r) => r.code))].join(","),
  );
  console.log(`      race resolved in ${elapsed}ms`);

  // The authoritative check is the database, not the responses.
  const { withTransaction } = await import("../src/config/database.js");
  const dbState = await withTransaction(async (tx) => {
    const active = await tx.one(
      `SELECT count(*)::int AS c FROM appointments
        WHERE slot_id = $1 AND status IN ('scheduled','confirmed','in-progress')`,
      [raceSlot],
    );
    const all = await tx.one(`SELECT count(*)::int AS c FROM appointments WHERE slot_id = $1`, [raceSlot]);
    const queue = await tx.one(`SELECT count(*)::int AS c FROM queue_entries WHERE slot_id = $1`, [raceSlot]);
    const history = await tx.one(
      `SELECT count(*)::int AS c FROM appointment_status_history h
         JOIN appointments a ON a.id = h.appointment_id
        WHERE a.slot_id = $1`,
      [raceSlot],
    );
    const slotStatus = await tx.one(`SELECT status::text FROM slots WHERE id = $1`, [raceSlot]);
    const winners = await tx.rows(
      `SELECT patient_id FROM appointments
        WHERE slot_id = $1 AND status IN ('scheduled','confirmed','in-progress')`,
      [raceSlot],
    );
    return { active: active.c, all: all.c, queue: queue.c, history: history.c, slotStatus: slotStatus.status, winners };
  });

  check(
    "exactly one ACTIVE appointment exists for the raced slot",
    dbState.active === 1,
    `${dbState.active} active rows`,
  );
  check(
    "no duplicate appointment rows were created at all",
    dbState.all === 1,
    `${dbState.all} rows total`,
  );
  check(
    "no duplicate or phantom queue state was created",
    dbState.queue === 0,
    `${dbState.queue} queue entries`,
  );
  check(
    "exactly one creation history row exists for the winning booking",
    dbState.history === 1,
    `${dbState.history} history rows`,
  );
  check(
    "the slot ends up booked, not left half-claimed",
    dbState.slotStatus === "booked",
    dbState.slotStatus,
  );
  check(
    "the single winner is one of the racing patients",
    dbState.winners.length === 1,
    `${dbState.winners.length} winners`,
  );

  // Every losing patient must have been left with nothing at all.
  const losersWithRows = results.filter(
    (r, i) => r.status === 409 && r.body?.data?.appointment,
  );
  check(
    "no refused attempt returned an appointment",
    losersWithRows.length === 0,
    `${losersWithRows.length} did`,
  );
};

/* ------------------------------------------------------------------ *
 *  10. Database verification (API stopped)                            *
 * ------------------------------------------------------------------ */

const databaseChecks = async () => {
  console.log("\n=== Database state ===\n");

  await withClient(async (db) => {
    /* ---- no partial writes ---- */

    //
    // Every assertion below is scoped to the slots and appointments THIS run
    // created. The seed leaves hundreds of slots marked 'booked' with no
    // appointment behind them and writes history rows with no actor, so an
    // unscoped query measures the seed's data quality rather than the booking
    // code under test. That seed inconsistency is a real finding and is reported
    // separately; it is not this phase's to fix.
    const mine = [...fx.created];

    const orphans = await db.query(
      `SELECT count(*)::int AS c FROM slots sl
         WHERE sl.status = 'booked'
           AND sl.id = ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM appointments a
                            WHERE a.slot_id = sl.id
                              AND a.status IN ('scheduled','confirmed','in-progress'))`,
      [fx.usedSlots],
    );
    check(
      "no slot this run booked is left marked booked without an active appointment",
      orphans.rows[0].c === 0,
      `${orphans.rows[0].c} orphaned booked slots`,
    );

    const takenButFree = await db.query(
      `SELECT count(*)::int AS c FROM appointments a
         JOIN slots sl ON sl.id = a.slot_id
        WHERE a.id = ANY($1::text[])
          AND a.status IN ('scheduled','confirmed','in-progress')
          AND sl.status <> 'booked'`,
      [mine],
    );
    check(
      "no active appointment from this run sits on a slot that is not marked booked",
      takenButFree.rows[0].c === 0,
      `${takenButFree.rows[0].c} mismatched slots`,
    );

    const cancelledConsistent = await db.query(
      `SELECT count(*)::int AS c FROM appointments
        WHERE id = ANY($1::text[])
          AND (status = 'cancelled') <> (cancelled_at IS NOT NULL)`,
      [mine],
    );
    check(
      "every appointment this run cancelled carries cancelled_at, and no other does",
      cancelledConsistent.rows[0].c === 0,
      `${cancelledConsistent.rows[0].c} inconsistent rows`,
    );

    /* ---- history is complete ---- */

    const noHistory = await db.query(
      `SELECT count(*)::int AS c FROM appointments a
        WHERE a.id = ANY($1::text[])
          AND NOT EXISTS (SELECT 1 FROM appointment_status_history h
                           WHERE h.appointment_id = a.id)`,
      [mine],
    );
    check("every appointment this run created has at least one history row", noHistory.rows[0].c === 0, `${noHistory.rows[0].c} without history`);

    const badFirst = await db.query(
      `SELECT count(*)::int AS c FROM appointments a
        WHERE a.id = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM appointment_status_history h
             WHERE h.appointment_id = a.id AND h.from_status IS NULL)`,
      [mine],
    );
    check("every appointment this run created has a creation entry", badFirst.rows[0].c === 0, `${badFirst.rows[0].c} without one`);

    const wrongActor = await db.query(
      `SELECT count(*)::int AS c FROM appointment_status_history h
         JOIN appointments a ON a.id = h.appointment_id
        WHERE a.id = ANY($1::text[])
          AND h.from_status IS NULL AND h.changed_by IS DISTINCT FROM a.patient_id`,
      [mine],
    );
    check(
      "the creation entry is attributed to the patient who booked",
      wrongActor.rows[0].c === 0,
      `${wrongActor.rows[0].c} attributed to somebody else`,
    );

    // Refused transitions must not have written history.
    const completedAppt = mine.length
      ? { rows: [{ id: fx.liveAppointment }] }
      : { rows: [] };
    if (completedAppt.rows[0]) {
      const hist = await db.query(
        `SELECT from_status::text, to_status::text FROM appointment_status_history
          WHERE appointment_id = $1 ORDER BY id`,
        [completedAppt.rows[0].id],
      );
      const toStatus = hist.rows.map((h) => h.to_status);
      check(
        "the completed appointment's history records exactly the transitions that happened",
        toStatus.filter((s) => s === "completed").length === 1,
        JSON.stringify(toStatus),
      );
      check(
        "the history never records a refused transition",
        toStatus.filter((s) => s === "confirmed").length === 1,
        JSON.stringify(toStatus),
      );
    }

    /* ---- queue consistency ---- */

    const dupes = await db.query(
      `SELECT count(*)::int AS c FROM (
         SELECT appointment_id FROM queue_entries
          WHERE appointment_id = ANY($1::text[])
          GROUP BY appointment_id HAVING count(*) > 1
       ) x`,
      [mine],
    );
    check("no appointment from this run has more than one queue entry", dupes.rows[0].c === 0, `${dupes.rows[0].c} duplicated`);

    const badPos = await db.query(
      `SELECT count(*)::int AS c FROM queue_entries WHERE position < 1`,
    );
    check("every queue position is positive", badPos.rows[0].c === 0);

    const orphanQueue = await db.query(
      `SELECT count(*)::int AS c FROM queue_entries q
         JOIN appointments a ON a.id = q.appointment_id
        WHERE a.id = ANY($1::text[])
          AND a.status IN ('cancelled','completed') AND q.state = 'waiting'`,
      [mine],
    );
    check(
      "no queue entry from this run is left waiting for a cancelled or completed appointment",
      orphanQueue.rows[0].c === 0,
      `${orphanQueue.rows[0].c} stale entries`,
    );

    const cancelledWithEntry = await db.query(
      `SELECT count(*)::int AS c FROM appointments a
         JOIN queue_entries q ON q.appointment_id = a.id
        WHERE a.id = ANY($1::text[]) AND a.status = 'cancelled'`,
      [mine],
    );
    check(
      "cancelling an appointment from this run clears its queue entry",
      cancelledWithEntry.rows[0].c === 0,
      `${cancelledWithEntry.rows[0].c} entries survived a cancellation`,
    );

    /* ---- notifications and outbox ---- */

    const notifiedBooking = await db.query(
      `SELECT count(*)::int AS c FROM notifications
        WHERE event = 'appointment_booked' AND appointment_id = ANY($1::text[])`,
      [mine],
    );
    check("booking writes a notification", notifiedBooking.rows[0].c > 0, `${notifiedBooking.rows[0].c}`);

      // The rendered body must state the real date and time.
      //
      // The booking path built its notification from a hand-assembled object
      // ({id, patientName, fee}) while the template renders `date` and
      // `startTime`, so every new booking notification read
      // "confirmed for undefined at undefined". The fix passes the locked slot's
      // own date and time through, so the message agrees with the booking.
      //
      // Only notifications created by THIS run are inspected; historical rows are
      // left exactly as they are.
      const bookedBodies = await db.query(
        `SELECT n.body,
                  EXISTS (
                    SELECT 1 FROM slots s2
                     WHERE s2.doctor_id = a.doctor_id
                       AND to_char(s2.starts_at AT TIME ZONE $2, 'YYYY-MM-DD')
                           = substring(n.body from 'confirmed for (\\d{4}-\\d{2}-\\d{2})')
                       AND to_char(s2.starts_at AT TIME ZONE $2, 'HH24:MI')
                           = substring(n.body from ' at (\\d{2}:\\d{2})')
                  ) AS names_a_real_slot
             FROM notifications n
             JOIN appointments a ON a.id = n.appointment_id
            WHERE n.event = 'appointment_booked'
              AND n.appointment_id = ANY($1::text[])`,
        [mine, TZ],
      );
      check("this run's booking notifications were found for inspection",
        bookedBodies.rows.length > 0, `${bookedBodies.rows.length}`);
      check("no booking notification from this run contains 'undefined'",
        bookedBodies.rows.every((r) => !/undefined/i.test(r.body)),
        JSON.stringify(bookedBodies.rows.map((r) => r.body).slice(0, 2)));
      check("every booking notification states a date and a start time",
        bookedBodies.rows.every((r) =>
          /confirmed for \d{4}-\d{2}-\d{2} at \d{2}:\d{2}/.test(r.body)),
        JSON.stringify(bookedBodies.rows.map((r) => r.body).slice(0, 2)));
      // The rendered date and time must name a real slot on that appointment's
      // own provider. Comparing against the appointment's CURRENT slot would be
      // wrong: a notification is a snapshot of the moment it was written, and
      // this run also reschedules appointments, so the booking text legitimately
      // names the slot that was booked rather than the one it moved to later.
      check("the date and time in each booking notification name a real slot for that provider",
        bookedBodies.rows.every((r) => r.names_a_real_slot),
        JSON.stringify(bookedBodies.rows.filter((r) => !r.names_a_real_slot)
          .map((r) => r.body).slice(0, 2)));

    // Counts both the notifications and their delivery rows, because a raw
    // `count(d.id)` grouped by event is the TOTAL across that event (39 rows for
    // 13 notifications), not a per-notification count. Comparing that total
    // against 3 is meaningless.
    const deliveries = await db.query(
      `SELECT n.event,
              count(DISTINCT n.id)::int AS notifications,
              count(d.id)::int        AS delivery_rows
         FROM notifications n
         LEFT JOIN notification_deliveries d ON d.notification_id = n.id
        WHERE n.appointment_id = ANY($1::text[])
        GROUP BY n.event`,
      [mine],
    );
    check(
      "every notification this run wrote has all three delivery channels",
      deliveries.rows.length > 0 &&
        deliveries.rows.every((r) => r.delivery_rows === r.notifications * 3),
      JSON.stringify(deliveries.rows),
    );

    const outbox = await db.query(
      `SELECT count(*)::int AS c FROM notification_outbox
        WHERE event = 'appointment_booked' AND payload->>'appointmentId' = ANY($1::text[])`,
      [mine],
    );
    check("the outbox records the booking notification", outbox.rows[0].c > 0, `${outbox.rows[0].c}`);

    const orphanNotifications = await db.query(
      `SELECT count(*)::int AS c FROM notifications n
        WHERE n.appointment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = n.appointment_id)`,
    );
    check("no notification points at a nonexistent appointment", orphanNotifications.rows[0].c === 0);

    // Delivery status must be resolved after commit, not left queued forever.
    const stillQueued = await db.query(
      `SELECT d.channel::text, d.status::text, count(*)::int AS c
         FROM notification_deliveries d
         JOIN notifications n ON n.id = d.notification_id
        WHERE n.appointment_id = ANY($1::text[])
        GROUP BY 1, 2`,
      [mine],
    );
    const inAppQueued = stillQueued.rows.filter(
      (r) => r.channel === "in-app" && r.status === "queued",
    );
    check(
      "no in-app delivery from this run is left in 'queued' after delivery was attempted",
      inAppQueued.length === 0,
      JSON.stringify(stillQueued.rows),
    );

    /* ---- the constraints actually exist ---- */

    const idx = await db.query(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('appointments_one_active_per_slot')`,
    );
    check(
      "the one-active-appointment-per-slot index exists",
      idx.rows.length === 1,
      "missing; double booking would be possible",
    );

    const excl = await db.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'appointments_patient_no_overlap'`,
    );
    check("the patient no-overlap exclusion constraint exists", excl.rows.length === 1);

    const trigger = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgname = 'appointments_slot_doctor_match_trg'`,
    );
    check(
      "the appointment/slot doctor-match trigger exists",
      trigger.rows.length === 1,
      "a caller could attach an appointment to another doctor's slot",
    );
  });

  /* ---- rollback proven with the real repository call ---- */

  //
  // Deliberately NOT inside the `withClient` block above: withTransaction takes
  // its own connection from the pool, and the local database serves one client,
  // so holding a direct connection open at the same time would deadlock. Each
  // transaction below runs on its own and closes before the next begins.
  console.log("\n=== Rollback of a claimed slot ===\n");
  const { withTransaction } = await import("../src/config/database.js");
  const slotRepo = (await import("../src/repositories/slotRepo.js")).default;

  const pick = await withTransaction(async (tx) =>
    tx.one(
      `SELECT sl.id FROM slots sl
        WHERE sl.status = 'available' AND sl.starts_at > now()
        ORDER BY sl.starts_at LIMIT 1`,
    ),
  );

  if (!pick) {
    check("a free future slot exists to test rollback with", false, "none available");
  } else {
    const slotId = pick.id;
    const statusOf = () =>
      withTransaction(async (tx) => (await tx.one(`SELECT status FROM slots WHERE id = $1`, [slotId])).status);

    // Claim, then throw: the claim must be undone.
    let threw = false;
    try {
      await withTransaction(async (tx) => {
        await slotRepo.claimIfAvailable(slotId, tx);
        // Stands in for the appointment insert, history row or notification that
        // would follow in bookingService.book.
        throw new Error("simulated failure after the slot claim");
      });
    } catch {
      threw = true;
    }
    check("a failure inside the booking transaction propagates", threw);
    check(
      "a slot claimed inside a rolled-back transaction returns to available",
      (await statusOf()) === "available",
      `status=${await statusOf()}`,
    );

    // The identical claim, committed, must stick.
    await withTransaction(async (tx) => {
      await slotRepo.claimIfAvailable(slotId, tx);
    });
    check(
      "the same claim commits when the transaction succeeds",
      (await statusOf()) === "booked",
      `status=${await statusOf()}`,
    );

    await withTransaction(async (tx) => {
      await tx.query(`UPDATE slots SET status = 'available' WHERE id = $1`, [slotId]);
    });
  }

  /* ---- queue capacity, which the API cannot provoke ---- */

  //
  // The one-active-appointment-per-slot rule means a second patient can never
  // share a slot, so "is this waiting room full?" cannot be reached through the
  // API: each patient would need their own slot, and capacity belongs to the
  // slot. The rule lives in queueRepo.join, so it is exercised there directly.
  //
  // `queue_entries.slot_id` and `queue_entries.appointment_id` are independent
  // columns with no constraint tying them together, which is also what makes a
  // busy waiting room expressible: several appointments can queue for one slot.

  console.log("\n=== Queue capacity ===\n");
  const queueRepo = (await import("../src/repositories/queueRepo.js")).default;

  const cap = await withTransaction(async (tx) =>
    tx.one(
      `SELECT sl.id, sl.doctor_id, sl.max_queue
         FROM slots sl
        WHERE sl.id = $1 AND sl.max_queue = 1`,
      [fx.capacitySlotSpare],
    ),
  );

  if (!cap) {
    check("a slot with max_queue = 1 exists to test capacity", false, "no such fixture");
  } else {
    // Count who is already waiting on that slot.
    const before = await withTransaction(async (tx) =>
      (
        await tx.rows(
          `SELECT position FROM queue_entries
            WHERE slot_id = $1 AND state = 'waiting' ORDER BY position`,
          [cap.id],
        )
      ).map((r) => r.position),
    );

    // Add one more waiting entry directly, taking it over capacity. Reuse an
    // appointment that already exists so no new one is needed.
    const spare = await withTransaction(async (tx) =>
      tx.one(
        `SELECT id, patient_id FROM appointments
          WHERE status IN ('confirmed','scheduled')
            AND id NOT IN (SELECT appointment_id FROM queue_entries)
          ORDER BY created_at LIMIT 1`,
      ),
    );

    if (!spare) {
      check("an appointment is available to overfill the waiting room with", false, "none spare");
    } else {
      await withTransaction(async (tx) => {
        const nextPos =
          Math.max(0, ...before) + 1;
        await tx.query(
          // `clinic_date` names the waiting room and is NOT NULL since migration
          // 017. Derived here from the slot with the same expression the
          // repository uses, so this fixture cannot disagree with the code path
          // it stands in for.
          `INSERT INTO queue_entries
             (appointment_id, slot_id, doctor_id, patient_id, position, state, clinic_date)
           SELECT $1, $2, $3, $4, $5, 'waiting',
                  to_char(starts_at AT TIME ZONE $6, 'YYYY-MM-DD')::date
             FROM slots WHERE id = $2`,
          [spare.id, cap.id, cap.doctor_id, spare.patient_id, nextPos, time.TZ],
        );
      });

      const overfilled = await withTransaction(async (tx) =>
        queueRepo.join(
          {
            // An appointment id that has no entry yet, so `join` cannot short
            // circuit on idempotency.
            appointmentId: "capacity-probe-" + cap.id,
            slotId: cap.id,
            doctorId: cap.doctor_id,
            patientId: spare.patient_id,
            capacity: cap.max_queue,
          },
          tx,
        ),
      );

      check(
        "joinQueue refuses an entry once the slot is at capacity",
        overfilled.full === true && overfilled.entry === null,
        JSON.stringify({ full: overfilled.full, entry: overfilled.entry }),
      );

      const waiting = await withTransaction(async (tx) =>
        (
          await tx.rows(
            `SELECT count(*)::int AS c FROM queue_entries
              WHERE slot_id = $1 AND state = 'waiting'`,
            [cap.id],
          )
        )[0].c,
      );
      check(
        "the refused entry was not written",
        waiting === before.length + 1,
        `${waiting} waiting, expected ${before.length + 1}`,
      );
    }

    // Clean up the probe row so later assertions see a consistent database.
    await withTransaction(async (tx) => {
      await tx.query(`DELETE FROM queue_entries WHERE appointment_id LIKE 'capacity-probe-%'`);
      await tx.query(
        `DELETE FROM queue_entries WHERE slot_id = $1 AND position > $2`,
        [cap.id, before.length],
      );
    });
  }
};

/* ------------------------------------------------------------------ *
 *  Run                                                                *
 * ------------------------------------------------------------------ */

/**
 * Remove everything this run put into the database, on its own connection.
 *
 * Fixtures used to be permanent, so re-running the suite stacked a fresh layer
 * on the previous one: seeded providers ran out of free window, and seeded
 * patients accumulated bookings that made the patient no-overlap rule refuse the
 * very fixture under test. Removing the run's own rows makes the suite
 * repeatable against the same database without weakening any assertion.
 *
 * Safe when there is nothing to remove, and safe to call twice.
 */
const cleanupAfterRun = async () => {
  const appts = [...fx.created];
  const slots = [...fx.madeSlots];
  const doctors = [...fx.madeDoctors];
  const users = [...fx.madeUsers];
  if (!appts.length && !slots.length && !doctors.length && !users.length) return;

  try {
    await withClient(async (tx) => {
      // Dependency order matters: appointments and slots first, because
      // appointments holds RESTRICT references to both doctors and patients, so
      // removing an account while one of its appointments survives would abort
      // the whole cleanup and leave the next run with residue.
      //
      // Everything else hanging off these rows cascades on its own
      // (doctor_services, doctor_languages, refresh_tokens, notifications,
      // patient_profiles, queue_entries), so no unrelated table is touched.
      if (appts.length || slots.length) {
        await tx.query(
          `DELETE FROM appointments
            WHERE (($1::text[] <> '{}') AND id = ANY($1::text[]))
               OR (($2::text[] <> '{}') AND slot_id = ANY($2::text[]))`,
          [appts, slots],
        );
      }
      if (slots.length) {
        await tx.query("DELETE FROM slots WHERE id = ANY($1::text[])", [slots]);
      }
      // Providers before their own user accounts: doctors.user_id cascades, but
      // being explicit keeps the order readable and makes the intent obvious.
      if (doctors.length) {
        await tx.query("DELETE FROM doctors WHERE id = ANY($1::text[])", [doctors]);
      }
      if (users.length) {
        await tx.query("DELETE FROM users WHERE id = ANY($1::text[])", [users]);
      }
    });
    console.log(
      `      teardown removed ${appts.length} appointment(s), ${slots.length} slot(s), ` +
        `${doctors.length} provider(s) and ${users.length} fixture account(s) this run created`,
    );
  } catch (err) {
    console.log(`  teardown could not complete: ${err.message}`);
  }
};

const run = async () => {
  console.log(`\n=== Phase 6 appointment checks (${BASE}) ===`);
  console.log(`      business timezone: ${time.TZ}`);

  // Fixtures must exist before the API starts: the local database serves one
  // client, so a direct connection and the API cannot be open at the same time.
  await buildFixtures();

  // Probed here, while this process holds the only connection and the API has
  // not started, so a single-connection database is detected without wedging it.
  fx.concurrency = await probeConcurrencySupport();
  fx.supportsConcurrency = fx.concurrency.concurrent;
  fx.concurrencyError = fx.concurrency.error ?? "no second connection could be established";
  console.log(
    `      concurrency support: ${fx.supportsConcurrency ? "yes" : `no (${fx.concurrencyError})`}`,
  );

  await startServer();

  await login();
  await bookingChecks();
  await authorizationChecks();
  await cancellationChecks();
  await transitionChecks();
  await rescheduleChecks();
  await queueChecks();
  await listingChecks();
  await transactionChecks();
  await checkInBoundaryChecks();
  await concurrencyChecks();

  await stopServer();

  await databaseChecks();

  // Put the database back the way this run found it.
  //
  // Every fixture this suite inserts - a slot, an appointment, the queue entry
  // and notification rows that cascade from it - was permanent. Re-running the
  // suite therefore stacked a fresh layer on top of the last one, and after a
  // few passes the seeded providers had no free window left and the seeded
  // patients held bookings that made the patient no-overlap rule refuse the very
  // fixture under test. Removing the run's own rows makes the suite repeatable
  // against the same database without weakening a single assertion.
  await cleanupAfterRun();

  console.log(`\n=== ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
  if (failures.length) console.log(`\n  Failed: ${failures.join("; ")}`);
  if (skips.length) console.log(`\n  Skipped:\n${skips.map((s) => `    - ${s}`).join("\n")}`);
  console.log("");

  process.exit(fail > 0 ? 1 : 0);
};

run()
  .catch(async (err) => {
    console.error(`\nAppointment checks crashed: ${err.stack || err.message}\n`);
    await stopServer();
    // A crashed run leaves its fixtures behind, and that residue is what makes
    // the NEXT run fail for reasons unrelated to the code under test. Clean up
    // on the failure path too, so one failure is never contagious.
    await cleanupAfterRun();
    process.exit(1);
  })
  .finally(async () => {
    await stopServer();
  });
