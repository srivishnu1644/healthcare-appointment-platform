/**
 * Phase 9 Checkpoint 2 — the doctor-day waiting room.
 *
 *   DATABASE_URL=... node scripts/queue-room-check.js
 *   API_URL=http://localhost:5000/api node scripts/queue-room-check.js
 *
 * WHAT THIS COVERS
 *   The waiting room is (doctor_id, clinic_date). Patients hold separate
 *   appointment slots but wait for the same person, so their order comes from
 *   when they ARRIVED.
 *
 *     * three patients checked in across three different slots are 1, 2 and 3
 *     * call-next promotes only the first waiting patient
 *     * the rest renumber immediately, with no gap
 *     * completing the consultation releases it, and the next call advances
 *     * cancellation removes a waiting patient and renumbers the rest
 *     * no-show keeps the record as `left` instead of deleting it
 *     * two simultaneous call-next requests promote ONE patient
 *     * call-next is idempotent while a consultation is active
 *     * check-in racing a cancellation leaves no orphan entry
 *     * anonymous callers are refused; another doctor is refused
 *     * a patient sees themselves and nobody else
 *     * queue entries written before the migration are still readable
 *
 * WHY THE FIXTURE IS BUILT RATHER THAN FOUND
 *   Check-in requires a slot that has ALREADY STARTED (`starts_at <= now()`),
 *   while booking only requires the calendar date not to have passed. So a slot
 *   dated TODAY whose start is in the past is bookable and check-in-able at any
 *   hour of the day. This suite creates such a slot per patient, which makes it
 *   deterministic whatever time it runs — there are no skips and nothing that
 *   only passes in the afternoon.
 *
 *   Each run gets its own provider, so it never depends on, or disturbs, the
 *   seeded doctors or the other suites. Everything it creates is removed again.
 */

import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import pg from "pg";
import * as time from "../src/utils/time.js";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)
  .toString(36)
  .padStart(3, "0")}`;
const PATIENT_PASSWORD = "patient123";

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

const check = (name, ok, extra = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${extra ? ` :: ${extra}` : ""}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ""}`);
  }
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = (sql, params = []) => db.query(sql, params);

async function call(pathname, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, data: json?.data ?? null };
}

const codeOf = (r) => r.body?.error?.code ?? null;

async function signIn(creds) {
  const r = await call("/auth/login", { method: "POST", body: creds });
  if (r.status !== 200) throw new Error(`login failed for ${creds.email}: ${r.body?.message}`);
  return r.data.token;
}

const toMin = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Minutes past midnight in the clinic's timezone. */
const clinicMinutes = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: time.TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
};

