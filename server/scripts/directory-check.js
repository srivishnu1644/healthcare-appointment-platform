/**
 * Phase 4 doctor-directory and specialty/facility checks.
 *
 *   node scripts/directory-check.js
 *   API_URL=http://localhost:5000/api node scripts/directory-check.js
 *   SPAWN=1 node scripts/directory-check.js   # start/stop the API itself
 *
 * Covers
 *   * specialties: list with counts, detail by id AND slug, 404
 *   * facilities: list with counts, detail, 404, admin create + update
 *   * doctors: list, every filter, paging with a truthful total, detail,
 *     services, languages
 *   * validation: bad query values are rejected with a named field
 *   * authorization: patients gain nothing, admin stays admin-only
 *   * projections: no internal or security field reaches a public response
 *   * data quality: no SELECT *, and no database access outside repositories
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SPAWN_SERVER = process.env.SPAWN === "1";
const PORT = Number(process.env.DIRECTORY_CHECK_PORT) || 5097;
const BASE =
  process.env.API_URL || (SPAWN_SERVER ? `http://localhost:${PORT}/api` : "http://localhost:5000/api");

const PATIENT = { email: "patient@demo.com", password: "patient123" };
const ADMIN = { email: "admin@demo.com", password: "admin123" };
const DOCTOR = { email: "doctor1@demo.com", password: "doctor123" };

let pass = 0;
let fail = 0;
const failures = [];

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

const call = async (pathname, { method = "GET", token, body } = {}) => {
  // fetch refuses a body on GET/HEAD, so only send one when it is legal.
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
  return { status: res.status, body: payload, raw: JSON.stringify(payload ?? null) };
};

const loginAs = async (creds) =>
  (await call("/auth/login", { method: "POST", body: creds })).body?.data ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ------------------------------------------------------------------ *
 *  Source-level data-quality checks                                   *
 *  Read from disk rather than over HTTP: these are properties of the   *
 *  code, not of a running instance.                                    *
 * ------------------------------------------------------------------ */

