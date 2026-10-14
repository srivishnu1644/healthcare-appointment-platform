#!/usr/bin/env node
/**
 * Phase 13 — validation and error handling.
 *
 * The shape of this suite is the opposite of a "the bad input was rejected"
 * smoke test. For almost every rule it asserts BOTH halves:
 *
 *   * the invalid value is refused, with the right status AND the right code;
 *   * the valid value is still accepted, and where a boundary exists, the value
 *     immediately on the other side of it is refused.
 *
 * A rejection test on its own is satisfied by a route that rejects everything,
 * and several of the defects found in this phase were rules that fired on the
 * bad value but were unreachable, wrong, or silently ignored.
 *
 *   node scripts/validation-check.js
 */
import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import { query, closePool } from "../src/config/database.js";

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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return {
    status: res.status,
    data: json?.data,
    code: json?.error?.code,
    details: json?.error?.details ?? [],
  };
};

const login = async (email, password) =>
  (await call("/auth/login", { method: "POST", body: { email, password } })).data;

/**
 * Assert an invalid value is refused AND a valid one is accepted.
 *
 * `valid` is what proves the rule is a rule rather than a blanket rejection.
 */
const pair = async (label, path, invalid, { wantStatus, wantCode, valid, method = "GET", token, validExpect = 200 }) => {
  const bad = await call(path, { method, token, body: invalid });
  check(
    `refused: ${label}`,
    bad.status === wantStatus && (!wantCode || bad.code === wantCode),
    `got HTTP ${bad.status} ${bad.code ?? ""} (wanted ${wantStatus} ${wantCode ?? "*"})`,
  );

  if (valid !== undefined) {
    const good = await call(path, { method, token, body: valid });
    check(
      `accepted: ${label}`,
      good.status === validExpect,
      `valid input got HTTP ${good.status}, not ${validExpect}`,
    );
  }
};

