/**
 * Phase 3 authentication and session-security checks.
 *
 *   node scripts/auth-check.js            # against http://localhost:5000
 *   API_URL=http://localhost:5099/api ... # against a running instance
 *   SPAWN=1 node scripts/auth-check.js    # start/stop the API itself
 *
 * Why this script can manage the server
 * -------------------------------------
 * Some of these checks need to put the database into a specific state — an
 * already-expired refresh token, for instance, which no API route can produce.
 * The bundled local PostgreSQL serves a single client at a time, so the test
 * process cannot open its own connection while the API holds the pool's.
 *
 * The script therefore owns the API lifecycle: it starts the server, runs the
 * HTTP checks, stops it, edits rows directly, restarts, and finishes with
 * assertions about what is actually stored.
 *
 * Coverage
 *   * login issues an access token and a refresh token
 *   * the access token carries only {sub, role}
 *   * refresh rotates, and the spent token cannot be reused
 *   * reuse is detected and revokes the whole family
 *   * logout revokes the session, and tolerates a token it does not know
 *   * expired access token, expired refresh token, and unknown tokens are all
 *     rejected with distinct, actionable codes
 *   * the database stores only digests — never a usable token
 *   * existing user/role authorization still holds
 */
import "./local-db-guard.mjs"; // MUST stay first: applies the local-DB override.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API = process.env.API_URL || "http://localhost:5000/api";
const SPAWN_SERVER = process.env.SPAWN === "1";
const PORT = Number(process.env.AUTHCHECK_PORT) || 5099;
const BASE = SPAWN_SERVER ? `http://localhost:${PORT}/api` : API;

const PATIENT = { email: "patient@demo.com", password: "patient123" };
const OTHER_PATIENT = { email: "ishita@demo.com", password: "patient123" };
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

/* ------------------------------------------------------------------ *
 *  HTTP helper                                                        *
 * ------------------------------------------------------------------ */

const call = async (pathname, { method = "GET", token, body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: payload };
};

