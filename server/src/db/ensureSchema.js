/**
 * Self-applying schema additions.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `notifications.deleted_at` was added in schema revision 020, and the
 * notification inbox queries it in every statement. Against a database that has
 * not been given that column, `GET /api/notifications` fails with
 * `column "deleted_at" does not exist` — which is not "the notifications are
 * empty", it is a 500 that hides 49 perfectly good rows behind an error the UI
 * has nowhere to show. The API looked broken; the inbox looked empty; both the
 * patient and the provider side were affected at once, because both read the
 * same table.
 *
 * The obvious remedy — "apply the schema file" — is not available here.
 * `db:schema` deliberately refuses to run against a database that already holds
 * the schema, because most of that file is plain CREATE. So the one piece of
 * DDL this project needed could not be applied by any supported command, which
 * is a design gap rather than an operator mistake.
 *
 * WHAT IT DOES
 * ------------
 *   1. Asks `information_schema` whether the column is there — a cheap read.
 *   2. Only if it is missing, runs the `ADD COLUMN IF NOT EXISTS` plus the two
 *      partial indexes that go with it.
 *
 * Step 1 is the important one. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is
 * idempotent, but it is not free: it takes an ACCESS EXCLUSIVE lock on the table
 * even when it does nothing. Asking first means a steady-state restart issues
 * no DDL and takes no lock on a live table at all.
 *
 * FAILURE IS REPORTED, NEVER THROWN
 * ---------------------------------
 * A deployment that cannot ALTER must still boot and still serve everything
 * else. So this never throws: it logs what went wrong, what it was trying to do,
 * and the exact statement to run by hand, then lets startup continue. Silently
 * swallowing it would be worse — the inbox would stay empty with no clue why —
 * so the message is deliberately loud and actionable.
 *
 * ROLES
 * -----
 * `DATABASE_URL` connects as the table OWNER (see README: the API reaches
 * PostgreSQL as an ordinary connection and owns its tables), which is the role
 * that may run DDL. A read-only deployment role would make this a no-op that
 * reports itself, which is the correct outcome for a deployment that cannot
 * change its own schema.
 *
 * Usage:
 *   node src/db/ensureSchema.js          # apply what is missing, then exit
 */
// FIRST, before anything that reads configuration: `database.js` resolves
// DATABASE_URL at import time and throws without it, and this module is runnable
// on its own (`npm run db:ensure`), where nothing else has loaded .env yet.
// dotenv never overwrites a variable that already exists, so importing this
// after another bootstrap is harmless.
import "../config/env.js";
import { query, rows, closePool } from "../config/database.js";
import logger from "../utils/logger.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const log = logger.tag("schema");

/**
 * The additions this module knows how to apply, newest first.
 *
 * Each is a list of statements that are individually idempotent, so applying one
 * twice is free. `column` is what the presence check looks for; a revision with
 * no column (an index-only one, say) sets `table` instead.
 */
const ADDITIONS = [
  {
    id: "020_notification_deletion",
    table: "notifications",
    column: "deleted_at",
    statements: [
      `ALTER TABLE notifications
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz`,
      `CREATE INDEX IF NOT EXISTS notifications_live_idx
          ON notifications (user_id, created_at DESC)
          WHERE deleted_at IS NULL`,
      `CREATE INDEX IF NOT EXISTS notifications_deleted_idx
          ON notifications (user_id, deleted_at DESC)
          WHERE deleted_at IS NOT NULL`,
    ],
  },
];

/** Has this column already been added? One indexed catalogue read. */
const columnExists = async (table, column) => {
  const r = await rows(
    `SELECT 1 AS present
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.length > 0;
};

/**
 * Apply whatever this build needs and the database is missing.
 *
 * @returns {Promise<{applied: string[], skipped: string[], failed: string[]}>}
 */
export const ensureSchema = async () => {
  const applied = [];
  const skipped = [];
  const failed = [];

  for (const addition of ADDITIONS) {
    try {
      if (await columnExists(addition.table, addition.column)) {
        skipped.push(addition.id);
        continue;
      }
      for (const statement of addition.statements) {
        await query(statement);
      }
      applied.push(addition.id);
      log.info(`applied schema addition ${addition.id}`);
    } catch (err) {
      failed.push(addition.id);
      console.error(
        [
          "",
          `[server] WARNING: could not apply schema addition ${addition.id}`,
          "",
          `  ${err.message}`,
          "",
          "  The notifications inbox will fail until this is done. Run:",
          ...addition.statements.map((s) => `    ${s.replace(/\s+/g, " ").trim()}`),
          "",
          "  (or `npm run db:ensure` as a role that may run DDL)",
          "",
        ].join("\n"),
      );
    }
  }

  return { applied, skipped, failed };
};

/**
 * Run the additions with a time limit.
 *
 * Startup should not hang because the database is slow to answer a catalogue
 * query, and a boot that takes longer than the deploy's patience gets killed
 * anyway — which looks identical to a crash. Failing the ensure and continuing
 * is the better of the two outcomes, and the warning above says what to run.
 */
export const ensureSchemaWithTimeout = async (ms = 5000) => {
  let timer;
  try {
    return await Promise.race([
      ensureSchema(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** `node src/db/ensureSchema.js` — the same work, outside a server boot. */
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const { applied, skipped, failed } = await ensureSchema();
  console.log(
    [
      "",
      `  applied:  ${applied.join(", ") || "none"}`,
      `  already:  ${skipped.join(", ") || "none"}`,
      `  failed:   ${failed.join(", ") || "none"}`,
      "",
    ].join("\n"),
  );
  await closePool();
  process.exit(failed.length ? 1 : 0);
}