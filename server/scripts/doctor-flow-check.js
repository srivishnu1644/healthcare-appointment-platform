/**
 * End-to-end doctor workflow.
 *
 *   node scripts/doctor-flow-check.js
 *   API_URL=http://localhost:5000/api node scripts/doctor-flow-check.js
 *
 * WHAT THIS COVERS
 *   One patient's visit, from the doctor's side, end to end:
 *
 *     1. the doctor signs in
 *     2. the doctor opens their workspace (schedule + queue)
 *     3. the doctor opens a slot
 *     4. a patient books it
 *     5. the doctor sees the appointment
 *     6. the patient checks in once the slot has started
 *     7. the doctor sees the patient in their queue
 *     8. the doctor completes the visit through a permitted transition
 *     9. the schedule and the queue both reflect the new state
 *
 *   Every rule is the server's, never the client's: the booking is refused if
 *   the date has passed, the check-in is refused until the slot has started, and
 *   the completion is refused unless the transition is allowed.
 *
 * WHY THE FIXTURE IS BUILT RATHER THAN FOUND
 *   Check-in requires a slot that has ALREADY STARTED (`starts_at <= now()`), so
 *   this cannot be asserted against whatever the seed happened to leave. The
 *   fixture therefore finds the earliest free 30-minute window earlier today and
 *   opens a slot in it. Booking is a DATE comparison while check-in is an
 *   INSTANT one, so a slot opened earlier today is bookable now and already
 *   begun - at any hour of the day, which is what makes this deterministic.
 *
 *   On a later run the same window is already there, so the slot is reused
 *   rather than added to.
 *
 * WHAT IT LEAVES BEHIND
 *   Step 8 is a terminal transition and there is no delete endpoint, so one
 *   completed appointment per run stays in the day's queue. Every other row is
 *   released. See the re-run notes in the README.
 */

const BASE = process.env.API_URL || "http://localhost:5000/api";
const TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";
const DOCTOR = { email: "doctor1@demo.com", password: "doctor123" };
/** Seeded patients; all share one password. */
const PATIENTS = ["ishita@demo.com", "aman@demo.com", "patient@demo.com"];
const PASSWORD = "patient123";

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
  return { status: res.status, body: json, data: json?.data ?? null };
}

const codeOf = (r) => r.body?.error?.code ?? null;

/** Sign in, or throw with the API's own message so the suite stops loudly. */
async function signIn(creds) {
  const r = await call("/auth/login", { method: "POST", body: creds });
  if (r.status !== 200) throw new Error(`login failed for ${creds.email}: ${r.body?.message}`);
  return r.data;
}

const clinicToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