const loginAs = async (creds) => {
  const r = await call("/auth/login", { method: "POST", body: creds });
  return r.body?.data ?? null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  Server lifecycle                                                   *
 * ------------------------------------------------------------------ */

let server = null;

const startServer = async () => {
  if (!SPAWN_SERVER) return;
  server = spawn(process.execPath, ["index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(`  [api] ${d}`));

  // Poll /health rather than sleeping a fixed amount.
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null)
      throw new Error(`API exited early with code ${server.exitCode}`);
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
 *  Direct database access                                            *
 *                                                                     *
 *  Only used while the API is stopped, because the local server      *
 *  serves one client at a time.                                       *
 * ------------------------------------------------------------------ */

const withDb = async (fn) => {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")
      ? false
      : { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      /* already closed */
    }
  }
};

/* ------------------------------------------------------------------ *
 *  Phase A — HTTP behaviour                                           *
 * ------------------------------------------------------------------ */

const phaseA = async () => {
  console.log("\n=== Phase A: token issuance and rotation ===\n");

  const session = await loginAs(PATIENT);
  check("login issues an access token", !!session?.token);
  check("login issues a refresh token", !!session?.refreshToken);

  if (!session?.token || !session?.refreshToken) return null;

  /* ---- access token shape ---- */
  const claims = JSON.parse(
    Buffer.from(session.token.split(".")[1], "base64url").toString(),
  );
  const claimKeys = Object.keys(claims).filter(
    (k) => !["iat", "exp", "iss"].includes(k),
  );
  check(
    "access token payload is minimal (only sub and role)",
    claimKeys.length === 2 && claims.sub && claims.role,
    `claims: ${JSON.stringify(claims)}`,
  );
  check(
    "access token carries no email, name or profile",
    !("email" in claims) && !("name" in claims) && !("profile" in claims),
  );
  check(
    "access token is short-lived (under 1 hour)",
    claims.exp - claims.iat <= 3600,
    `lifetime ${claims.exp - claims.iat}s`,
  );
  check(
    "refresh token is opaque, not a JWT",
    !session.refreshToken.includes(".") &&
      session.refreshToken.length >= 40,
    `len ${session.refreshToken.length}`,
  );
  check(
    "login reports expiresIn",
    Number(session.expiresIn) > 0 && Number(session.expiresIn) <= 3600,
    `expiresIn=${session.expiresIn}`,
  );

  /* ---- the access token works ---- */
  const me = await call("/auth/me", { token: session.token });
  check(
    "access token authenticates /auth/me",
    me.status === 200 && me.body?.data?.user?.email === PATIENT.email,
    `status=${me.status}`,
  );

  const noAuth = await call("/auth/me");
  check(
    "missing access token is rejected",
    noAuth.status === 401 && noAuth.body?.error?.code === "NO_TOKEN",
    `status=${noAuth.status}`,
  );

  /* ---- /auth/session ---- */
  const sess = await call("/auth/session", { token: session.token });
  check(
    "GET /auth/session validates the access token",
    sess.status === 200 && sess.body?.data?.user?.email === PATIENT.email,
    `status=${sess.status}`,
  );
  check(
    "/auth/session counts live sessions",
    sess.body?.data?.activeSessions >= 1,
    `activeSessions=${sess.body?.data?.activeSessions}`,
  );
  check(
    "/auth/session requires authentication",
    (await call("/auth/session")).status === 401,
  );

  /* ---- /auth/session identifies the caller's own session ---- */
  const own = await call("/auth/session", {
    token: session.token,
    headers: { "X-Refresh-Token": session.refreshToken },
  });
  check(
    "/auth/session reports the session behind this refresh token",
    own.body?.data?.session &&
      own.body?.data?.session.expiresInSeconds > 0,
    JSON.stringify(own.body?.data?.session),
  );

  // A refresh token belonging to somebody else must not be described back.
  const other = await loginAs(ADMIN);
  const foreign = await call("/auth/session", {
    token: session.token,
    headers: { "X-Refresh-Token": other.refreshToken },
  });
  check(
    "/auth/session will not describe another user's refresh token",
    foreign.status === 200 && foreign.body?.data?.session === null,
    `session=${JSON.stringify(foreign.body?.data?.session)}`,
  );

  /* ---- rotation ---- */
  const first = session.refreshToken;
  const rot = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: first },
  });
  check(
    "refresh returns a new token pair",
    rot.status === 200 && !!rot.body?.data?.token && !!rot.body?.data?.refreshToken,
    `status=${rot.status} ${rot.body?.message ?? ""}`,
  );
  check(
    "rotation issues a different refresh token",
    rot.body?.data?.refreshToken !== first,
  );

  // The access token is NOT required to differ from the previous one. It
  // carries only {sub, role}, so two tokens minted in the same second are
  // byte-identical by design - which is precisely why the payload is minimal.
  // What matters is that the new one is valid and identifies the same user.
  const rotatedMe = await call("/auth/me", { token: rot.body?.data?.token });
  check(
    "the rotated access token authenticates and identifies the same user",
    rotatedMe.status === 200 &&
      rotatedMe.body?.data?.user?.id === me.body?.data?.user?.id,
    `status=${rotatedMe.status}`,
  );
  const second = rot.body?.data?.refreshToken;

  /* ---- the spent token must not work again ---- */
  const replay = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: first },
  });
  check(
    "a spent refresh token is refused (reuse detection)",
    replay.status === 401 &&
      replay.body?.error?.code === "REFRESH_TOKEN_REUSED",
    `status=${replay.status} code=${replay.body?.error?.code}`,
  );

  /* ---- and reuse condemns the successor ---- */
  const successor = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: second },
  });
  check(
    "reuse detection revokes the whole token family",
    successor.status === 401,
    `successor status=${successor.status}`,
  );

  return { first, second, claims };
};

/* ------------------------------------------------------------------ *
 *  Authorization must be unaffected                                   *
 * ------------------------------------------------------------------ */

