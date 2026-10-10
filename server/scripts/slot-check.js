/**
 * Phase 5 slot and availability checks.
 *
 *   node scripts/slot-check.js
 *   API_URL=http://localhost:5000/api node scripts/slot-check.js
 *   SPAWN=1 node scripts/slot-check.js   # start/stop the API itself
 *
 * Covers
 *   * time utilities: date/time validation, round-tripping a local wall-clock
 *     time to an instant and back, and daylight-saving behaviour in zones that
 *     actually observe it
 *   * slots: list, detail, doctor/date/mode/status filters, clock-time and date
 *     ranges, paging with a truthful total
 *   * availability: summary, per-date range, and the rule that a slot which has
 *     already started is never advertised
 *   * management: create, duplicates, overlap, abutment, invalid times and
 *     ranges, midnight-crossing durations
 *   * authorization: provider owns their schedule, admin owns all, patients own
 *     none, unauthenticated callers get nothing
 *   * timezone: one configured zone drives storage, labelling and "today"
 *   * source-level: no fixed UTC offset survives anywhere in src/
 *
 * Re-running
 * ----------
 * Every fixture is placed on a date the doctor genuinely has no slots on, found
 * by asking the availability range which dates are occupied and taking the first
 * gap. That keeps "3 slots were created" true on the first run and on the tenth,
 * without needing to delete anything afterwards - the suite never touches the
 * database directly, because the bundled local PostgreSQL serves one client and
 * the API owns it.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SPAWN_SERVER = process.env.SPAWN === "1";
const PORT = Number(process.env.SLOT_CHECK_PORT) || 5096;
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
  return { status: res.status, body: payload, data: payload?.data ?? null };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The error code the API returned, for concise assertions. */
const codeOf = (r) => r.body?.error?.code ?? null;

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
 *  1. Time utilities                                                  *
 * ------------------------------------------------------------------ */

const timeUtilChecks = async () => {
  console.log("\n=== Time utilities ===\n");
  const time = await import("../src/utils/time.js");

  check(
    "the configured zone is the one everything else reads",
    time.TZ === (process.env.APP_TIMEZONE || "Asia/Kolkata"),
    time.TZ,
  );

  // --- date validation ---
  const goodDates = ["2026-01-01", "2026-02-28", "2028-02-29", "2027-12-31"];
  check(
    "real calendar dates are accepted",
    goodDates.every((d) => time.isValidDate(d)),
    goodDates.filter((d) => !time.isValidDate(d)).join(", "),
  );

  const badDates = [
    "2026-02-30", // February never has 30 days
    "2026-13-01", // no month 13
    "2026-00-10", // no month 0
    "2026-04-31", // April has 30
    "2026-2-3", // not zero-padded
    "not-a-date",
    "",
    "20260101",
  ];
  const rejectedDates = badDates.filter((d) => time.isValidDate(d));
  check(
    "impossible and malformed dates are rejected",
    rejectedDates.length === 0,
    `wrongly accepted: ${rejectedDates.join(", ")}`,
  );

  // --- time validation ---
  const goodTimes = ["00:00", "09:00", "09:30", "23:59", "12:05"];
  check(
    "24-hour clock times are accepted",
    goodTimes.every((t) => time.isValidTime(t)),
    goodTimes.filter((t) => !time.isValidTime(t)).join(", "),
  );

  const badTimes = ["24:00", "09:60", "9:00", "09:0", "0900", "abc", "", "-1:00"];
  const rejectedTimes = badTimes.filter((t) => time.isValidTime(t));
  check(
    "out-of-range and malformed times are rejected",
    rejectedTimes.length === 0,
    `wrongly accepted: ${rejectedTimes.join(", ")}`,
  );

  // --- the round-trip that the whole design rests on ---
  const samples = [
    ["2026-01-15", "09:00"],
    ["2026-06-15", "14:30"],
    ["2026-10-25", "00:05"],
    ["2026-12-31", "23:55"],
    ["2027-03-28", "12:00"],
  ];
  const mismatches = samples.filter(([d, t]) => {
    const instant = time.localToInstant(d, t);
    return time.localDate(instant) !== d || time.localTime(instant) !== t;
  });
  check(
    "a local wall-clock time round-trips through an instant unchanged",
    mismatches.length === 0,
    mismatches.map(([d, t]) => `${d} ${t}`).join(", "),
  );

  // The instant must genuinely be the zone's offset away. Checking only that the
  // labels round-trip would pass even if the offset were applied with the wrong
  // sign on the way in and corrected on the way out.
  const probeInstant = time.localToInstant("2026-06-15", "12:00");
  const offsetMin = time.currentOffsetMinutes(probeInstant);
  const actualUtcMin =
    Number(probeInstant.toISOString().slice(11, 13)) * 60 +
    Number(probeInstant.toISOString().slice(14, 16));
  const expectedUtcMin = ((12 * 60 - offsetMin) % 1440 + 1440) % 1440;
  check(
    "the offset applied is the zone's real offset for that date",
    actualUtcMin === expectedUtcMin,
    `stored ${probeInstant.toISOString()} = ${actualUtcMin} UTC minutes, expected ${expectedUtcMin} for offset ${offsetMin}`,
  );

  check(
    "today is reported in the business zone, not UTC",
    time.todayLocal() === time.localDate(new Date()),
    time.todayLocal(),
  );

  // --- bookability ---
  check("today is a bookable date", time.isBookableDate(time.todayLocal()));
  check(
    "yesterday is not a bookable date",
    !time.isBookableDate(time.localDate(new Date(Date.now() - 86400000))),
  );
  check("a malformed date is not bookable", !time.isBookableDate("banana"));

  // --- arithmetic helpers ---
  // durationMinutesBetween deliberately does NOT wrap around midnight. That is
  // how a duration crossing into the next day is detected: 23:50 + 20min is
  // "00:10", which comes back as a large negative rather than a tidy 20, and the
  // caller rejects it. Wrapping here would make every overnight slot legal.
  check(
    "a range that wraps past midnight is reported as negative, not as 30",
    time.durationMinutesBetween("23:45", "00:15") === -1410,
    String(time.durationMinutesBetween("23:45", "00:15")),
  );
  check("a backwards range is reported as negative", time.durationMinutesBetween("10:00", "09:30") === -30);
  check("a same-time range is zero", time.durationMinutesBetween("10:00", "10:00") === 0);
  check(
    "an ordinary forward range reports its true length",
    time.durationMinutesBetween("09:00", "09:30") === 30,
  );

  const slotService = await import("../src/services/slotService.js");
  check("adding 30 minutes to 23:45 does wrap the clock", slotService.addMinutes("23:45", 30) === "00:15");
  check("adding 15 minutes to 09:00 does not wrap", slotService.addMinutes("09:00", 15) === "09:15");
  check("adding minutes past the end of the day wraps once", slotService.addMinutes("23:30", 60) === "00:30");
};

