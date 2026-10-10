/**
 * Migrate the Phase 1 JSON datastore into PostgreSQL.
 *
 *   node src/db/scripts/migrate-json.js            # abort if the DB has data
 *   node src/db/scripts/migrate-json.js --force    # wipe target tables first
 *   node src/db/scripts/migrate-json.js --status   # compare counts only
 *
 * ID strategy: every existing id is preserved verbatim, so patients,
 * doctors, slots and appointments keep pointing at each other without any
 * remapping table. Passwords are the notable exception — `hashed:` values
 * cannot satisfy the new CHECK constraint and are re-hashed with bcrypt
 * as they are read, then discarded.
 *
 * The JSON file is never modified or deleted. It remains the rollback
 * reference until the PostgreSQL deployment is trusted in production.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, one, closePool, withTransaction } from "../../config/database.js";
import { hashPassword } from "../../utils/password.js";
import logger from "../../utils/logger.js";

const log = logger.tag("migrate-json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JSON_PATH = process.env.JSON_DATA_PATH
  ? path.resolve(process.env.JSON_DATA_PATH)
  : path.resolve(__dirname, "../../../.data/db.json");

// Shared with the API, so a time read out of the legacy JSON lands on the same
// instant the application will later display.
const { TZ, localToInstant } = await import("../../utils/time.js");
const FORCE = process.argv.includes("--force");
const STATUS_ONLY = process.argv.includes("--status");

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Naive local wall-clock → instant, honouring the configured zone.
 *
 * This project previously had three separate implementations of this
 * conversion, two of them driven by a hardcoded per-zone offset table that
 * covered only two zones. They now all call utils/time.js, so the migration,
 * the seed and the API cannot disagree about what "09:00 on 2030-01-01" means.
 */

/** Read the JSON datastore. */
const readJson = () => {
  if (!fs.existsSync(JSON_PATH)) {
    throw new Error(
      `JSON datastore not found at ${JSON_PATH}.\n` +
        "Nothing to migrate. Set JSON_DATA_PATH to point at a different file.",
    );
  }
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
};

/** Tables, in dependency order, for the --force truncate. */
const TABLES = [
  "notification_outbox",
  "notification_deliveries",
  "notifications",
  "queue_entries",
  "appointment_status_history",
  "appointments",
  "slots",
  "doctor_languages",
  "doctor_services",
  "doctors",
  "patient_allergies",
  "patient_profiles",
  "users",
  "seed_metadata",
  "triage_sessions",
  "audit_logs",
  "services",
  "facilities",
  "specialties",
];

const targetCounts = async () => {
  const out = {};
  for (const t of TABLES) {
    if (t === "notification_outbox") continue; // sequence, skip
    const r = await one(`SELECT count(*)::int AS c FROM ${t}`);
    out[t] = r.c;
  }
  // The JSON datastore called this `queue`; the table is `queue_entries`.
  // Without this alias the report always showed `n/a` and quietly skipped
  // validating one of the entities the migration is supposed to cover.
  out.queue = out.queue_entries;
  return out;
};

let synthesisedSlots = 0;

/** How many slots this script created to back slot-less appointments. */
const SYNTHETIC_PREFIX = "slot_migrated_";

const countSyntheticSlots = async () =>
  (await one(
    "SELECT count(*)::int AS c FROM slots WHERE id LIKE $1",
    [`${SYNTHETIC_PREFIX}%`],
  ))?.c ?? 0;