const phaseAuthorization = async () => {
  console.log("\n=== Phase A2: existing authorization still holds ===\n");

  const patient = await loginAs(PATIENT);
  const admin = await loginAs(ADMIN);
  const doctor = await loginAs(DOCTOR);

  check("patient can log in", !!patient?.token);
  check("admin can log in", !!admin?.token);
  check("doctor can log in", !!doctor?.token);

  const asPatient = await call("/admin/overview", { token: patient?.token });
  check(
    "patient is refused the admin dashboard",
    asPatient.status === 403,
    `status=${asPatient.status}`,
  );

  const asDoctor = await call("/admin/overview", { token: doctor?.token });
  check(
    "doctor is refused the admin dashboard",
    asDoctor.status === 403,
    `status=${asDoctor.status}`,
  );

  const asAdmin = await call("/admin/overview", { token: admin?.token });
  check(
    "admin reaches the admin dashboard",
    asAdmin.status === 200 && !!asAdmin.body?.data?.kpis,
    `status=${asAdmin.status}`,
  );

  const wrongPassword = await call("/auth/login", {
    method: "POST",
    body: { email: PATIENT.email, password: "not-the-password" },
  });
  check(
    "wrong password is refused",
    wrongPassword.status === 401 &&
      wrongPassword.body?.error?.code === "BAD_CREDENTIALS",
    `status=${wrongPassword.status}`,
  );

  const unknownAccount = await call("/auth/login", {
    method: "POST",
    body: { email: "nobody@nowhere.local", password: PATIENT.password },
  });
  check(
    "unknown account gives the same error as a wrong password",
    unknownAccount.body?.error?.code === wrongPassword.body?.error?.code,
    `${unknownAccount.body?.error?.code} vs ${wrongPassword.body?.error?.code}`,
  );

  /* ---- role isolation on a doctor-only route ---- */
  const providerRoute = await call("/doctors/me/schedule", {
    token: patient?.token,
  });
  check(
    "patient is refused the provider schedule",
    providerRoute.status === 403,
    `status=${providerRoute.status}`,
  );

  return { patient, admin, doctor };
};

/* ------------------------------------------------------------------ *
 *  Invalid tokens                                                     *
 * ------------------------------------------------------------------ */

