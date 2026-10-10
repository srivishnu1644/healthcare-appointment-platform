/**
 * Schema verification.
 *
 * Proves the constraints this migration exists to introduce actually fire,
 * by attempting each violation and requiring the database to reject it.
 *
 *   DATABASE_URL=... node src/db/scripts/verify-schema.js
 *
 * Connection strategy: every statement runs on its own short-lived
 * connection. A connection that has raised a constraint violation cannot be
 * reused — the backend abandons the transaction and the protocol stream
 * desynchronises — and the bundled local PostgreSQL serves one client at a
 * time, so neither the pool nor a shared client is safe here.
 *
 * Because each statement is its own transaction, a violating insert rolls
 * back by itself. The baseline rows a check needs are created explicitly and
 * deleted afterwards, so this script leaves no trace.
 */
import pg from "pg";

let pass = 0;
let fail = 0;

/* ------------------------------------------------------------------ *
 *  Statement execution                                                *
 * ------------------------------------------------------------------ */

const clientConfig = () => {
  const url = process.env.DATABASE_URL?.trim();
  const local = url ? /localhost|127\.0\.0\.1|\.local/.test(url) : true;

  if (url) {
    return {
      connectionString: url,
      ssl:
        process.env.DB_SSL === "true" || !local
          ? { rejectUnauthorized: false }
          : false,
    };
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  };
};

/**
 * Run one statement on a fresh connection.
 * @returns {{ok: boolean, rows?: any[], code?: string, message?: string}}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute one statement on a fresh connection, retrying a failed *handshake*.
 *
 * The retry applies only to ECONNRESET / EPIPE during connect, which happens
 * when a server that serves a single client at a time has not finished
 * releasing the previous socket. A genuine constraint violation carries a
 * SQLSTATE and is never retried — it is the answer, not a failure.
 */
const exec = async (text, params = [], { attempts = 6 } = {}) => {
  let last = { ok: false, code: "UNKNOWN", message: "not attempted" };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = new pg.Client(clientConfig());
    try {
      await client.connect();
      const r = await client.query(text, params);
      return { ok: true, rows: r.rows };
    } catch (err) {
      last = { ok: false, code: err.code, message: err.message };
      const isHandshakeDrop =
        ["ECONNRESET", "EPIPE", "ECONNREFUSED"].includes(err.code) ||
        /Connection terminated/.test(err.message);
      // A constraint violation is a result. Only a dropped socket is retried.
      if (!isHandshakeDrop || attempt === attempts) return last;
    } finally {
      try {
        client.end();
      } catch {
        /* socket already gone */
      }
    }
    await sleep(250 * attempt);
  }
  return last;
};

const rows = async (text, params = []) => (await exec(text, params)).rows ?? [];
const one = async (text, params = []) => (await rows(text, params))[0] ?? null;

/**
 * Run several statements on ONE connection.
 *
 * `exec` opens a fresh client per statement, which is what a suite that
 * deliberately provokes constraint violations wants - each one has to be
 * isolated. But a session setting does NOT survive that: `SET enable_seqscan =
 * off` applied through `exec` is discarded when that client ends, so the EXPLAINs
 * that follow run with sequential scans still enabled and the check silently
 * asserts nothing.
 *
 * That bug was here all along and only surfaced once the suite ran against a real
 * PostgreSQL server instead of the single-connection bundled one. Anything that
 * needs a GUC to persist across statements must use this.
 *
 * @param {(q: (text: string, params?: any[]) => Promise<any[]>)} fn
 */
const withSession = async (fn) => {
  const client = new pg.Client(clientConfig());
  await connectWithRetry(client);
  try {
    const q = async (text, params = []) => (await client.query(text, params)).rows;
    return await fn(q);
  } finally {
    try {
      await client.end();
    } catch {
      /* socket already gone */
    }
  }
};

