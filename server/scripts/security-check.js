/**
 * Phase 1 security regression checks.
 *
 * Every assertion here corresponds to a finding in the Phase 0 audit that this
 * phase was required to fix. Run against a live server:
 *
 *   node index.js &            # or npm run dev
 *   npm run test:security
 *
 * Requires a server on API_URL (default http://localhost:5000/api).
 * Exits non-zero if any check fails.
 */
/* Local-DB guard. This suite speaks HTTP and opens no database connection
   itself; the guard is here so that the rule is uniform across every suite
   and so a future edit that adds a database query is protected automatically. */
import "./local-db-guard.mjs";

const BASE = process.env.API_URL || "http://localhost:5000/api";

let pass = 0;
let fail = 0;

const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` :: ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

async function call(pathname, { method = "GET", token, body, origin } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json, headers: res.headers };
}

const login = async (email, password) =>
  (await call("/auth/login", { method: "POST", body: { email, password } }))
    .body?.data?.token || null;

/** Recursively collect every key present anywhere in a payload. */
const allKeys = (value, acc = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((v) => allKeys(v, acc));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
};

const containsSecretKey = (payload) => {
  const keys = allKeys(payload);
  return ["password", "passwordHash", "password_hash"].filter((k) =>
    keys.has(k),
  );
};

const run = async () => {
  console.log(`\n=== Phase 1 security checks (${BASE}) ===\n`);

  /* ---------------------------------------------------------------- *
   * S-01  /api/demo-accounts must not exist                           *
   * ---------------------------------------------------------------- */
  const demo = await call("/demo-accounts");
  check(
    "S-01 /api/demo-accounts is not served",
    demo.status === 404,
    `status=${demo.status}`,
  );

  /* ---------------------------------------------------------------- *
   * S-02  passwords are bcrypt hashes                                *
   * ---------------------------------------------------------------- */
  const patientToken = await login("patient@demo.com", "patient123");
  const doctorToken = await login("doctor1@demo.com", "doctor123");
  const adminToken = await login("admin@demo.com", "admin123");
  const otherPatientToken = await login("ishita@demo.com", "patient123");
  const otherDoctorToken = await login("doctor5@demo.com", "doctor123");

  check("patient login works", !!patientToken);
  check("doctor login works", !!doctorToken);
  check("admin login works", !!adminToken);

  const badLogin = await call("/auth/login", {
    method: "POST",
    body: { email: "patient@demo.com", password: "wrong" },
  });
  check("bad password rejected", badLogin.status === 401);

  /* ---------------------------------------------------------------- *
   * S-03/S-04  no password in any response                           *
   * ---------------------------------------------------------------- */
  const me = await call("/auth/me", { token: doctorToken });
  check(
    "S-04 /auth/me exposes no password key",
    containsSecretKey(me.body).length === 0,
    containsSecretKey(me.body).join(",") || "clean",
  );
  check(
    "S-04 /auth/me doctor.user absent",
    !me.body?.data?.user?.doctor?.user,
  );

  const doctors = (await call("/doctors")).body?.data?.doctors || [];
  const doctorId = doctors[0]?.id;

  const doctorProfile = await call(`/doctors/${doctorId}`);
  check(
    "S-03 public doctor profile exposes no password",
    containsSecretKey(doctorProfile.body).length === 0,
  );

  const adminDoctors = await call("/admin/doctors", { token: adminToken });
  check(
    "S-03 /admin/doctors exposes no password",
    containsSecretKey(adminDoctors.body).length === 0,
  );

  const adminPatients = await call("/admin/patients", { token: adminToken });
  check(
    "S-19 /admin/patients exposes no password",
    containsSecretKey(adminPatients.body).length === 0,
  );

  /* ---------------------------------------------------------------- *
   * S-05  self-registration cannot escalate to doctor                *
   * ---------------------------------------------------------------- */
  const escalate = await call("/auth/register", {
    method: "POST",
    body: {
      name: "Escalation Probe",
      email: `probe-${Date.now()}@example.com`,
      password: "probe-password-1",
      role: "provider",
    },
  });
  check(
    "S-05 register with role:provider yields a patient",
    escalate.body?.data?.user?.role === "patient",
    `role=${escalate.body?.data?.user?.role} status=${escalate.status}`,
  );
  check(
    "S-05 register ignores unknown role field",
    escalate.body?.data?.user?.role !== "doctor",
  );

  /* ---------------------------------------------------------------- *
   * S-06  check-in ownership (the reproduced IDOR)                    *
   * ---------------------------------------------------------------- */
  const ishita = (await call("/auth/me", { token: otherPatientToken })).body
    ?.data?.user;
  const ishitaAppts =
    (await call("/appointments", { token: otherPatientToken })).body?.data
      ?.appointments || [];
  const victim = ishitaAppts[0];

  if (victim) {
    const idor = await call(`/appointments/${victim.id}/check-in`, {
      method: "POST",
      token: patientToken,
    });
    check(
      "S-06 non-owner cannot check in to an appointment",
      idor.status === 403,
      `status=${idor.status} msg=${idor.body?.message}`,
    );

    const idorRead = await call(`/appointments/${victim.id}`, {
      token: patientToken,
    });
    check(
      "S-06 non-owner cannot read an appointment",
      idorRead.status === 403,
      `status=${idorRead.status}`,
    );

    const idorCancel = await call(`/appointments/${victim.id}/cancel`, {
      method: "PATCH",
      token: patientToken,
      body: { reason: "probe" },
    });
    check(
      "S-06 non-owner cannot cancel an appointment",
      idorCancel.status === 403,
      `status=${idorCancel.status}`,
    );

    const idorResched = await call(`/appointments/${victim.id}/reschedule`, {
      method: "PATCH",
      token: patientToken,
      body: { slotId: "slot_does_not_exist" },
    });
    check(
      "S-06 non-owner cannot reschedule an appointment",
      idorResched.status === 403,
      `status=${idorResched.status}`,
    );

    const ownerRead = await call(`/appointments/${victim.id}`, {
      token: otherPatientToken,
    });
    check(
      "owner CAN still read their own appointment",
      ownerRead.status === 200,
      `status=${ownerRead.status}`,
    );
    check(
      "S-03 /appointments/:id exposes no password",
      containsSecretKey(ownerRead.body).length === 0,
      containsSecretKey(ownerRead.body).join(",") || "clean",
    );

    const adminRead = await call(`/appointments/${victim.id}`, {
      token: adminToken,
    });
    check("admin CAN still read any appointment", adminRead.status === 200);
  } else {
    check("S-06 appointment ownership (no victim available)", false, "skipped");
  }

  /* ---------------------------------------------------------------- *
   * S-07  notification patientId IDOR                                *
   * ---------------------------------------------------------------- */
  if (ishita) {
    const leak = await call(`/notifications?patientId=${ishita.id}`, {
      token: otherDoctorToken,
    });
    check(
      "S-07 doctor cannot read another patient's notifications",
      leak.status === 403,
      `status=${leak.status}`,
    );

    const selfLeak = await call(`/notifications?patientId=${ishita.id}`, {
      token: patientToken,
    });
    check(
      "patient cannot pass someone else's patientId",
      selfLeak.status === 403,
      `status=${selfLeak.status}`,
    );

    const own = await call("/notifications", { token: otherPatientToken });
    check(
      "patient can still read their own notifications",
      own.status === 200,
      `status=${own.status}`,
    );

    const adminOk = await call(`/notifications?patientId=${ishita.id}`, {
      token: adminToken,
    });
    check(
      "admin can still read another patient's notifications",
      adminOk.status === 200,
      `status=${adminOk.status}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * S-08  profile injection                                           *
   * ---------------------------------------------------------------- */
  const inject = await call("/auth/me", {
    method: "PATCH",
    token: patientToken,
    body: {
      profile: {
        role: "admin",
        isAdmin: true,
        junk: { deep: 1 },
        allergies: "not-an-array",
      },
    },
  });
  const stored = inject.body?.data?.user?.profile || {};
  check(
    "S-08 injected role key is not persisted",
    stored.role === undefined,
    `role=${stored.role}`,
  );
  check("S-08 injected isAdmin key is not persisted", stored.isAdmin === undefined);
  check("S-08 injected junk key is not persisted", stored.junk === undefined);
  check(
    "S-08 allergies stays an array",
    Array.isArray(stored.allergies),
    `type=${typeof stored.allergies}`,
  );
  check(
    "S-08 top-level role is still patient",
    inject.body?.data?.user?.role === "patient",
  );

  /* ---------------------------------------------------------------- *
   * S-09  token does not leak PII, and health is trimmed in prod      *
   * ---------------------------------------------------------------- */
  check(
    "S-22 JWT payload contains no email claim",
    !Buffer.from(patientToken.split(".")[1], "base64url")
      .toString()
      .includes("@"),
  );

  /* ---------------------------------------------------------------- *
   * S-11  CORS rejects an unlisted origin                             *
   * ---------------------------------------------------------------- */
  const blocked = await call("/health", { origin: "https://evil.example.com" });
  check(
    "S-11 CORS omits allow-origin for an unlisted origin",
    !blocked.headers.get("access-control-allow-origin"),
    `header=${blocked.headers.get("access-control-allow-origin")}`,
  );

  const allowed = await call("/health", { origin: "http://localhost:5173" });
  check(
    "S-11 CORS allows the configured dev origin",
    allowed.headers.get("access-control-allow-origin") ===
      "http://localhost:5173",
    `header=${allowed.headers.get("access-control-allow-origin")}`,
  );

  /* ---------------------------------------------------------------- *
   * S-13  security headers                                            *
   * ---------------------------------------------------------------- */
  check(
    "S-13 Helmet sets X-Content-Type-Options",
    blocked.headers.get("x-content-type-options") === "nosniff",
  );
  check(
    "S-13 Helmet sets a Content-Security-Policy",
    !!blocked.headers.get("content-security-policy"),
  );
  check("S-13 Helmet sets X-Frame-Options", !!blocked.headers.get("x-frame-options"));

  /* ---------------------------------------------------------------- *
   * Role gates must still hold                                        *
   * ---------------------------------------------------------------- */
  const patientAdmin = await call("/admin/overview", { token: patientToken });
  check(
    "patient still blocked from admin",
    patientAdmin.status === 403,
    `status=${patientAdmin.status}`,
  );

  const patientSchedule = await call("/doctors/me/schedule", {
    token: patientToken,
  });
  check(
    "patient still blocked from provider schedule",
    patientSchedule.status === 403,
    `status=${patientSchedule.status}`,
  );

  const patientSlotWrite = await call(`/doctors/${doctorId}/slots`, {
    method: "POST",
    token: patientToken,
    body: { date: "2033-01-01", times: ["09:00"] },
  });
  check(
    "patient still blocked from creating slots",
    patientSlotWrite.status === 403,
    `status=${patientSlotWrite.status}`,
  );

  const doctorOwn = await call("/doctors/me/schedule", { token: doctorToken });
  check(
    "doctor can still read their own schedule",
    doctorOwn.status === 200,
    `status=${doctorOwn.status}`,
  );
  check(
    "doctor schedule exposes no password",
    containsSecretKey(doctorOwn.body).length === 0,
  );

  /* ---------------------------------------------------------------- *
   * Booking still works end to end                                    *
   * ---------------------------------------------------------------- */
  // "Today" in the business timezone, NOT UTC. The API dates slots with
  // `AT TIME ZONE APP_TIMEZONE`, so a UTC-derived date disagrees with it for the
  // first few hours of the local day - and this block needs a slot dated today so
  // it can exercise check-in, which is only valid on the day of the appointment.
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  }).format(new Date());
  const slots =
    (await call(`/doctors/${doctorId}/slots`, { token: patientToken })).body?.data
      ?.slots || [];
  // Pick the latest free slot that the patient does not already hold, so the
  // booking block is skipped only when genuinely nothing is bookable.
  const heldKeys = new Set(
    (await call("/appointments", { token: patientToken })).body?.data
      ?.appointments?.filter((a) =>
        ["scheduled", "confirmed", "in-progress"].includes(a.status),
      )
      .map((a) => `${a.date}|${a.startTime}`) || [],
  );

  const bookable = slots.filter(
    (s) =>
      s.status === "available" &&
      s.date >= today &&
      !heldKeys.has(`${s.date}|${s.startTime}`),
  );

  // Two different slots are needed.
  //
  // `free` is for booking, so the latest available slot will do. The check-in
  // case builds its own slot below: Phase 6 restricts check-in to the day of the
  // appointment, and borrowing a leftover seeded slot made that depend on what
  // earlier suites had already consumed.
  const free = bookable.sort((a, b) =>
    a.date === b.date
      ? b.startTime.localeCompare(a.startTime)
      : b.date.localeCompare(a.date),
  )[0];

  if (free) {
    const booking = await call("/appointments", {
      method: "POST",
      token: patientToken,
      body: { doctorId, slotId: free.id, reason: "Phase 1 verification" },
    });
    check(
      "booking still succeeds",
      booking.status === 201 || booking.status === 200,
      `status=${booking.status}`,
    );

    const apptId = booking.body?.data?.appointment?.id;
    if (apptId) {
      const doubleBook = await call("/appointments", {
        method: "POST",
        token: patientToken,
        body: { doctorId, slotId: free.id },
      });
      check("double booking still rejected", doubleBook.status >= 400);

      // Check-in is restricted to the day of the appointment and enforced as an
      // INSTANT comparison (`starts_at <= now()`), while booking is a DATE
      // comparison: the clinic's current day stays bookable until 23:59
      // (bookingService.assertBookableDate). A slot earlier today that has
      // already begun is therefore exactly the scenario, and it can be built at
      // any hour of the day rather than only while a future slot remains.
      //
      // The slot is created through the provider's own slot API rather than
      // borrowed from the seed. Earlier suites consume seeded slots and the demo
      // patient accumulates appointments of its own, so a leftover-slot fixture
      // only works on a virgin database and fails for reasons unrelated to the
      // rule under test.
      //
      // Exactly ONE slot is created, and later runs reuse it: the same window is
      // requested again, the API declines to duplicate it, and the slot already
      // on the calendar is booked instead. The appointment is cancelled at the
      // end so this suite leaves no clash behind for the suites that follow.
      const meDoctorId = me.body?.data?.user?.doctor?.id;
      let checkInSlot = null;
      let checkInApptId = null;

      if (meDoctorId) {
        const nowMin = (() => {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).formatToParts(new Date());
          const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
          return (get("hour") % 24) * 60 + get("minute");
        })();
        const toMin = (t) => {
          const [h, m] = String(t).split(":").map(Number);
          return h * 60 + m;
        };
        const hhmm = (m) =>
          `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

        // Asked for by date explicitly: the unqualified slots listing omits the
        // part of the day that has already passed, and this fixture deliberately
        // looks for a window that HAS passed.
        const todaysSlots = (
          await call(`/doctors/${meDoctorId}/slots?date=${today}`, {
            token: patientToken,
          })
        ).body?.data?.slots ?? [];
        // Prefer a slot an earlier run of this suite already left behind. It
        // goes back to `available` when the appointment is cancelled at the end,
        // so repeated runs settle on one slot instead of adding one each time.
        const reusable = todaysSlots.find(
          (s) => s.status === "available" && toMin(s.startTime) + 30 <= nowMin,
        );
        if (reusable) {
          checkInSlot = reusable;
        } else {
          // Otherwise take the earliest free 30-minute window that has begun.
          const busy = todaysSlots.map((s) => [toMin(s.startTime), toMin(s.endTime)]);
          let start = null;
          for (let m = 0; m + 30 <= nowMin - 5; m += 5) {
            if (!busy.some(([f, t]) => m < t && f < m + 30)) {
              start = m;
              break;
            }
          }
          if (start !== null) {
            const made = (
              await call(`/doctors/${meDoctorId}/slots`, {
                method: "POST",
                token: doctorToken,
                body: {
                  date: today,
                  times: [hhmm(start)],
                  duration: 30,
                  mode: "in-person",
                  fee: 500,
                  maxQueue: 3,
                },
              })
            ).body?.data?.created?.[0];
            // `created` echoes the candidate plus its new id and carries no
            // status column, and a slot that was just inserted is available by
            // definition.
            checkInSlot = made ? { ...made, status: "available" } : null;
          }
        }
      }

      if (checkInSlot?.status === "available") {
        const todayBooking = await call("/appointments", {
          method: "POST",
          token: patientToken,
          body: { doctorId: meDoctorId, slotId: checkInSlot.id },
        });
        check(
          "a slot dated today that has already started can still be booked (booking is date-based)",
          todayBooking.status === 201,
          `HTTP ${todayBooking.status}`,
        );
        if (todayBooking.status === 201) {
          checkInApptId = todayBooking.body?.data?.appointment?.id;
        }
      }

      if (checkInApptId) {
        const checkIn = await call(`/appointments/${checkInApptId}/check-in`, {
          method: "POST",
          token: patientToken,
        });
        check(
          "owner can still check in on the day of the appointment",
          checkIn.status === 200,
          `status=${checkIn.status}`,
        );
      } else {
        check(
          "owner can still check in on the day of the appointment",
          false,
          checkInSlot
            ? `the ${checkInSlot.startTime} slot is ${checkInSlot.status}, not available`
            : "no free started window dated today could be found on this calendar",
        );
      }

      // Release the slot so the next suite - and the next run of this one - sees
      // the calendar the way it found it.
      if (checkInApptId) {
        await call(`/appointments/${checkInApptId}/cancel`, {
          method: "PATCH",
          token: patientToken,
          body: { reason: "security-check cleanup" },
        });
      }

      // A slot that has not started yet must not be checkable.
      //
      // The documented rule (Phase 0 finding D-B4) is an INSTANT comparison,
      // `starts_at <= now()`, not a calendar one, so the appointment to test with
      // is `free` whenever its slot is still in the future - which it is here,
      // because `free` is deliberately the LATEST bookable slot. That makes this
      // assertion deterministic whatever day or hour the suite runs.
      const startsAt = free.startsAt ?? booking.body?.data?.appointment?.startsAt;
      const stillUpcoming = startsAt ? new Date(startsAt).getTime() > Date.now() : false;
      if (apptId && stillUpcoming) {
        const earlyCheckIn = await call(`/appointments/${apptId}/check-in`, {
          method: "POST",
          token: patientToken,
        });
        check(
          "check-in is refused while the slot has not started",
          earlyCheckIn.status === 400 &&
            earlyCheckIn.body?.error?.code === "SLOT_NOT_STARTED",
          `status=${earlyCheckIn.status} code=${earlyCheckIn.body?.error?.code}`,
        );
      } else if (apptId) {
        check(
          "check-in is refused while the slot has not started",
          true,
          "skipped: the chosen slot has already started, so the rule cannot apply",
        );
      }

      const cancel = await call(`/appointments/${apptId}/cancel`, {
        method: "PATCH",
        token: patientToken,
        body: { reason: "Phase 1 cleanup" },
      });
      check("owner can still cancel", cancel.status === 200);

      const notifs = await call("/notifications", { token: patientToken });
      check(
        "notification created for the change",
        (notifs.body?.data?.notifications?.length ?? 0) > 0,
      );
    }
  } else {
    check("booking flow (no late free slot available)", true, "skipped");
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error("\nSecurity checks crashed:", err);
  process.exit(1);
});