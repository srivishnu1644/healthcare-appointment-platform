/**
 * End-to-end API smoke test. Run with the server already listening:
 *   node scripts/smoke.js
 */
const BASE = process.env.API_URL || "http://localhost:5000/api";

let pass = 0;
let fail = 0;

const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` :: ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

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
  return { status: res.status, body: json };
}

const login = async (email, password) => {
  const r = await call("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  return r.body?.data?.token || null;
};

const run = async () => {
  console.log(`\n=== Healthcare API smoke test (${BASE}) ===\n`);

  // --- health ---
  const health = await call("/health");
  check("health returns 200", health.status === 200, `status=${health.status}`);
  check(
    "seed data present",
    (health.body?.data?.counts?.doctors ?? 0) > 0,
    JSON.stringify(health.body?.data?.counts),
  );

  // --- auth ---
  const patientToken = await login("patient@demo.com", "patient123");
  check("patient login", !!patientToken);
  const adminToken = await login("admin@demo.com", "admin123");
  check("admin login", !!adminToken);
  const doctorToken = await login("doctor1@demo.com", "doctor123");
  check("doctor login", !!doctorToken);

  const badLogin = await call("/auth/login", {
    method: "POST",
    body: { email: "patient@demo.com", password: "wrong" },
  });
  check(
    "bad password rejected",
    badLogin.status === 401,
    `status=${badLogin.status}`,
  );

  const noAuth = await call("/appointments");
  check(
    "protected route needs auth",
    noAuth.status === 401,
    `status=${noAuth.status}`,
  );

  // --- discovery ---
  const specs = await call("/doctors/specialties", { token: patientToken });
  check("specialties list", (specs.body?.data?.specialties?.length ?? 0) > 0);

  const docs = await call("/doctors?limit=5", { token: patientToken });
  const doctors = docs.body?.data?.doctors || [];
  check("doctor discovery", doctors.length > 0, `count=${doctors.length}`);

  const filtered = await call(
    `/doctors?specialty=${encodeURIComponent(doctors[0]?.specialtyName || "")}`,
    { token: patientToken },
  );
  check(
    "specialty filter works",
    (filtered.body?.data?.doctors?.length ?? 0) > 0,
    `filter=${doctors[0]?.specialtyName}`,
  );

  const facilities = await call("/doctors/facilities", { token: patientToken });
  check("facility list", (facilities.body?.data?.facilities?.length ?? 0) > 0);

  const services = await call("/doctors/services", { token: patientToken });
  check("service list", (services.body?.data?.services?.length ?? 0) > 0);

  // --- slots + booking ---
  const doctorId = doctors[0]?.id;
  const slotsRes = await call(`/doctors/${doctorId}/slots`, {
    token: patientToken,
  });
  const slots = slotsRes.body?.data?.slots || [];
  check("doctor slots returned", slots.length > 0, `count=${slots.length}`);
  check(
    "slot dates returned",
    (slotsRes.body?.data?.dates?.length ?? 0) > 0,
    `dates=${slotsRes.body?.data?.dates?.length}`,
  );
  // Slots carry `status`, not a derived `isAvailable` flag. The server rejects
  // bookings for past slots, so only consider slots that are still ahead of us.
  // Slot timestamps are split across `date` (YYYY-MM-DD) and `startTime` (HH:mm).
  const now = Date.now();
  const slotTime = (s) =>
    new Date(`${s.date}T${s.startTime || "00:00"}:00`).getTime();
  // Skip slots this patient already booked so the suite stays idempotent
  // across repeated runs (the .data snapshot persists between runs).
  // The server's clash guard keys on date + startTime only (it blocks a patient
  // from holding two appointments at the same clock time, even with different
  // doctors), so mirror that exact key here.
  const ACTIVE = ["pending", "confirmed", "scheduled", "in-progress"];
  const mineBefore = await call("/appointments", { token: patientToken });
  const bookedKeys = new Set(
    (mineBefore.body?.data?.appointments || [])
      .filter((a) => ACTIVE.includes(a.status))
      .map((a) => `${a.date}|${a.startTime}`),
  );
  const freeSlot = slots.find(
    (s) =>
      s.status === "available" &&
      slotTime(s) > now &&
      !bookedKeys.has(`${s.date}|${s.startTime}`),
  );
  check("at least one upcoming free slot", !!freeSlot);

  if (freeSlot) {
    const booking = await call("/appointments", {
      method: "POST",
      token: patientToken,
      body: {
        doctorId,
        slotId: freeSlot.id,
        reason: "Smoke test booking",
        mode: "in-person",
      },
    });
    check(
      "booking succeeds",
      booking.status === 201 || booking.status === 200,
      `status=${booking.status} ${booking.body?.message || ""}`,
    );

    const apptId = booking.body?.data?.appointment?.id;

    const doubleBook = await call("/appointments", {
      method: "POST",
      token: patientToken,
      body: { doctorId, slotId: freeSlot.id, reason: "Should fail" },
    });
    check(
      "double booking rejected",
      doubleBook.status >= 400,
      `status=${doubleBook.status}`,
    );

    if (apptId) {
      const list = await call("/appointments", { token: patientToken });
      const mine = list.body?.data?.appointments || [];
      check(
        "booking appears in my appointments",
        mine.some((a) => a.id === apptId),
        `total=${mine.length}`,
      );

      const cancel = await call(`/appointments/${apptId}/cancel`, {
        method: "PATCH",
        token: patientToken,
        body: { reason: "Smoke test cleanup" },
      });
      check(
        "cancel works",
        cancel.status === 200,
        `status=${cancel.status} ${cancel.body?.message || ""}`,
      );

      const notifications = await call("/notifications", {
        token: patientToken,
      });
      check(
        "notification created for change",
        (notifications.body?.data?.notifications?.length ?? 0) > 0,
      );
    }
  }

  // --- AI triage ---
  const triage = await call("/ai/triage", {
    method: "POST",
    token: patientToken,
    body: { description: "chest pain and shortness of breath" },
  });
  const triageData = triage.body?.data;
  check(
    "ai triage returns urgency",
    !!triageData?.urgency,
    `urgency=${triageData?.urgency}`,
  );
  check(
    "ai triage suggests departments",
    (triageData?.departments?.length ?? 0) > 0,
    JSON.stringify(triageData?.departments),
  );
  check(
    "ai triage suggests doctors",
    (triageData?.recommendedDoctorIds?.length ?? 0) > 0,
    `count=${triageData?.recommendedDoctorIds?.length}`,
  );
  check(
    "ai triage returns advice",
    !!triageData?.advice,
    triageData?.advice?.slice(0, 60),
  );

  // --- role gating ---
  const patientAdmin = await call("/admin/overview", { token: patientToken });
  check(
    "patient blocked from admin",
    patientAdmin.status === 403,
    `status=${patientAdmin.status}`,
  );

  const overview = await call("/admin/overview", { token: adminToken });
  check("admin overview", overview.status === 200);
  check(
    "analytics present",
    !!overview.body?.data?.totals || !!overview.body?.data?.kpis,
    Object.keys(overview.body?.data || {})
      .slice(0, 6)
      .join(","),
  );

  const adminDoctors = await call("/admin/doctors", { token: adminToken });
  check("admin doctor management", adminDoctors.status === 200);

  const adminPatients = await call("/admin/patients", { token: adminToken });
  check("admin patient list", adminPatients.status === 200);

  // --- doctor dashboard ---
  const schedule = await call("/doctors/me/schedule", { token: doctorToken });
  check(
    "doctor own schedule",
    schedule.status === 200,
    `status=${schedule.status}`,
  );

  const patientSchedule = await call("/doctors/me/schedule", {
    token: patientToken,
  });
  check(
    "patient blocked from doctor schedule",
    patientSchedule.status === 403,
    `status=${patientSchedule.status}`,
  );

  // --- queue (doctorId is required) ---
  const queue = await call(`/appointments/queue?doctorId=${doctorId}`, {
    token: patientToken,
  });
  check(
    "live queue endpoint",
    queue.status === 200,
    `status=${queue.status} ${queue.body?.message || ""}`,
  );

  const queueNoDoc = await call("/appointments/queue", { token: patientToken });
  check(
    "queue requires doctorId",
    queueNoDoc.status === 400,
    `status=${queueNoDoc.status}`,
  );

  const availability = await call(
    `/appointments/availability?doctorId=${doctorId}`,
    { token: patientToken },
  );
  check("availability summary", availability.status === 200);

  // --- 404 ---
  const missing = await call("/does-not-exist", { token: patientToken });
  check(
    "unknown route 404s",
    missing.status === 404,
    `status=${missing.status}`,
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