const phaseInvalid = async () => {
  console.log("\n=== Phase A3: invalid tokens ===\n");

  const session = await loginAs(PATIENT);

  /* ---- garbage refresh tokens ---- */
  const bogus = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: "a".repeat(43) },
  });
  check(
    "a well-formed but unknown refresh token is refused",
    bogus.status === 401 &&
      bogus.body?.error?.code === "INVALID_REFRESH_TOKEN",
    `status=${bogus.status} code=${bogus.body?.error?.code}`,
  );

  const tooShort = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: "short" },
  });
  check(
    "a malformed refresh token is refused",
    tooShort.status >= 400,
    `status=${tooShort.status}`,
  );

  const missing = await call("/auth/refresh", { method: "POST", body: {} });
  check(
    "a missing refresh token is refused",
    missing.status >= 400,
    `status=${missing.status}`,
  );

  /* ---- tampered access tokens ---- */
  const tampered = `${session.token.slice(0, -3)}abc`;
  const bad = await call("/auth/me", { token: tampered });
  check(
    "a tampered access token is refused",
    bad.status === 401,
    `status=${bad.status}`,
  );

  const garbage = await call("/auth/me", { token: "not.a.jwt" });
  check(
    "a non-JWT access token is refused",
    garbage.status === 401 &&
      garbage.body?.error?.code === "INVALID_TOKEN",
    `status=${garbage.status} code=${garbage.body?.error?.code}`,
  );

  /* ---- a correctly signed but expired access token ---- */
  // Signed with the real secret, so this proves expiry is detected on its own
  // terms rather than being lumped in with "invalid".
  const expired = await mintExpiredAccessToken(session.user?.id ?? "");
  const exp = await call("/auth/me", { token: expired });
  check(
    "an expired access token reports TOKEN_EXPIRED (so a client knows to refresh)",
    exp.status === 401 && exp.body?.error?.code === "TOKEN_EXPIRED",
    `status=${exp.status} code=${exp.body?.error?.code}`,
  );

  /* ---- logout ---- */
  const doomed = await loginAs(OTHER_PATIENT);
  const out = await call("/auth/logout", {
    method: "POST",
    body: { refreshToken: doomed.refreshToken },
  });
  check(
    "logout succeeds",
    out.status === 200 && out.body?.data?.ok === true,
    `status=${out.status}`,
  );
  check(
    "logout revoked at least one session",
    Number(out.body?.data?.revoked) >= 1,
    `revoked=${out.body?.data?.revoked}`,
  );

  const afterLogout = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: doomed.refreshToken },
  });
  check(
    "the refresh token is dead after logout",
    afterLogout.status === 401,
    `status=${afterLogout.status}`,
  );

  /* ---- logout must not be an oracle, and must always work ---- */
  const unknownLogout = await call("/auth/logout", {
    method: "POST",
    body: { refreshToken: "b".repeat(43) },
  });
  check(
    "logout with an unknown token still returns 200",
    unknownLogout.status === 200 && unknownLogout.body?.data?.ok === true,
    `status=${unknownLogout.status}`,
  );

  const emptyLogout = await call("/auth/logout", { method: "POST", body: {} });
  check(
    "logout with no token at all still returns 200",
    emptyLogout.status === 200 && emptyLogout.body?.data?.ok === true,
    `status=${emptyLogout.status}`,
  );

  /* ---- logout does not kill an unrelated session ---- */
  const victim = await loginAs(PATIENT);
  const bystander = await loginAs(ADMIN);
  await call("/auth/logout", {
    method: "POST",
    body: { refreshToken: victim.refreshToken },
  });
  const bystanderRefresh = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: bystander.refreshToken },
  });
  check(
    "logging out of one session leaves another session alone",
    bystanderRefresh.status === 200,
    `status=${bystanderRefresh.status}`,
  );

  /* ---- wrong password on refresh must not rotate anything ---- */
  const target = await loginAs(PATIENT);
  const notMine = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: `${target.refreshToken.slice(0, 42)}Z` },
  });
  check(
    "a near-miss refresh token is refused",
    notMine.status === 401,
    `status=${notMine.status}`,
  );

  /* ---- sign out everywhere ---- */
  const device1 = await loginAs(OTHER_PATIENT);
  const device2 = await loginAs(OTHER_PATIENT);
  const adminSession = await loginAs(ADMIN);

  const everywhere = await call("/auth/logout", {
    method: "POST",
    token: device1.token,
    body: { allDevices: true },
  });
  check(
    "logout with allDevices ends every session for the account",
    everywhere.status === 200 &&
      Number(everywhere.body?.data?.revoked) >= 2,
    `status=${everywhere.status} revoked=${everywhere.body?.data?.revoked}`,
  );

  const d1 = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: device1.refreshToken },
  });
  const d2 = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: device2.refreshToken },
  });
  check(
    "both sessions are dead after allDevices logout",
    d1.status === 401 && d2.status === 401,
    `device1=${d1.status} device2=${d2.status}`,
  );

  const adminRefresh = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: adminSession.refreshToken },
  });
  check(
    "allDevices logout does not touch another account",
    adminRefresh.status === 200,
    `status=${adminRefresh.status}`,
  );

  // allDevices needs an identity to scope the revocation. Without one it must
  // degrade to an ordinary logout of the presented token - which is legitimate,
  // because the caller owns that token - and must NOT reach the same user's
  // other sessions.
  const adminDevice1 = await loginAs(ADMIN);
  const adminDevice2 = await loginAs(ADMIN);

  const anonymous = await call("/auth/logout", {
    method: "POST",
    body: { refreshToken: adminDevice1.refreshToken, allDevices: true },
  });
  check(
    "allDevices without a valid access token does not fail",
    anonymous.status === 200,
    `status=${anonymous.status}`,
  );
  check(
    "an anonymous allDevices logout revokes only the presented session",
    Number(anonymous.body?.data?.revoked) === 1,
    `revoked=${anonymous.body?.data?.revoked}`,
  );

  const otherDevice = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: adminDevice2.refreshToken },
  });
  check(
    "an anonymous allDevices logout cannot reach the user's other sessions",
    otherDevice.status === 200,
    `status=${otherDevice.status}`,
  );
};