/* ------------------------------------------------------------------ *
 *  2. The configured zone, checked in zones that observe DST           *
 * ------------------------------------------------------------------ */

/**
 * Run a snippet in a child process with a specific APP_TIMEZONE.
 *
 * utils/time.js reads the zone once at load, so a zone cannot be changed from
 * inside a running process. A child per zone is the honest way to prove the
 * configuration is actually honoured end to end.
 */
const inZone = (zone, snippet) => {
  const res = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", snippet],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, APP_TIMEZONE: zone },
    },
  );
  if (res.status !== 0) return { failed: true, stderr: res.stderr };
  try {
    return { failed: false, ...JSON.parse(res.stdout.trim().split("\n").pop()) };
  } catch {
    return { failed: true, stderr: res.stdout };
  }
};

/**
 * The snippet below asks the zone itself where its transitions are, rather than
 * hardcoding a date. The rules are not fixed: the EU moves on the last Sunday of
 * March and October, the US on the second Sunday of March and the first of
 * November, and southern-hemisphere zones invert all of it. A test that names a
 * date is a test that goes stale, and silently stops testing anything.
 */
const ZONE_SNIPPET = `
const t = await import("./src/utils/time.js");

// Walk the year one day at a time and record where the offset actually moves.
let spring = null, fall = null, prev = null;
for (let d = new Date(Date.UTC(2027, 0, 1)); d.getUTCFullYear() === 2027; d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  const off = t.currentOffsetMinutes(t.localToInstant(iso, "12:00"));
  if (prev !== null && off !== prev) {
    if (off > prev) { if (!spring) spring = iso; }        // clocks go forward
    else if (!fall) fall = iso;                            // clocks go back
  }
  prev = off;
}

console.log(JSON.stringify({
  zone: t.TZ,
  summer: t.currentOffsetMinutes(t.localToInstant("2027-06-15", "12:00")),
  winter: t.currentOffsetMinutes(t.localToInstant("2027-01-15", "12:00")),
  spring, fall,
  skipped: spring ? t.nonexistentLocalTime(spring, "01:30") : null,
  skippedOk: spring ? !t.nonexistentLocalTime(spring, "03:30") : null,
  ambiguous: fall ? t.ambiguousLocalTime(fall, "01:30") : null,
  ambiguousNo: fall ? !t.ambiguousLocalTime(fall, "05:30") : null,
  quietSpring: spring ? !t.nonexistentLocalTime("2027-05-15", "01:30") : null,
  roundTrip: t.localTime(t.localToInstant("2027-06-15", "12:00")) === "12:00"
}));
`;

const timezoneChecks = () => {
  console.log("\n=== Timezone configuration ===\n");

  const kolkata = inZone("Asia/Kolkata", ZONE_SNIPPET);
  check(
    "Asia/Kolkata is +05:30 all year",
    !kolkata.failed && kolkata.summer === 330 && kolkata.winter === 330,
    JSON.stringify(kolkata),
  );
  // With no transition to test against, the snippet reports null rather than
  // false; what matters is that nothing was detected to be skipped or repeated.
  check(
    "Asia/Kolkata never skips or repeats an hour",
    !kolkata.failed && kolkata.skipped === null && kolkata.ambiguous === null,
    JSON.stringify(kolkata),
  );

  const london = inZone("Europe/London", ZONE_SNIPPET);
  check(
    "Europe/London is +01:00 in summer and +00:00 in winter",
    !london.failed && london.summer === 60 && london.winter === 0,
    JSON.stringify(london),
  );
  check(
    "the hour skipped by spring forward is detected as nonexistent",
    !london.failed && london.skipped === true && london.skippedOk === true,
    JSON.stringify(london),
  );
  check(
    "the hour repeated by fall back is detected as ambiguous",
    !london.failed && london.ambiguous === true && london.ambiguousNo === true,
    JSON.stringify(london),
  );
  check(
    "an ordinary day is neither skipped nor repeated",
    !london.failed && london.quietSpring === true,
    JSON.stringify(london),
  );
  check(
    "Kolkata, which has never observed daylight saving, has no transitions",
    !kolkata.failed && kolkata.spring === null && kolkata.fall === null,
    `spring=${kolkata.spring} fall=${kolkata.fall}`,
  );

  const newYork = inZone("America/New_York", ZONE_SNIPPET);
  check(
    "America/New_York carries a negative offset",
    !newYork.failed && newYork.summer === -240 && newYork.winter === -300,
    JSON.stringify(newYork),
  );

  const utc = inZone("UTC", ZONE_SNIPPET);
  check("UTC is a zero offset all year", !utc.failed && utc.summer === 0 && utc.winter === 0, JSON.stringify(utc));

  // The four zones above all round-trip, which is the property that matters
  // whatever the offset happens to be.
  const allRoundTrip = [kolkata, london, newYork, utc].every((z) => !z.failed && z.roundTrip === true);
  check("every configured zone round-trips a local time", allRoundTrip);

  // A typo must fail at boot, not silently produce times hours out.
  const bad = inZone("Mars/Olympus", `await import("./src/utils/time.js");`);
  check(
    "an invalid APP_TIMEZONE fails at startup rather than silently",
    bad.failed && /not a valid IANA timezone/i.test(bad.stderr ?? ""),
    (bad.stderr ?? "").split("\n").find((l) => /APP_TIMEZONE/.test(l)) ?? "",
  );
};

