/**
 * Schema migration runner.
 *
 * Migrations are plain .sql files in ./migrations, applied in filename
 * order and recorded in `schema_migrations`. Forward-only by design: an
 * applied migration is never re-run or edited, so a database can be
 * rebuilt from scratch by replaying the directory.
 *
 * Usage:
 *   node src/db/migrate.js            # apply pending migrations
 *   node src/db/migrate.js --status   # show what is applied
 *   node src/db/migrate.js --reset    # drop and recreate the schema, then apply all
 */
import "../config/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, exec, one, closePool } from "../config/database.js";
import logger from "../utils/logger.js";

const log = logger.tag("migrate");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Every statement in this schema uses IF NOT EXISTS / OR REPLACE where it
 * matters, so applying a migration to a partially-created database is safe.
 */
const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0
);
`;

const readMigrations = () =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));

const applied = async () => {
  const rows = await query("SELECT filename FROM schema_migrations");
  return new Set(rows.rows.map((r) => r.filename));
};

const status = async () => {
  await exec(BOOTSTRAP);
  const done = await applied();
  const files = readMigrations();
  console.log(`\nMigrations (${files.length} files):\n`);
  for (const f of files) {
    console.log(`  ${done.has(f) ? "[applied] " : "[pending] "}${f}`);
  }
  const pending = files.filter((f) => !done.has(f)).length;
  console.log(`\n  ${done.size} applied, ${pending} pending\n`);
  return pending;
};

/** Drop every object in the public schema. Destructive; --reset only. */
const reset = async () => {
  log.warn("dropping and recreating the public schema");
  await exec(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
  `);
};

const migrate = async () => {
  await exec(BOOTSTRAP);
  const done = await applied();
  const files = readMigrations();

  console.log(`\nApplying ${files.length} migrations…\n`);

  let count = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log(`  skip    ${file} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const started = Date.now();

    // Each migration is applied inside its own transaction, so a failure
    // leaves the database on the last good version rather than half-migrated.
    await exec("BEGIN");
    try {
      await exec(sql);
      const ms = Date.now() - started;
      // Parameterised, so this must go through query() rather than exec().
      await query(
        "INSERT INTO schema_migrations (filename, duration_ms) VALUES ($1, $2)",
        [file, ms],
      );
      await exec("COMMIT");
      console.log(`  applied ${file} (${ms}ms)`);
      count += 1;
    } catch (err) {
      await exec("ROLLBACK");
      console.error(`\n  FAILED  ${file}`);
      console.error(`          ${err.message}`);
      if (err.hint) console.error(`          hint: ${err.hint}`);
      await closePool();
      process.exit(1);
    }
  }

  const tables = await one(
    `SELECT count(*)::int AS c
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  console.log(
    `\n  ${count} applied now, ${tables.c} tables in schema public\n`,
  );
};

const run = async () => {
  const arg = process.argv[2];
  try {
    if (arg === "--status") {
      const pending = await status();
      await closePool();
      process.exit(pending > 0 ? 0 : 0);
    }
    if (arg === "--reset") {
      await reset();
    }
    await migrate();
    await closePool();
  } catch (err) {
    console.error(`\nMigration error: ${err.message}\n`);
    await closePool();
    process.exit(1);
  }
};

run();