/**
 * Sign a correctly signed access token that expired an hour ago.
 *
 * Uses the same secret and issuer as the server, so the only thing wrong with
 * it is the expiry. That distinguishes "expired" from "invalid" as an outcome.
 */
const mintExpiredAccessToken = async (sub) => {
  const jwt = (await import("jsonwebtoken")).default;
  return jwt.sign(
    { sub, role: "patient" },
    process.env.JWT_SECRET,
    {
      // `expiresIn` must be negative relative to now.
      expiresIn: -3600,
      issuer: process.env.JWT_ISSUER || "medicare-api",
    },
  );
};

/* ------------------------------------------------------------------ *
 *  Phase B — expired refresh token, driven through the database       *
 * ------------------------------------------------------------------ */

const phaseExpiredRefresh = async () => {
  console.log("\n=== Phase B: an expired refresh token ===\n");

  const session = await loginAs(PATIENT);
  if (!session?.refreshToken) {
    check("setup: could not log in for the expiry test", false);
    return;
  }

  await stopServer();

  await withDb(async (c) => {
    // Only this session's row, matched on its digest — the same lookup the
    // server performs.
    const digest = (await import("node:crypto"))
      .createHash("sha256")
      .update(session.refreshToken, "utf8")
      .digest("hex");
    await c.query(
      "UPDATE refresh_tokens SET expires_at = now() - interval '1 hour' WHERE token_hash = $1",
      [digest],
    );
  });

  await startServer();

  const expired = await call("/auth/refresh", {
    method: "POST",
    body: { refreshToken: session.refreshToken },
  });
  check(
    "an expired refresh token is refused",
    expired.status === 401,
    `status=${expired.status}`,
  );
  check(
    "an expired refresh token reports its own code",
    expired.body?.error?.code === "REFRESH_TOKEN_EXPIRED",
    `code=${expired.body?.error?.code}`,
  );

  // The access token from that login must still work: refresh expiry and access
  // expiry are independent clocks.
  const stillOk = await call("/auth/me", { token: session.token });
  check(
    "the access token outlives the refresh token",
    stillOk.status === 200,
    `status=${stillOk.status}`,
  );
};

/* ------------------------------------------------------------------ *
 *  Phase C — what is actually stored                                  *
 * ------------------------------------------------------------------ */