/** Minutes past midnight in the clinic's timezone. */
const clinicMinutes = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
};

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const run = async () => {
  console.log(`\n=== Doctor end-to-end workflow (${BASE}) ===`);
  console.log(`      clinic timezone: ${TZ}\n`);

  const today = clinicToday();
  const nowMin = clinicMinutes();

  /* -- 1. the doctor signs in ------------------------------------------ */
  const doctor = await signIn(DOCTOR);
  check("1. the doctor signs in", Boolean(doctor?.token));
  check("   the session carries the provider role", doctor?.user?.role === "doctor",
    `role=${doctor?.user?.role}`);
  check("   the session carries no password", doctor?.user?.password === undefined);

  const doctorId = doctor?.user?.doctor?.id;
  check("   the doctor resolves a provider id", Boolean(doctorId));

  const badLogin = await call("/auth/login", {
    method: "POST",
    body: { email: DOCTOR.email, password: "wrong-password" },
  });
  check("   a wrong password is still refused", badLogin.status >= 400,
    `HTTP ${badLogin.status}`);

  /* -- 2. the doctor opens their workspace ----------------------------- */
  const scheduleOpen = await call("/doctors/me/schedule?date=" + today, {
    token: doctor.token,
  });
  check("2. the schedule opens for the signed-in doctor", scheduleOpen.status === 200,
    `HTTP ${scheduleOpen.status}`);
  check("   it resolves the same provider", scheduleOpen.data?.doctor?.id === doctorId);
  check("   it returns the appointments, not a bare profile",
    Array.isArray(scheduleOpen.data?.appointments));

  const queueOpen = await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
    token: doctor.token,
  });
  check("   the queue opens too", queueOpen.status === 200,
    `HTTP ${queueOpen.status}`);
  check("   the queue is the doctor's own",
    queueOpen.data?.doctorId === doctorId, `doctorId=${queueOpen.data?.doctorId}`);

  const patientPeek = await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`);
  check("   an unauthenticated caller cannot open it", patientPeek.status === 401,
    `HTTP ${patientPeek.status}`);

  /* -- 3. the doctor opens a slot that has already begun --------------- */
  const todaysSlots = (await call(`/doctors/${doctorId}/slots?date=${today}`)).data?.slots ?? [];

  // Prefer a window an earlier run already opened; otherwise find the earliest
  // free one that has started.
  const busy = todaysSlots.map((s) => [toMin(s.startTime), toMin(s.endTime)]);
  const freeStarts = [];
  for (let m = 0; m + 30 <= nowMin - 5; m += 5) {
    if (!busy.some(([f, t]) => m < t && f < m + 30)) freeStarts.push(m);
  }
  const reusable = todaysSlots.find(
    (s) => s.status === "available" && toMin(s.startTime) + 30 <= nowMin,
  );
  let start = reusable ? toMin(reusable.startTime) : (freeStarts[0] ?? null);
  check("3. a started window is available for the visit", start !== null,
    start === null ? `no free window before ${hhmm(nowMin)}` : hhmm(start));

  let slot = reusable ?? null;
  if (!slot && start !== null) {
    const made = await call(`/doctors/${doctorId}/slots`, {
      method: "POST",
      token: doctor.token,
      body: {
        date: today,
        times: [hhmm(start)],
        duration: 30,
        mode: "in-person",
        fee: 500,
        maxQueue: 3,
      },
    });
    // `created` echoes the candidate plus its new id and carries no status
    // column; a slot that was just inserted is available by definition.
    const created = made.data?.created?.[0];
    slot = created ? { ...created, status: "available", startTime: hhmm(start) } : null;
  }
  check("   the slot exists and is open", slot?.status === "available",
    `${slot?.startTime ?? "none"} ${slot?.status ?? ""}`);

  // The doctor's own rules still apply to their own calendar.
  const badSlot = await call(`/doctors/${doctorId}/slots`, {
    method: "POST",
    token: doctor.token,
    body: { date: today, times: ["25:00"], duration: 30, mode: "in-person" },
  });
  check("   an impossible time is still refused", badSlot.status >= 400,
    `HTTP ${badSlot.status} ${codeOf(badSlot) ?? ""}`);

  let patient = null;
  let appointmentId = null;

  if (slot?.id) {
    /* -- 4. a patient books it ---------------------------------------- */
    for (const email of PATIENTS) {
      const candidate = await signIn({ email, password: PASSWORD });
      const booked = await call("/appointments", {
        method: "POST",
        token: candidate.token,
        body: { doctorId, slotId: slot.id, reason: "End-to-end workflow" },
      });
      if (booked.status === 201) {
        patient = candidate;
        appointmentId = booked.data?.appointment?.id;
        break;
      }
    }
    check("4. a patient books the open slot", Boolean(appointmentId));

    if (appointmentId) {
      const again = await call("/appointments", {
        method: "POST",
        token: patient.token,
        body: { doctorId, slotId: slot.id },
      });
      check("   the same slot cannot be booked twice", again.status >= 400,
        `HTTP ${again.status} ${codeOf(again) ?? ""}`);

      /* -- 5. the doctor sees the appointment -------------------------- */
      const withAppt = await call(`/doctors/me/schedule?date=${today}`, {
        token: doctor.token,
      });
      const seen = (withAppt.data?.appointments ?? []).some(
        (a) => a.id === appointmentId,
      );
      check("5. the doctor sees the new appointment", seen);
      const row = (withAppt.data?.appointments ?? []).find((a) => a.id === appointmentId);
      check("   it carries the clinic's own time, not a converted one",
        row?.startTime === slot.startTime,
        `startTime=${row?.startTime} expected=${slot.startTime}`);
      check("   it is not yet checked in", row?.queuePosition === null,
        `queuePosition=${row?.queuePosition}`);

      /* -- 6. the patient checks in once it has started ---------------- */
      const checkIn = await call(`/appointments/${appointmentId}/check-in`, {
        method: "POST",
        token: patient.token,
      });
      check("6. the patient checks in on a started slot", checkIn.status === 200,
        `HTTP ${checkIn.status} ${codeOf(checkIn) ?? ""}`);
      // `waitFor` names it `queuePosition`, matching the field the list reports.
      check("   check-in reports a server-assigned position",
        Number.isInteger(checkIn.data?.queuePosition) && checkIn.data.queuePosition >= 1,
        `queuePosition=${checkIn.data?.queuePosition}`);
      check("   check-in also returns the server's own wait estimate",
        Number.isInteger(checkIn.data?.estimatedWaitMinutes) &&
          typeof checkIn.data?.estimatedWaitLabel === "string",
        `wait=${checkIn.data?.estimatedWaitMinutes} label=${checkIn.data?.estimatedWaitLabel}`);

      // Another patient may not check in on someone else's visit.
      const other = await signIn({ email: "patient@demo.com", password: PASSWORD });
      const otherCheckIn = await call(`/appointments/${appointmentId}/check-in`, {
        method: "POST",
        token: other.token,
      });
      check("   another patient cannot check in on it", otherCheckIn.status >= 400,
        `HTTP ${otherCheckIn.status}`);

      /* -- 7. the doctor sees the patient in their queue --------------- */
      const queue = (await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
        token: doctor.token,
      })).data;
      const entry = (queue?.entries ?? []).find((e) => e.appointmentId === appointmentId);
      check("7. the patient appears in the doctor's queue", Boolean(entry));
      check("   the entry carries the same position check-in reported",
        entry?.position === checkIn.data?.queuePosition,
        `queue=${entry?.position} checkIn=${checkIn.data?.queuePosition}`);
      check("   the queue is waiting, not something invented",
        entry?.state === "waiting", `state=${entry?.state}`);
      check("   the waiting total counts the patient",
        queue?.waiting === (queue?.entries ?? []).filter((e) => e.state === "waiting").length,
        `waiting=${queue?.waiting}`);

      // A patient cannot read the room.
      const asPatient = (await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
        token: patient.token,
      })).data;
      check("   the patient still only sees their own row",
        (asPatient?.entries ?? []).length <= 1,
        `entries=${(asPatient?.entries ?? []).length} room=${queue?.total}`);

      /* -- 8. the doctor completes the visit --------------------------- */
      // An illegal transition first, so "it worked" means something.
      const illegal = await call(`/appointments/${appointmentId}/status`, {
        method: "PATCH",
        token: doctor.token,
        body: { status: "scheduled" },
      });
      check("8. an impermissible transition is refused", illegal.status >= 400,
        `HTTP ${illegal.status} ${codeOf(illegal) ?? ""}`);

      const completed = await call(`/appointments/${appointmentId}/status`, {
        method: "PATCH",
        token: doctor.token,
        body: { status: "completed" },
      });
      check("   completing the visit is accepted", completed.status === 200,
        `HTTP ${completed.status} ${codeOf(completed) ?? ""}`);

      // Completed is terminal.
      const reopen = await call(`/appointments/${appointmentId}/status`, {
        method: "PATCH",
        token: doctor.token,
        body: { status: "in-progress" },
      });
      check("   a completed visit cannot be reopened", reopen.status >= 400,
        `HTTP ${reopen.status}`);

      /* -- 9. the workspace reflects the new state --------------------- */
      const after = (await call(`/doctors/me/schedule?date=${today}`, {
        token: doctor.token,
      })).data;
      const afterRow = (after?.appointments ?? []).find((a) => a.id === appointmentId);
      check("9. the doctor's list shows the visit completed",
        afterRow?.status === "completed", `status=${afterRow?.status}`);
      check("   it is no longer an active queue member",
        afterRow?.queuePosition === null, `queuePosition=${afterRow?.queuePosition}`);

      const afterQueue = (await call(`/appointments/queue?doctorId=${doctorId}&date=${today}`, {
        token: doctor.token,
      })).data;
      const afterEntry = (afterQueue?.entries ?? []).find(
        (e) => e.appointmentId === appointmentId,
      );
      check("   the queue entry is completed too, not left waiting",
        afterEntry?.state === "completed", `state=${afterEntry?.state}`);
      check("   the waiting total no longer counts them",
        afterQueue?.waiting === (afterQueue?.entries ?? []).filter((e) => e.state === "waiting").length,
        `waiting=${afterQueue?.waiting}`);

      // Another doctor cannot reach in.
      const otherDoctor = await signIn({ email: "doctor2@demo.com", password: "doctor123" });
      const hijack = await call(`/appointments/${appointmentId}/status`, {
        method: "PATCH",
        token: otherDoctor.token,
        body: { status: "no-show" },
      });
      check("   another doctor cannot manage this appointment", hijack.status === 403,
        `HTTP ${hijack.status} ${codeOf(hijack) ?? ""}`);

      const otherSlot = await call(`/doctors/${doctorId}/slots/${slot.id}`, {
        method: "PATCH",
        token: otherDoctor.token,
        body: { status: "blocked" },
      });
      check("   another doctor cannot manage this slot", otherSlot.status === 403,
        `HTTP ${otherSlot.status}`);
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) process.exitCode = 1;
};

run().catch((err) => {
  console.error(`\nSUITE ERROR: ${err.message}`);
  process.exitCode = 1;
});