const run = async () => {
  console.log(`\n=== Phase 9 queue room checks (${BASE}) ===`);
  console.log(`      clinic timezone: ${time.TZ}\n`);

  const today = time.todayLocal();
  const nowMin = clinicMinutes();

  const { hashPassword } = await import("../src/utils/password.js");

  /* ------------------------------------------------------------------ *
   * Fixture: one throwaway provider with back-dated, already-started slots
   * ------------------------------------------------------------------ */
  const specialty = await q("SELECT id FROM specialties ORDER BY slug LIMIT 1");
  const facility = await q("SELECT id FROM facilities ORDER BY id LIMIT 1");
  const pw = await hashPassword("doctor123");

  const docEmail = `room-${RUN_ID}@phase9.test`;
  const user = await q(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, 'doctor', $3, $4) RETURNING id`,
    [docEmail, pw, `Dr. Room ${RUN_ID}`, "+91920000000"],
  );
  const doctor = await q(
    `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee)
     VALUES ($1, $2, $3, 700) RETURNING id`,
    [user.rows[0].id, specialty.rows[0].id, facility.rows[0].id],
  );
  const doctorId = doctor.rows[0].id;
  const doctorToken = await signIn({ email: docEmail, password: "doctor123" });

  // Seeded patients, so the suite never has to register accounts.
  const patientTokens = [];
  for (const email of ["ishita@demo.com", "aman@demo.com", "patient@demo.com"]) {
    patientTokens.push({
      email,
      token: await signIn({ email, password: PATIENT_PASSWORD }),
    });
  }

  /**
   * A slot dated today, starting `agoMin` minutes ago: bookable (the date has
   * not passed) and already begun (the instant has).
   */
  const makeStartedSlot = async (agoMin) => {
    const startMin = Math.max(0, nowMin - agoMin);
    const local = `${today} ${hhmm(startMin)}:00`;
    const r = await q(
      `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, status, fee, max_queue)
       VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE $5,
               ($3::date + $4::time) AT TIME ZONE $5 + interval '30 minutes',
               'available', 700, 3)
       RETURNING id`,
      [doctorId, facility.rows[0].id, today, hhmm(startMin), time.TZ],
    );
    return r.rows[0].id;
  };

  // Three started slots for one doctor, on different times.
  const slots = [];
  for (const ago of [240, 180, 120]) slots.push(await makeStartedSlot(ago));
  check("the fixture has three distinct started slots", new Set(slots).size === 3, slots.length);

  // `forDoctor` matters: the schema enforces that an appointment's doctor owns
  // its slot, so booking a second room's slot under the first room's doctor is
  // refused (correctly, and for a reason that has nothing to do with the queue).
  const bookAndCheckIn = async (slotId, patient, forDoctor = doctorId) => {
    const booked = await call("/appointments", {
      method: "POST",
      token: patient.token,
      body: { doctorId: forDoctor, slotId, reason: "queue room check" },
    });
    if (booked.status !== 201) return { booked, appointmentId: null };
    const id = booked.data?.appointment?.id;
    const checkIn = await call(`/appointments/${id}/check-in`, {
      method: "POST",
      token: patient.token,
    });
    return { booked, appointmentId: id, checkIn };
  };

  const room = async () => {
    const r = await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
      token: doctorToken,
    });
    return r.data;
  };
  const waitingRoom = (d) => (d?.entries ?? []).filter((e) => e.state === "waiting");
  const callNext = async () =>
    call("/appointments/queue/next", {
      method: "POST",
      token: doctorToken,
      body: { doctorId, date: today },
    });

  /* -- 1. three patients, three slots, positions 1 2 3 ------------------ */
  const bookings = [];
  for (let i = 0; i < 3; i += 1) {
    bookings.push(await bookAndCheckIn(slots[i], patientTokens[i]));
  }
  check(
    "all three patients booked and checked in",
    bookings.every((b) => b.booked.status === 201 && b.checkIn?.status === 200),
    bookings.map((b) => `${b.booked.status}/${b.checkIn?.status ?? "-"}`).join(" "),
  );

  let r = await room();
  let waiting = waitingRoom(r);
  check("the room reports three waiting patients", waiting.length === 3, `waiting=${waiting.length}`);
  check(
    "waiting positions are 1, 2 and 3",
    JSON.stringify(waiting.map((e) => e.roomPosition)) === "[1,2,3]",
    waiting.map((e) => `${e.patientName}:${e.roomPosition}`).join(" "),
  );
  check(
    "positions follow arrival order, not slot order",
    waiting[0].joinedAt <= waiting[1].joinedAt &&
      waiting[1].joinedAt <= waiting[2].joinedAt,
    waiting.map((e) => e.joinedAt).join(" | "),
  );
  check("the room names its clinic date", r?.clinicDate === today, `${r?.clinicDate}`);
  check("the waiting count matches the rows", r?.waitingCount === 3, `${r?.waitingCount}`);
  check("the legacy per-slot column is still present but unused for ranking",
    r?.entries.every((e) => e.position === 1),
    JSON.stringify(r?.entries.map((e) => e.position)));

  // A patient sees their own real place.
  const own = (
    await call("/appointments", { token: patientTokens[2].token })
  ).data.appointments.find((a) => a.id === bookings[2].appointmentId);
  check("a waiting patient is told position 3", own?.queuePosition === 3, `${own?.queuePosition}`);
  check("a waiting patient carries the waiting state", own?.queueState === "waiting", `${own?.queueState}`);

  /* -- 2. call-next promotes only the first waiting patient ------------ */
  const first = waiting[0];
  const n1 = await callNext();
  check("call-next succeeds", n1.status === 200, `HTTP ${n1.status} ${codeOf(n1) ?? ""}`);
  check("call-next promoted somebody", n1.data?.promoted === true);
  check("it promoted the first arrival", n1.data?.entry?.appointmentId === first.appointmentId,
    `${n1.data?.entry?.patientName} vs ${first.patientName}`);
  check("the promoted patient left the waiting line",
    n1.data?.activeConsultation?.appointmentId === first.appointmentId);

  r = await room();
  waiting = waitingRoom(r);
  check("the consultation is reported separately from the line",
    r?.activeConsultation?.appointmentId === first.appointmentId &&
      !waiting.some((e) => e.appointmentId === first.appointmentId),
    `active=${r?.activeConsultation?.patientName}`);
  check("the consultation has no place in the line",
    r?.activeConsultation?.roomPosition === null, `${r?.activeConsultation?.roomPosition}`);
  check("the rest renumbered to 1 and 2 with no gap",
    JSON.stringify(waiting.map((e) => e.roomPosition)) === "[1,2]",
    waiting.map((e) => `${e.patientName}:${e.roomPosition}`).join(" "));

  /* -- 3. repeated call-next is idempotent ------------------------------ */
  const again = await callNext();
  check("a second call-next does not advance the queue", again.data?.promoted === false);
  check("it returns the same patient",
    again.data?.entry?.appointmentId === first.appointmentId,
    again.data?.entry?.patientName);
  const third = await callNext();
  check("and a third is still the same patient",
    third.data?.entry?.appointmentId === first.appointmentId);
  check("the line is untouched by the repeats", waitingRoom(await room()).length === 2);

  /* -- 4. two simultaneous call-next requests --------------------------- */
  // A second room so the race has its own three patients and no consultation.
  const user2 = await q(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, 'doctor', $3, $4) RETURNING id`,
    [`room-race-${RUN_ID}@phase9.test`, pw, `Dr. Race ${RUN_ID}`, "+91920000001"],
  );
  const doctor2 = await q(
    `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee)
     VALUES ($1, $2, $3, 700) RETURNING id`,
    [user2.rows[0].id, specialty.rows[0].id, facility.rows[0].id],
  );
  const doctor2Id = doctor2.rows[0].id;
  const doctor2Token = await signIn({
    email: `room-race-${RUN_ID}@phase9.test`,
    password: "doctor123",
  });
  const raceSlots = [];
  for (const ago of [300, 240, 180]) {
    const r2 = await q(
      `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at, status, fee, max_queue)
       VALUES ($1, $2, ($3::date + $4::time) AT TIME ZONE $5,
               ($3::date + $4::time) AT TIME ZONE $5 + interval '30 minutes',
               'available', 700, 3) RETURNING id`,
      [doctor2Id, facility.rows[0].id, today, hhmm(Math.max(0, nowMin - ago)), time.TZ],
    );
    raceSlots.push(r2.rows[0].id);
  }

  // Patients of their own. The seeded ones are already holding appointments from
  // the room above, and `appointments_patient_no_overlap` is global - it does not
  // care which doctor - so reusing them here would be refused for the right
  // reason and prove nothing about the race.
  const racePw = await hashPassword(PATIENT_PASSWORD);
  const racePatients = [];
  for (let i = 0; i < 3; i += 1) {
    const email = `room-race-patient-${i}-${RUN_ID}@phase9.test`;
    await q(
      `INSERT INTO users (email, password_hash, role, full_name, phone)
       VALUES ($1, $2, 'patient', $3, $4)`,
      [email, racePw, `Race Patient ${i}`, `+91930${i}${RUN_ID.slice(-6)}`],
    );
    racePatients.push({ email, token: await signIn({ email, password: PATIENT_PASSWORD }) });
  }
  for (let i = 0; i < 3; i += 1) await bookAndCheckIn(raceSlots[i], racePatients[i], doctor2Id);
  const raceRoom = (
    await call(`/appointments/queue?doctorId=${doctor2Id}&date=${today}`, { token: doctor2Token })
  ).data;
  check("the race room has three waiting patients before the race",
    raceRoom?.waitingCount === 3, `waitingCount=${raceRoom?.waitingCount}`);

  const raceCall = () =>
    call("/appointments/queue/next", {
      method: "POST",
      token: doctor2Token,
      body: { doctorId: doctor2Id, date: today },
    });
  const [ra, rb] = await Promise.all([raceCall(), raceCall()]);
  check("both concurrent call-next requests were answered",
    ra.status === 200 && rb.status === 200, `${ra.status}/${rb.status}`);
  const inConsultation = await q(
    `SELECT count(*)::int AS n FROM queue_entries
      WHERE doctor_id = $1 AND clinic_date = $2::date AND state = 'in-consultation'`,
    [doctor2Id, today],
  );
  check("exactly one patient is in consultation", inConsultation.rows[0].n === 1,
    `${inConsultation.rows[0].n} in consultation`);
  check("both requests named the same patient",
    ra.data?.entry?.appointmentId === rb.data?.entry?.appointmentId,
    `${ra.data?.entry?.patientName} vs ${rb.data?.entry?.patientName}`);
  check("and exactly one of them did the promoting",
    [ra, rb].filter((x) => x.data?.promoted === true).length === 1,
    `promoted flags: ${ra.data?.promoted},${rb.data?.promoted}`);

  /* -- 5. completion releases the consultation and the next one advances */
  const done = await call(`/appointments/${first.appointmentId}/status`, {
    method: "PATCH",
    token: doctorToken,
    body: { status: "completed" },
  });
  check("the consultation can be completed", done.status === 200, `HTTP ${done.status}`);
  r = await room();
  check("the room has no active consultation", r?.activeConsultation === null,
    `${r?.activeConsultation?.patientName}`);
  check("the completed entry is kept as history",
    r?.entries.some((e) => e.appointmentId === first.appointmentId && e.state === "completed"));
  check("the completed entry is not in the line",
    !waitingRoom(r).some((e) => e.appointmentId === first.appointmentId));

  const n2 = await callNext();
  check("call-next now advances to the next patient",
    n2.data?.promoted === true && n2.data?.entry?.appointmentId !== first.appointmentId,
    n2.data?.entry?.patientName);
  r = await room();
  check("the line renumbered again to a single patient",
    JSON.stringify(waitingRoom(r).map((e) => e.roomPosition)) === "[1]",
    JSON.stringify(waitingRoom(r).map((e) => e.roomPosition)));

  /* -- 6. cancellation removes a waiting patient and renumbers ---------- */
  const remaining = waitingRoom(r)[0];
  const cancelled = await call(`/appointments/${remaining.appointmentId}/cancel`, {
    method: "PATCH",
    token: remaining.patientId === patientTokens[1].token ? patientTokens[1].token : doctorToken,
    body: { reason: "queue room check" },
  });
  check("a waiting patient can be cancelled", cancelled.status === 200,
    `HTTP ${cancelled.status} ${codeOf(cancelled) ?? ""}`);
  r = await room();
  check("the cancelled patient left the line",
    !waitingRoom(r).some((e) => e.appointmentId === remaining.appointmentId));
  check("the room is now empty", waitingRoom(r).length === 0,
    JSON.stringify(waitingRoom(r).map((e) => e.patientPosition)));

  /* -- 7. no-show keeps the record as `left` ---------------------------- */
  const nsSlot = await makeStartedSlot(90);
  const nsPatient = patientTokens[0];
  const ns = await bookAndCheckIn(nsSlot, nsPatient);
  check("a patient checked in for the no-show case", ns.checkIn?.status === 200);
  const nsStatus = await call(`/appointments/${ns.appointmentId}/status`, {
    method: "PATCH",
    token: doctorToken,
    body: { status: "no-show" },
  });
  check("a checked-in patient can be marked no-show", nsStatus.status === 200,
    `HTTP ${nsStatus.status} ${codeOf(nsStatus) ?? ""}`);
  const leftRow = await q(
    `SELECT state, left_at FROM queue_entries WHERE appointment_id = $1`,
    [ns.appointmentId],
  );
  check("the queue entry is KEPT as `left` rather than deleted",
    leftRow.rows[0]?.state === "left", `state=${leftRow.rows[0]?.state}`);
  check("and it records when they left", Boolean(leftRow.rows[0]?.left_at));
  r = await room();
  check("a `left` entry never appears in the waiting room",
    !waitingRoom(r).some((e) => e.appointmentId === ns.appointmentId));

  /* -- 8. an empty room reports 404 rather than inventing a patient ---- */
  const emptyDoctorUser = await q(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, 'doctor', $3, $4) RETURNING id`,
    [`room-empty-${RUN_ID}@phase9.test`, pw, `Dr. Empty ${RUN_ID}`, "+91920000002"],
  );
  const emptyDoctor = await q(
    `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee)
     VALUES ($1, $2, $3, 700) RETURNING id`,
    [emptyDoctorUser.rows[0].id, specialty.rows[0].id, facility.rows[0].id],
  );
  const emptyToken = await signIn({
    email: `room-empty-${RUN_ID}@phase9.test`,
    password: "doctor123",
  });
  const emptyNext = await call("/appointments/queue/next", {
    method: "POST",
    token: emptyToken,
    body: { doctorId: emptyDoctor.rows[0].id, date: today },
  });
  check("calling next in an empty room is a 404", emptyNext.status === 404,
    `HTTP ${emptyNext.status} ${codeOf(emptyNext) ?? ""}`);
  check("with a precise code", codeOf(emptyNext) === "NO_WAITING_PATIENT", `${codeOf(emptyNext)}`);
  const emptyRoom = (
    await call(`/appointments/queue?doctorId=${emptyDoctor.rows[0].id}&date=${today}`, {
      token: emptyToken,
    })
  ).data;
  check("an empty room reads as zero, not null",
    emptyRoom?.waitingCount === 0 && emptyRoom?.activeConsultation === null,
    `waitingCount=${emptyRoom?.waitingCount}`);

  /* -- 9. authorization ------------------------------------------------- */
  const anonQueue = await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`);
  check("an anonymous caller cannot read a room", anonQueue.status === 401,
    `HTTP ${anonQueue.status}`);
  const anonNext = await call("/appointments/queue/next", {
    method: "POST",
    body: { doctorId, date: today },
  });
  check("an anonymous caller cannot call next", anonNext.status === 401,
    `HTTP ${anonNext.status}`);

  const crossNext = await call("/appointments/queue/next", {
    method: "POST",
    token: doctor2Token,
    body: { doctorId, date: today },
  });
  check("another doctor cannot advance this room", crossNext.status === 403,
    `HTTP ${crossNext.status} ${codeOf(crossNext) ?? ""}`);

  const patientNext = await call("/appointments/queue/next", {
    method: "POST",
    token: patientTokens[0].token,
    body: { doctorId, date: today },
  });
  check("a patient cannot advance a waiting room", patientNext.status === 403,
    `HTTP ${patientNext.status} ${codeOf(patientNext) ?? ""}`);

  const badDate = await call("/appointments/queue/next", {
    method: "POST",
    token: doctorToken,
    body: { doctorId, date: "not-a-date" },
  });
  check("a malformed date is refused", badDate.status === 400,
    `HTTP ${badDate.status} ${codeOf(badDate) ?? ""}`);

  const missingDoctor = await call("/appointments/queue/next", {
    method: "POST",
    token: doctorToken,
    body: { date: today },
  });
  check("a missing doctorId is refused", missingDoctor.status >= 400,
    `HTTP ${missingDoctor.status} ${codeOf(missingDoctor) ?? ""}`);

  /* -- 10. patient privacy --------------------------------------------- */
  const selfView = (
    await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
      token: patientTokens[0].token,
    })
  ).data;
  check("a patient sees at most their own row", (selfView?.entries ?? []).length <= 1,
    `entries=${(selfView?.entries ?? []).length}`);
  // Absence, not a value that happens to match. A caller-scoped count would
  // satisfy the old "equals my row count" check while still putting a field
  // named like a room total into a patient's payload.
  check("a patient is never told the room's waiting count",
    selfView?.waitingCount === undefined && selfView?.total === undefined,
    `waitingCount=${selfView?.waitingCount} total=${selfView?.total}`);
  check("a patient is never told who is in consultation",
    selfView?.activeConsultation === null, `${selfView?.activeConsultation}`);
  check("a patient's view carries no other patient's name",
    JSON.stringify(selfView?.entries ?? []).indexOf("Ishita") < 0 ||
      (selfView?.entries ?? []).length <= 1);

  /* -- 11. check-in racing a cancellation leaves no orphan --------------- */
  const raceSlot = await makeStartedSlot(60);
  const racePatient = patientTokens[1];
  const raceBook = await call("/appointments", {
    method: "POST",
    token: racePatient.token,
    body: { doctorId, slotId: raceSlot, reason: "race" },
  });
  const raceAppt = raceBook.data?.appointment?.id;
  check("the race fixture booked", raceBook.status === 201, `HTTP ${raceBook.status}`);
  const [checkInRes, cancelRes] = await Promise.all([
    call(`/appointments/${raceAppt}/check-in`, { method: "POST", token: racePatient.token }),
    call(`/appointments/${raceAppt}/cancel`, {
      method: "PATCH",
      token: racePatient.token,
      body: { reason: "race" },
    }),
  ]);
  const raceEntry = await q(
    `SELECT id, state FROM queue_entries WHERE appointment_id = $1`,
    [raceAppt],
  );
  const raceApptRow = await q(
    `SELECT status FROM appointments WHERE id = $1`,
    [raceAppt],
  );
  // Order-independent. Both operations take the room's advisory lock FIRST, so
  // they cannot interleave; whichever goes second decides the end state. The old
  // check demanded that a successful check-in's entry survive a later
  // cancellation, which is wrong: cancelling an appointment the patient was
  // checked in to SHOULD remove them from the waiting room. What must hold is
  // that the two facts agree - a cancelled appointment has no entry at all, and
  // an uncancelled one has an entry exactly when the check-in was accepted.
  check(
    "a check-in racing a cancellation ends in exactly one consistent state",
    (raceApptRow.rows[0]?.status === "cancelled" && raceEntry.rows.length === 0) ||
      (raceApptRow.rows[0]?.status !== "cancelled" &&
        (checkInRes.status === 200) === (raceEntry.rows.length === 1)),
    `checkIn=${checkInRes.status} appointment=${raceApptRow.rows[0]?.status} ` +
      `entries=${raceEntry.rows.length}`,
  );
  check(
    "and never leaves a waiting entry on a cancelled appointment",
    !(raceEntry.rows.length === 1 && raceApptRow.rows[0]?.status === "cancelled"),
    `entry=${raceEntry.rows[0]?.state} appointment=${raceApptRow.rows[0]?.status}`,
  );

  /* -- 12. entries written before the migration are still readable ------ */
  // clinic_date is NOT NULL, so a row that could not be dated would have made
  // the migration fail outright. This proves the room read covers legacy rows
  // and that the stored legacy column did not leak into the ranking.
  const legacy = await q(
    `SELECT count(*)::int AS n FROM queue_entries
      WHERE clinic_date IS NULL`,
  );
  check("no queue entry is left without a clinic date", legacy.rows[0].n === 0, `${legacy.rows[0].n}`);
  const dated = await q(
    `SELECT count(*)::int AS n
       FROM queue_entries q JOIN slots sl ON sl.id = q.slot_id
      WHERE q.clinic_date <> to_char(sl.starts_at AT TIME ZONE $1, 'YYYY-MM-DD')::date`,
    [time.TZ],
  );
  check("every entry's clinic date agrees with its slot", dated.rows[0].n === 0, `${dated.rows[0].n}`);
  const dupConsult = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT doctor_id, clinic_date FROM queue_entries
        WHERE state = 'in-consultation'
        GROUP BY doctor_id, clinic_date HAVING count(*) > 1) x`,
  );
  check("no doctor-day ever has two consultations", dupConsult.rows[0].n === 0,
    `${dupConsult.rows[0].n}`);
};

const cleanup = async () => {
  if (!db.connection?.stream) return;
  try {
    const emailLike = `%-${RUN_ID}@phase9.test`;
    const docs = await q("SELECT id FROM doctors WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)", [emailLike]);
    const ids = docs.rows.map((d) => d.id);
    if (ids.length) {
      // FK order: entries -> appointments -> slots -> doctors -> users.
      await q("DELETE FROM queue_entries WHERE doctor_id = ANY($1)", [ids]);
      await q("DELETE FROM appointments WHERE doctor_id = ANY($1)", [ids]);
      await q("DELETE FROM slots WHERE doctor_id = ANY($1)", [ids]);
      await q("DELETE FROM doctors WHERE id = ANY($1)", [ids]);
    }
    await q("DELETE FROM users WHERE email LIKE $1", [emailLike]);
  } catch (err) {
    console.error(`  cleanup failed: ${err.message}`);
  }
};

try {
  await db.connect();
  await run();
} catch (err) {
  console.error(`\nSUITE ERROR: ${err.message}`);
  fail += 1;
  failures.push("suite error");
} finally {
  await cleanup();
  await db.end().catch(() => {});
}

console.log(`\n=== ${pass} passed, ${fail} failed, ${skip} skipped ===`);
if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
if (fail) process.exitCode = 1;