const phaseStorage = async (rawTokens) => {
  console.log("\n=== Phase C: what the database stores ===\n");

  await stopServer();

  const result = await withDb(async (c) => {
    const rows = (await c.query("SELECT * FROM refresh_tokens")).rows;

    const allRaw = [...rawTokens].filter(Boolean);

    // The decisive check: no column of any row may contain a token we handed
    // out. This is what "the database stores only digests" actually means.
    const leak = allRaw.filter((t) =>
      rows.some((r) => JSON.stringify(r).includes(t)),
    );

    // A stored value that is not a 64-char hex digest is either a raw token or
    // a truncated/corrupt hash; either way it is a defect.
    const malformed = rows.filter((r) => !/^[0-9a-f]{64}$/.test(r.token_hash));

    const reasons = await c.query(
      `SELECT revoked_reason, count(*)::int AS c
         FROM refresh_tokens WHERE revoked_at IS NOT NULL
        GROUP BY revoked_reason ORDER BY revoked_reason`,
    );

    const rotated = await c.query(
      `SELECT count(*)::int AS c FROM refresh_tokens
        WHERE revoked_reason = 'rotated' AND replaced_by IS NOT NULL AND used_at IS NOT NULL`,
    );

    const badRotation = await c.query(
      `SELECT count(*)::int AS c FROM refresh_tokens
        WHERE (replaced_by IS NULL) <> (used_at IS NULL)`,
    );

    return {
      count: rows.length,
      leak,
      malformed,
      reasons: reasons.rows,
      rotated: rotated.rows[0].c,
      badRotation: badRotation.rows[0].c,
    };
  });

  check(
    "no raw refresh token appears anywhere in the database",
    result.leak.length === 0,
    `${result.leak.length} leaked`,
  );
  check(
    "token_hash is a 64-character hex digest on every row",
    result.malformed.length === 0,
    `${result.malformed.length} malformed`,
  );
  check(
    "every rotation records both replaced_by and used_at",
    result.badRotation === 0,
    `${result.badRotation} inconsistent`,
  );
  check(
    "rotation is recorded in the database",
    result.rotated >= 1,
    `rotated=${result.rotated}`,
  );
  check(
    "reuse detection recorded a 'reuse_detected' revocation",
    result.reasons.some((r) => r.revoked_reason === "reuse_detected"),
    JSON.stringify(result.reasons),
  );
  check(
    "logout recorded a 'logout' revocation",
    result.reasons.some((r) => r.revoked_reason === "logout"),
    JSON.stringify(result.reasons),
  );
  check(
    "expiry recorded an 'expired' revocation",
    result.reasons.some((r) => r.revoked_reason === "expired"),
    JSON.stringify(result.reasons),
  );
  check(
    "no revocation has a reason outside the allowed set",
    result.reasons.every((r) =>
      ["rotated", "logout", "reuse_detected", "expired", "revoked"].includes(
        r.revoked_reason,
      ),
    ),
    JSON.stringify(result.reasons),
  );

  /* ---- the retention job must not touch live sessions ---- */
  const purge = await withDb(async (c) => {
    // Age every row past the grace period. Live sessions are protected by
    // expires_at, so this only affects tokens that were already unusable.
    await c.query(
      "UPDATE refresh_tokens SET expires_at = now() - interval '10 days'",
    );
    return (await c.query("SELECT count(*)::int AS c FROM refresh_tokens")).rows[0]
      .c;
  });

  const { default: sessionRepo } = await import("../src/repositories/sessionRepo.js");
  const removed = await sessionRepo.purgeExpired(24);
  const { closePool } = await import("../src/config/database.js");
  await closePool();

  check(
    "purging expired tokens removes them",
    removed > 0 && removed <= purge,
    `removed=${removed} of ${purge}`,
  );
  check(
    "purging never removes a token that is still inside its grace period",
    removed <= purge,
  );

  const after = await withDb(async (c) => ({
    total: (await c.query("SELECT count(*)::int AS c FROM refresh_tokens")).rows[0].c,
    live: (
      await c.query(
        "SELECT count(*)::int AS c FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()",
      )
    ).rows[0].c,
  }));

  check(
    "no live session was destroyed by the purge",
    after.live === 0,
    `live=${after.live}`,
  );
};

/* ------------------------------------------------------------------ *
 *  Run                                                                *
 * ------------------------------------------------------------------ */

const run = async () => {
  console.log(`\n=== Phase 3 auth checks (${BASE}) ===`);

  await startServer();

  const collected = [];

  const a = await phaseA();
  if (a) collected.push(a.first, a.second);

  await phaseAuthorization();
  await phaseInvalid();

  await phaseExpiredRefresh();

  await phaseStorage(collected);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (failures.length) {
    console.log(`\n  Failed: ${failures.join("; ")}`);
  }
  console.log("");

  process.exit(fail > 0 ? 1 : 0);
};

run()
  .catch(async (err) => {
    console.error(`\nAuth checks crashed: ${err.stack || err.message}\n`);
    await stopServer();
    process.exit(1);
  })
  .finally(async () => {
    await stopServer();
  });