const status = async (json) => {
  const source = {
    users: json.users.length,
    doctors: json.doctors.length,
    specialties: json.specialties.length,
    facilities: json.facilities.length,
    services: json.services.length,
    slots: json.slots.length,
    appointments: json.appointments.length,
    notifications: json.notifications.length,
    queue: json.queue.length,
  };

  // `meta` in the JSON file held a single field, seededAt. It becomes a
  // seed_metadata row rather than a count, so it is validated separately:
  // the original value must be preserved so a migrated deployment can still
  // answer "when was this dataset seeded?".
  const jsonMeta = { seededAt: json.meta?.seededAt ?? null };
  let target = {};
  try {
    target = await targetCounts();
  } catch {
    log.warn("target tables not reachable; is the schema applied?");
  }

  // An appointment whose JSON record had no slotId needs one, because
  // appointments.slot_id is NOT NULL in the new schema. Those synthesised rows
  // are expected, so the slot count is compared against JSON + synthesised.
  //
  // In --status mode the import has not run, so the count is read back from the
  // database instead of from this process's bookkeeping.
  if (synthesisedSlots === 0) synthesisedSlots = await countSyntheticSlots();
  const expected = { ...source };
  expected.slots = source.slots + synthesisedSlots;

  console.log("\n  ENTITY            JSON     POSTGRES");
  console.log("  ----------------  -------  ----------");
  for (const [k, v] of Object.entries(expected)) {
    const t = target[k];
    const mark = t === undefined ? "  n/a" : t === v ? "  ok" : `  MISMATCH (${t})`;
    console.log(
      `  ${k.padEnd(16)}  ${String(v).padStart(7)}  ${String(t ?? "-").padStart(10)}${mark}`,
    );
  }
  if (synthesisedSlots) {
    console.log(
      `\n  ${synthesisedSlots} historical slot(s) were synthesised: those appointments`,
    );
    console.log(
      "  carried no slotId in the JSON, and appointments.slot_id is NOT NULL.",
    );
  }

  // Meta is not a collection, so it gets an explicit assertion instead of a
  // row in the count table.
  const stored = await one(
    `SELECT value->>'seededAt' AS seeded_at
       FROM seed_metadata WHERE key = 'json_migration'`,
  );
  const metaOk = stored?.seeded_at === jsonMeta.seededAt;
  console.log(`\n  meta.seededAt: ${jsonMeta.seededAt ?? "(none)"}`);
  console.log(
    `    preserved in seed_metadata: ${metaOk ? "ok" : `MISMATCH (${stored?.seeded_at ?? "absent"})`}`,
  );

  console.log();
  return { ...expected, metaOk };
};

/** Delete every row so a re-run is deterministic. */
const truncateAll = async () => {
  await query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  log.info("target tables truncated");
};

