#!/usr/bin/env node
/**
 * Phase 12 — the administrative surface.
 *
 * An administrator can see everything and change almost nothing, deliberately.
 * The distinction is the point of these checks:
 *
 *   * every admin endpoint refuses an anonymous caller, a patient and a doctor;
 *   * the cross-clinic views return only their own rows, never another role's
 *     secrets, and never a password hash or a token;
 *   * filtering, searching, sorting and pagination agree with each other - the
 *     count describes the set the page is drawn from, not some other query;
 *   * a `sort` value that is not in the whitelist is IGNORED rather than reaching
 *     SQL, and a hostile one changes nothing;
 *   * there is no admin endpoint that writes to an appointment, so the booking,
 *     ownership and transition rules cannot be bypassed by using one.
 *
 *   node scripts/admin-check.js
 */
import { query, closePool } from "../src/config/database.js";
import { hashPassword } from "../src/utils/password.js";

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

const call = async (path, { method = "GET", token, body } = {}) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json?.data, json, code: json?.error?.code };
};

const login = async (email, password) =>
  (await call("/auth/login", { method: "POST", body: { email, password } })).data;

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const madeUsers = [];

const run = async () => {
  const admin = await login("admin@demo.com", "admin123");
  const patient = await login("patient@demo.com", "patient123");
  const doctor = await login("doctor1@demo.com", "doctor123");
  const A = admin.token;

  /* ---------------------------------------------------------------- *
   * 1. Role enforcement on every admin endpoint                       *
   * ---------------------------------------------------------------- */
  const endpoints = [
    "/admin/overview",
    "/admin/appointments",
    "/admin/queue",
    "/admin/scheduler",
    "/admin/doctors",
    "/admin/patients",
    "/admin/patients?search=a&limit=5",
    "/admin/facilities",
    "/admin/services",
    "/admin/notifications",
  ];

  for (const path of endpoints) {
    const anon = await call(path);
    const pat = await call(path, { token: patient.token });
    const doc = await call(path, { token: doctor.token });
    check(
      `admin route refuses non-admins: ${path}`,
      anon.status === 401 && pat.status === 403 && doc.status === 403,
      `anon=${anon.status} patient=${pat.status} doctor=${doc.status}`,
    );
  }

  const ok = await call("/admin/overview", { token: A });
  check("an admin can reach it", ok.status === 200, `HTTP ${ok.status}`);

  /* ---------------------------------------------------------------- *
   * 2. The overview is an operations view, not just a chart          *
   * ---------------------------------------------------------------- */
  const ov = ok.data ?? {};
  check("the overview reports the waiting room", typeof ov.queue?.waiting === "number",
    JSON.stringify(ov.queue));
  check("the overview reports notification operations",
    typeof ov.notifications?.deliveries?.queued === "number",
    JSON.stringify(ov.notifications));
  check("the overview reports scheduler state", ov.scheduler && typeof ov.scheduler.running === "boolean",
    JSON.stringify(ov.scheduler));
  check("and still reports the pre-existing analytics",
    typeof ov.kpis?.totalAppointments === "number" && Array.isArray(ov.trend),
    `kpis=${typeof ov.kpis?.totalAppointments} trend=${Array.isArray(ov.trend)}`);

  /* ---------------------------------------------------------------- *
   * 3. Cross-clinic appointments                                     *
   * ---------------------------------------------------------------- */
  const all = await call("/admin/appointments?limit=200", { token: A });
  check("appointments lists across every doctor", all.status === 200, `HTTP ${all.status}`);
  const rows = all.data?.appointments ?? [];
  check("and returns rows", rows.length > 0, `rows=${rows.length}`);
  check("each row names both sides of the appointment",
    rows.every((r) => r.patientName && r.doctorName && r.date && r.startTime),
    JSON.stringify(rows[0] ?? {}).slice(0, 140));
  check("the total is a number the page can trust",
    Number.isInteger(all.data?.total) && all.data.total >= rows.length,
    `total=${all.data?.total} rows=${rows.length}`);

  // Two different doctors must actually appear, or "cross-clinic" is untested.
  check("the view genuinely spans more than one provider",
    new Set(rows.map((r) => r.doctorId)).size > 1,
    `doctors=${new Set(rows.map((r) => r.doctorId)).size}`);

  /* ---- filtering ---- */
  const completed = await call("/admin/appointments?status=completed&limit=200", { token: A });
  check("a status filter returns only that status",
    (completed.data?.appointments ?? []).every((r) => r.status === "completed"),
    `rows=${(completed.data?.appointments ?? []).length}`);
  check("and the filtered total agrees with the filter",
    completed.data.total <= all.data.total,
    `filtered=${completed.data.total} all=${all.data.total}`);

  const multi = await call("/admin/appointments?status=completed,cancelled&limit=200", { token: A });
  check("a comma-separated status filter is accepted",
    multi.status === 200 &&
      (multi.data?.appointments ?? []).every((r) => ["completed", "cancelled"].includes(r.status)),
    `HTTP ${multi.status}`);

  /* ---- search ---- */
  const target = rows[0];
  const byPatient = await call(
    `/admin/appointments?search=${encodeURIComponent(target.patientName)}&limit=200`,
    { token: A },
  );
  check("search by patient name finds that patient",
    (byPatient.data?.appointments ?? []).some((r) => r.patientName === target.patientName),
    `hits=${(byPatient.data?.appointments ?? []).length}`);
  check("and returns nobody else matching by accident",
    (byPatient.data?.appointments ?? []).every((r) =>
      `${r.patientName} ${r.doctorName} ${r.patientEmail}`.toLowerCase()
        .includes(target.patientName.toLowerCase())),
    "an unrelated row came back");

  const byNothing = await call("/admin/appointments?search=zzzz-no-such-person", { token: A });
  check("a search matching nothing returns an empty page, not everything",
    byNothing.status === 200 &&
      (byNothing.data?.appointments ?? []).length === 0 &&
      byNothing.data.total === 0,
    `rows=${(byNothing.data?.appointments ?? []).length} total=${byNothing.data?.total}`);

  /* ---- sorting ---- */
  const byPatientName = await call("/admin/appointments?sort=patient&limit=50", { token: A });
  const names = (byPatientName.data?.appointments ?? []).map((r) => r.patientName);
  check("sort=patient is applied",
    JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))),
    names.slice(0, 4).join(","));

  const injection = await call(
    `/admin/appointments?sort=${encodeURIComponent("; DROP TABLE users--")}&limit=5`,
    { token: A },
  );
  check("an unknown sort is ignored rather than reaching SQL",
    injection.status === 200 && (injection.data?.appointments ?? []).length > 0,
    `HTTP ${injection.status}`);
  const usersStillThere = await query("SELECT count(*)::int AS n FROM users");
  check("and the users table is untouched by the attempt",
    usersStillThere.rows[0].n > 0,
    `users=${usersStillThere.rows[0].n}`);

  /* ---- pagination ---- */
  const page1 = await call("/admin/appointments?limit=5&offset=0", { token: A });
  const page2 = await call("/admin/appointments?limit=5&offset=5", { token: A });
  check("two pages return different rows",
    page1.status === 200 && page2.status === 200 &&
      page1.data.appointments[0]?.id !== page2.data.appointments[0]?.id,
    `first=${page1.data?.appointments?.[0]?.id} second=${page2.data?.appointments?.[0]?.id}`);
  check("both pages agree on the same total",
    page1.data.total === page2.data.total && page1.data.total === all.data.total,
    `${page1.data?.total} vs ${page2.data?.total} vs ${all.data?.total}`);
  check("the page size is honoured",
    page1.data.appointments.length <= 5 && page2.data.appointments.length <= 5,
    `${page1.data?.appointments.length}/${page2.data?.appointments.length}`);

  // Validation is authoritative: an out-of-range limit is a 422 at the edge, not
  // a silently clamped number. The repository clamps too, as a second line of
  // defence for any caller that reaches it without passing through the route.
  const bigPage = await call("/admin/appointments?limit=100000", { token: A });
  check("an oversized limit is refused by validation",
    bigPage.status === 422,
    `HTTP ${bigPage.status}`);
  const atMax = await call("/admin/appointments?limit=200", { token: A });
  check("and the maximum accepted limit works",
    atMax.status === 200 && atMax.data.limit === 200,
    `HTTP ${atMax.status} limit=${atMax.data?.limit}`);

  const badOffset = await call("/admin/appointments?offset=-5", { token: A });
  check("a negative offset is refused by validation", badOffset.status === 422,
    `HTTP ${badOffset.status}`);

  /* ---- date range ---- */
  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const far = await call(`/admin/appointments?from=${future}&limit=50`, { token: A });
  check("a future-only date range returns nothing",
    far.status === 200 && (far.data?.appointments ?? []).length === 0,
    `rows=${(far.data?.appointments ?? []).length}`);

  // The other half of the proof: a range that DOES cover real rows must return
  // them. Testing only the empty case would still pass if the predicate had been
  // `WHERE false`, which is the usual way a filter test goes green by accident.
  const bounds = rows.map((r) => r.date).sort();
  const span = await call(
    `/admin/appointments?from=${bounds[0]}&to=${bounds[bounds.length - 1]}&limit=200`,
    { token: A },
  );
  check("a date range covering the data returns the same rows as no filter",
    span.status === 200 && span.data.total === all.data.total,
    `range=${span.data?.total} unfiltered=${all.data?.total}`);
  check("and every returned row actually falls inside it",
    (span.data?.appointments ?? []).every(
      (r) => r.date >= bounds[0] && r.date <= bounds[bounds.length - 1],
    ),
    "a row outside the requested range came back");

  const narrow = await call(
    `/admin/appointments?from=${bounds[0]}&to=${bounds[0]}&limit=200`,
    { token: A },
  );
  check("a single-day range returns only that day",
    narrow.status === 200 &&
      (narrow.data?.appointments ?? []).every((r) => r.date === bounds[0]),
    `day=${bounds[0]} rows=${(narrow.data?.appointments ?? []).length}`);
  check("and a single day is a strict subset of the full range",
    narrow.data.total <= span.data.total,
    `${narrow.data?.total} vs ${span.data?.total}`);

  const inverted = await call(
    `/admin/appointments?from=${bounds[bounds.length - 1]}&to=${bounds[0]}&limit=5`,
    { token: A },
  );
  check("an inverted range (from later than to) returns nothing rather than everything",
    inverted.status === 200 && (inverted.data?.appointments ?? []).length === 0,
    `rows=${(inverted.data?.appointments ?? []).length}`);


  // These reached a SQL `::date` cast before Phase 13, which turned a bad query
  // parameter into a 500. They are the reason `type: "date"` now checks that the
  // day exists rather than only that it looks like one.
  for (const [label, value] of [
    ["not a date", "not-a-date"],
    ["an impossible day", "2026-02-31"],
    ["an impossible month", "2026-13-01"],
    ["a day with no zero", "2026-1-5"],
  ]) {
    const r = await call(`/admin/appointments?from=${value}`, { token: A });
    check(`a malformed date is refused: ${label} (${value})`,
      r.status === 422 && r.code === "VALIDATION_ERROR",
      `HTTP ${r.status} ${r.code ?? ""}`);
  }

  /* ---------------------------------------------------------------- *
   * 4. No admin endpoint writes to an appointment                     *
   * ---------------------------------------------------------------- */
  // If one existed, an admin could change an appointment without passing the
  // ownership, transition and room-lock rules. Proved by trying the obvious
  // shapes and requiring each to be a 404 - the route does not exist.
  const writeAttempts = [
    ["POST", "/admin/appointments"],
    ["PATCH", `/admin/appointments/${target.id}`],
    ["PATCH", `/admin/appointments/${target.id}/status`],
    ["DELETE", `/admin/appointments/${target.id}`],
    ["POST", `/admin/appointments/${target.id}/check-in`],
    ["POST", "/admin/queue/next"],
  ];
  for (const [method, path] of writeAttempts) {
    const r = await call(path, { method, token: A, body: { status: "completed" } });
    check(
      `no admin write path for appointments: ${method} ${path}`,
      r.status === 404 || r.status === 405,
      `HTTP ${r.status} ${r.code ?? ""}`,
    );
  }

  const untouched = await query(
    "SELECT status FROM appointments WHERE id = $1",
    [target.id],
  );
  check("and the target appointment is genuinely unchanged",
    untouched.rows[0]?.status === target.status,
    `was ${target.status}, now ${untouched.rows[0]?.status}`);

  /* ---------------------------------------------------------------- *
   * 5. Waiting rooms                                                *
   * ---------------------------------------------------------------- */
  const rooms = await call("/admin/queue", { token: A });
  check("queue monitoring responds", rooms.status === 200, `HTTP ${rooms.status}`);
  check("with a shaped payload",
    Array.isArray(rooms.data?.rooms) && Number.isInteger(rooms.data?.total),
    JSON.stringify(rooms.data ?? {}).slice(0, 120));

  // Now drive a real room and prove it shows up with the same counting the
  // patient-facing API uses.
  const stamp = RUN;
  const facility = await query("SELECT id FROM facilities ORDER BY name LIMIT 1");
  const specialty = await query("SELECT id FROM specialties ORDER BY slug LIMIT 1");
  const du = await query(
    `INSERT INTO users (email, password_hash, role, full_name, phone)
     VALUES ($1, $2, 'doctor', $3, $4) RETURNING id`,
    [`admin-room-${stamp}@phase12.test`, await hashPassword("room12345"), "Dr. Room Probe", `+9196${stamp.slice(-9)}`],
  );
  madeUsers.push(du.rows[0].id);
  const dd = await query(
    `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee, experience_years, seed_rating, seed_review_count)
     VALUES ($1, $2, $3, 400, 5, 4.5, 5) RETURNING id`,
    [du.rows[0].id, specialty.rows[0].id, facility.rows[0].id],
  );
  const roomDoctorId = dd.rows[0].id;

  const started = new Date(Date.now() - 20 * 60_000);
  const slot = await call(`/doctors/${roomDoctorId}/slots`, {
    method: "POST",
    token: A,
    body: {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(started),
      times: [new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(started)],
      duration: 30,
      mode: "in-person",
      fee: 400,
      maxQueue: 5,
    },
  });
  const slotId = slot.data?.created?.[0]?.id;
  check("the room fixture slot exists", Boolean(slotId), `HTTP ${slot.status}`);

  if (slotId) {
    const pu = await call("/auth/register", {
      method: "POST",
      body: {
        name: "Room Patient",
        email: `admin-room-patient-${stamp}@phase12.test`,
        password: "room12345",
        phone: `+9197${stamp.slice(-9)}`,
      },
    });
    check("the room fixture patient registered", pu.status === 201, `HTTP ${pu.status}`);
    const booked = await call("/appointments", {
      method: "POST",
      token: pu.data.token,
      body: { doctorId: roomDoctorId, slotId },
    });
    check("and booked", booked.status === 201, `HTTP ${booked.status}`);
    const checkedIn = await call(
      `/appointments/${booked.data?.appointment?.id}/check-in`,
      { method: "POST", token: pu.data.token },
    );
    check("and checked in", checkedIn.status === 200, `HTTP ${checkedIn.status}`);

    const roomsAfter = await call("/admin/queue", { token: A });
    const mine = (roomsAfter.data?.rooms ?? []).find((r) => r.doctorId === roomDoctorId);
    check("the occupied room appears in admin queue monitoring", Boolean(mine),
      `rooms=${(roomsAfter.data?.rooms ?? []).length}`);
    check("and its waiting count matches the patient-facing API",
      mine?.waiting === 1,
      `admin=${mine?.waiting}`);

    const myQueue = await call(
      `/appointments/queue?doctorId=${roomDoctorId}&date=${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(started)}`,
      { token: pu.data.token },
    );
    check("the patient view agrees on the count",
      (myQueue.data?.entries ?? []).filter((e) => e.state === "waiting").length === mine?.waiting,
      `patient=${(myQueue.data?.entries ?? []).length} admin=${mine?.waiting}`);

    // The room must also appear in the appointment list with its queue state.
    const inAppts = await call(
      `/admin/appointments?search=${encodeURIComponent("Room Patient")}&limit=20`,
      { token: A },
    );
    check("the waiting patient shows queue state in the appointment view",
      (inAppts.data?.appointments ?? []).some((r) => r.queueState === "waiting"),
      JSON.stringify((inAppts.data?.appointments ?? []).map((r) => r.queueState)));
  }

  /* ---------------------------------------------------------------- *
   * 6. Availability                                                 *
   * ---------------------------------------------------------------- */
  const availability = await call(`/admin/doctors/${roomDoctorId}/availability`, { token: A });
  check("availability responds", availability.status === 200, `HTTP ${availability.status}`);
  check("and counts the day's slots",
    availability.data?.total >= 1 && availability.data?.available + availability.data?.booked +
      availability.data?.blocked === availability.data?.total,
    JSON.stringify(availability.data));
  check("with an active appointment counted once, not per appointment",
    availability.data?.withActiveAppointment <= availability.data?.total,
    `withActive=${availability.data?.withActiveAppointment} total=${availability.data?.total}`);

  const unknownDoc = await call(
    "/admin/doctors/00000000-0000-0000-0000-000000000000/availability",
    { token: A },
  );
  check("an unknown provider is a 404, not a zeroed report",
    unknownDoc.status === 404,
    `HTTP ${unknownDoc.status}`);

  /* ---------------------------------------------------------------- *
   * 7. Patient directory: privacy and paging                         *
   * ---------------------------------------------------------------- */
  const allPatients = await call("/admin/patients", { token: A });
  check("the unpaginated shape still works for existing callers",
    allPatients.status === 200 && Array.isArray(allPatients.data?.patients) &&
      typeof allPatients.data?.count === "number",
    JSON.stringify(Object.keys(allPatients.data ?? {})));

  const paged = await call("/admin/patients?limit=2&offset=0", { token: A });
  check("a paginated request returns a page plus a true total",
    paged.status === 200 && Number.isInteger(paged.data?.total) &&
      (paged.data?.patients ?? []).length <= 2,
    `rows=${(paged.data?.patients ?? []).length} total=${paged.data?.total}`);

  const paged2 = await call("/admin/patients?limit=2&offset=2", { token: A });
  check("and a second page differs from the first",
    (paged.data?.patients ?? [])[0]?.id !== (paged2.data?.patients ?? [])[0]?.id,
    `${paged.data?.patients?.[0]?.id} vs ${paged2.data?.patients?.[0]?.id}`);

  const searched = await call("/admin/patients?search=ishita", { token: A });
  check("patient search filters on the server",
    (searched.data?.patients ?? []).every((p) =>
      `${p.name} ${p.email} ${p.phone ?? ""}`.toLowerCase().includes("ishita")),
    JSON.stringify((searched.data?.patients ?? []).map((p) => p.name)));

  const body = JSON.stringify(allPatients.data ?? {});
  check("no password hash is exposed",
    !/password_hash|passwordHash|\$2[aby]\$/i.test(body),
    "a bcrypt hash appears in the payload");
  check("no token or secret is exposed",
    !/eyJhbGciOi|"token"|"refreshToken"|"accessToken"/i.test(body),
    "a token appears in the payload");
  check("the directory exposes no appointment reason or clinical note",
    !/"reason"|symptom|diagnosis/i.test(body),
    "a clinical field appears in the payload");

  /* ---------------------------------------------------------------- *
   * 8. Scheduler monitoring                                         *
   * ---------------------------------------------------------------- */
  const sched = await call("/admin/scheduler", { token: A });
  check("scheduler status responds", sched.status === 200, `HTTP ${sched.status}`);
  check("and says whether the timer is running",
    typeof sched.data?.running === "boolean" && typeof sched.data?.enabled === "boolean",
    `running=${sched.data?.running} enabled=${sched.data?.enabled}`);
  check("and includes delivery counters",
    typeof sched.data?.notifications?.deliveries?.queued === "number",
    JSON.stringify(sched.data?.notifications?.deliveries));
  check("and states its limitations rather than implying exactness",
    /approximate/i.test(sched.data?.note ?? ""),
    (sched.data?.note ?? "").slice(0, 80));
};

run()
  .then(async () => {
    for (const id of madeUsers) {
      await query("DELETE FROM notifications WHERE user_id = $1", [id]).catch(() => {});
      await query("DELETE FROM appointments WHERE doctor_id IN (SELECT id FROM doctors WHERE user_id = $1)", [id]).catch(() => {});
      await query("DELETE FROM slots WHERE doctor_id IN (SELECT id FROM doctors WHERE user_id = $1)", [id]).catch(() => {});
      await query("DELETE FROM doctors WHERE user_id = $1", [id]).catch(() => {});
    }
    await query(`DELETE FROM users WHERE email LIKE 'admin-room-%@phase12.test'`).catch(() => {});
    await closePool();
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(`  suite crashed: ${err.stack ?? err.message}`);
    await query(`DELETE FROM users WHERE email LIKE 'admin-room-%@phase12.test'`).catch(() => {});
    await closePool().catch(() => {});
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  });