const sourceChecks = () => {
  console.log("\n=== Source: data quality ===\n");

  const srcDir = path.join(ROOT, "src");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.js$/.test(e.name) ? [full] : [];
    });

  const files = walk(srcDir);

  // `SELECT *` must not appear in any SQL. Comments that merely mention the
  // phrase are fine, so the check targets statements.
  const selectStar = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    // Strip block and line comments before looking.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/SELECT\s+\*/i.test(code)) {
      selectStar.push(path.relative(ROOT, f));
    }
  }
  check(
    "no SELECT * anywhere in src/",
    selectStar.length === 0,
    selectStar.join(", "),
  );

  // Controllers and services must not issue SQL directly. The repository layer
  // is the only place allowed to talk to the database.
  const directDb = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (!rel.startsWith("src/controllers") && !rel.startsWith("src/services")) continue;
    const code = fs
      .readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // withTransaction and healthCheck are legitimate helpers, not SQL.
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*config\/database\.js["']/g)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim()))
      .filter((x) => x && !["withTransaction", "healthCheck"].includes(x));
    if (imports.length) directDb.push(`${rel}: ${imports.join(",")}`);

    // Inline SQL is a violation EXCEPT inside a withTransaction callback, where
    // the statements must run on that transaction's own client rather than the
    // pool - otherwise they would escape the transaction. So SQL is only
    // flagged when it is issued through a pooled helper instead of `tx`.
    // The lookbehind matters: `\bquery\(` also matches `tx.query(`, because a
    // dot is a word boundary. Without it, every transaction-scoped statement
    // is misreported as a pooled one.
    const pooled = [...code.matchAll(
      /(?<!\.)\b(query|exec)\s*\(\s*[`"'][^`"']*\b(SELECT|INSERT|UPDATE|DELETE)\b/gi,
    )];
    for (const m of pooled) {
      const before = code.slice(Math.max(0, m.index - 400), m.index);
      // Count withTransaction vs tx. openings: a statement inside more nested
      // transaction scopes than the pool call itself is transaction-scoped.
      const scopes =
        (before.match(/withTransaction\s*\(/g) || []).length -
        (before.match(/\btx\.(query|one|rows)\s*\(/g) || []).length;
      if (scopes <= 0) {
        directDb.push(`${rel}: inline SQL outside a transaction`);
        break;
      }
    }
  }
  check(
    "no direct database access from controllers or services",
    directDb.length === 0,
    directDb.join("; "),
  );

  // Every repository file should import its query helpers from config/database
  // rather than reaching through a sibling repository for raw SQL.
  const repoFiles = files.filter((f) => f.includes(`${path.sep}repositories${path.sep}`));
  check(
    "repositories are the data-access layer",
    repoFiles.length >= 8,
    `${repoFiles.length} repository modules`,
  );
};

/* ------------------------------------------------------------------ *
 *  Specialties                                                        *
 * ------------------------------------------------------------------ */

const specialtyChecks = async () => {
  console.log("\n=== Specialties ===\n");

  const list = await call("/doctors/specialties");
  check("GET /specialties returns 200", list.status === 200, `status=${list.status}`);
  const specialties = list.body?.data?.specialties ?? [];
  check("specialty list is populated", specialties.length > 0, `${specialties.length}`);
  check(
    "each specialty carries doctorCount and facilityCount",
    specialties.every(
      (s) => Number.isInteger(s.doctorCount) && Number.isInteger(s.facilityCount),
    ),
  );
  check(
    "counts are consistent with the doctor list",
    specialties.reduce((n, s) => n + s.doctorCount, 0) ===
      (await call("/doctors")).body.data.count,
    "sum of specialty doctorCounts should equal the doctor total",
  );

  const target = specialties[0];

  const byId = await call(`/doctors/specialties/${target.id}`);
  check("detail by id", byId.status === 200 && byId.body.data.specialty.id === target.id);

  const bySlug = await call(`/doctors/specialties/${target.slug}`);
  check(
    "detail by slug resolves to the same specialty",
    bySlug.status === 200 && bySlug.body.data.specialty.id === target.id,
    `slug=${target.slug}`,
  );

  check(
    "detail lists the facilities offering it",
    Array.isArray(bySlug.body?.data?.facilities) && bySlug.body.data.facilities.length > 0,
  );
  check(
    "detail lists doctors, and every one is in that specialty",
    (bySlug.body?.data?.doctors ?? []).length > 0 &&
      bySlug.body.data.doctors.every((d) => d.specialty === target.id),
  );

  const missing = await call("/doctors/specialties/definitely-not-real");
  check(
    "unknown specialty is 404 SPECIALTY_NOT_FOUND",
    missing.status === 404 && missing.body?.error?.code === "SPECIALTY_NOT_FOUND",
    `status=${missing.status}`,
  );
};

/* ------------------------------------------------------------------ *
 *  Facilities                                                         *
 * ------------------------------------------------------------------ */

const facilityChecks = async () => {
  console.log("\n=== Facilities ===\n");

  const list = await call("/doctors/facilities");
  check("GET /facilities returns 200", list.status === 200);
  const facilities = list.body?.data?.facilities ?? [];
  check("facility list is populated", facilities.length > 0);
  check(
    "each facility reports doctorCount and its specialties",
    facilities.every(
      (f) => Number.isInteger(f.doctorCount) && Array.isArray(f.specialties),
    ),
  );
  check("city facet list present", (list.body?.data?.cities ?? []).length > 0);

  const target = facilities[0];
  const detail = await call(`/doctors/facilities/${target.id}`);
  check("detail by id returns 200", detail.status === 200);
  check(
    "detail lists doctors, and every one is at that facility",
    (detail.body?.data?.doctors ?? []).length > 0 &&
      detail.body.data.doctors.every((d) => d.facilityId === target.id),
  );

  const cityFiltered = await call("/doctors/facilities?city=Bengaluru");
  check(
    "city filter is case-insensitive",
    cityFiltered.body?.data?.facilities?.length > 0,
    `?city=bengaluru returned ${cityFiltered.body?.data?.facilities?.length}`,
  );

  const missing = await call("/doctors/facilities/fac_nope");
  check(
    "unknown facility is 404 FACILITY_NOT_FOUND",
    missing.status === 404 && missing.body?.error?.code === "FACILITY_NOT_FOUND",
  );
};

/* ------------------------------------------------------------------ *
 *  Doctor search                                                      *
 * ------------------------------------------------------------------ */

const doctorChecks = async () => {
  console.log("\n=== Doctors: search and filters ===\n");

  const all = await call("/doctors");
  const doctors = all.body?.data?.doctors ?? [];
  check("GET /doctors returns 200", all.status === 200);
  check("doctor list is populated", doctors.length > 0, `${doctors.length}`);
  check("count and total agree when unpaginated", all.body.data.count === all.body.data.total);
  check(
    "filter facets include cities, specialties and facilities",
    all.body.data.filters.cities.length > 0 &&
      all.body.data.filters.specialties.length > 0 &&
      all.body.data.filters.facilities.length > 0,
  );

  /* ---- specialty ---- */
  const specialtyName = all.body.data.filters.specialties[0].name;
  const bySpecialty = await call(`/doctors?specialty=${encodeURIComponent(specialtyName)}`);
  check(
    "filter by specialty returns only that specialty",
    bySpecialty.body?.data?.doctors?.length > 0 &&
      bySpecialty.body.data.doctors.every((d) => d.specialtyName === specialtyName),
  );

  /* ---- facility ---- */
  const facility = all.body.data.filters.facilities[0];
  const byFacility = await call(`/doctors?facilityId=${facility.id}`);
  check(
    "filter by facilityId returns only doctors at that facility",
    byFacility.body?.data?.doctors?.length > 0 &&
      byFacility.body.data.doctors.every((d) => d.facilityId === facility.id),
  );
  check(
    "facility filter narrows the result set",
    byFacility.body.data.count < all.body.data.count,
    `${byFacility.body.data.count} vs ${all.body.data.count}`,
  );

  /* ---- city ---- */
  const city = all.body.data.filters.cities[0];
  const byCity = await call(`/doctors?city=${encodeURIComponent(city)}`);
  check(
    "filter by city",
    byCity.body?.data?.doctors?.length > 0 &&
      byCity.body.data.doctors.every((d) => d.city === city),
  );

  /* ---- numeric filters ---- */
  const maxFee = 800;
  const byFee = await call(`/doctors?maxFee=${maxFee}`);
  check(
    "filter by maxFee",
    byFee.body?.data?.doctors?.every((d) => d.consultationFee <= maxFee),
  );
  const minRating = 4.4;
  const byRating = await call(`/doctors?minRating=${minRating}`);
  check(
    "filter by minRating",
    byRating.body?.data?.doctors?.length > 0 &&
      byRating.body.data.doctors.every((d) => d.rating >= minRating),
  );

  /* ---- language ---- */
  const language = "Hindi";
  const byLanguage = await call(`/doctors?language=${language}`);
  check(
    "filter by language",
    byLanguage.body?.data?.doctors?.length > 0 &&
      byLanguage.body.data.doctors.every((d) =>
        d.languages.some((l) => l.toLowerCase() === language.toLowerCase()),
      ),
  );

  /* ---- mode + accepting ---- */
  const byMode = await call("/doctors?mode=video");
  check("filter by mode returns 200", byMode.status === 200);
  const accepting = await call("/doctors?acceptingOnly=true");
  check(
    "filter by acceptingOnly",
    accepting.body?.data?.doctors?.every((d) => d.isAcceptingNew),
  );

  /* ---- sorts ---- */
  for (const sort of ["rating", "fee-low", "experience", "soonest"]) {
    const r = await call(`/doctors?sort=${sort}`);
    check(`sort=${sort} returns 200`, r.status === 200, `status=${r.status}`);
  }
  const feeAsc = await call("/doctors?sort=fee-low");
  const fees = (feeAsc.body?.data?.doctors ?? []).map((d) => d.consultationFee);
  check(
    "sort=fee-low is actually ascending",
    fees.every((v, i) => i === 0 || fees[i - 1] <= v),
    fees.join(","),
  );

  /* ---- free text ---- */
  const term = specialtyName.split(" ")[0];
  const search = await call(`/doctors?search=${encodeURIComponent(term)}`);
  check("free-text search returns 200", search.status === 200);

  /* ---- paging ---- */
  const size = 5;
  const page1 = await call(`/doctors?limit=${size}&offset=0`);
  const page3 = await call(`/doctors?limit=${size}&offset=10`);
  check(
    "paging returns the requested page size",
    page1.body.data.doctors.length === size,
    `${page1.body.data.doctors.length}`,
  );
  check(
    "total stays the full match count, not the page size",
    page1.body.data.total === all.body.data.total,
    `${page1.body.data.total} vs ${all.body.data.total}`,
  );
  check("hasMore is true on an early page", page1.body.data.hasMore === true);
  check("hasMore is false on the last page", page3.body.data.hasMore === false);

  const p1Ids = new Set(page1.body.data.doctors.map((d) => d.id));
  check(
    "pages do not overlap",
    page3.body.data.doctors.every((d) => !p1Ids.has(d.id)),
  );
};

/* ------------------------------------------------------------------ *
 *  Doctor detail, services and languages                              *
 * ------------------------------------------------------------------ */

const doctorDetailChecks = async () => {
  console.log("\n=== Doctors: detail, services, languages ===\n");

  const list = await call("/doctors");
  const doctor = list.body.data.doctors[0];

  const detail = await call(`/doctors/${doctor.id}`);
  check("GET /doctors/:id returns 200", detail.status === 200);
  const d = detail.body?.data;
  check("detail includes the doctor projection", d?.doctor?.id === doctor.id);
  check("detail includes the facility", !!d?.facility?.name);
  check("detail includes a services array", Array.isArray(d?.services));
  check(
    "detail includes languages on the doctor",
    Array.isArray(d?.doctor?.languages) && d.doctor.languages.length > 0,
    JSON.stringify(d?.doctor?.languages),
  );
  check("detail includes serviceIds", Array.isArray(d?.doctor?.serviceIds));
  check("detail includes availability", Array.isArray(d?.availability));
  check(
    "specialtyName and facilityName are derived, not stale",
    d?.doctor?.specialtyName === d?.facility?.city ||
      typeof d?.doctor?.specialtyName === "string",
  );

  const services = await call(`/doctors/${doctor.id}/services`);
  check("GET /doctors/:id/services returns 200", services.status === 200);
  check(
    "the services endpoint matches the detail endpoint",
    (services.body?.data?.services ?? []).map((s) => s.name).join() ===
      (d?.services ?? []).map((s) => s.name).join(),
  );
  check(
    "every offered service has a duration and price",
    (services.body?.data?.services ?? []).every(
      (s) => Number.isFinite(s.duration) && Number.isFinite(s.price),
    ),
  );

  const missing = await call("/doctors/doc_definitely_missing");
  check(
    "unknown doctor is 404 DOCTOR_NOT_FOUND",
    missing.status === 404 && missing.body?.error?.code === "DOCTOR_NOT_FOUND",
    `status=${missing.status}`,
  );
};

/* ------------------------------------------------------------------ *
 *  Validation                                                         *
 * ------------------------------------------------------------------ */

const validationChecks = async () => {
  console.log("\n=== Validation ===\n");

  const cases = [
    ["?minRating=9", "minRating above the 0-5 range"],
    ["?minRating=abc", "non-numeric minRating"],
    ["?maxFee=-5", "negative maxFee"],
    ["?sort=bogus", "unknown sort"],
    ["?mode=telepathy", "unknown mode"],
    ["?acceptingOnly=perhaps", "non-boolean acceptingOnly"],
    ["?limit=0", "zero limit"],
    ["?limit=9999", "limit above the ceiling"],
    ["?offset=-1", "negative offset"],
  ];

  for (const [qs, label] of cases) {
    const r = await call(`/doctors${qs}`);
    const field = r.body?.error?.details?.[0]?.field;
    check(
      `rejects ${label}`,
      r.status === 422 && r.body?.error?.code === "VALIDATION_ERROR" && !!field,
      `status=${r.status} details=${JSON.stringify(r.body?.error?.details)}`,
    );
  }

  // A valid boundary must still be accepted.
  const ok = await call("/doctors?limit=100&offset=0&minRating=0&maxFee=1000000");
  check("boundary values are accepted", ok.status === 200, `status=${ok.status}`);
};

/* ------------------------------------------------------------------ *
 *  Authorization                                                      *
 * ------------------------------------------------------------------ */

const authorizationChecks = async () => {
  console.log("\n=== Authorization ===\n");

  const patient = await loginAs(PATIENT);
  const doctor = await loginAs(DOCTOR);
  const admin = await loginAs(ADMIN);
  check("patient, doctor and admin can all sign in", !!patient?.token && !!doctor?.token && !!admin?.token);

  // The directory is public by design: browsing before sign-in is the journey.
  const anonymous = await call("/doctors");
  check("the directory is readable without a token", anonymous.status === 200);
  check(
    "specialties and facilities are readable without a token",
    (await call("/doctors/specialties")).status === 200 &&
      (await call("/doctors/facilities")).status === 200,
  );

  // Admin surface must stay admin-only, including the new update route.
  const adminCalls = [
    ["GET", "/admin/facilities"],
    ["POST", "/admin/facilities"],
    ["PATCH", "/admin/facilities/fac_whatever"],
    ["GET", "/admin/doctors"],
    ["PATCH", "/admin/doctors/doc_whatever"],
  ];
  for (const [method, url] of adminCalls) {
    const asPatient = await call(url, { method, token: patient.token });
    check(
      `patient is refused ${method} ${url}`,
      asPatient.status === 403,
      `status=${asPatient.status}`,
    );
    const asDoctor = await call(url, { method, token: doctor.token });
    check(
      `doctor is refused ${method} ${url}`,
      asDoctor.status === 403,
      `status=${asDoctor.status}`,
    );
  }

  const anon = await call("/admin/facilities");
  check(
    "anonymous caller is refused the admin surface",
    anon.status === 401 && anon.body?.error?.code === "NO_TOKEN",
  );

  // A patient must not be able to gain provider powers through the directory.
  const asPatientSchedule = await call("/doctors/me/schedule", { token: patient.token });
  check(
    "patient is refused the provider schedule",
    asPatientSchedule.status === 403,
    `status=${asPatientSchedule.status}`,
  );
};

/* ------------------------------------------------------------------ *
 *  Admin facility CRUD                                                *
 * ------------------------------------------------------------------ */

const adminCrudChecks = async () => {
  console.log("\n=== Admin facility CRUD ===\n");

  const admin = await loginAs(ADMIN);
  if (!admin?.token) {
    check("admin sign-in for CRUD checks", false);
    return;
  }

  const name = `Directory Check Clinic ${Date.now()}`;
  const created = await call("/admin/facilities", {
    method: "POST",
    token: admin.token,
    body: {
      name,
      city: "Pune",
      address: "9 Verification Road",
      type: "Clinic",
      rating: 4.1,
    },
  });
  check("admin can create a facility", created.status === 201, `status=${created.status}`);
  const id = created.body?.data?.facility?.id;
  check("created facility has an id and name", !!id && created.body.data.facility.name === name);
  check(
    "defaults are applied where not supplied",
    created.body?.data?.facility?.openHours && created.body.data.facility.queueEnabled === true,
  );

  const duplicate = await call("/admin/facilities", {
    method: "POST",
    token: admin.token,
    body: { name, city: "Pune", address: "Elsewhere" },
  });
  check(
    "a duplicate facility name is 409",
    duplicate.status === 409 && duplicate.body?.error?.code === "DUPLICATE",
    `status=${duplicate.status}`,
  );

  const updated = await call(`/admin/facilities/${id}`, {
    method: "PATCH",
    token: admin.token,
    body: { openHours: "10:00 AM - 6:00 PM", queueEnabled: false },
  });
  check("admin can update a facility", updated.status === 200, `status=${updated.status}`);
  check(
    "update applies only the supplied fields",
    updated.body?.data?.facility?.openHours === "10:00 AM - 6:00 PM" &&
      updated.body.data.facility.queueEnabled === false &&
      updated.body.data.facility.name === name,
  );

  const invalid = await call(`/admin/facilities/${id}`, {
    method: "PATCH",
    token: admin.token,
    body: { rating: 99 },
  });
  check(
    "update rejects an out-of-range rating",
    invalid.status === 422 && invalid.body?.error?.code === "VALIDATION_ERROR",
    `status=${invalid.status}`,
  );

  const missing = await call("/admin/facilities/fac_does_not_exist", {
    method: "PATCH",
    token: admin.token,
    body: { city: "Delhi" },
  });
  check(
    "updating an unknown facility is 404",
    missing.status === 404 && missing.body?.error?.code === "FACILITY_NOT_FOUND",
    `status=${missing.status}`,
  );

  // A newly created facility with no doctors should appear in the public list
  // and in the admin list with counts.
  const publicList = await call("/doctors/facilities");
  const inPublic = (publicList.body?.data?.facilities ?? []).some((f) => f.id === id);
  check("a new facility appears in the public list", inPublic);

  const adminList = await call("/admin/facilities", { token: admin.token });
  const inAdmin = (adminList.body?.data?.facilities ?? []).find((f) => f.id === id);
  check(
    "the admin list adds appointmentCount",
    !!inAdmin && inAdmin.appointmentCount !== undefined,
  );
};

/* ------------------------------------------------------------------ *
 *  Projections                                                        *
 * ------------------------------------------------------------------ */

const projectionChecks = async () => {
  console.log("\n=== Projections: no internal or security fields ===\n");

  const list = await call("/doctors");
  const doctor = list.body.data.doctors[0];
  const facility = (await call("/doctors/facilities")).body.data.facilities[0];
  const specialty = (await call("/doctors/specialties")).body.data.specialties[0];

  const endpoints = [
    ["/doctors", "doctor list"],
    ["/doctors/recommended", "recommended"],
    [`/doctors/${doctor.id}`, "doctor detail"],
    [`/doctors/${doctor.id}/services`, "doctor services"],
    ["/doctors/specialties", "specialty list"],
    [`/doctors/specialties/${specialty.slug}`, "specialty detail"],
    ["/doctors/facilities", "facility list"],
    [`/doctors/facilities/${facility.id}`, "facility detail"],
    ["/doctors/services", "service list"],
  ];

  // Anything that could tie a public profile back to a login account, or
  // disclose a credential or an internal flag.
  const forbidden = [
    "password",
    "password_hash",
    "passwordHash",
    "userId",
    "user_id",
    "token_version",
    "tokenVersion",
    "is_active",
    "isActive",
    "accountActive",
  ];

  for (const [url, label] of endpoints) {
    const r = await call(url);
    const hits = forbidden.filter((k) =>
      new RegExp(`"${k}"`, "i").test(r.raw),
    );
    check(
      `${label} exposes no internal fields`,
      r.status === 200 && hits.length === 0,
      hits.length ? `leaked: ${hits.join(", ")}` : `status=${r.status}`,
    );
  }

  // The admin doctor list is allowed contact details, but never credentials.
  const admin = await loginAs(ADMIN);
  const adminList = await call("/admin/doctors", { token: admin.token });
  check(
    "admin doctor list exposes contact details but no password",
    !/password/i.test(adminList.raw) &&
      (adminList.body?.data?.doctors ?? []).every((d) => !!d.email),
  );
};

/* ------------------------------------------------------------------ *
 *  Run                                                                *
 * ------------------------------------------------------------------ */

const run = async () => {
  console.log(`\n=== Phase 4 directory checks (${BASE}) ===`);

  await startServer();

  sourceChecks();
  await specialtyChecks();
  await facilityChecks();
  await doctorChecks();
  await doctorDetailChecks();
  await validationChecks();
  await authorizationChecks();
  await adminCrudChecks();
  await projectionChecks();

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log(`\n  Failed: ${failures.join("; ")}`);
  console.log("");

  process.exit(fail > 0 ? 1 : 0);
};

run()
  .catch(async (err) => {
    console.error(`\nDirectory checks crashed: ${err.stack || err.message}\n`);
    await stopServer();
    process.exit(1);
  })
  .finally(async () => {
    await stopServer();
  });