const migrate = async (json) => {
  /* -------------------------------------------------------------- *
   *  specialties, facilities, services
   * -------------------------------------------------------------- */
  for (const s of json.specialties) {
    await query(
      `INSERT INTO specialties (id, name, slug, description, icon)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.name, s.slug || slugify(s.name), s.description, s.icon],
    );
  }
  log.info(`specialties: ${json.specialties.length}`);

  for (const f of json.facilities) {
    await query(
      `INSERT INTO facilities (id, name, city, address, type, phone, open_hours, rating, queue_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        f.id,
        f.name,
        f.city,
        f.address,
        f.type,
        f.phone ?? null,
        f.openHours ?? null,
        f.rating ?? null,
        f.queueEnabled ?? true,
      ],
    );
  }
  log.info(`facilities: ${json.facilities.length}`);

  for (const s of json.services) {
    await query(
      `INSERT INTO services (id, name, description, duration_minutes, price, currency)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.name, s.description, s.duration, s.price, s.currency || "INR"],
    );
  }
  log.info(`services: ${json.services.length}`);

  /* -------------------------------------------------------------- *
   *  users (patients, doctors, admin) + profiles                    *
   * -------------------------------------------------------------- */
  let rehashed = 0;
  for (const u of json.users) {
    let passwordHash = u.password;

    // The new schema rejects anything that is not a bcrypt hash, so a
    // legacy `hashed:` value is upgraded here. The plaintext is never
    // written anywhere.
    if (!/^\$2[aby]\$\d{2}\$/.test(String(passwordHash))) {
      const legacy = String(passwordHash).replace(/^hashed:/, "");
      passwordHash = await hashPassword(legacy);
      rehashed += 1;
    }

    await query(
      `INSERT INTO users (id, email, password_hash, role, full_name, phone, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        u.id,
        u.email,
        passwordHash,
        u.role,
        u.name,
        u.phone ?? null,
        u.createdAt ? new Date(u.createdAt) : new Date(),
      ],
    );

    if (u.profile && Object.keys(u.profile).length) {
      await query(
        `INSERT INTO patient_profiles
           (user_id, date_of_birth, gender, blood_group, address_line, emergency_contact)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO NOTHING`,
        [
          u.id,
          u.profile.dateOfBirth || null,
          u.profile.gender || null,
          u.profile.bloodGroup || null,
          u.profile.address || null,
          u.profile.emergencyContact || null,
        ],
      );
      for (const allergen of u.profile.allergies || []) {
        await query(
          "INSERT INTO patient_allergies (patient_id, allergen) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [u.id, String(allergen)],
        );
      }
    }
  }
  log.info(`users: ${json.users.length} (${rehashed} password(s) re-hashed with bcrypt)`);

  /* -------------------------------------------------------------- *
   *  doctors                                                        *
   * -------------------------------------------------------------- */
  for (const d of json.doctors) {
    await query(
      `INSERT INTO doctors
         (id, user_id, specialty_id, facility_id, qualification, experience_years,
          bio, consultation_fee, is_accepting_new, avatar_color,
          seed_rating, seed_review_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        d.id,
        d.userId,
        d.specialty,
        d.facilityId,
        d.qualification ?? null,
        d.experience ?? null,
        d.bio ?? null,
        d.consultationFee,
        d.isAcceptingNew ?? true,
        d.imageColor ?? null,
        d.rating ?? null,
        d.reviewCount ?? 0,
      ],
    );

    for (const sid of d.serviceIds || []) {
      await query(
        "INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [d.id, sid],
      );
    }
    for (const lang of d.languages || []) {
      await query(
        "INSERT INTO doctor_languages (doctor_id, language) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [d.id, lang],
      );
    }
  }
  log.info(`doctors: ${json.doctors.length}`);

  /* -------------------------------------------------------------- *
   *  slots                                                          *
   * -------------------------------------------------------------- */
  // Facilities are needed on the slot row (denormalised from the doctor).
  const doctorFacility = new Map(json.doctors.map((d) => [d.id, d.facilityId]));

  let slotConflicts = 0;
  let slotErrors = 0;

  for (const s of json.slots) {
    try {
      await query(
        `INSERT INTO slots
           (id, doctor_id, facility_id, starts_at, ends_at, mode, status, fee, max_queue, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          s.id,
          s.doctorId,
          doctorFacility.get(s.doctorId),
          localToInstant(s.date, s.startTime),
          localToInstant(s.date, s.endTime),
          s.mode || "in-person",
          s.status || "available",
          s.fee ?? null,
          s.maxQueue ?? 3,
          s.createdAt ? new Date(s.createdAt) : new Date(),
        ],
      );
    } catch (err) {
      // Overlaps or duplicates in the old data are reported, not hidden.
      if (["23P01", "23505"].includes(err.code)) {
        slotConflicts += 1;
      } else {
        slotErrors += 1;
      }
    }
  }
  log.info(
    `slots: ${json.slots.length} read, ${slotConflicts} overlapping/duplicate (rejected by the schema), ${slotErrors} other errors`,
  );

  /* -------------------------------------------------------------- *
   *  appointments                                                   *
   *                                                             *
   *  The JSON seed created historical appointments with NO        *
   *  slotId, because its slot generator only produced the next 14 *
   *  days while those appointments are in the past. `slots.slot_id *
   *  is NOT NULL in the new schema, so a slot is synthesised for   *
   *  each such appointment, at the appointment's own date and time. *
   *  Where that would collide with another synthetic slot for the *
   *  same doctor, the start time is nudged forward in 30-minute   *
   *  steps: the source data recorded no slot, so it cannot have   *
   *  encoded a real conflict.                                     *
   * -------------------------------------------------------------- */
  const syntheticByKey = new Map();
  const SYNTHETIC_PREFIX = "slot_migrated_";

  const ensureSlotFor = async (a) => {
    if (a.slotId) {
      const existing = await one("SELECT id FROM slots WHERE id = $1", [a.slotId]);
      return existing ? a.slotId : null;
    }

    const doctorId = a.doctorId;
    const facilityId = doctorFacility.get(doctorId);
    const base = localToInstant(a.date, a.startTime);

    // Prefer an existing free slot at exactly the stated time.
    const existing = await one(
      `SELECT id FROM slots
        WHERE doctor_id = $1 AND starts_at = $2 AND status <> 'booked'`,
      [doctorId, base],
    );
    if (existing) return existing.id;

    // Otherwise synthesise one, stepping forward in 30-minute steps until a
    // free window is found. A busy doctor can have every 30-minute slot in a
    // day taken, so the search runs over a fortnight before giving up.
    const MAX_OFFSET_MIN = 14 * 24 * 60;
    let offsetMin = 0;
    let slotId = null;

    while (offsetMin < MAX_OFFSET_MIN) {
      const startsAt = new Date(base.getTime() + offsetMin * 60_000);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const key = `${doctorId}|${startsAt.toISOString()}`;

      if (!syntheticByKey.has(key)) {
        syntheticByKey.set(key, true);
        try {
          const r = await one(
            `INSERT INTO slots (id, doctor_id, facility_id, starts_at, ends_at, mode, status, fee, max_queue, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,'blocked',$7,3,$8)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [
              `${SYNTHETIC_PREFIX}${doctorId}_${a.date}_${a.startTime}_${offsetMin}`,
              doctorId,
              facilityId,
              startsAt,
              endsAt,
              a.mode || "in-person",
              a.fee ?? null,
              a.createdAt ? new Date(a.createdAt) : new Date(),
            ],
          );
          slotId = r?.id ?? null;
          if (slotId) break;
        } catch (err) {
          // 23P01: that window is already taken by a real slot, so the
          // appointment keeps its stated time and the search steps forward.
          // ON CONFLICT (id) does not cover an exclusion violation.
          if (!["23P01", "23505"].includes(err.code)) throw err;
        }
      }
      offsetMin += 30;
    }

    return slotId;
  };
  let aptErrors = 0;
  let aptConflicts = 0;

  let syntheticSlots = 0;

  for (const a of json.appointments) {
    try {
      if (a.status === "cancelled" && !a.cancelledAt) {
        // The schema requires cancelled_at whenever status is cancelled.
        a.cancelledAt = a.createdAt || new Date().toISOString();
      }

      const resolvedSlotId = await ensureSlotFor(a);
      if (!resolvedSlotId) {
        aptErrors += 1;
        log.warn(`appointment ${a.id}: no slot could be resolved`);
        continue;
      }
      if (!a.slotId) syntheticSlots += 1;

      const slot = await one(
        "SELECT starts_at, ends_at FROM slots WHERE id = $1",
        [resolvedSlotId],
      );

      await query(
        `INSERT INTO appointments
           (id, patient_id, doctor_id, slot_id, specialty_id, facility_id,
            mode, status, reason, symptoms, fee, cancel_reason,
            cancelled_at, cancelled_by, reminder_sent_at, created_at,
            starts_at, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          a.patientId,
          a.doctorId,
          resolvedSlotId,
          json.doctors.find((d) => d.id === a.doctorId)?.specialty,
          a.facilityId || doctorFacility.get(a.doctorId),
          a.mode || "in-person",
          a.status,
          a.reason ?? null,
          a.symptoms ?? null,
          a.fee ?? null,
          a.cancelReason ?? null,
          a.cancelledAt ? new Date(a.cancelledAt) : null,
          a.cancelledBy ?? null,
          a.reminderSent ? new Date(a.createdAt || Date.now()) : null,
          a.createdAt ? new Date(a.createdAt) : new Date(),
          // The slot is the authority for the time window.
          slot?.starts_at ?? localToInstant(a.date, a.startTime),
          slot?.ends_at ?? localToInstant(a.date, a.endTime),
        ],
      );

      // Give every migrated appointment an opening history row, so the new
      // audit trail is populated from the start.
      await query(
        `INSERT INTO appointment_status_history (appointment_id, from_status, to_status, note)
         VALUES ($1, NULL, $2, 'Migrated from JSON datastore')`,
        [a.id, a.status],
      );
    } catch (err) {
      if (["23P01", "23505"].includes(err.code)) {
        aptConflicts += 1;
        log.warn(
          `appointment ${a.id} rejected by ${err.constraint || err.code}: ${err.detail || err.message}`,
        );
      } else {
        aptErrors += 1;
        if (aptErrors <= 5) log.warn(`appointment ${a.id}: ${err.message}`);
      }
    }
  }
  synthesisedSlots = syntheticSlots;
  log.info(
    `appointments: ${json.appointments.length} read, ${syntheticSlots} historical slot(s) synthesised, ` +
      `${aptConflicts} overlapping (rejected), ${aptErrors} other errors`,
  );

  /* -------------------------------------------------------------- *
   *  notifications + queue                                          *
   * -------------------------------------------------------------- */
  for (const n of json.notifications) {
    await query(
      `INSERT INTO notifications
         (id, user_id, appointment_id, event, title, body, read_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [
        n.id,
        n.patientId,
        n.appointmentId || null,
        n.event,
        n.subject,
        n.body,
        n.read ? n.createdAt : null,
        n.createdAt ? new Date(n.createdAt) : new Date(),
      ],
    );
    // One delivery row per channel the old `channel: "both"` implied.
    for (const channel of ["in-app", "sms", "email"]) {
      await query(
        `INSERT INTO notification_deliveries (notification_id, channel, destination, status)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          n.id,
          channel,
          channel === "email" ? n.email : channel === "sms" ? n.phone : null,
          n.status === "queued" ? "queued" : n.status,
        ],
      );
    }
  }
  log.info(`notifications: ${json.notifications.length}`);

  // Positions are allocated per slot, in array order.
  //
  // The JSON model had no position column at all - queue order lived in the
  // array order, and `slots.currentQueue` was a counter that only ever
  // incremented. Assigning every entry position 1 looks harmless until two
  // entries share a slot, which the source data does contain: queue_unique_position
  // then rejects the second insert and the patient silently loses their place
  // in the queue.
  //
  // Array order is the queue order, so walking it and incrementing per slot
  // reproduces the original ordering faithfully.
  const nextPositionBySlot = new Map();
  let queueRejected = 0;

  for (const q of json.queue) {
    const position = (nextPositionBySlot.get(q.slotId) ?? 0) + 1;
    try {
      await query(
        `INSERT INTO queue_entries
           (id, appointment_id, slot_id, doctor_id, patient_id, state, position, joined_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [
          q.id,
          q.appointmentId,
          q.slotId,
          q.doctorId,
          q.patientId,
          q.state || "waiting",
          position,
          q.joinedAt ? new Date(q.joinedAt) : new Date(),
        ],
      );
      nextPositionBySlot.set(q.slotId, position);
    } catch (err) {
      queueRejected += 1;
      log.warn(`queue entry ${q.id} rejected by ${err.constraint || err.code}`);
    }
  }
  log.info(
    `queue entries: ${json.queue.length} read, ${queueRejected} rejected`,
  );

  /* -------------------------------------------------------------- *
   *  seed metadata                                                  *
   * -------------------------------------------------------------- */
  await query(
    `INSERT INTO seed_metadata (key, value, updated_at)
     VALUES ('json_migration', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
    [
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        source: JSON_PATH,
        seededAt: json.meta?.seededAt ?? null,
        counts: {
          users: json.users.length,
          doctors: json.doctors.length,
          slots: json.slots.length,
          appointments: json.appointments.length,
        },
      }),
    ],
  );
};

const run = async () => {
  console.log(`\n=== JSON -> PostgreSQL migration ===\n`);
  console.log(`  source: ${JSON_PATH}`);

  const json = readJson();

  if (STATUS_ONLY) {
    await status(json);
    await closePool();
    return;
  }

  const existing = await one("SELECT count(*)::int AS c FROM users");
  if (existing.c > 0 && !FORCE) {
    console.error(
      `\n  Target database already contains ${existing.c} user(s).`,
      "\n  Re-run with --force to truncate the target first, or --status to compare.\n",
    );
    await closePool();
    process.exit(1);
  }

  if (existing.c > 0 && FORCE) await truncateAll();

  await migrate(json);
  await status(json);

  console.log("  Migration complete.");
  console.log(
    "  The JSON file has NOT been modified or deleted — it remains the rollback reference.\n",
  );
  await closePool();
};

run().catch(async (err) => {
  console.error(`\n  Migration failed: ${err.message}\n`);
  if (err.code) console.error(`  SQLSTATE ${err.code}\n`);
  await closePool();
  process.exit(1);
});