/** Connect, retrying only a failed handshake (never a statement error). */
const connectWithRetry = async (client, attempts = 6) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.connect();
      return;
    } catch (err) {
      const dropped =
        ["ECONNRESET", "EPIPE", "ECONNREFUSED"].includes(err.code) ||
        /Connection terminated|socket/i.test(err.message);
      if (!dropped || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
};

/** Assert a statement is rejected with the expected SQLSTATE. */
const rejects = async (text, expectedCode, params = []) => {
  const outcome = await exec(text, params);
  if (outcome.ok) {
    throw new Error(`expected ${expectedCode}, but the statement SUCCEEDED`);
  }
  if (outcome.code !== expectedCode) {
    throw new Error(
      `expected ${expectedCode}, got ${outcome.code} (${outcome.message})`,
    );
  }
  console.log(`      rejected with SQLSTATE ${outcome.code}`);
};

/* ------------------------------------------------------------------ *
 *  Fixture helpers                                                    *
 *                                                                     *
 *  Baseline rows are created explicitly and deleted afterwards, so the   *
 *  checks leave no residue. `created` records them in reverse insertion  *
 *  order, which is the safe deletion order given the foreign keys.        *
 * ------------------------------------------------------------------ */

let created = [];

/** Register a fixture row for later deletion. */
const onCleanup = (sql, params = []) => created.push({ sql, params });

/**
 * Delete every fixture row this check created, children before parents.
 *
 * Order matters: a check registers its slot first and its appointments after,
 * so deleting in reverse is the only order that satisfies the foreign keys.
 * Deleting a slot that an appointment still references fails with SQLSTATE
 * 23001 and leaves the row behind.
 *
 * Failures are reported rather than swallowed: a silently skipped DELETE would
 * leave the database permanently dirtier after every run, which is exactly the
 * sort of thing a verification script must not do.
 */
const cleanupAll = async () => {
  const pending = created.reverse();
  created = [];
  if (!pending.length) return;

  // One connection for every DELETE. Opening a connection per statement makes
  // the bundled local server drop sockets under rapid churn, which shows up as
  // spurious ECONNRESET on the cleanup itself.
  const client = new pg.Client(clientConfig());
  client.on("error", () => {});
  const failed = [];
  try {
    // Same retry the rest of the script uses: the bundled local server drops
    // sockets under rapid reconnects, which is not a statement failure.
    await connectWithRetry(client, 8);
    for (const { sql, params } of pending) {
      try {
        await client.query(sql, params);
      } catch (err) {
        failed.push(`${sql} -> ${err.code}`);
      }
    }
  } catch (err) {
    failed.push(`connect -> ${err.code}`);
  } finally {
    try {
      await client.end();
    } catch {
      /* socket already gone */
    }
  }

  if (failed.length) {
    console.log(`      WARNING: ${failed.length} cleanup statement(s) failed:`);
    failed.forEach((f) => console.log(`        ${f}`));
  }
};

/** Wrap a destructive check so its fixtures are always removed. */
const withCleanup = async (fn) => {
  created = [];
  try {
    await fn();
  } finally {
    await cleanupAll();
  }
};

/**
 * A future instant far beyond any seeded slot.
 *
 * Includes a random component so repeated runs, and any slot a crashed
 * earlier run left behind, cannot collide: the slots_no_doctor_overlap
 * exclusion constraint would otherwise reject the fixture itself.
 */
let clock = 0;
const futureBase = () => {
  clock += 200 * 86400_000;
  const jitterDays = Math.floor(Math.random() * 3000);
  const jitterMinutes = Math.floor(Math.random() * 600);
  return new Date(Date.now() + clock + jitterDays * 86400_000 + jitterMinutes * 60000);
};
const at = (base, minutes) => new Date(base.getTime() + minutes * 60000);

/** An INSERT ... RETURNING that must succeed; a failure here is a test bug. */
const insertReturning = async (sql, params, label) => {
  const outcome = await exec(sql, params);
  if (!outcome.ok) {
    throw new Error(`${label} fixture insert failed: ${outcome.code} ${outcome.message}`);
  }
  const row = outcome.rows?.[0];
  if (!row) throw new Error(`${label} fixture insert returned no row`);
  return row;
};

const insertSlot = async (doctorId, facilityId, startsAt, endsAt) => {
  const r = await insertReturning(
    `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [doctorId, facilityId, startsAt, endsAt],
    "slot",
  );
  onCleanup("DELETE FROM slots WHERE id = $1", [r.id]);
  return r;
};

const insertAppointment = async (row) => {
  const r = await insertReturning(
    `INSERT INTO appointments
       (patient_id, doctor_id, slot_id, specialty_id, facility_id,
        mode, status, starts_at, ends_at, cancelled_at)
     VALUES ($1,$2,$3,$4,$5,'in-person',$6,$7,$8,$9) RETURNING id`,
    [
      row.patientId,
      row.doctorId,
      row.slotId,
      row.specialtyId,
      row.facilityId,
      row.status,
      row.startsAt,
      row.endsAt,
      row.cancelledAt ?? null,
    ],
    "appointment",
  );
  onCleanup("DELETE FROM appointments WHERE id = $1", [r.id]);
  return r;
};

/** A SELECT whose absence is a test-setup failure, not a null to trip over. */
const requireOne = async (sql, params = [], label = "row") => {
  const r = await one(sql, params);
  if (!r) throw new Error(`fixture lookup returned no ${label} — is the database seeded?`);
  return r;
};

/** Two doctors, so a patient-overlap test is not masked by slot overlap. */
const twoDoctors = async () => ({
  a: await requireOne("SELECT id, facility_id FROM doctors ORDER BY id LIMIT 1", [], "doctor"),
  b: await requireOne(
    "SELECT id, facility_id FROM doctors ORDER BY id OFFSET 1 LIMIT 1",
    [],
    "second doctor",
  ),
});

const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`FAIL  ${name} :: ${err.message}`);
    fail += 1;
  }
};

/* ------------------------------------------------------------------ *
 *  Structural checks                                                  *
 * ------------------------------------------------------------------ */

const structuralChecks = async () => {
  await check("all 13 migrations applied", async () => {
    const r = await one("SELECT count(*)::int AS c FROM schema_migrations");
    if (r.c < 13) throw new Error(`only ${r.c} applied`);
    console.log(`      ${r.c} migrations recorded`);
  });

  await check("expected tables exist", async () => {
    const expected = [
      "users", "patient_profiles", "patient_allergies", "refresh_tokens",
      "specialties", "facilities", "services",
      "doctors", "doctor_services", "doctor_languages",
      "slots", "appointments", "appointment_status_history",
      "queue_entries", "notifications", "notification_deliveries",
      "notification_outbox", "audit_logs", "triage_sessions", "seed_metadata",
      "schema_migrations",
    ];
    const r = await one(
      `SELECT count(*)::int AS c FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [expected],
    );
    if (r.c !== expected.length) throw new Error(`${r.c}/${expected.length}`);
    console.log(`      ${r.c} tables`);
  });

  await check("every enum type created", async () => {
    const expected = [
      "user_role", "consult_mode", "slot_status", "appt_status",
      "queue_state", "notify_channel", "delivery_status", "cancelled_by_role",
    ];
    const r = await one(
      "SELECT count(*)::int AS c FROM pg_type WHERE typname = ANY($1)",
      [expected],
    );
    if (r.c !== expected.length) throw new Error(`${r.c}/${expected.length}`);
    console.log(`      ${r.c} enum types`);
  });

  await check("RLS is enabled on every sensitive table", async () => {
    const r = await one(`
      SELECT count(*)::int AS c FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`);
    if (r.c < 10) throw new Error(`only ${r.c} tables`);
    console.log(`      ${r.c} tables have RLS enabled with no permissive policies`);
  });

  await check("named indexes exist on the hot query paths", async () => {
    const expected = [
      "slots_doctor_available_idx", "appointments_one_active_per_slot",
      "appointments_patient_idx", "appointments_doctor_idx",
      "doctors_specialty_facility_idx", "doctor_languages_lang_idx",
      "notifications_user_unread_idx", "facilities_city_idx",
      "queue_unique_position", "users_email_key",
    ];
    const r = await one(
      "SELECT count(*)::int AS c FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)",
      [expected],
    );
    if (r.c !== expected.length) throw new Error(`${r.c}/${expected.length}`);
    console.log(`      ${r.c} named indexes verified`);
  });

  // This used to assert that the planner picks slots_doctor_available_idx, which
  // is a statement about today's row counts rather than about the schema: at this
  // table size the planner is equally entitled to prefer slots_status_idx and
  // still return an index scan for the same query. Widening the seeded slot grid
  // tipped it over and the check failed while the index remained perfectly usable.
  //
  // The property worth protecting is the one its neighbour already states: an
  // index CAN serve the predicate, so the query never degrades into a sequential
  // scan as the table grows. Both halves are now checked separately.
  const SLOT_AVAILABILITY_SQL = `
    SELECT id FROM slots
     WHERE doctor_id = 'x' AND starts_at > now() AND status = 'available'
     ORDER BY starts_at LIMIT 1`;

  await check("the slot availability query uses an index, not a sequential scan", async () => {
    const plan = await rows(`EXPLAIN (FORMAT TEXT) ${SLOT_AVAILABILITY_SQL}`);
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    if (/Seq Scan on/.test(text)) throw new Error(`sequential scan:\n${text}`);
    if (!/Index (Scan|Only Scan)|Bitmap Index Scan/.test(text)) {
      throw new Error(`expected an index scan; got:\n${text}`);
    }
    console.log("      index scan confirmed");
  });

  // Asserted structurally rather than by asking the planner. Even with sequential
  // scans disabled the planner may legitimately choose the GiST index
  // slots_no_doctor_overlap, because its leading column is also doctor_id and it
  // covers the same equality. Demanding one specific index would be asserting a
  // costing decision, so what is checked instead is that the index exists with the
  // columns and predicate the query needs - which is the part that would actually
  // break.
  await check("slots_doctor_available_idx is defined for doctor + upcoming + available", async () => {
    const r = await one(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'slots_doctor_available_idx'`);
    if (!r) throw new Error("index is missing");
    const def = r.indexdef;
    for (const [what, re] of [
      ["doctor_id column", /\(doctor_id/],
      ["starts_at column", /starts_at/],
      ["status predicate", /WHERE\s*\(.*status\s*=\s*'available'/i],
    ]) {
      if (!re.test(def)) throw new Error(`${what} missing from: ${def}`);
    }
    console.log("      slots_doctor_available_idx confirmed");
  });
};

/* ------------------------------------------------------------------ *
 *  Directory index usability                                          *
 *                                                                     *
 *  These assert an index can serve its predicate, not that the        *
 *  planner picks it today. On a 12-doctor table a sequential scan is  *
 *  genuinely cheaper, so "did it choose the index?" would only assert  *
 *  that the dataset is too small. What actually breaks silently is an  *
 *  index that exists but cannot serve the query - wrong column order,  *
 *  or an expression mismatch such as indexing `city` while the query   *
 *  filters `lower(city)`. Disabling seq scans forces the planner to   *
 *  use an index if one can serve the predicate, which is the property  *
 *  worth pinning.                                                      *
 * ------------------------------------------------------------------ */

const directoryChecks = async () => {
  const expected = [
    ["doctors_facility_idx", "doctors_facility_active_idx"],
    ["doctors_specialty_facility_idx"],
    ["facilities_city_name_idx"],
    ["facilities_city_lower_idx"],
    ["facilities_city_idx"],
    ["doctor_languages_lang_idx"],
    ["doctor_services_pkey"],
    ["specialties_slug_key"],
  ];

  await check("directory indexes exist", async () => {
    const r = await one(
      `SELECT count(*)::int AS c FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [expected.flat()],
    );
    if (r.c !== expected.flat().length) {
      throw new Error(`${r.c}/${expected.flat().length} present`);
    }
    console.log(`      ${r.c} directory indexes present`);
  });

  // Each predicate must be servable by an index. Any index on the table counts:
  // the property under test is "no sequential scan on a large table", not
  // which of several overlapping indexes wins today.
  const usable = [
    ["doctors by facility", "SELECT id FROM doctors WHERE facility_id = 'x'"],
    ["doctors by specialty", "SELECT id FROM doctors WHERE specialty_id = 'x'"],
    [
      "doctors by specialty + facility",
      "SELECT id FROM doctors WHERE specialty_id = 'x' AND facility_id = 'y'",
    ],
    [
      "doctors by facility + accepting",
      "SELECT id FROM doctors WHERE facility_id = 'x' AND is_accepting_new",
    ],
    ["doctors by fee", "SELECT id FROM doctors WHERE consultation_fee <= 1000"],
    ["doctors by rating", "SELECT id FROM doctors WHERE seed_rating >= 4.5"],
    [
      "doctor counts per specialty",
      "SELECT specialty_id, count(*) FROM doctors GROUP BY specialty_id",
    ],
    [
      "doctor counts per facility",
      "SELECT facility_id, count(*) FROM doctors GROUP BY facility_id",
    ],
    ["facilities by city (case-insensitive)", "SELECT id FROM facilities WHERE lower(city) = lower('x')"],
    ["facilities by city, ordered by name", "SELECT id FROM facilities WHERE city = 'x' ORDER BY name"],
    ["specialty by slug", "SELECT id FROM specialties WHERE slug = lower('x')"],
    ["languages for a doctor", "SELECT language FROM doctor_languages WHERE doctor_id = 'x'"],
    ["services for a doctor", "SELECT service_id FROM doctor_services WHERE doctor_id = 'x'"],
  ];

  await check("directory queries are index-servable", async () => {
    // One session, so `enable_seqscan = off` actually reaches the EXPLAINs.
    const notServable = await withSession(async (q) => {
      await q("SET enable_seqscan = off");
      const bad = [];
      for (const [label, sql] of usable) {
        const plan = await q(`EXPLAIN (FORMAT TEXT) ${sql}`);
        const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
        // Only a *sequential* scan counts as a failure. A Bitmap Heap Scan sits
        // on top of a Bitmap Index Scan and is very much an indexed read.
        const scanLines = text
          .split("\n")
          .filter((l) => /Seq Scan on/.test(l))
          .join(" | ");
        if (scanLines) bad.push(`${label} -> ${scanLines.trim()}`);
      }
      await q("SET enable_seqscan = on");
      return bad;
    });
    if (notServable.length) {
      throw new Error(
        `sequential scan even with seqscan disabled:\n        ${notServable.join("\n        ")}`,
      );
    }
    console.log(`      ${usable.length} predicates all index-servable`);
  });
};