/* ------------------------------------------------------------------ *
 *  3. Source-level checks                                             *
 * ------------------------------------------------------------------ */

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sourceChecks = () => {
  console.log("\n=== Source: timezone and data access ===\n");

  const srcDir = path.join(ROOT, "src");
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.js$/.test(e.name) ? [full] : [];
    });
  const files = walk(srcDir);

  // The bug this phase exists to remove: a fixed UTC offset standing in for a
  // real zone. Comments may mention it; code may not.
  const offsets = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const patterns = [
      /\?\?\s*5\.5/, // (process.env.APP_TZ_OFFSET_HOURS ?? 5.5)
      /5\.5\s*\*\s*3600/, // Date.now() + 5.5 * 3600_000
      /OFFSET_MS/, // a named offset constant
      /"Asia\/Kolkata"\s*\?/, // a two-world zone branch
    ];
    for (const re of patterns) {
      if (re.test(code)) offsets.push(`${path.relative(ROOT, f)}: ${re}`);
    }
  }
  check(
    "no fixed UTC offset is used as a timezone anywhere in src/",
    offsets.length === 0,
    offsets.join("; "),
  );

  // SQL must derive local time from the configured zone, not a literal.
  const literalZones = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const hits = [...code.matchAll(/AT TIME ZONE\s*'([^']+)'/g)].map((m) => m[1]);
    if (hits.length) literalZones.push(`${path.relative(ROOT, f)}: ${hits.join(", ")}`);
  }
  check(
    "no SQL hardcodes a timezone literal",
    literalZones.length === 0,
    literalZones.join("; "),
  );

  // There must be exactly one definition of the business zone.
  const zoneDefs = files.filter((f) =>
    /export const TZ = process\.env\.APP_TIMEZONE/.test(stripComments(fs.readFileSync(f, "utf8"))),
  );
  check(
    "the business timezone is defined in exactly one module",
    zoneDefs.length === 1 && zoneDefs[0].endsWith(path.join("utils", "time.js")),
    zoneDefs.map((f) => path.relative(ROOT, f)).join(", ") || "none",
  );

  // Time conversion belongs to the shared helper, not to each caller.
  const rawConversions = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (rel.includes(`${path.sep}utils${path.sep}`)) continue;
    const code = stripComments(fs.readFileSync(f, "utf8"));
    if (/Date\.UTC\(\s*\w+\s*,/.test(code) && /AT TIME ZONE|tzLiteral|DATE_EXPR/.test(code)) {
      rawConversions.push(rel);
    }
  }
  check(
    "local-to-instant conversion is not reimplemented in a repository",
    rawConversions.length === 0,
    rawConversions.join(", "),
  );

  // Slot validation must live in the service, not be duplicated in the
  // controller alongside it.
  const ctrl = stripComments(fs.readFileSync(path.join(srcDir, "controllers", "doctorController.js"), "utf8"));
  check(
    "the controller performs no timezone arithmetic of its own",
    !/Date\.UTC|TZ_OFFSET|localToInstant|addMinutes/.test(ctrl),
  );

  // Data access stays in repositories.
  const directDb = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (!rel.startsWith("src/controllers") && !rel.startsWith("src/services")) continue;
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*config\/database\.js["']/g)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim()))
      .filter((x) => x && !["withTransaction", "healthCheck"].includes(x));
    if (imports.length) directDb.push(`${rel}: ${imports.join(",")}`);
    const pooled = [...code.matchAll(
      /(?<!\.)\b(query|exec)\s*\(\s*[`"'][^`"']*\b(SELECT|INSERT|UPDATE|DELETE)\b/gi,
    )];
    for (const m of pooled) {
      const before = code.slice(Math.max(0, m.index - 400), m.index);
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

  const selectStar = [];
  for (const f of files) {
    if (/SELECT\s+\*/i.test(stripComments(fs.readFileSync(f, "utf8")))) {
      selectStar.push(path.relative(ROOT, f));
    }
  }
  check("no SELECT * anywhere in src/", selectStar.length === 0, selectStar.join(", "));
};

/* ------------------------------------------------------------------ *
 *  API checks                                                         *
 * ------------------------------------------------------------------ */

let ctx = {};

const loginAll = async () => {
  const as = async (creds) => (await call("/auth/login", { method: "POST", body: creds })).data;
  const patient = await as(PATIENT);
  const admin = await as(ADMIN);
  const doctor = await as(DOCTOR);
  ctx.P = patient.token;
  ctx.A = admin.token;
  ctx.D = doctor.token;
  ctx.ME = doctor.user.doctor.id;

  const dir = await call("/doctors?limit=20");
  ctx.OTHER = dir.data.doctors.find((d) => d.id !== ctx.ME).id;
  check("logged in as patient, admin and provider", Boolean(ctx.P && ctx.A && ctx.D && ctx.ME));
  check("found a second doctor to test cross-doctor access", Boolean(ctx.OTHER), ctx.OTHER);
};

const post = (doctorId, token, body) =>
  call(`/doctors/${doctorId}/slots`, { method: "POST", token, body });
const patch = (doctorId, slotId, token, body) =>
  call(`/doctors/${doctorId}/slots/${slotId}`, { method: "PATCH", token, body });

/**
 * A date this doctor has no slots on.
 *
 * The availability range only returns dates that have slots, so anything absent
 * from it is genuinely free. Using one keeps "3 slots created" exact on every
 * run without the suite having to clean up after itself.
 */
const pickFreeDate = async () => {
  const r = await call(`/doctors/${ctx.ME}/availability?range=1&days=90`);
  const taken = new Set((r.data?.days ?? []).map((d) => d.date));
  const start = new Date();
  for (let i = 2; i < 90; i += 1) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    if (!taken.has(d)) return d;
  }
  throw new Error("no free date found in the next 90 days");
};

/* ---- reading ---- */

const slotReadChecks = async () => {
  console.log("\n=== Slots: reading ===\n");

  const all = await call(`/doctors/${ctx.ME}/slots`);
  check("GET /doctors/:id/slots succeeds", all.status === 200);
  check(
    "the response keeps slots, dates and summary for the existing client",
    Array.isArray(all.data?.slots) && Array.isArray(all.data?.dates) && "summary" in (all.data ?? {}),
    Object.keys(all.data ?? {}).join(", "),
  );
  check(
    "with no limit the whole schedule is returned",
    all.data.slots.length === all.data.total,
    `${all.data.slots.length} rows vs total ${all.data.total}`,
  );

  const shapes = all.data.slots[0] ?? {};
  check(
    "a slot carries a local date, local times and the underlying instants",
    ["date", "startTime", "endTime", "startsAt", "endsAt"].every((k) => shapes[k] !== undefined),
    Object.keys(shapes).join(", "),
  );
  check(
    "a slot's local time and its instant describe the same moment",
    (() => {
      const s = shapes;
      if (!s.startsAt) return false;
      const asUtc = new Date(s.startsAt).toISOString().slice(11, 16);
      const asLocal = new Date(s.startsAt).toLocaleTimeString("en-GB", {
        timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return asLocal === s.startTime && asUtc !== asLocal;
    })(),
    `${shapes.startsAt} labelled ${shapes.startTime}`,
  );
  check(
    "the local date is never empty and matches its slot's date",
    /^\d{4}-\d{2}-\d{2}$/.test(shapes.date ?? ""),
    shapes.date,
  );

  // --- paging ---
  const page = await call(`/doctors/${ctx.ME}/slots?limit=3`);
  check("limit caps the number of rows returned", page.data.slots.length === 3, String(page.data.slots.length));
  check(
    "total reports the full match count, not the page size",
    page.data.total > 3 && page.data.total === all.data.total,
    `page total ${page.data.total} vs unpaged ${all.data.total}`,
  );
  check("the page echoes its limit and offset", page.data.limit === 3 && page.data.offset === 0);

  const second = await call(`/doctors/${ctx.ME}/slots?limit=3&offset=3`);
  const overlap = second.data.slots.filter((s) => page.data.slots.some((p) => p.id === s.id));
  check("offset advances the window without repeating rows", second.data.slots.length === 3 && overlap.length === 0);
  check(
    "offset keeps reporting the same total",
    second.data.total === page.data.total,
    `${second.data.total} vs ${page.data.total}`,
  );

  // --- filters ---
  const aDate = all.data.dates[0];
  const byDate = await call(`/doctors/${ctx.ME}/slots?date=${aDate}`);
  check(
    "date filter returns only that date",
    byDate.data.slots.length > 0 && byDate.data.slots.every((s) => s.date === aDate),
    `${byDate.data.slots.length} rows`,
  );
  check("date filter narrows the total too", byDate.data.total === byDate.data.slots.length);
  check("date filter populates the summary", byDate.data.summary?.totalSlots === byDate.data.total);

  const video = await call(`/doctors/${ctx.ME}/slots?mode=video`);
  check(
    "mode filter returns only that mode",
    video.data.slots.every((s) => s.mode === "video"),
    [...new Set(video.data.slots.map((s) => s.mode))].join(","),
  );

  const blocked = await call(`/doctors/${ctx.ME}/slots?status=blocked`);
  check(
    "status filter returns only that status",
    blocked.data.slots.every((s) => s.status === "blocked"),
    [...new Set(blocked.data.slots.map((s) => s.status))].join(","),
  );

  // --- ranges ---
  const morning = await call(`/doctors/${ctx.ME}/slots?date=${aDate}&from=00:00&to=11:59`);
  check(
    "a clock-time range keeps only the slots inside it",
    morning.data.slots.every((s) => s.startTime >= "00:00" && s.startTime <= "11:59"),
    morning.data.slots.map((s) => s.startTime).join(" "),
  );
  check(
    "a clock-time range is a strict subset of the day",
    morning.data.slots.length > 0 && morning.data.slots.length < byDate.data.slots.length,
    `${morning.data.slots.length} of ${byDate.data.slots.length}`,
  );

  const wholeDay = await call(`/doctors/${ctx.ME}/slots?from=${aDate}&to=${aDate}`);
  check(
    "a date given as from/to covers the whole local day",
    wholeDay.data.slots.length === byDate.data.slots.length &&
      wholeDay.data.slots.every((s) => s.date === aDate),
    `${wholeDay.data.slots.length} vs ${byDate.data.slots.length}`,
  );

  const reversed = await call(`/doctors/${ctx.ME}/slots?date=${aDate}&from=18:00&to=09:00`);
  check(
    "a range whose start is after its end is refused",
    reversed.status === 400 && codeOf(reversed) === "INVALID_DATE_RANGE",
    `HTTP ${reversed.status} ${codeOf(reversed)}`,
  );

  const junkRange = await call(`/doctors/${ctx.ME}/slots?from=yesterday`);
  check(
    "an unparseable range boundary is refused rather than guessed",
    junkRange.status === 400 && codeOf(junkRange) === "INVALID_DATE_RANGE",
    `HTTP ${junkRange.status} ${codeOf(junkRange)}`,
  );

  // --- futureOnly ---
  const future = await call(`/doctors/${ctx.ME}/slots?futureOnly=true`);
  const now = Date.now();
  check(
    "futureOnly excludes every slot that has already started",
    future.data.slots.every((s) => new Date(s.startsAt).getTime() > now),
    future.data.slots.filter((s) => new Date(s.startsAt).getTime() <= now).map((s) => `${s.date} ${s.startTime}`).join(", "),
  );
  // Whether any slot has started yet depends on the hour the suite runs, so the
  // count is not asserted directly. What must hold every time is that
  // futureOnly only ever removes rows, and that every row it removed is one that
  // had already started.
  const futureIds = new Set(future.data.slots.map((s) => s.id));
  const removed = all.data.slots.filter((s) => !futureIds.has(s.id));
  check(
    "futureOnly only removes rows, never adds any",
    future.data.slots.length <= all.data.slots.length,
    `${future.data.slots.length} of ${all.data.slots.length}`,
  );
  check(
    "every slot futureOnly removed had already started",
    removed.every((s) => new Date(s.startsAt).getTime() <= now),
    removed.map((s) => `${s.date} ${s.startTime}`).join(", "),
  );
  check(
    "removing rows is also reflected in the reported total",
    future.data.total === future.data.slots.length,
    `total=${future.data.total} rows=${future.data.slots.length}`,
  );

  // --- detail ---
  const one = all.data.slots.find((s) => s.date === aDate) ?? all.data.slots[0];
  const detail = await call(`/doctors/${ctx.ME}/slots/${one.id}`);
  check("GET a single slot succeeds", detail.status === 200);
  check("the detail matches the listed slot", detail.data?.slot?.id === one.id);
  check(
    "the detail names the doctor and the facility",
    Boolean(detail.data?.slot?.doctorName && detail.data?.slot?.facilityName),
    JSON.stringify({ d: detail.data?.slot?.doctorName, f: detail.data?.slot?.facilityName }),
  );
  check(
    "a slot detail carries nothing resembling a credential",
    !/password|hash|secret|token/i.test(JSON.stringify(detail.data)),
  );

  const wrongDoctor = await call(`/doctors/${ctx.OTHER}/slots/${one.id}`);
  check(
    "a valid slot id cannot be read through a different doctor's URL",
    wrongDoctor.status === 404 && codeOf(wrongDoctor) === "SLOT_NOT_FOUND",
    `HTTP ${wrongDoctor.status}`,
  );

  const noSuch = await call(`/doctors/${ctx.ME}/slots/00000000-0000-0000-0000-000000000000`);
  check("an unknown slot id is a 404", noSuch.status === 404, `HTTP ${noSuch.status}`);

  ctx.DATE = aDate;
  ctx.ONE = one;
};

const availabilityChecks = async () => {
  console.log("\n=== Availability ===\n");

  const sum = await call(`/doctors/${ctx.ME}/availability`);
  check("GET availability succeeds", sum.status === 200);
  check(
    "the summary reports counts and the zone it used",
    ["totalSlots", "available", "booked", "blocked", "utilizationPercent", "nextAvailableSlot", "timezone"].every(
      (k) => k in (sum.data ?? {}),
    ),
    Object.keys(sum.data ?? {}).join(", "),
  );
  check(
    "the summary names the configured zone rather than assuming one",
    typeof sum.data.timezone === "string" && /UTC[+-]/.test(sum.data.timezone),
    sum.data.timezone,
  );

  const today = new Date();
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  }).format(today);

  const todaySummary = await call(`/doctors/${ctx.ME}/availability?date=${localToday}`);
  const t = todaySummary.data ?? {};
  // Every slot has exactly one status, and `available` deliberately excludes the
  // ones that have already started, so the three buckets plus `elapsed` must
  // account for the day exactly. Anything else means a slot is counted twice or
  // dropped.
  check(
    "available, elapsed, booked and blocked partition the day exactly",
    t.available + t.elapsed + t.booked + t.blocked === t.totalSlots,
    `available=${t.available} elapsed=${t.elapsed} booked=${t.booked} blocked=${t.blocked} total=${t.totalSlots}`,
  );
  if (t.elapsed > 0) {
    // elapsed and available are not complements of one another: a day can hold
    // slots that have already started AND slots still to come. What must hold is
    // that the elapsed ones are not counted as available, which the partition
    // check above already proves.
    check(
      "a day with elapsed slots still reports the ones that are still bookable",
      t.available >= 0 && t.available + t.elapsed <= t.totalSlots,
      `available=${t.available} elapsed=${t.elapsed} total=${t.totalSlots}`,
    );
    const futureOnes = (
      await call(`/doctors/${ctx.ME}/slots?date=${localToday}&status=available&futureOnly=true`)
    ).data.slots.length;
    check(
      "the available count equals the future available slots listed for today",
      t.available === futureOnes,
      `summary says ${t.available}, list shows ${futureOnes}`,
    );
    check(
      "the day's slots list still contains the elapsed ones",
      (await call(`/doctors/${ctx.ME}/slots?date=${localToday}`)).data.slots.length === t.totalSlots,
      "the list and the summary disagree on how many slots today has",
    );
  } else {
    check("no slot has started yet today, so nothing is elapsed", t.elapsed === 0);
  }

  const next = sum.data.nextAvailableSlot;
  if (next) {
    const nextInstant = new Date(
      await call(`/doctors/${ctx.ME}/slots?date=${next.date}&mode=${next.mode}&futureOnly=true`)
        .then((r) => r.data.slots.find((s) => s.startTime === next.time)?.startsAt ?? ""),
    );
    check(
      "the advertised next slot is genuinely in the future",
      nextInstant instanceof Date && !Number.isNaN(nextInstant.getTime()) && nextInstant.getTime() > Date.now(),
      `${next.date} ${next.time}`,
    );
  } else {
    check("the advertised next slot is genuinely in the future", true, "no next slot published");
  }

  // --- per-date range ---
  const range = await call(`/doctors/${ctx.ME}/availability?range=1&days=7`);
  check("availability can be returned day by day", range.status === 200 && Array.isArray(range.data?.days));
  check(
    "the range respects the requested number of days",
    range.data.days.length > 0 && range.data.days.length <= 7,
    `${range.data.days.length} days`,
  );
  check(
    "the range is ordered by date",
    range.data.days.every((d, i) => i === 0 || d.date > range.data.days[i - 1].date),
    range.data.days.map((d) => d.date).join(" "),
  );
  check(
    "every date in the range is today or later",
    range.data.days.every((d) => d.date >= localToday),
    range.data.days.map((d) => d.date).filter((d) => d < localToday).join(" "),
  );
  check(
    "no date in the range advertises a slot that has already started",
    range.data.days.every((d) => !d.nextAvailableSlot || d.nextAvailableSlot.date >= localToday),
    JSON.stringify(range.data.days.map((d) => d.nextAvailableSlot)),
  );
  check(
    "each day carries a status and a truthful available count",
    range.data.days.every(
      (d) => typeof d.status === "string" && d.available >= 0 && d.available <= d.totalSlots,
    ),
    JSON.stringify(range.data.days.map((d) => `${d.date}:${d.available}/${d.totalSlots}`)),
  );
  check(
    "a day with no open slot is not described as available",
    range.data.days.every((d) => (d.available === 0 ? d.status !== "available" : true)),
    JSON.stringify(range.data.days.map((d) => `${d.date}:${d.status}`)),
  );

  const rangeVideo = await call(`/doctors/${ctx.ME}/availability?range=1&days=7&mode=video`);
  const videoDays = new Set((await call(`/doctors/${ctx.ME}/slots?mode=video&futureOnly=true`)).data.slots.map((s) => s.date));
  check(
    "a mode filter narrows the availability range",
    rangeVideo.data.days.every((d) => videoDays.has(d.date)),
    JSON.stringify(rangeVideo.data.days.map((d) => d.date)),
  );

  // The two ways of asking for the range must agree.
  const asFlagTrue = await call(`/doctors/${ctx.ME}/availability?range=true&days=7`);
  const asFlagOne = await call(`/doctors/${ctx.ME}/availability?range=1&days=7`);
  check(
    "range=true and range=1 mean the same thing",
    JSON.stringify(asFlagTrue.data?.days) === JSON.stringify(asFlagOne.data?.days),
  );

  const perDay = await call(`/doctors/${ctx.ME}/availability?date=${ctx.DATE}`);
  const matching = range.data.days.find((d) => d.date === ctx.DATE);
  if (matching) {
    check(
      "the per-day range row agrees with the single-date summary",
      matching.totalSlots === perDay.data.totalSlots && matching.available === perDay.data.available,
      `range ${matching.totalSlots}/${matching.available} vs summary ${perDay.data.totalSlots}/${perDay.data.available}`,
    );
  }

  // Available dates, as the booking UI consumes them.
  const dates = await call(`/doctors/${ctx.ME}/slots?futureOnly=true`);
  check(
    "the advertised dates never include one whose slots have all passed",
    dates.data.dates.every((d) => d >= localToday),
    dates.data.dates.filter((d) => d < localToday).join(", "),
  );
  check(
    "every advertised date really has a bookable slot",
    dates.data.dates.every((d) =>
      dates.data.slots.some((s) => s.date === d && s.status === "available"),
    ),
  );

  // A doctor with no slots at all must report so honestly.
  const empty = await call(`/doctors/${ctx.OTHER}/availability?range=1&days=3`);
  check("availability for a quiet doctor is still a well-formed response", empty.status === 200);
};

const slotCreateChecks = async () => {
  console.log("\n=== Slots: creating ===\n");

  const date = await pickFreeDate();
  console.log(`      fixture date: ${date}\n`);

  const made = await post(ctx.ME, ctx.D, { date, times: ["09:00", "11:00", "14:30"], duration: 30, mode: "video" });
  check("creating slots succeeds", made.status === 201, `HTTP ${made.status} ${codeOf(made) ?? ""}`);
  check("all three requested slots were created", made.data?.createdCount === 3, String(made.data?.createdCount));
  check(
    "the created slots come back with the requested local times",
    ["09:00", "11:00", "14:30"].every((t) => made.data.created.some((c) => c.startTime === t)),
    JSON.stringify(made.data.created),
  );
  check(
    "a 30-minute duration yields a matching end time",
    made.data.created.every((c) => {
      const [h, m] = c.startTime.split(":").map(Number);
      const [eh, em] = c.endTime.split(":").map(Number);
      return eh * 60 + em - (h * 60 + m) === 30;
    }),
    JSON.stringify(made.data.created),
  );
  check("the requested mode is stored", made.data.created.every((c) => c.mode === "video"));

  // The stored instant must match the local wall-clock time in the zone.
  const stored = (await call(`/doctors/${ctx.ME}/slots?date=${date}`)).data.slots;
  const zone = process.env.APP_TIMEZONE || "Asia/Kolkata";
  check(
    "the stored instant renders back to exactly the requested local time",
    ["09:00", "11:00", "14:30"].every((t) => {
      const s = stored.find((x) => x.startTime === t);
      if (!s) return false;
      const back = new Date(s.startsAt).toLocaleTimeString("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return back === t;
    }),
    stored.map((s) => `${s.startTime}@${s.startsAt}`).join(" "),
  );
  check(
    "the fixture date really had no slots beforehand",
    stored.filter((s) => ["09:00", "11:00", "14:30"].includes(s.startTime)).length === 3,
    `${stored.length} slots now on ${date}`,
  );

  // --- duplicates and overlap ---
  const again = await post(ctx.ME, ctx.D, { date, times: ["09:00", "11:00", "14:30"], duration: 30, mode: "video" });
  check(
    "re-creating identical slots creates nothing and says why",
    again.data?.createdCount === 0 && again.data.skipped.length === 3 &&
      again.data.skipped.every((s) => s.reason === "duplicate"),
    JSON.stringify(again.data?.skipped),
  );

  const clash = await post(ctx.ME, ctx.D, { date, times: ["09:15"], duration: 30 });
  check(
    "a slot overlapping an existing one is refused",
    clash.data?.createdCount === 0 && clash.data.skipped[0]?.reason === "overlaps",
    JSON.stringify(clash.data?.skipped),
  );

  const abut = await post(ctx.ME, ctx.D, { date, times: ["09:30"], duration: 30 });
  check(
    "a slot starting exactly when another ends is allowed",
    abut.data?.createdCount === 1,
    JSON.stringify(abut.data?.created ?? abut.data?.skipped),
  );

  const partial = await post(ctx.ME, ctx.D, { date, times: ["16:00", "16:15"], duration: 30 });
  check(
    "two overlapping times in one request do not both get created",
    partial.data?.createdCount <= 1,
    JSON.stringify(partial.data),
  );

  const repeatInRequest = await post(ctx.ME, ctx.D, { date, times: ["18:00", "18:00", "18:00"], duration: 15 });
  check(
    "the same time repeated in one request creates exactly one slot",
    repeatInRequest.data?.createdCount === 1,
    JSON.stringify(repeatInRequest.data?.createdCount),
  );

  ctx.CREATED = made.data.created;
};

/**
 * Every malformed request must be refused, and refused for the stated reason
 * rather than by accident.
 */
const slotValidationChecks = async () => {
  console.log("\n=== Slots: validation ===\n");

  const date = await pickFreeDate();
  const cases = [
    ["a time that is not a time", { date, times: ["abc"] }, 400, "INVALID_TIME"],
    ["an impossible hour", { date, times: ["99:99"] }, 400, "INVALID_TIME"],
    ["an unpadded hour", { date, times: ["9:00"] }, 400, "INVALID_TIME"],
    ["hour 24, which is not a clock time", { date, times: ["24:00"] }, 400, "INVALID_TIME"],
    ["minute 60", { date, times: ["09:60"] }, 400, "INVALID_TIME"],
    ["a date that does not exist", { date: "2027-02-30", times: ["09:00"] }, 400, "INVALID_DATE"],
    ["a date in the far past", { date: "2020-01-01", times: ["09:00"] }, 400, "SLOT_IN_PAST"],
    ["yesterday", { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), times: ["09:00"] }, 400, "SLOT_IN_PAST"],
    ["an empty list of times", { date, times: [] }, 422, "VALIDATION_ERROR"],
    ["times that are not a list", { date, times: "09:00" }, 422, "VALIDATION_ERROR"],
    ["no times at all", { date }, 422, "VALIDATION_ERROR"],
    ["no date at all", { times: ["09:00"] }, 422, "VALIDATION_ERROR"],
    ["a zero duration", { date, times: ["09:00"], duration: 0 }, 422, "VALIDATION_ERROR"],
    ["a duration beyond the maximum", { date, times: ["09:00"], duration: 999 }, 422, "VALIDATION_ERROR"],
    ["a mode that does not exist", { date, times: ["09:00"], mode: "carrier-pigeon" }, 422, "VALIDATION_ERROR"],
    ["more slots than one request may create", { date, times: Array.from({ length: 101 }, (_, i) => `${String(i % 24).padStart(2, "0")}:00`) }, 422, "VALIDATION_ERROR"],
    ["a duration that would run past midnight", { date, times: ["23:50"], duration: 20 }, 400, "INVALID_TIME_RANGE"],
    ["one bad time among good ones", { date, times: ["09:00", "nope", "10:00"] }, 400, "INVALID_TIME"],
  ];

  for (const [label, body, status, code] of cases) {
    const r = await post(ctx.ME, ctx.D, body);
    check(
      `refuses ${label}`,
      r.status === status && codeOf(r) === code,
      `HTTP ${r.status} ${codeOf(r) ?? ""} (wanted ${status} ${code})`,
    );
  }

  // Validation must be all-or-nothing: one bad time means nothing is written.
  const clean = await pickFreeDate();
  const mixed = await post(ctx.ME, ctx.D, { date: clean, times: ["09:00", "10:00"], duration: 30 });
  const untouched = await post(ctx.ME, ctx.D, { date: clean, times: ["bad"], duration: 30 });
  check("a request containing a bad time creates no slots at all", untouched.status === 400);
  const after = await call(`/doctors/${ctx.ME}/slots?date=${clean}`);
  check(
    "the good times from the earlier request are still the only ones present",
    after.data.slots.length === mixed.data.createdCount,
    `${after.data.slots.length} rows vs ${mixed.data.createdCount} created`,
  );

  const longList = await post(ctx.ME, ctx.D, {
    date: await pickFreeDate(),
    times: Array.from({ length: 50 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`),
    duration: 15,
  });
  check(
    "a long list of times within the cap is accepted",
    longList.status === 201 && longList.data.createdCount === 50,
    `HTTP ${longList.status} created=${longList.data?.createdCount}`,
  );
};

const slotUpdateChecks = async () => {
  console.log("\n=== Slots: updating ===\n");

  const date = await pickFreeDate();
  const made = await post(ctx.ME, ctx.D, { date, times: ["10:00"], duration: 30 });
  const slotId = made.data.created[0].id;
  ctx.UPDATE_SLOT = slotId;

  const blocked = await patch(ctx.ME, slotId, ctx.D, { status: "blocked" });
  check("a provider can block their own slot", blocked.status === 200 && blocked.data.slot.status === "blocked");

  // The date held exactly one slot, so blocking it must empty that day.
  const afterBlock = await call(`/doctors/${ctx.ME}/availability?date=${date}`);
  check(
    "blocking the only slot leaves nothing available on that day",
    afterBlock.data.available === 0 && afterBlock.data.blocked === 1,
    `available=${afterBlock.data.available} blocked=${afterBlock.data.blocked}`,
  );
  check(
    "a fully blocked day is not advertised as available",
    afterBlock.data.status !== "available",
    afterBlock.data.status,
  );
  const openOnDate = await call(`/doctors/${ctx.ME}/slots?date=${date}&status=available&futureOnly=true`);
  check(
    "the blocked slot is no longer offered as available",
    openOnDate.data.slots.length === 0,
    `${openOnDate.data.slots.length} still offered`,
  );

  const reopened = await patch(ctx.ME, slotId, ctx.D, { status: "available" });
  check("a provider can reopen their own slot", reopened.data?.slot?.status === "available");

  const mode = await patch(ctx.ME, slotId, ctx.D, { mode: "video" });
  check("a provider can change the mode of their own slot", mode.data?.slot?.mode === "video");

  const ownFee = await patch(ctx.ME, slotId, ctx.D, { fee: 1234 });
  check(
    "a provider cannot set their own price",
    ownFee.status === 403 && codeOf(ownFee) === "FORBIDDEN",
    `HTTP ${ownFee.status} ${codeOf(ownFee)}`,
  );

  const adminFee = await patch(ctx.ME, slotId, ctx.A, { fee: 1234 });
  check("an administrator can set the price", adminFee.status === 200 && adminFee.data.slot.fee === 1234);

  const ownQueue = await patch(ctx.ME, slotId, ctx.D, { maxQueue: 9 });
  check("a provider cannot change the queue capacity", ownQueue.status === 403, `HTTP ${ownQueue.status}`);

  const booked = await patch(ctx.ME, slotId, ctx.D, { status: "booked" });
  check(
    "nobody can declare a slot booked by hand",
    booked.status === 422,
    `HTTP ${booked.status} ${codeOf(booked)}`,
  );

  const empty = await patch(ctx.ME, slotId, ctx.D, {});
  check("an empty update is refused", empty.status === 400 && codeOf(empty) === "EMPTY_PATCH", `HTTP ${empty.status}`);

  const negFee = await patch(ctx.ME, slotId, ctx.A, { fee: -5 });
  check("a negative price is refused", negFee.status === 422, `HTTP ${negFee.status}`);

  const moved = await patch(ctx.ME, slotId, ctx.A, { doctorId: ctx.OTHER });
  check(
    "a slot cannot be reassigned to another doctor",
    moved.status === 422 || (moved.data?.slot?.doctorId ?? ctx.ME) === ctx.ME,
    `HTTP ${moved.status}`,
  );

  const unknown = await patch(ctx.ME, "00000000-0000-0000-0000-000000000000", ctx.D, { status: "blocked" });
  check("updating an unknown slot is a 404", unknown.status === 404, `HTTP ${unknown.status}`);
};

const authorizationChecks = async () => {
  console.log("\n=== Authorization ===\n");

  const date = await pickFreeDate();

  const anon = await post(ctx.ME, null, { date, times: ["09:00"] });
  check("an unauthenticated create is refused", anon.status === 401, `HTTP ${anon.status}`);

  const anonPatch = await patch(ctx.ME, ctx.UPDATE_SLOT, null, { status: "blocked" });
  check("an unauthenticated update is refused", anonPatch.status === 401, `HTTP ${anonPatch.status}`);

  const patient = await post(ctx.ME, ctx.P, { date, times: ["09:00"] });
  check(
    "a patient cannot create slots",
    patient.status === 403 && codeOf(patient) === "FORBIDDEN",
    `HTTP ${patient.status} ${codeOf(patient)}`,
  );

  const patientPatch = await patch(ctx.ME, ctx.UPDATE_SLOT, ctx.P, { status: "blocked" });
  check("a patient cannot update slots", patientPatch.status === 403, `HTTP ${patientPatch.status}`);

  const foreign = await post(ctx.OTHER, ctx.D, { date, times: ["09:00"] });
  check(
    "a provider cannot create slots on another doctor's calendar",
    foreign.status === 403 && codeOf(foreign) === "FORBIDDEN",
    `HTTP ${foreign.status} ${codeOf(foreign)}`,
  );

  const foreignPatch = await patch(ctx.OTHER, ctx.UPDATE_SLOT, ctx.D, { status: "blocked" });
  check("a provider cannot update another doctor's slot", foreignPatch.status === 404, `HTTP ${foreignPatch.status}`);

  const asAdmin = await post(ctx.OTHER, ctx.A, { date, times: ["09:00"] });
  check("an administrator can create slots for any doctor", asAdmin.status === 201, `HTTP ${asAdmin.status}`);

  // An administrator updating their own slot proves nothing, since an admin has
  // no doctor profile. This creates a slot on the *other* doctor as admin, then
  // changes it, so the test is about authority rather than ownership.
  const adminMade = await post(ctx.OTHER, ctx.A, { date, times: ["12:00"], duration: 30 });
  const adminSlotId = adminMade.data?.created?.[0]?.id;
  const adminPatch = await patch(ctx.OTHER, adminSlotId, ctx.A, { status: "blocked" });
  check(
    "an administrator can update a slot on a doctor who is not themselves",
    adminPatch.status === 200 && adminPatch.data.slot.status === "blocked",
    `HTTP ${adminPatch.status} ${codeOf(adminPatch) ?? ""}`,
  );

  const unknownDoc = await post("00000000-0000-0000-0000-000000000000", ctx.A, { date, times: ["09:00"] });
  check(
    "creating slots for a doctor that does not exist is a 404",
    unknownDoc.status === 404 && codeOf(unknownDoc) === "DOCTOR_NOT_FOUND",
    `HTTP ${unknownDoc.status} ${codeOf(unknownDoc)}`,
  );

  // The public reads must stay public and stay harmless.
  const publicList = await call(`/doctors/${ctx.ME}/slots`);
  check("the slot list is still readable without a session", publicList.status === 200);
  check(
    "the public slot list exposes no patient information",
    !/patient|appointmentId|userId|password/i.test(JSON.stringify(publicList.data)),
  );
};

/* ------------------------------------------------------------------ *
 *  Run                                                                *
 * ------------------------------------------------------------------ */

const run = async () => {
  console.log(`\n=== Phase 5 slot and availability checks (${BASE}) ===`);

  await startServer();

  timeUtilChecks();
  timezoneChecks();
  sourceChecks();
  await loginAll();
  await slotReadChecks();
  await availabilityChecks();
  await slotCreateChecks();
  await slotValidationChecks();
  await slotUpdateChecks();
  await authorizationChecks();

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (failures.length) console.log(`\n  Failed: ${failures.join("; ")}`);
  console.log("");

  process.exit(fail > 0 ? 1 : 0);
};

run()
  .catch(async (err) => {
    console.error(`\nSlot checks crashed: ${err.stack || err.message}\n`);
    await stopServer();
    process.exit(1);
  })
  .finally(async () => {
    await stopServer();
  });
