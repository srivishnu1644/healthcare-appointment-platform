#!/usr/bin/env node
/**
 * Phase 10 — notifications.
 *
 * Covers the things that are easy to get quietly wrong:
 *
 *   * every supported event actually produces a message, addressed to the RIGHT
 *     person - a queue notification sent to the doctor would be a privacy bug,
 *     not a cosmetic one;
 *   * a caller can read only their own notifications, and marking somebody
 *     else's read is impossible rather than merely discouraged;
 *   * a retried or concurrent request produces ONE message, proven under real
 *     concurrency rather than by calling the service twice in a row;
 *   * reminders fire once, and a rescheduled appointment is reminded about again;
 *   * the background passes record what they did, and the drain settles its work.
 *
 * Deterministic: it builds its own fixtures and controls the clock through the
 * database rather than waiting for a slot to arrive.
 *
 *   node scripts/notification-check.js
 */
import { query, one, closePool } from "../src/config/database.js";
import * as time from "../src/utils/time.js";

const API = process.env.API_URL || "http://localhost:5000/api";

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ""}`);
  }
};

const call = async (path, { method = "GET", token, body, raw = false } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, ...(raw ? { headers: res.headers } : {}), data: json?.data, json, code: json?.error?.code };
};

const login = async (email, password) =>
  (await call("/auth/login", { method: "POST", body: { email, password } })).data;

const codeOf = (r) => r.json?.error?.code ?? null;

/** Rows for one user, newest first - the same shape the endpoint returns. */
const rowsFor = async (userId) =>
  (
    await query(
      "SELECT id, event, title, body, read_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    )
  ).rows;

const eventsFor = async (userId, event) =>
  (await rowsFor(userId)).filter((n) => n.event === event);

const tokenOf = async (email, password = "doctor123") => (await login(email, password)).token;
const patientToken = async (email) => (await login(email, "patient123")).token;

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Fixtures are written straight to the database rather than through the API.
 *
 * Public registration only ever creates a PATIENT - doctor accounts are
 * provisioned by an admin - so there is no endpoint that would make a provider
 * for this suite to use. This is the same approach the booking and room suites
 * take, for the same reason.
 */
const madeUsers = new Set();
const madeDoctors = new Set();

async function makeFixtureUser(role, tag) {
  const { hashPassword } = await import("../src/utils/password.js");
  const email = `notify-${tag}-${RUN_ID}@phase10.test`;
  const u = await query(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [
      email,
      await hashPassword("test12345"),
      role,
      `${role === "doctor" ? "Dr. " : ""}Notify ${tag}`,
      `+9192${RUN_ID.slice(-6)}${String(madeUsers.size).padStart(2, "0")}`,
    ],
  );
  madeUsers.add(u.rows[0].id);
  return { id: u.rows[0].id, email, password: "test12345" };
}

async function makeFixtureDoctor(tag) {
  const user = await makeFixtureUser("doctor", tag);
  const specialty = await query("SELECT id FROM specialties ORDER BY slug LIMIT 1");
  const facility = await query("SELECT id FROM facilities ORDER BY name LIMIT 1");
  const d = await query(
    `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee,
                          experience_years, seed_rating, seed_review_count)
     VALUES ($1, $2, $3, 400, 5, 4.5, 10)
     RETURNING id`,
    [user.id, specialty.rows[0].id, facility.rows[0].id],
  );
  madeDoctors.add(d.rows[0].id);
  const token = (await login(user.email, user.password)).token;
  return { email: user.email, userId: user.id, token, doctorId: d.rows[0].id };
}

/**
 * Two slots at controlled instants: one that has already started (so check-in
 * is allowed) and one far ahead (so a reminder is due). Inserted directly, so
 * the suite never depends on what the seed left on the calendar.
 */
async function makeSlots(doctorId, facilityId, offsetHours = 20) {
  const specialty = await query("SELECT id FROM specialties ORDER BY slug LIMIT 1");
  const facility = facilityId
    ? { rows: [{ id: facilityId }] }
    : await query("SELECT id FROM facilities ORDER BY name LIMIT 1");
  const insert = async (at) => {
    const r = await query(
      `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, mode, status,
                          fee, max_queue)
       VALUES ($1, $2, $3, $4, 'in-person', 'available', 400, 5)
       RETURNING id`,
      [
        doctorId,
        facility.rows[0].id,
        at.toISOString(),
        new Date(at.getTime() + 30 * 60 * 1000).toISOString(),
      ],
    );
    return {
      id: r.rows[0].id,
      startTime: time.localTime(at.toISOString()),
      date: time.localDate(at.toISOString()),
    };
  };
  return {
    startedSlot: await insert(new Date(Date.now() - 30 * 60 * 1000)),
    // Offset per fixture: the suite's single patient holds one appointment per
    // fixture doctor, and two at the same instant would be refused by the real
    // overlap rule - which would read as a suite failure rather than the clash it
    // actually is.
    futureSlot: await insert(new Date(Date.now() + offsetHours * 60 * 60 * 1000)),
    // A second future slot on the SAME doctor, because an appointment can only be
    // rescheduled onto a slot its own provider owns. Rescheduling onto another
    // doctor's slot is correctly refused, which would make this a test of the
    // wrong rule entirely.
    futureSlot2: await insert(new Date(Date.now() + (offsetHours + 12) * 60 * 60 * 1000)),
  };
}

async function dropFixtures() {
  // Appointments first: they reference both the slot and the user, so deleting
  // either side first trips a foreign key and leaves the fixtures behind for the
  // next run to trip over.
  for (const id of madeDoctors) {
    await query("DELETE FROM appointments WHERE doctor_id = $1", [id]).catch(() => {});
  }
  for (const id of madeUsers) {
    await query("DELETE FROM appointments WHERE patient_id = $1", [id]).catch(() => {});
    await query("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => {});
  }
  for (const id of madeDoctors) {
    await query("DELETE FROM slots WHERE doctor_id = $1", [id]).catch(() => {});
    await query("DELETE FROM doctors WHERE id = $1", [id]).catch(() => {});
  }
  await query("DELETE FROM users WHERE email LIKE 'notify-%@phase10.test'").catch(() => {});
}

const run = async () => {
  /* ---------------------------------------------------------------- *
   * 1. Every supported event                                         *
   * ---------------------------------------------------------------- */
  // A fixture patient and a fixture doctor, both written directly: public
  // registration only creates patients, and this suite needs a provider too.
  const pUser = await makeFixtureUser("patient", "patient");
  const pt = (await login(pUser.email, pUser.password)).token;
  const ptId = pUser.id;
  const ptMe = (await call("/auth/me", { token: pt })).data;

  const doc = await makeFixtureDoctor("events");
  const slots = await makeSlots(doc.doctorId);

  const booked = await call("/appointments", {
    method: "POST",
    token: pt,
    body: { doctorId: doc.doctorId, slotId: slots.futureSlot.id },
  });
  const apptId = booked.data?.appointment?.id;
  check("the appointment was booked", booked.status === 201, `HTTP ${booked.status}`);
  check(
    "booking produced exactly one confirmation",
    (await eventsFor(ptId, "appointment_booked")).length === 1,
    `${(await eventsFor(ptId, "appointment_booked")).length} confirmation(s)`,
  );

  // The confirmation must reach the PATIENT, and must not reach the doctor.
  check(
    "the booking confirmation went to the patient",
    (await rowsFor(ptId)).some((n) => n.event === "appointment_booked"),
    "patient has no confirmation",
  );
  const doctorId = doc.doctorId;
  const doctorUserId = (await call("/auth/me", { token: doc.token })).data.user.id;
  check(
    "the doctor received nobody else's appointment details",
    (await rowsFor(doctorUserId)).every(
      (n) => !n.body.includes(ptMe.user.fullName),
    ),
    "a notification containing the patient's name was addressed to the doctor",
  );

  const resched = await call(`/appointments/${apptId}/reschedule`, {
    method: "PATCH",
    token: pt,
    body: { slotId: slots.startedSlot.id },
  });
  check("the appointment was rescheduled", resched.status === 200, `HTTP ${resched.status}`);
  check(
    "rescheduling produced a reschedule message",
    (await eventsFor(ptId, "appointment_rescheduled")).length === 1,
    `${(await eventsFor(ptId, "appointment_rescheduled")).length}`,
  );

  const checkedIn = await call(`/appointments/${apptId}/check-in`, { method: "POST", token: pt });
  check("check-in succeeded", checkedIn.status === 200, `HTTP ${checkedIn.status}`);
  check(
    "check-in produced a checked-in message",
    (await eventsFor(ptId, "appointment_checked_in")).length === 1,
    `${(await eventsFor(ptId, "appointment_checked_in")).length}`,
  );
  const checkInBody = (await eventsFor(ptId, "appointment_checked_in"))[0]?.body ?? "";
  check(
    "the checked-in message states the patient's place in the room",
    /number \d+ in the waiting room/.test(checkInBody),
    checkInBody.slice(0, 120),
  );

  const today = time.localDate(new Date().toISOString());
  const called = await call("/appointments/queue/next", {
    method: "POST",
    token: doc.token,
    body: { doctorId, date: today },
  });
  check("call-next promoted the patient", called.status === 200, `HTTP ${called.status}`);
  check(
    "call-next produced an 'it is your turn' message",
    (await eventsFor(ptId, "queue_called")).length === 1,
    `${(await eventsFor(ptId, "queue_called")).length}`,
  );

  const completed = await call(`/appointments/${apptId}/status`, {
    method: "PATCH",
    token: doc.token,
    body: { status: "completed" },
  });
  check("the visit was completed", completed.status === 200, `HTTP ${completed.status}`);
  check(
    "completion produced a completion message, not a bare status line",
    (await eventsFor(ptId, "appointment_completed")).length === 1,
    `${(await eventsFor(ptId, "appointment_completed")).length}`,
  );

  /* ---------------------------------------------------------------- *
   * 2. Duplicate suppression under real concurrency                   *
   * ---------------------------------------------------------------- */
  const dupDoc = await makeFixtureDoctor("dup");
  const dupSlots = await makeSlots(dupDoc.doctorId, null, 26);

  // The SAME booking request, five times at once, against a slot nobody has
  // booked yet. Exactly one may win: the rest must be refused. This is the race
  // the slot's exclusion rule exists for, and it must not turn into five
  // appointments and five confirmations.
  const racers = await Promise.all(
    Array.from({ length: 5 }, () =>
      call("/appointments", {
        method: "POST",
        token: pt,
        body: { doctorId: dupDoc.doctorId, slotId: dupSlots.futureSlot.id },
      }),
    ),
  );
  const created = racers.filter((r) => r.status === 201);
  const conflicts = racers.filter((r) => r.status === 409);
  const dupAppt = created[0]?.data?.appointment?.id ?? null;
  check(
    "five simultaneous bookings of one slot produce exactly one appointment",
    created.length === 1 && conflicts.length === 4,
    `created=${created.length} conflicts=${conflicts.length} statuses=${racers.map((r) => r.status).join(",")}`,
  );
  const dupRows = (
    await query(
      "SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1",
      [dupSlots.futureSlot.id],
    )
  ).rows[0].n;
  check("and the slot really holds one appointment", dupRows === 1, `rows=${dupRows}`);
  const dupConfirmations = (
    await query(
      `SELECT count(*)::int AS n FROM notifications
        WHERE user_id = $1 AND appointment_id = $2 AND event = 'appointment_booked'`,
      [ptId, dupAppt],
    )
  ).rows[0].n;
  check(
    "and exactly one confirmation message for it",
    dupConfirmations === 1,
    `messages=${dupConfirmations}`,
  );

  // Retrying a request that already succeeded must not add a second message.
  const beforeCount = (await rowsFor(ptId)).length;
  await call(`/appointments/${apptId}/check-in`, { method: "POST", token: pt });
  await call(`/appointments/${apptId}/check-in`, { method: "POST", token: pt });
  check(
    "repeating check-in does not add a second checked-in message",
    (await rowsFor(ptId)).length === beforeCount,
    `${beforeCount} -> ${(await rowsFor(ptId)).length}`,
  );

  /* ---------------------------------------------------------------- *
   * 2b. A duplicate must never undo the change that caused it        *
   * ---------------------------------------------------------------- */
  // The notification is written INSIDE the transaction that books the
  // appointment. In PostgreSQL a failed statement aborts the whole transaction,
  // so a duplicate handled by catching an exception would still roll the booking
  // back on COMMIT - losing a patient's appointment because a message was already
  // there. This forces a genuine collision: the same event is notified twice for
  // one appointment, inside one live transaction.
  const dupeDoc = await makeFixtureDoctor("rollback");
  const dupeSlots = await makeSlots(dupeDoc.doctorId, null, 50);
  const dupeBook = await call("/appointments", {
    method: "POST",
    token: pt,
    body: { doctorId: dupeDoc.doctorId, slotId: dupeSlots.futureSlot.id },
  });
  const dupeAppt = dupeBook.data?.appointment?.id ?? null;
  check("the rollback fixture booked", dupeBook.status === 201, `HTTP ${dupeBook.status}`);

  const { withTransaction } = await import("../src/config/database.js");
  const { enqueueNotifications } = await import("../src/services/notificationService.js");
  const { default: doctorRepo } = await import("../src/repositories/doctorRepo.js");
  const { default: appointmentRepo } = await import("../src/repositories/appointmentRepo.js");
  const dupeApptRow = dupeAppt ? await appointmentRepo.findById(dupeAppt) : null;
  const dupeDoctor = dupeApptRow ? await doctorRepo.findById(dupeApptRow.doctorId) : null;

  let dupeError = null;
  let dupeQueued = null;
  if (dupeApptRow && dupeDoctor) {
    try {
      dupeQueued = await withTransaction(async (tx) => {
        // A real business change first, so there is something to lose.
        await appointmentRepo.updateFields(dupeAppt, { reason: "collision probe" }, tx);
        // Then the same event again for the same appointment: the second insert
        // collides on the dedupe index.
        await enqueueNotifications({
          event: "appointment_booked",
          appointment: dupeApptRow,
          doctor: dupeDoctor,
          facility: null,
          patient: { id: dupeApptRow.patientId, name: dupeApptRow.patientName },
          tx,
        });
        return enqueueNotifications({
          event: "appointment_booked",
          appointment: dupeApptRow,
          doctor: dupeDoctor,
          facility: null,
          patient: { id: dupeApptRow.patientId, name: dupeApptRow.patientName },
          tx,
        });
      });
    } catch (err) {
      dupeError = err;
    }
  }
  check(
    "a duplicate notification does not throw out of the transaction",
    dupeError === null,
    dupeError ? `${dupeError.code ?? ""} ${dupeError.message}` : "",
  );
  check(
    "and is reported as suppressed rather than as a second message",
    Array.isArray(dupeQueued) && dupeQueued.length === 0,
    JSON.stringify(dupeQueued),
  );
  // Read straight from the row rather than through the API projection: the point
  // is whether the TRANSACTION committed, and the projection is not what decides
  // that (and does not carry every column).
  const dupeRaw = dupeAppt
    ? (await query("SELECT status, reason FROM appointments WHERE id = $1", [dupeAppt])).rows[0]
    : null;
  check(
    "the business change in the same transaction still commits",
    dupeRaw?.status === "confirmed" && dupeRaw?.reason === "collision probe",
    `status=${dupeRaw?.status} reason=${dupeRaw?.reason}`,
  );
  const dupeMessages = (
    await query(
      `SELECT count(*)::int AS n FROM notifications
        WHERE appointment_id = $1 AND event = 'appointment_booked'`,
      [dupeAppt],
    )
  ).rows[0].n;
  check(
    "and exactly one confirmation exists for it",
    dupeMessages === 1,
    `messages=${dupeMessages}`,
  );

  /* ---------------------------------------------------------------- *
   * 3. Ownership and privacy                                         *
   * ---------------------------------------------------------------- */
  const mine = await call("/notifications", { token: pt });
  check("a caller can list their own notifications", mine.status === 200, `HTTP ${mine.status}`);
  check(
    "the list contains only notifications addressed to them",
    (mine.data?.notifications ?? []).every((n) => n.userId === ptId),
    `${(mine.data?.notifications ?? []).length} rows`,
  );

  const otherToken = await patientToken("aman@demo.com");
  const otherList = await call("/notifications", { token: otherToken });
  check(
    "another patient sees none of their notifications",
    (otherList.data?.notifications ?? []).every((n) => n.userId !== ptId),
    "a row belonging to someone else was returned",
  );

  const crossRead = await call(`/notifications?patientId=${ptId}`, { token: otherToken });
  check(
    "a patient cannot read another patient's notifications by asking",
    crossRead.status === 403,
    `HTTP ${crossRead.status} ${codeOf(crossRead)}`,
  );

  const ownId = (mine.data?.notifications ?? [])[0]?.id;
  const crossMark = await call(`/notifications/${ownId}/read`, {
    method: "PATCH",
    token: otherToken,
  });
  check(
    "a patient cannot mark somebody else's notification read",
    crossMark.status === 404 || crossMark.status === 403,
    `HTTP ${crossMark.status} ${codeOf(crossMark)}`,
  );
  const stillUnread = (
    await query("SELECT read_at FROM notifications WHERE id = $1", [ownId])
  ).rows[0];
  check(
    "and that attempt left it unread",
    stillUnread?.read_at === null,
    `read_at=${stillUnread?.read_at}`,
  );

  const anonList = await call("/notifications");
  check("an anonymous caller cannot list notifications", anonList.status === 401,
    `HTTP ${anonList.status}`);

  const markOwn = await call(`/notifications/${ownId}/read`, { method: "PATCH", token: pt });
  check("the owner CAN mark their own notification read", markOwn.status === 200,
    `HTTP ${markOwn.status}`);
  const nowRead = (await query("SELECT read_at FROM notifications WHERE id = $1", [ownId]))
    .rows[0];
  check("and it is persisted", nowRead?.read_at !== null, `read_at=${nowRead?.read_at}`);

  const unknownId = await call("/notifications/00000000-0000-0000-0000-000000000000/read", {
    method: "PATCH",
    token: pt,
  });
  check(
    "marking a notification that does not exist is a 404, not a silent success",
    unknownId.status === 404,
    `HTTP ${unknownId.status}`,
  );

  const sweepAttempt = await call("/notifications/reminders/sweep", {
    method: "POST",
    token: pt,
    body: { hours: 24 },
  });
  check("a patient cannot trigger the reminder sweep", sweepAttempt.status === 403,
    `HTTP ${sweepAttempt.status}`);

  /* ---------------------------------------------------------------- *
   * 4. Reminders                                                    *
   * ---------------------------------------------------------------- */
  const remDoc = await makeFixtureDoctor("reminder");
  const remSlots = await makeSlots(remDoc.doctorId, null, 32);
  const remBook = await call("/appointments", {
    method: "POST",
    token: pt,
    body: { doctorId: remDoc.doctorId, slotId: remSlots.futureSlot.id },
  });
  const remAppt = remBook.data?.appointment?.id;
  check("the reminder fixture booked", remBook.status === 201, `HTTP ${remBook.status}`);

  const adminToken = (await login("admin@demo.com", "admin123")).token;
  const sweep1 = await call("/notifications/reminders/sweep", {
    method: "POST",
    token: adminToken,
    body: { hours: 48 },
  });
  check("the sweep ran", sweep1.status === 200, `HTTP ${sweep1.status}`);
  const reminders1 = await eventsFor(ptId, "appointment_reminder");
  check(
    "the sweep sent a reminder for the upcoming appointment",
    reminders1.length >= 1,
    `reminders=${reminders1.length}`,
  );

  // Run it again immediately. Nothing has come due in between, so a correct
  // sweep must produce nothing at all.
  await call("/notifications/reminders/sweep", {
    method: "POST",
    token: adminToken,
    body: { hours: 48 },
  });
  check(
    "a second sweep sends no duplicate reminder",
    (await eventsFor(ptId, "appointment_reminder")).length === reminders1.length,
    `${reminders1.length} -> ${(await eventsFor(ptId, "appointment_reminder")).length}`,
  );

  const claimed = (
    await query("SELECT reminder_sent_at FROM appointments WHERE id = $1", [remAppt])
  ).rows[0];
  check(
    "the appointment is stamped so it will not be reminded about again",
    claimed?.reminder_sent_at !== null,
    `reminder_sent_at=${claimed?.reminder_sent_at}`,
  );

  // Two concurrent sweeps must still produce exactly one message: the claim is
  // a guarded UPDATE, so only one caller wins the row.
  const beforeConcurrent = (await eventsFor(ptId, "appointment_reminder")).length;
  await query("UPDATE appointments SET reminder_sent_at = NULL WHERE id = $1", [remAppt]);
  await query("DELETE FROM notifications WHERE user_id = $1 AND event = 'appointment_reminder'", [ptId]);
  await Promise.all([
    call("/notifications/reminders/sweep", { method: "POST", token: adminToken, body: { hours: 48 } }),
    call("/notifications/reminders/sweep", { method: "POST", token: adminToken, body: { hours: 48 } }),
    call("/notifications/reminders/sweep", { method: "POST", token: adminToken, body: { hours: 48 } }),
  ]);
  check(
    "three concurrent sweeps produce exactly one reminder",
    (await eventsFor(ptId, "appointment_reminder")).length === 1,
    `reminders=${(await eventsFor(ptId, "appointment_reminder")).length}`,
  );
  void beforeConcurrent;

  // A reschedule must make the appointment eligible for a NEW reminder, because
  // the message that was sent was about the old time.
  const remReschedSlots = remSlots;
  const moved = await call(`/appointments/${remAppt}/reschedule`, {
    method: "PATCH",
    token: pt,
    body: { slotId: remReschedSlots.futureSlot2.id },
  });
  check("the reminder fixture was rescheduled", moved.status === 200, `HTTP ${moved.status}`);
  const afterMove = (
    await query("SELECT reminder_sent_at FROM appointments WHERE id = $1", [remAppt])
  ).rows[0];
  check(
    "rescheduling clears the reminder stamp so the new time can be reminded about",
    afterMove?.reminder_sent_at === null,
    `reminder_sent_at=${afterMove?.reminder_sent_at}`,
  );

  /* ---------------------------------------------------------------- *
   * 5. Outbox drain and sweep bookkeeping                            *
   * ---------------------------------------------------------------- */
  const drain = await call("/notifications/outbox/drain", {
    method: "POST",
    token: adminToken,
    body: { limit: 200 },
  });
  check("the outbox drain ran", drain.status === 200, `HTTP ${drain.status}`);
  check(
    "the drain reports what it did",
    typeof drain.data?.processed === "number" && typeof drain.data?.skipped === "number",
    JSON.stringify(drain.data ?? {}).slice(0, 120),
  );
  const queuedLeft = (
    await query("SELECT count(*)::int AS n FROM notification_deliveries WHERE status = 'queued'")
  ).rows[0].n;
  check("the drain left nothing queued behind", queuedLeft === 0, `queued=${queuedLeft}`);

  const patientDrain = await call("/notifications/outbox/drain", {
    method: "POST",
    token: pt,
    body: {},
  });
  check("a patient cannot trigger the drain", patientDrain.status === 403,
    `HTTP ${patientDrain.status}`);

  const sched = await call("/notifications/scheduler", { token: adminToken });
  check("the scheduler reports its state", sched.status === 200, `HTTP ${sched.status}`);
  check(
    "the scheduler states its timing limitations rather than implying exactness",
    /approximate/i.test(sched.data?.note ?? ""),
    (sched.data?.note ?? "").slice(0, 80),
  );
  // A background timer running DURING a suite would produce notifications at
  // moments the suite does not control, and two suites sweeping the same database
  // would race for the same reminder rows. Asserting it is off turns a convention
  // into a checked property.
  check(
    "the background timer is disabled while deterministic tests run",
    sched.data?.enabled === false && sched.data?.running === false,
    `enabled=${sched.data?.enabled} running=${sched.data?.running}`,
  );
  const patientSched = await call("/notifications/scheduler", { token: pt });
  check("a patient cannot read the scheduler state", patientSched.status === 403,
    `HTTP ${patientSched.status}`);

  const sweeps = (
    await query(
      "SELECT kind, processed, skipped, failed FROM notification_sweeps ORDER BY started_at DESC LIMIT 10",
    )
  ).rows;
  check(
    "every background pass recorded what it did",
    sweeps.length > 0 && sweeps.some((r) => r.kind === "reminders") && sweeps.some((r) => r.kind === "outbox"),
    JSON.stringify(sweeps.slice(0, 3)),
  );

  /* ---------------------------------------------------------------- *
   * 6. In-app delivery is reported                                   *
   * ---------------------------------------------------------------- */
  // The in-app channel is the only one this deployment delivers. If it is not
  // reported as delivered, the caller is told a message failed when it did not.
  /* ---- the key distinguishes real repeats, not just "event + appointment" ---- */
  // Deduplication must suppress a RETRY without suppressing a second genuine
  // event of the same type. That is entirely the discriminator's job, so it is
  // tested directly rather than inferred from the end-to-end cases.
  const { buildDedupeKey } = await import("../src/services/notificationService.js");
  const base = { event: "queue_called", userId: "u1", appointmentId: "a1" };
  const first = buildDedupeKey({ ...base, discriminator: "2026-10-13T09:00:00Z" });
  const retrySame = buildDedupeKey({ ...base, discriminator: "2026-10-13T09:00:00Z" });
  const laterCall = buildDedupeKey({ ...base, discriminator: "2026-10-13T11:30:00Z" });
  const otherEvent = buildDedupeKey({
    event: "appointment_checked_in",
    userId: "u1",
    appointmentId: "a1",
    discriminator: "2026-10-13T09:00:00Z",
  });
  const otherPatient = buildDedupeKey({
    ...base,
    userId: "u2",
    discriminator: "2026-10-13T09:00:00Z",
  });
  check(
    "the same event retried produces the same key, so it is suppressed",
    first === retrySame && first !== null,
    `${first} vs ${retrySame}`,
  );
  check(
    "the same event a second time with a different discriminator is NOT suppressed",
    laterCall !== first,
    `${first} vs ${laterCall}`,
  );
  check(
    "a different event for the same appointment is not suppressed",
    otherEvent !== first,
    `${first} vs ${otherEvent}`,
  );
  check(
    "the same event for a different patient is not suppressed",
    otherPatient !== first,
    `${first} vs ${otherPatient}`,
  );
  check(
    "an event with no appointment still gets a key, rather than being un-deduplicated",
    buildDedupeKey({ event: "system", userId: "u1" }) !== null,
    "no key produced",
  );

  /* ---- retry behaviour is bounded ---- */
  // A channel that keeps failing must not be retried for ever. The drain skips a
  // row attempted inside its backoff window, so a second immediate pass leaves it
  // alone; that is the bound, and it is what stops a broken provider turning into
  // an unbounded retry loop.
  const { drainOutbox } = await import("../src/services/notificationService.js");
  const retryTarget = (
    await query(
      `SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ptId],
    )
  ).rows[0];
  await query(
    `UPDATE notification_deliveries SET status = 'queued', attempted_at = NULL
      WHERE notification_id = $1`,
    [retryTarget.id],
  );
  const drain1 = await drainOutbox({ limit: 200 });
  check(
    "a re-queued delivery is picked up by the next drain",
    drain1.processed >= 1,
    JSON.stringify(drain1),
  );
  const afterFirst = (
    await query(
      `SELECT count(*)::int AS n FROM notification_deliveries
        WHERE notification_id = $1 AND status = 'queued' AND attempted_at IS NOT NULL`,
      [retryTarget.id],
    )
  ).rows[0].n;
  const drain2 = await drainOutbox({ limit: 200 });
  const afterSecond = (
    await query(
      `SELECT count(*)::int AS n FROM notification_deliveries
        WHERE notification_id = $1 AND status = 'queued' AND attempted_at IS NOT NULL`,
      [retryTarget.id],
    )
  ).rows[0].n;
  check(
    "an immediate second drain does not re-attempt a just-attempted delivery",
    drain2.processed === 0 && afterSecond === afterFirst,
    `processed=${drain2.processed} queued-with-attempt ${afterFirst} -> ${afterSecond}`,
  );
  check(
    "and the message is settled, not left queued forever",
    (
      await query(
        `SELECT count(*)::int AS n FROM notification_deliveries
          WHERE notification_id = $1 AND status = 'queued'`,
        [retryTarget.id],
      )
    ).rows[0].n === 0,
    "still queued after two drains",
  );

  const { deliverNotification } = await import("../src/services/notificationService.js");
  const someMessage = (
    await query(
      `SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ptId],
    )
  ).rows[0];
  await query(
    `UPDATE notification_deliveries SET status = 'queued', attempted_at = NULL
      WHERE notification_id = $1`,
    [someMessage.id],
  );
  const outcome = await deliverNotification(someMessage.id);
  check(
    "an in-app message is reported as delivered",
    outcome.delivered === true &&
      outcome.results.some((r) => r.channel === "in-app" && r.status === "delivered"),
    JSON.stringify(outcome).slice(0, 140),
  );
};

run()
  .then(async () => {
    await dropFixtures();
    await closePool();
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(`  suite crashed: ${err.stack ?? err.message}`);
    await dropFixtures().catch(() => {});
    await closePool().catch(() => {});
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  });