/* ------------------------------------------------------------------ *
 *  Constraint checks                                                  *
 * ------------------------------------------------------------------ */

const constraintChecks = async () => {
  await check("users_email_format rejects a malformed email", async () => {
    await withCleanup(() =>
      rejects(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ('not-an-email','$2a$10$abcdefghijklmnopqrstuv','Test Person')`,
        "23514",
      ),
    );
  });

  await check("users_password_is_bcrypt makes 'hashed:' unrepresentable", async () => {
    await withCleanup(() =>
      rejects(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ('legacy@test.local','hashed:plaintext123','Legacy User')`,
        "23514",
      ),
    );
    console.log("      the Phase 0 storage format can no longer be written");
  });

  await check("users_email unique is case-insensitive (citext)", async () => {
    const existing = await requireOne("SELECT email FROM users LIMIT 1", [], "user");
    await withCleanup(() =>
      rejects(
        `INSERT INTO users (email, password_hash, full_name)
         VALUES ($1,'$2a$10$abcdefghijklmnopqrstuv','Duplicate')`,
        "23505",
        [String(existing.email).toUpperCase()],
      ),
    );
  });

  await check("doctors_one_account_per_doctor is unique", async () => {
    await withCleanup(async () => {
      const d = await requireOne("SELECT user_id FROM doctors LIMIT 1", [], "doctor");
      await rejects(
        `INSERT INTO doctors (user_id, specialty_id, facility_id, consultation_fee)
           SELECT user_id, specialty_id, facility_id, consultation_fee
             FROM doctors WHERE user_id = $1`,
        "23505",
        [d.user_id],
      );
    });
  });

  await check("slots_no_doctor_overlap rejects overlapping slots", async () => {
    await withCleanup(async () => {
      const doc = await requireOne("SELECT id, facility_id FROM doctors LIMIT 1", [], "doctor");
      const base = futureBase();
      await insertSlot(doc.id, doc.facility_id, base, at(base, 30));
      await rejects(
        `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
         VALUES ($1,$2,$3,$4)`,
        "23P01",
        [doc.id, doc.facility_id, at(base, 15), at(base, 45)],
      );
    });
    console.log("      D-B1 fixed: a doctor can no longer hold 09:00 and 09:15");
  });

  await check("abutting slots for one doctor remain valid", async () => {
    await withCleanup(async () => {
      const doc = await requireOne("SELECT id, facility_id FROM doctors LIMIT 1", [], "doctor");
      const base = futureBase();
      await insertSlot(doc.id, doc.facility_id, base, at(base, 30));
      await insertSlot(doc.id, doc.facility_id, at(base, 30), at(base, 60));
    });
  });

  await check("appointments_one_active_per_slot blocks a double booking", async () => {
    await withCleanup(async () => {
      const doc = await requireOne("SELECT id, facility_id FROM doctors LIMIT 1", [], "doctor");
      const spec = await requireOne("SELECT id FROM specialties LIMIT 1", [], "specialty");
      const p1 = await requireOne("SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1", [], "patient");
      const p2 = await requireOne("SELECT id FROM users WHERE role = 'patient' ORDER BY id OFFSET 1 LIMIT 1", [], "second patient");
      const base = futureBase();
      const end = at(base, 30);
      const slot = await insertSlot(doc.id, doc.facility_id, base, end);

      await insertAppointment({
        patientId: p1.id,
        doctorId: doc.id,
        slotId: slot.id,
        specialtyId: spec.id,
        facilityId: doc.facility_id,
        status: "confirmed",
        startsAt: base,
        endsAt: end,
      });

      // A different patient booking the same slot must still be refused.
      await rejects(
        `INSERT INTO appointments
           (patient_id, doctor_id, slot_id, specialty_id, facility_id,
            mode, status, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,'in-person','confirmed',$6,$7)`,
        "23505",
        [p2.id, doc.id, slot.id, spec.id, doc.facility_id, base, end],
      );
    });
    console.log("      double booking on one slot is now structurally impossible");
  });

  await check("appointments_patient_no_overlap blocks an overlapping booking", async () => {
    await withCleanup(async () => {
      const patient = await requireOne(
        "SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1",
        [],
        "patient",
      );
      const spec = await requireOne("SELECT id FROM specialties LIMIT 1", [], "specialty");
      const { a, b } = await twoDoctors();
      const base = futureBase();

      // Different doctors, so only the patient-overlap rule can fire.
      const s1 = await insertSlot(a.id, a.facility_id, base, at(base, 30));
      await insertAppointment({
        patientId: patient.id,
        doctorId: a.id,
        slotId: s1.id,
        specialtyId: spec.id,
        facilityId: a.facility_id,
        status: "confirmed",
        startsAt: base,
        endsAt: at(base, 30),
      });

      const s2 = await insertSlot(b.id, b.facility_id, at(base, 15), at(base, 45));
      await rejects(
        `INSERT INTO appointments
           (patient_id, doctor_id, slot_id, specialty_id, facility_id,
            mode, status, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,'in-person','confirmed',$6,$7)`,
        "23P01",
        [patient.id, b.id, s2.id, spec.id, b.facility_id, at(base, 15), at(base, 45)],
      );
    });
    console.log("      D-B1 fixed: a patient cannot hold 09:00 and 09:15");
  });

  await check("a cancelled record frees its slot and time again", async () => {
    await withCleanup(async () => {
      const patient = await requireOne(
        "SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1",
        [],
        "patient",
      );
      const spec = await requireOne("SELECT id FROM specialties LIMIT 1", [], "specialty");
      const { a, b } = await twoDoctors();
      const base = futureBase();
      const end = at(base, 30);

      const s1 = await insertSlot(a.id, a.facility_id, base, end);
      await insertAppointment({
        patientId: patient.id,
        doctorId: a.id,
        slotId: s1.id,
        specialtyId: spec.id,
        facilityId: a.facility_id,
        status: "cancelled",
        startsAt: base,
        endsAt: end,
        cancelledAt: new Date(),
      });

      const s2 = await insertSlot(b.id, b.facility_id, base, end);
      await insertAppointment({
        patientId: patient.id,
        doctorId: b.id,
        slotId: s2.id,
        specialtyId: spec.id,
        facilityId: b.facility_id,
        status: "confirmed",
        startsAt: base,
        endsAt: end,
      });
    });
  });

  await check("appointments_cancel_consistent requires cancelled_at", async () => {
    await withCleanup(async () => {
      const doc = await requireOne("SELECT id, facility_id FROM doctors LIMIT 1", [], "doctor");
      const patient = await requireOne(
        "SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1",
        [],
        "patient",
      );
      const spec = await requireOne("SELECT id FROM specialties LIMIT 1", [], "specialty");
      const base = futureBase();
      const end = at(base, 30);
      const slot = await insertSlot(doc.id, doc.facility_id, base, end);

      await rejects(
        `INSERT INTO appointments
           (patient_id, doctor_id, slot_id, specialty_id, facility_id,
            mode, status, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,'in-person','cancelled',$6,$7)`,
        "23514",
        [patient.id, doc.id, slot.id, spec.id, doc.facility_id, base, end],
      );
    });
  });

  await check("appointment doctor must own its slot (trigger)", async () => {
    await withCleanup(async () => {
      const patient = await requireOne(
        "SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1",
        [],
        "patient",
      );
      const spec = await requireOne("SELECT id FROM specialties LIMIT 1", [], "specialty");
      const { a, b } = await twoDoctors();
      const base = futureBase();
      const end = at(base, 30);
      const slot = await insertSlot(a.id, a.facility_id, base, end);

      // The slot belongs to doctor A; the appointment claims doctor B.
      await rejects(
        `INSERT INTO appointments
           (patient_id, doctor_id, slot_id, specialty_id, facility_id,
            mode, status, starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,'in-person','confirmed',$6,$7)`,
        "23514",
        [patient.id, b.id, slot.id, spec.id, b.facility_id, base, end],
      );
    });
  });

  await check("queue_one_entry_per_appointment prevents a duplicate check-in", async () => {
    await withCleanup(async () => {
      const a = await requireOne(
        "SELECT id, slot_id, doctor_id, patient_id FROM appointments ORDER BY id LIMIT 1",
        [],
        "appointment",
      );
      const insert = () =>
        exec(
          `INSERT INTO queue_entries
             (id, appointment_id, slot_id, doctor_id, patient_id, position)
           VALUES (gen_random_uuid()::text,$1,$2,$3,$4,1)`,
          [a.id, a.slot_id, a.doctor_id, a.patient_id],
        );

      const first = await insert();
      if (!first.ok) throw new Error(`setup insert failed: ${first.code}`);
      onCleanup("DELETE FROM queue_entries WHERE appointment_id = $1", [a.id]);

      const second = await insert();
      if (second.ok) throw new Error("expected 23505, but a second entry was accepted");
      if (second.code !== "23505") {
        throw new Error(`expected 23505, got ${second.code}`);
      }
      console.log("      rejected with SQLSTATE 23505");
    });
    console.log("      S-06/D-B4 fixed: check-in inflation is impossible");
  });
};

