/**
 * Apply the single-file schema (supabase/schema.sql) to one database.
 *
 * This is the project's only route to the schema: `supabase/schema.sql` is the
 * checked-in source of truth, and it records itself in `schema_migrations` as it
 * applies, so re-running it is a no-op and the applied state is auditable.
 *
 * It is meant for a FRESH database — a new Supabase project, an empty
 * local instance — and refuses one that already holds the application
 * schema, because most of the file is plain CREATE and would fail
 * halfway. The whole file runs in ONE transaction, so a failure leaves
 * the database exactly as it was.
 *
 * Usage:
 *   DATABASE_URL=... node src/db/apply-schema.js
 */
import "../config/env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, one, closePool } from "../config/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(__dirname, "../../../supabase/schema.sql");

const run = async () => {
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error(
      [
        "",
        `  ${SCHEMA_FILE} was not found.`,
        "",
        "  This file IS the schema — restore it from version control.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const existing = await one("SELECT to_regclass('public.users') AS t");
  if (existing.t) {
    console.error(
      [
        "",
        "  This database already has the application schema (public.users exists).",
        "",
        "  Applying the single file would fail on its first CREATE TABLE. This",
        "  command targets a database with no application schema in it. To start",
        "  over on a disposable database, drop it first:",
        "",
        "    DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
        "",
        "  A fresh Supabase project, or a brand-new local database, is the",
        "  intended target of this command.",
        "",
      ].join("\n"),
    );
    await closePool();
    process.exit(1);
  }

  const sql = fs.readFileSync(SCHEMA_FILE, "utf8");
  const client = await getPool().connect();
  const started = Date.now();

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the connection is already gone; there is nothing to roll back on it */
    }
    console.error(`\n  Apply failed: ${err.message}`);
    if (err.code) console.error(`  SQLSTATE ${err.code}`);
    if (err.hint) console.error(`  hint: ${err.hint}`);
    console.error("  The transaction was rolled back; the database is unchanged.\n");
    await closePool();
    process.exit(1);
  } finally {
    client.release();
  }

  const ms = Date.now() - started;
  const tables = await one(
    `SELECT count(*)::int AS c
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const migrations = await one(
    "SELECT count(*)::int AS c FROM schema_migrations",
  );

  console.log(
    [
      "",
      `  applied ${path.relative(path.resolve(__dirname, "../../.."), SCHEMA_FILE)} (${ms}ms)`,
      `          ${tables.c} tables, ${migrations.c} migrations recorded`,
      "",
      "  Next, for demo data:  npm run db:seed",
      "",
    ].join("\n"),
  );

  await closePool();
};

run().catch(async (err) => {
  console.error(`\nSchema apply error: ${err.message}\n`);
  await closePool();
  process.exit(1);
});