const run = async () => {
  const patient = await login("patient@demo.com", "patient123");
  const doctor = await login("doctor1@demo.com", "doctor123");
  const admin = await login("admin@demo.com", "admin123");
  if (!patient?.token || !doctor?.token || !admin?.token) {
    throw new Error("could not log in as the three demo roles");
  }
  const P = patient.token;
  const D = doctor.token;
  const A = admin.token;

  const doctorId = (await call("/doctors")).data?.doctors?.[0]?.id;

  /* ================================================================ *
   * 1. The rule set itself
   *
   * Asserted directly against the middleware, because the property that
   * matters - a declared rule actually firing - is invisible from HTTP if
   * every route happens to omit that field.
   * ================================================================ */
  const validate = (await import("../src/middlewares/validateRequest.js")).default;
  const runRule = (rules, payload, source = "query") =>
    new Promise((resolve) => {
      validate(rules, source)(
        { [source]: JSON.parse(JSON.stringify(payload)) },
        {},
        (err) =>
          resolve(
            err
              ? { errors: err.details?.map((d) => `${d.field}: ${d.message}`) ?? [] }
              : { errors: [] },
          ),
      );
    });

  // `pattern` did not exist before Phase 13, and its absence was silent.
  check(
    "the validator honours a pattern rule",
    (await runRule({ s: { pattern: "^[a-z]+$" } }, { s: "abc" })).errors.length === 0 &&
      (await runRule({ s: { pattern: "^[a-z]+$" } }, { s: "ABC" })).errors.length === 1,
  );

  // A route could previously declare a nested rule and nothing would happen.
  const nested = { profile: { type: "object", gender: { type: "string", enum: ["male", "female"] } } };
  check(
    "a nested rule fires rather than being silently ignored",
    (await runRule(nested, { profile: { gender: "male" } }, "body")).errors.length === 0,
  );
  check(
    "and it rejects a nested value outside its rule",
    (await runRule(nested, { profile: { gender: "banana" } }, "body")).errors.length === 1,
  );
  check(
    "nested rule failures are reported with a dotted path",
    (await runRule(nested, { profile: { gender: "banana" } }, "body")).errors[0]?.startsWith(
      "profile.gender:",
    ),
    (await runRule(nested, { profile: { gender: "banana" } }, "body")).errors[0],
  );

  // Two levels deep, because one level can pass by coincidence.
  check(
    "nesting recurses more than one level",
    (
      await runRule(
        { a: { type: "object", b: { type: "object", c: { type: "string", maxLength: 2 } } } },
        { a: { b: { c: "far too long" } } },
        "body",
      )
    ).errors.length === 1,
  );

  // An object has no `.length`, so length bounds could never see it.
  check(
    "maxKeys bounds an object",
    (await runRule({ o: { type: "object", maxKeys: 2 } }, { o: { a: 1, b: 2, c: 3 } }, "body")).errors.length === 1 &&
      (await runRule({ o: { type: "object", maxKeys: 3 } }, { o: { a: 1, b: 2, c: 3 } }, "body")).errors.length === 0,
  );

  // `date` is deliberately shape-only so the slot contract keeps answering 400
  // INVALID_DATE. `calendarDate` is the strict one. Both are asserted, because
  // conflating them is exactly the regression Phase 13 introduced and reverted.
  check(
    "type:date is SHAPE only (the slot route's 400 contract depends on it)",
    (await runRule({ d: { type: "date" } }, { d: "2026-02-31" })).errors.length === 0,
  );
  check(
    "type:date still rejects a non-date",
    (await runRule({ d: { type: "date" } }, { d: "nonsense" })).errors.length === 1,
  );
  for (const [label, value] of [
    ["an impossible day", "2026-02-31"],
    ["an impossible month", "2026-13-01"],
    ["an unpadded month", "2026-1-5"],
    ["day zero", "2026-10-00"],
  ]) {
    check(
      `type:calendarDate rejects ${label}`,
      (await runRule({ d: { type: "calendarDate" } }, { d: value })).errors.length === 1,
    );
  }
  check(
    "type:calendarDate accepts a real leap day",
    (await runRule({ d: { type: "calendarDate" } }, { d: "2024-02-29" })).errors.length === 0,
  );
  check(
    "type:calendarDate rejects a non-leap 29 February",
    (await runRule({ d: { type: "calendarDate" } }, { d: "2026-02-29" })).errors.length === 1,
  );

  // `enumList` keeps the comma-separated contract AND rejects nonsense.
  const S = ["scheduled", "confirmed", "in-progress", "completed", "cancelled", "no-show"];
  const enumRule = { status: { type: "string", enumList: S } };
  check(
    "enumList accepts a single value",
    (await runRule(enumRule, { status: "scheduled" })).errors.length === 0,
  );
  check(
    "enumList accepts a comma-separated list (an existing contract)",
    (await runRule(enumRule, { status: "scheduled,confirmed" })).errors.length === 0,
  );
  check(
    "enumList rejects an unknown value",
    (await runRule(enumRule, { status: "bogus" })).errors.length === 1,
  );
  check(
    "enumList rejects one bad value inside an otherwise valid list",
    (await runRule(enumRule, { status: "scheduled,bogus" })).errors.length === 1,
  );

  check(
    "type:uuid accepts a canonical uuid",
    (await runRule({ id: { type: "uuid" } }, { id: "3ff762bb-9f6b-47fe-b1b1-6bef7c62e0ae" })).errors.length === 0,
  );
  for (const bad of ["not-a-uuid", "3ff762bb9f6b47feb1b16bef7c62e0ae", "{3ff762bb-9f6b-47fe-b1b1-6bef7c62e0ae}", "3ff762bb-9f6b-47fe-b1b1-6bef7c62e0aez"]) {
    check(
      `type:uuid rejects ${JSON.stringify(bad)}`,
      (await runRule({ id: { type: "uuid" } }, { id: bad })).errors.length === 1,
    );
  }
  // An empty string is "absent" to this validator, by design and everywhere, so
  // `type` alone does not reject it - `required` does. Both halves asserted so
  // the distinction is recorded rather than assumed.
  check(
    "an empty value is treated as absent, not as a type failure",
    (await runRule({ id: { type: "uuid" } }, { id: "" })).errors.length === 0,
  );
  check(
    "and `required` is what rejects it",
    (await runRule({ id: { required: true, type: "uuid" } }, { id: "" })).errors.length === 1,
  );

  /* ================================================================ *
   * 2. Pagination bounds, on both sides of every edge
   * ================================================================ */
  // `paginated: false` for endpoints that do not take an offset. `/notifications`
  // returns the most recent N and has never had paging; asking it to reject
  // `offset=-1` would be asserting a contract that was never offered.
  for (const [path, token, paginated] of [
    ["/appointments", P, true],
    ["/notifications", P, false],
    ["/admin/appointments", A, true],
    ["/admin/patients", A, true],
    ["/admin/queue", A, true],
  ]) {
    const atMin = await call(`${path}?limit=1&offset=0`, { token });
    check(`${path} accepts the minimum page size`, atMin.status === 200, `HTTP ${atMin.status}`);
    const atZero = await call(`${path}?limit=0`, { token });
    check(`${path} refuses limit=0`, atZero.status === 422, `HTTP ${atZero.status}`);
    const atNeg = await call(`${path}?limit=-1`, { token });
    check(`${path} refuses a negative limit`, atNeg.status === 422, `HTTP ${atNeg.status}`);
    if (paginated) {
      const atNegOffset = await call(`${path}?offset=-1`, { token });
      check(`${path} refuses a negative offset`, atNegOffset.status === 422, `HTTP ${atNegOffset.status}`);
    }
    const huge = await call(`${path}?limit=100000`, { token });
    check(`${path} refuses an oversized limit`, huge.status === 422, `HTTP ${huge.status}`);
  }

  /* ================================================================ *
   * 3. No malformed input may become a 500
   *
   * Each of these reached a SQL cast before Phase 13 and answered
   * INTERNAL_ERROR. A 5xx here is always a defect, never an acceptable
   * answer to bad input.
   * ================================================================ */
  const fiveHundredHunters = [
    ["negative notification limit", "/notifications?limit=-1", P],
    ["impossible queue date", `/appointments/queue?doctorId=${doctorId}&date=2026-02-31`, P],
    ["garbage queue date", `/appointments/queue?doctorId=${doctorId}&date=nonsense`, P],
    ["impossible appointment from", "/appointments?from=2026-02-31", P],
    ["garbage appointment to", "/appointments?to=garbage", P],
    ["impossible admin from", "/admin/appointments?from=2026-02-31", A],
    ["malformed notification id", "/notifications/not-a-uuid/read", P],
    ["malformed availability date", `/appointments/availability?doctorId=${doctorId}&date=2026-13-01`, P],
  ];
  for (const [label, path, token] of fiveHundredHunters) {
    const method = path.endsWith("/read") ? "PATCH" : "GET";
    const r = await call(path, { method, token });
    check(
      `no 500 for ${label}`,
      r.status < 500,
      `HTTP ${r.status} ${r.code ?? ""}`,
    );
  }

  /* ================================================================ *
   * 3b. Specific error codes are preserved where they already existed
   *
   * Phase 13 added route validation to several endpoints, and twice it silently
   * replaced a specific 400 with a generic 422. An existing suite caught both.
   * These assertions pin the specific codes so the same replacement cannot pass
   * unnoticed next time.
   * ================================================================ */
  for (const [label, path] of [
    ["live queue", "/appointments/queue"],
    ["availability", "/appointments/availability"],
  ]) {
    const missing = await call(path, { token: P });
    check(
      `${label}: a missing doctorId keeps its specific 400 MISSING_DOCTOR`,
      missing.status === 400 && missing.code === "MISSING_DOCTOR",
      `HTTP ${missing.status} ${missing.code ?? ""}`,
    );
    const malformed = await call(`${path}?doctorId=not-a-uuid`, { token: P });
    check(
      `${label}: a malformed doctorId is refused rather than reaching a uuid cast`,
      malformed.status === 422 && malformed.code === "VALIDATION_ERROR",
      `HTTP ${malformed.status} ${malformed.code ?? ""}`,
    );
  }

  // The slot endpoint has the same shape: a real day absent from the calendar is
  // the CONTROLLER's precise `400 INVALID_DATE`, which is why the shared `date`
  // type stayed shape-only.
  const impossibleSlotDay = await call(`/doctors/${doctorId}/slots`, {
    method: "POST",
    token: A,
    body: { date: "2026-02-31", times: ["10:00"], duration: 30, mode: "in-person", fee: 300 },
  });
  check(
    "a non-existent slot day keeps its specific 400 INVALID_DATE",
    impossibleSlotDay.status === 400 && impossibleSlotDay.code === "INVALID_DATE",
    `HTTP ${impossibleSlotDay.status} ${impossibleSlotDay.code ?? ""}`,
  );

  /* ================================================================ *
   * 3c. A body that is not JSON at all is a 400, not a 500
   *
   * Regression. body-parser runs before any route handler, so its parse
   * failures arrived at the error handler as raw exceptions. Nothing recognised
   * them, so a truncated or malformed body produced INTERNAL_ERROR and a 500 -
   * blaming the server for the caller's typo. The endpoint is now mapped to
   * 400 INVALID_JSON.
   *
   * This needs a caller that does NOT stringify: `call` above always produces
   * valid JSON, so the bug is unreachable through it.
   *
   * The matching negative assertion matters as much as the positive one: a
   * handler that mapped everything to 400 would pass "no 500" while hiding
   * genuine faults, so the real 500 path is pinned at the end.
   * ================================================================ */
  const rawBody = async (path, { method = "POST", token, payload } = {}) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { method, headers, body: payload });
    const json = await res.json().catch(() => null);
    return { status: res.status, code: json?.error?.code, message: json?.error?.message ?? "" };
  };

  const badBodies = [
    ["truncated object", '{"email":"a@b.com"'],
    ["bare opening brace", "{"],
    ["not json at all", "this is not json"],
    ["single quotes", "{'email':'a@b.com'}"],
    ["trailing comma", '{"email":"a@b.com",}'],
  ];
  for (const [label, payload] of badBodies) {
    const r = await rawBody("/auth/login", { payload });
    check(
      `${label} is a 400 INVALID_JSON, not a 500`,
      r.status === 400 && r.code === "INVALID_JSON",
      `HTTP ${r.status} ${r.code ?? ""}`,
    );
  }

  const payloadLeak = await rawBody("/auth/login", {
    payload: '{"token":"super-secret-value"',
  });
  check(
    "the rejected payload is not echoed back to the caller",
    !/super-secret-value/.test(payloadLeak.message),
    payloadLeak.message.slice(0, 80),
  );

  const authedBad = await rawBody("/auth/me", {
    method: "PATCH",
    token: P,
    payload: "{",
  });
  check(
    "an authenticated route rejects a malformed body the same way",
    authedBad.status === 400 && authedBad.code === "INVALID_JSON",
    `HTTP ${authedBad.status} ${authedBad.code ?? ""}`,
  );

  const stillFine = await call("/auth/me", { token: P });
  check(
    "and the same request with a valid body still succeeds",
    stillFine.status === 200,
    `HTTP ${stillFine.status}`,
  );

  const unknown = await call("/no-such-route/at/all", { method: "POST", body: {} });
  check(
    "a genuine server fault path is untouched by the new mapping",
    unknown.status === 404,
    `HTTP ${unknown.status}`,
  );

  /* ================================================================ *
   * 4. Status filtering rejects nonsense, keeps the list form
   * ================================================================ */
  await pair("unknown appointment status", "/appointments?status=bogus", undefined, {
    wantStatus: 422,
    wantCode: "VALIDATION_ERROR",
    token: P,
  });
  const oneStatus = await call("/appointments?status=scheduled", { token: P });
  check("a real status is accepted", oneStatus.status === 200, `HTTP ${oneStatus.status}`);
  const twoStatus = await call("/appointments?status=scheduled,confirmed", { token: P });
  check("a comma-separated status list is accepted", twoStatus.status === 200, `HTTP ${twoStatus.status}`);

  /* ================================================================ *
   * 5. Profile input is bounded, and bounded data is stored
   * ================================================================ */
  await pair(
    "an over-long name",
    "/auth/me",
    { name: "x".repeat(500) },
    { wantStatus: 422, wantCode: "VALIDATION_ERROR", valid: { name: "Ishita Desai" }, method: "PATCH", token: P },
  );
  await pair(
    "an over-long phone",
    "/auth/me",
    { phone: "9".repeat(400) },
    { wantStatus: 422, wantCode: "VALIDATION_ERROR", valid: { phone: "+919876543210" }, method: "PATCH", token: P },
  );
  // The profile is SANITISED, not rejected: a bad field is dropped and the rest of
  // the update is applied. That is this endpoint's established contract, and the
  // route deliberately does not duplicate the controller's allow-list to change
  // it. Asserted as a pair - the bad field disappears AND the good one lands.
  //
  // Merge semantics: a field the sanitiser rejects is left UNCHANGED, not cleared.
  // So the assertion is that the bad value is not what comes back - not that the
  // field is blank, which would be false whenever a good value was set earlier.
  const genderBefore = (await call("/auth/me", { token: P })).data?.user?.profile?.gender;
  const cleanGender = await call("/auth/me", {
    method: "PATCH",
    token: P,
    body: { profile: { gender: "not-a-gender", bloodGroup: "O+" } },
  });
  check(
    "an unknown profile gender is never stored",
    cleanGender.status === 200 && cleanGender.data?.user?.profile?.gender !== "not-a-gender",
    `HTTP ${cleanGender.status} gender=${cleanGender.data?.user?.profile?.gender}`,
  );
  check(
    "and the rejected field keeps its previous value (merge, not clear)",
    cleanGender.data?.user?.profile?.gender === genderBefore,
    `before=${genderBefore} after=${cleanGender.data?.user?.profile?.gender}`,
  );
  check(
    "while the valid field beside it is applied",
    cleanGender.data?.user?.profile?.bloodGroup === "O+",
    `bloodGroup=${cleanGender.data?.user?.profile?.bloodGroup}`,
  );

  // A date column, so it comes back as an instant rather than the string that was
  // sent. Compared in the clinic's own zone, which is the only zone in which
  // "1990-04-02" is a meaningful claim.
  const CLINIC_DATE = (iso) =>
    iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso)) : undefined;

  const badDob = await call("/auth/me", {
    method: "PATCH",
    token: P,
    body: { profile: { dateOfBirth: "not-a-date" } },
  });
  check(
    "a non-date profile date of birth is rejected by the sanitiser",
    badDob.status === 200 && CLINIC_DATE(badDob.data?.user?.profile?.dateOfBirth) !== "not-a-date",
    `HTTP ${badDob.status} dob=${badDob.data?.user?.profile?.dateOfBirth}`,
  );

  const goodDob = await call("/auth/me", {
    method: "PATCH",
    token: P,
    body: { profile: { dateOfBirth: "1990-04-02", gender: "female" } },
  });
  check(
    "a real profile date of birth round-trips to the same calendar day",
    CLINIC_DATE(goodDob.data?.user?.profile?.dateOfBirth) === "1990-04-02",
    `stored=${goodDob.data?.user?.profile?.dateOfBirth} clinic-day=${CLINIC_DATE(goodDob.data?.user?.profile?.dateOfBirth)}`,
  );
  check(
    "and the valid gender beside it is applied",
    goodDob.data?.user?.profile?.gender === "female",
    `gender=${goodDob.data?.user?.profile?.gender}`,
  );

  // A profile with more keys than the cap is refused before the sanitiser runs.
  const wide = await call("/auth/me", {
    method: "PATCH",
    token: P,
    body: { profile: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"])) },
  });
  check(
    "an over-wide profile object is refused",
    wide.status === 422 && wide.code === "VALIDATION_ERROR",
    `HTTP ${wide.status} ${wide.code ?? ""}`,
  );

  // The over-long name must NOT have been silently truncated and stored. Before
  // Phase 13 the controller sliced to 120 characters and answered 200, so the
  // user believed a name was saved when most of it had been discarded.
  const me = await call("/auth/me", { token: P });
  check(
    "the profile survived the rejected update intact",
    me.data?.user?.name?.length <= 120,
    `stored name length ${me.data?.user?.name?.length}`,
  );

  /* ================================================================ *
   * 6. Identifier validation
   * ================================================================ */
  // A patient is refused on ROLE before the id is looked at, which is the
  // point: a 404 here would confirm whether an appointment id is real.
  const asPatient = await call("/appointments/not-a-uuid/status", {
    method: "PATCH",
    token: P,
    body: { status: "completed" },
  });
  check(
    "role is checked before the id, so existence is not confirmed",
    asPatient.status === 403,
    `HTTP ${asPatient.status} ${asPatient.code ?? ""}`,
  );
  // A doctor passes the role gate, so a malformed id is what is left to reject.
  const asDoctor = await call("/appointments/not-a-uuid/status", {
    method: "PATCH",
    token: D,
    body: { status: "completed" },
  });
  check(
    "a malformed id for an authorised role is a clean 404, not a 500",
    asDoctor.status === 404,
    `HTTP ${asDoctor.status} ${asDoctor.code ?? ""}`,
  );

  /* ================================================================ *
   * 7. Error responses are consistent
   * ================================================================ */
  const shapes = [
    ["unauthenticated", await call("/appointments")],
    ["wrong role", await call("/admin/appointments", { token: P })],
    ["validation failure", await call("/appointments?limit=0", { token: P })],
    ["not found", await call("/appointments/00000000-0000-0000-0000-000000000000/status", { method: "PATCH", token: D, body: { status: "completed" } })],
    ["bad credentials", await call("/auth/login", { method: "POST", body: { email: "patient@demo.com", password: "wrong-password-entirely" } })],
  ];
  for (const [label, r] of shapes) {
    check(
      `${label}: carries a machine-readable code`,
      typeof r.code === "string" && r.code.length > 0 && r.code === r.code.toUpperCase().replace(/[^A-Z_]/g, "_"),
      `code=${r.code}`,
    );
    check(`${label}: leaks no stack trace or SQL`, !/at .*\.js:\d+|SELECT |INSERT |pq:|node_modules/i.test(JSON.stringify(r)), r.code);
  }

  // A 500 must never be the answer to a caller's mistake.
  const serverError = shapes.filter(([, r]) => r.status >= 500);
  check("none of the error shapes is a 5xx", serverError.length === 0, `${serverError.length} did`);

  /* ================================================================ *
   * 8. The repository clamps too, for a caller that bypasses the route
   * ================================================================ */
  const notificationRepo = (await import("../src/repositories/notificationRepo.js")).default;
  const userId = patient.user.id ?? (await query("SELECT id FROM users WHERE email = $1", ["patient@demo.com"])).rows[0].id;
  for (const bad of [-1, -1000, 0]) {
    const rows = await notificationRepo.listForUser(userId, bad);
    check(
      `listForUser survives limit=${bad}`,
      Array.isArray(rows) && rows.length <= 200,
      `rows=${rows?.length}`,
    );
  }
  const bigPage = await notificationRepo.listForUser(userId, 100000);
  check("listForUser clamps an oversized limit", bigPage.length <= 200, `rows=${bigPage.length}`);
};

run()
  .then(async () => {
    await closePool();
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(`  suite crashed: ${err.stack ?? err.message}`);
    await closePool().catch(() => {});
    console.log("");
    console.log(`  === ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  });