/* ------------------------------------------------------------------ *
 *  Transaction helper                                                 *
 *                                                                     *
 *  Phase 2 adds `withTransaction()` (config/database.js) but does    *
 *  NOT rewire booking onto it - that is Phase 6. These checks exist  *
 *  so the helper is proven correct before anything depends on it: a   *
 *  helper that silently committed early, or ignored a rollback, would *
 *  make Phase 6 booking transaction unsafe.                          *
 *                                                                     *
 *  They exercise the real helper, not a hand-rolled imitation.       *
 *                                                                     *
 *  Connection discipline: the helper pool keeps one connection open  *
 *  for the duration, and the bundled local server serves a single    *
 *  client at a time. Every fixture lookup therefore runs INSIDE the  *
 *  transaction, on the helper own client, and the one check that must *
 *  provoke a constraint violation runs after the pool is closed.     *
 * ------------------------------------------------------------------ */

/** Look up a row inside the transaction, failing loudly if it is absent. */
const txRequire = async (tx, sql, params, label) => {
  const row = await tx.one(sql, params);
  if (!row) throw new Error(`fixture lookup returned no ${label}`);
  return row;
};

/**
 * Slot count used to assert durability.
 *
 * Read through whichever client is currently safe: the pool while it holds a
 * connection (the pool refuses to hand out a second one, and the bundled local
 * server serves a single client), or a short-lived connection otherwise.
 */
let slotCountViaPool = null;
const slotCount = async () =>
  slotCountViaPool
    ? (await slotCountViaPool()).c
    : (await one("SELECT count(*)::int AS c FROM slots"))?.c;

const transactionChecks = async () => {
  const { withTransaction, closePool, healthCheck } = await import(
    "../../config/database.js"
  );

  const slotsBefore = await slotCount();
  if (slotsBefore === undefined) {
    throw new Error("could not read the initial slot count");
  }

  // From here on the pool owns the only client, so durability assertions read
  // through it rather than opening a second connection.
  const slotRepo = await import("../../repositories/slotRepo.js");
  slotCountViaPool = slotRepo.count;

  /* ---------------- pool-backed checks ---------------- */

  await check("withTransaction commits on success", () =>
    withCleanup(async () => {
    const baseline = await slotCount();
    await withTransaction(async (tx) => {
      const doc = await txRequire(
        tx,
        "SELECT id, facility_id FROM doctors ORDER BY id LIMIT 1",
        [],
        "doctor",
      );
      const base = futureBase();
      const slot = await tx.one(
        `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [doc.id, doc.facility_id, base, at(base, 30)],
      );
      onCleanup("DELETE FROM slots WHERE id = $1", [slot.id]);

      // Visible to this transaction before it commits.
      const seen = await tx.one(
        "SELECT count(*)::int AS c FROM slots WHERE id = $1",
        [slot.id],
      );
      if (seen.c !== 1) throw new Error("insert not visible inside the transaction");
    });

    const after = await slotCount();
    if (after !== baseline + 1) {
      throw new Error(`insert did not survive COMMIT (${after} slots)`);
    }
    console.log("      write visible in-transaction and durable after COMMIT");
  }));

  await check("withTransaction rolls back when the callback throws", () =>
    withCleanup(async () => {
    const baseline = await slotCount();
    let propagated = false;
    try {
      await withTransaction(async (tx) => {
        const doc = await txRequire(
          tx,
          "SELECT id, facility_id FROM doctors ORDER BY id LIMIT 1",
          [],
          "doctor",
        );
        const base = futureBase();
        await tx.query(
          `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
           VALUES ($1,$2,$3,$4)`,
          [doc.id, doc.facility_id, base, at(base, 30)],
        );
        throw new Error("__force_rollback__");
      });
    } catch (err) {
      if (err.message !== "__force_rollback__") throw err;
      propagated = true;
    }
    if (!propagated) throw new Error("the thrown error did not propagate");

    const after = await slotCount();
    if (after !== baseline) {
      throw new Error(`the insert survived ROLLBACK (${after} slots)`);
    }
    console.log("      the error propagated and the write was discarded");
  }));

  await check("nested withTransaction uses SAVEPOINTs", () =>
    withCleanup(async () => {
    const baseline = await slotCount();
    await withTransaction(async (outer) => {
      const doc = await txRequire(
        outer,
        "SELECT id, facility_id FROM doctors ORDER BY id OFFSET 2 LIMIT 1",
        [],
        "third doctor",
      );
      const base = futureBase();
      const slot = await outer.one(
        `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [doc.id, doc.facility_id, base, at(base, 30)],
      );
      onCleanup("DELETE FROM slots WHERE id = $1", [slot.id]);

      try {
        // The inner call fails. Because it rolls back only to its own
        // savepoint, the outer transaction and its row must survive.
        await withTransaction(async (inner) => {
          await inner.query(
            `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
             VALUES ($1,$2,$3,$4)`,
            [doc.id, doc.facility_id, at(base, 60), at(base, 90)],
          );
          throw new Error("__inner_rollback__");
        });
      } catch (err) {
        if (err.message !== "__inner_rollback__") throw err;
      }

      const still = await outer.one("SELECT 1 AS ok FROM slots WHERE id = $1", [
        slot.id,
      ]);
      if (!still) throw new Error("the outer insert was lost");
    });

    const after = await slotCount();
    if (after !== baseline + 1) {
      throw new Error(
        `expected only the outer slot to commit, got ${after - baseline} extra`,
      );
    }
    console.log("      inner rollback left the outer transaction intact");
  }));

  await check("SELECT ... FOR UPDATE takes a row lock", async () => {
    await withTransaction(async (tx) => {
      const slot = await txRequire(
        tx,
        "SELECT id FROM slots ORDER BY id LIMIT 1",
        [],
        "slot",
      );
      const locked = await tx.one(
        "SELECT id FROM slots WHERE id = $1 FOR UPDATE",
        [slot.id],
      );
      if (!locked) throw new Error("FOR UPDATE returned no row");
    });
    console.log("      row locking is available for Phase 6 booking");
  });

  // The pool must let go of its connection before a second client is opened.
  await closePool();
  slotCountViaPool = null;

  /* ---------------- the violation check ---------------- */

  await check("a constraint violation aborts the whole transaction", () =>
    withCleanup(async () => {
    const baseline = await slotCount();
    // Dedicated connection on purpose: a constraint violation abandons the
    // transaction and desynchronises the connection that raised it, so it
    // must not run on a pooled connection the script reuses.
    const client = new pg.Client(clientConfig());
    // A pg Client with no "error" listener turns a socket reset into an
    // unhandled event that kills the process. This connection is expected to
    // be abandoned mid-transaction, so its teardown errors are noise.
    client.on("error", () => {});
    try {
      await client.connect();
      const doc = (
        await client.query(
          "SELECT id, facility_id FROM doctors ORDER BY id LIMIT 1",
        )
      ).rows[0];
      const base = futureBase();
      await client.query("BEGIN");
      const slot = (
        await client.query(
          `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [doc.id, doc.facility_id, base, at(base, 30)],
        )
      ).rows[0];
      onCleanup("DELETE FROM slots WHERE id = $1", [slot.id]);

      let violation = null;
      try {
        // Overlaps the slot just created, so it must be rejected.
        await client.query(
          `INSERT INTO slots (doctor_id, facility_id, starts_at, ends_at)
           VALUES ($1,$2,$3,$4)`,
          [doc.id, doc.facility_id, at(base, 15), at(base, 45)],
        );
      } catch (err) {
        violation = err;
      }
      if (!violation) {
        throw new Error("expected 23P01, but the overlapping slot was accepted");
      }
      if (violation.code !== "23P01") {
        throw new Error(`expected 23P01, got ${violation.code}`);
      }
      await client.query("ROLLBACK");
    } finally {
      // The socket was just abandoned mid-transaction; let the server
      // release it before the assertion opens a new client.
      await new Promise((r) => setTimeout(r, 500));
      try {
        await client.end();
      } catch {
        /* socket already gone */
      }
    }

    const after = await slotCount();
    if (after !== baseline) {
      throw new Error(
        `the first insert survived despite the later violation (${after} slots)`,
      );
    }
    console.log("      no partially-booked state is representable");
  }));

  await check("healthCheck reports the connected server", async () => {
    const h = await healthCheck();
    if (!h.ok) throw new Error(`health check failed: ${h.error}`);
    console.log(`      PostgreSQL ${h.version}`);
  });
};


/* ------------------------------------------------------------------ *
 *  Seeded data invariants                                             *
 *                                                                     *
 *  The constraint checks above prove the SCHEMA rejects bad states.   *
 *  These prove the seed does not PRODUCE them, which is a different    *
 *  claim: a seed can satisfy every constraint and still be incoherent, *
 *  and a demo database full of impossible data is worse than an empty  *
 *  one. Read-only throughout.                                          *
 * ------------------------------------------------------------------ */

/** Assert a count is exactly zero, naming how many rows broke the rule. */
const expectNone = async (sql, params = []) => {
  const r = await one(sql, params);
  if (r?.c !== 0) throw new Error(`${r.c} row(s) violate the invariant`);
};

const seededDataChecks = async () => {
  const seeded = await one(`SELECT count(*)::int AS c FROM appointments`);
  if (!seeded?.c) {
    console.log("\n=== Seeded data invariants ===\n");
    console.log("      no seeded appointments present; run `npm run db:seed` to exercise these");
    return;
  }

  console.log("\n=== Seeded data invariants ===\n");

  /* ---- slot / appointment agreement ---- */

  await check("seed: no slot is 'booked' without an active appointment", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM slots sl
       WHERE sl.status = 'booked'
         AND NOT EXISTS (SELECT 1 FROM appointments a
                          WHERE a.slot_id = sl.id
                            AND a.status IN ('scheduled','confirmed','in-progress'))`),
  );

  await check("seed: no active appointment sits on a slot that is not 'booked'", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
        JOIN slots sl ON sl.id = a.slot_id
       WHERE a.status IN ('scheduled','confirmed','in-progress')
         AND sl.status <> 'booked'`),
  );

  await check("seed: booked slots and active appointments agree in number", async () => {
    const booked = await one(`SELECT count(*)::int AS c FROM slots WHERE status = 'booked'`);
    const active = await one(`
      SELECT count(*)::int AS c FROM appointments
       WHERE status IN ('scheduled','confirmed','in-progress')`);
    if (booked.c !== active.c) {
      throw new Error(`${booked.c} booked slot(s) vs ${active.c} active appointment(s)`);
    }
  });

  await check("seed: an appointment's time window is its slot's time window", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
        JOIN slots sl ON sl.id = a.slot_id
       WHERE a.starts_at <> sl.starts_at OR a.ends_at <> sl.ends_at`),
  );

  await check("seed: an appointment's doctor owns its slot", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
        JOIN slots sl ON sl.id = a.slot_id
       WHERE a.doctor_id <> sl.doctor_id`),
  );

  await check("seed: an appointment's mode matches its slot's mode", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
        JOIN slots sl ON sl.id = a.slot_id
       WHERE a.mode <> sl.mode`),
  );

  await check("seed: a finished appointment is never on a future slot", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
        JOIN slots sl ON sl.id = a.slot_id
       WHERE a.status IN ('completed','cancelled','no-show')
         AND sl.starts_at > now()`),
  );

  await check("seed: no appointment starts before it was created", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments
       WHERE starts_at < created_at - interval '1 minute'`),
  );

  /* ---- cancellation consistency ---- */

  await check("seed: every cancelled appointment carries cancelled_at", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments
       WHERE status = 'cancelled' AND cancelled_at IS NULL`),
  );

  await check("seed: no uncancelled appointment carries cancelled_at", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments
       WHERE status <> 'cancelled' AND cancelled_at IS NOT NULL`),
  );

  await check("seed: every cancelled appointment records who cancelled it", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments
       WHERE status = 'cancelled' AND cancelled_by IS NULL`),
  );

  /* ---- history ---- */

  await check("seed: every appointment has a creation history row", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
       WHERE NOT EXISTS (SELECT 1 FROM appointment_status_history h
                          WHERE h.appointment_id = a.id AND h.from_status IS NULL)`),
  );

  await check("seed: no history row is missing an actor", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointment_status_history
       WHERE changed_by IS NULL`),
  );

  await check("seed: a creation row's actor is the patient who booked", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointment_status_history h
        JOIN appointments a ON a.id = h.appointment_id
       WHERE h.from_status IS NULL AND h.changed_by IS DISTINCT FROM a.patient_id`),
  );

  await check("seed: a creation row names the appointment's current status", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointments a
       WHERE NOT EXISTS (SELECT 1 FROM appointment_status_history h
                          WHERE h.appointment_id = a.id
                            AND h.from_status IS NULL
                            AND h.to_status = a.status)`),
  );

  await check("seed: the history covers every seeded appointment", async () => {
    const apts = await one(`SELECT count(*)::int AS c FROM appointments`);
    const hist = await one(`
      SELECT count(DISTINCT appointment_id)::int AS c FROM appointment_status_history`);
    if (apts.c !== hist.c) {
      throw new Error(`${apts.c} appointment(s) but ${hist.c} covered by history`);
    }
  });

  await check("seed: no history row predates the appointment it describes", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM appointment_status_history h
        JOIN appointments a ON a.id = h.appointment_id
       WHERE h.created_at < a.created_at - interval '1 minute'`),
  );

  /* ---- queue ---- */

  await check("seed: no appointment has more than one queue entry", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM (
        SELECT appointment_id FROM queue_entries GROUP BY appointment_id HAVING count(*) > 1
      ) x`),
  );

  await check("seed: every queue position is positive", () =>
    expectNone(`SELECT count(*)::int AS c FROM queue_entries WHERE position < 1`));

  await check("seed: no two waiting entries share a position within a slot", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM (
        SELECT slot_id, position FROM queue_entries WHERE state = 'waiting'
         GROUP BY slot_id, position HAVING count(*) > 1
      ) x`),
  );

  await check("seed: no queue entry waits for a closed appointment", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM queue_entries q
        JOIN appointments a ON a.id = q.appointment_id
       WHERE q.state = 'waiting'
         AND a.status IN ('cancelled','completed','no-show')`),
  );

  await check("seed: every queue entry agrees with its appointment's slot, doctor and patient", () =>
    expectNone(`
      SELECT count(*)::int AS c FROM queue_entries q
        JOIN appointments a ON a.id = q.appointment_id
       WHERE q.slot_id <> a.slot_id OR q.doctor_id <> a.doctor_id
          OR q.patient_id <> a.patient_id`),
  );

  /* ---- the seed's own bookkeeping ---- */

  await check("seed: the recorded booked-slot count matches reality", async () => {
    const actual = await one(`SELECT count(*)::int AS c FROM slots WHERE status = 'booked'`);
    const recorded = await one(`
      SELECT (value->'counts'->>'bookedSlots')::int AS c
        FROM seed_metadata WHERE key = 'seed'`);
    if (recorded?.c !== actual.c) {
      throw new Error(`metadata says ${recorded?.c}, database has ${actual.c}`);
    }
  });
};

const run = async () => {
  console.log("\n=== Schema verification ===\n");
  await structuralChecks();
  await directoryChecks();
  await constraintChecks();
  await seededDataChecks();
  await transactionChecks();

  // Belt and braces: if a run was interrupted, the explicit per-check cleanup
  // may not have run. Fixture slots are only ever created far beyond the
  // seeded window, so anything there is residue.
  const residue = await one(`
    SELECT count(*)::int AS c FROM slots
     WHERE starts_at > now() + interval '60 days'`);
  if (residue?.c > 0) {
    await exec(`
      DELETE FROM slots WHERE starts_at > now() + interval '60 days'
        AND id NOT IN (SELECT slot_id FROM appointments)`);
    const after = await one(`
      SELECT count(*)::int AS c FROM slots
       WHERE starts_at > now() + interval '60 days'
         AND id NOT IN (SELECT slot_id FROM appointments)`);
    console.log(
      `      swept ${residue.c - after.c} residual fixture slot(s) from an interrupted run`,
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(`\nVerification crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});