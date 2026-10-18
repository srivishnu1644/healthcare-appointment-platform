/**
 * PostgreSQL connection pool.
 *
 * Replaces the JSON datastore's in-memory object (src/config/db.js in
 * Phase 1) as the source of truth. The Express API is the only consumer;
 * no Supabase client is used server-side, so the service-role key is
 * never exposed to the browser.
 *
 * Credentials come from the environment only:
 *   DATABASE_URL              full postgres:// connection string (preferred)
 *   DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD  discrete fallback
 *   DB_SSL                    'true' to require TLS (required by Supabase)
 *
 * SSL is mandatory for any non-localhost host, so a Supabase connection
 * string cannot accidentally be used in plaintext.
 *
 * Pool sizing: DB_POOL_MAX defaults to 10, which is right for Supabase. A
 * single-connection local PostgreSQL needs DB_POOL_MAX=1 — the code issues
 * concurrent queries via Promise.all in a few places and would otherwise see
 * "Connection terminated unexpectedly".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import pg from "pg";
import logger from "../utils/logger.js";

const log = logger.tag("db");

const {
  Pool,
  types: { setTypeParser },
} = pg;

// Return BIGINT (int8) as a JS number rather than a string. Safe here
// because every bigint in this schema is a monotonic sequence id.
setTypeParser(20, (v) => (v === null ? null : Number(v)));

const IS_TEST = process.env.NODE_ENV === "test";

/* ------------------------------------------------------------------ *
 *  Connection configuration                                          *
 * ------------------------------------------------------------------ */

const buildConfig = () => {
  const url = process.env.DATABASE_URL?.trim();

  /* ---------------------------------------------------------------- *
   * Defence in depth: the local-only test guard.                      *
   *                                                                   *
   * If something sets BOOKMYDOC_TEST_HARNESS=1, DATABASE_URL must be  *
   * the authorised isolated local database or startup fails rather     *
   * than silently running the application against a real one. It is   *
   * the backstop for a harness that opts in without applying the       *
   * override: `buildConfig()` runs at module-init, so an override      *
   * applied afterwards would already be too late.                       *
   *                                                                   *
   * Gated on the explicit opt-in flag, so the application's own      *
   * behaviour - including running against a hosted database - is     *
   * unchanged. This is a test control, not a product control.          *
   * ---------------------------------------------------------------- */
  if (process.env.BOOKMYDOC_TEST_HARNESS === "1") {
    const allowed = "postgresql://postgres@127.0.0.1:5440/bookmydoc_test";
    if (url !== allowed) {
      throw new Error(
        [
          "",
          "LOCAL-DB GUARD (inside database.js): a test harness is running and",
          "DATABASE_URL is not the authorised isolated local database.",
          "",
          "  in force: " +
            (url
              ? // Redact the password, and only that.
                url.replace(/\/\/([^:/@]+):[^@/]+@/, "//$1:<redacted>@")
              : "(unset)"),
          "",
          "  required: " + allowed,
          "",
          "  Import local-db-guard.mjs before this module, or set:",
          "    BOOKMYDOC_TEST_HARNESS=1",
          "",
        ].join("\n"),
      );
    }
  }

  if (url) {
    const sslRequired =
      process.env.DB_SSL === "true" || !/localhost|127\.0\.0\.1|\.local/.test(url);
    return {
      connectionString: url,
      // Supabase requires TLS. Local development over a unix socket or
      // loopback does not, and asking for it there fails the handshake.
      ssl: sslRequired ? { rejectUnauthorized: false } : false,
    };
  }

  const host = process.env.DB_HOST;
  if (!host) return null;

  return {
    host,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || "postgres",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    ssl:
      process.env.DB_SSL === "true" || !/localhost|127\.0\.0\.1/.test(host)
        ? { rejectUnauthorized: false }
        : false,
  };
};

const config = buildConfig();

let pool = null;

/**
 * Lazily create the pool.
 * @returns {import('pg').Pool}
 */
export const getPool = () => {
  if (!config) {
    throw new Error(
      [
        "DATABASE_URL is not configured.",
        "",
        "  Set it in server/.env — see server/.env.example.",
        "  Supabase:  DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres",
        "  Local:      DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/bookmydoc",
      ].join("\n"),
    );
  }

  if (!pool) {
    pool = new Pool({
      ...config,
      max: Number(process.env.DB_POOL_MAX) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // An idle client error (e.g. the database restarts) must not take the
    // process down; the next checkout reconnects.
    pool.on("error", (err) => {
      log.error(`idle client error: ${err.message}`);
    });

    if (!IS_TEST) {
      log.info(
        `pool created (max ${Number(process.env.DB_POOL_MAX) || 10}, ssl=${config.ssl ? "on" : "off"})`,
      );
    }
  }

  return pool;
};

/* ------------------------------------------------------------------ *
 *  Transaction context                                               *
 * ------------------------------------------------------------------ */

/**
 * The client currently running a transaction, if any.
 *
 * AsyncLocalStorage rather than a module-level variable, because the API
 * serves concurrent requests: a bare variable would let one request's nested
 * call reuse another request's connection.
 *
 * Declared here rather than in the Transactions section below because the pooled
 * query helpers need to consult it, in order to refuse a pooled query issued from
 * inside a transaction.
 */
const txStore = new AsyncLocalStorage();

/* ------------------------------------------------------------------ *
 *  Query helpers                                                     *
 * ------------------------------------------------------------------ */

/**
 * Throw if a pooled query is attempted while a transaction is open.
 *
 * Only fires inside a transaction callback; ordinary pooled reads are
 * unaffected. Set DB_ALLOW_POOLED_QUERY_IN_TX=true to bypass, which exists for
 * tests that deliberately assert the old behaviour.
 */
const assertOutsideTransaction = (text) => {
  if (!txStore.getStore()) return;
  if (process.env.DB_ALLOW_POOLED_QUERY_IN_TX === "true") return;
  throw new Error(
    [
      "A pooled query was issued inside a transaction.",
      "",
      "  withTransaction() does not reroute the pooled query()/rows()/one()",
      "  helpers - a repository call on a write path must accept a transaction",
      "  handle and receive it, so the statement runs on the transaction's own",
      "  connection.",
      "",
      `  statement: ${String(text).trim().slice(0, 160)}`,
    ].join("\n"),
  );
};

/**
 * Run a single query.
 *
 * Always parameterised — values are passed as $1, $2 … and never
 * interpolated into the SQL string.
 *
 * @param {string} text  SQL with $n placeholders
 * @param {any[]} params parameter values
 * @returns {Promise<{rows: any[], rowCount: number}>}
 */
export const query = async (text, params = []) => {
  // Guard against the mistake that `withTransaction` cannot catch for you.
  //
  // A transaction does NOT make the pooled helpers transactional. `txStore` is
  // used to detect nesting and to keep concurrent requests apart; it does not
  // reroute `query()`. So a repository call inside a transaction callback that
  // forgets to accept and pass `tx` runs on a DIFFERENT pooled connection:
  //
  //   * it does not see the transaction's uncommitted writes, and the
  //     transaction cannot see its write, so a rollback leaves the write behind;
  //   * at a small DB_POOL_MAX it deadlocks, because the transaction already
  //     holds the only connection and is waiting for this one.
  //
  // Both failure modes are silent or misleading - a stale read looks like a
  // logic bug, and the deadlock surfaces as a 10-second connection timeout. This
  // turns that into an immediate, unambiguous error naming the statement.
  assertOutsideTransaction(text);
  const p = getPool();
  const started = Date.now();
  try {
    const result = await p.query(text, params);
    const ms = Date.now() - started;
    if (ms > 250) log.warn(`slow query ${ms}ms: ${text.slice(0, 90)}`);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  } catch (err) {
    log.error(`query failed [${err.code || "?"}]: ${text.slice(0, 90)}`);
    throw err;
  }
};

/** Convenience wrapper returning just the rows. */
export const rows = async (text, params = []) => (await query(text, params)).rows;

/** Convenience wrapper returning the first row, or null. */
export const one = async (text, params = []) => {
  const r = await rows(text, params);
  return r[0] ?? null;
};

/**
 * Run a multi-statement SQL script (used by the migration runner).
 * No parameters are supported, by design: migrations are static files.
 *
 * @param {string} sql
 */
export const exec = async (sql) => {
  const p = getPool();
  return p.query(sql);
};

/* ------------------------------------------------------------------ *
 *  Transactions                                                      *
 * ------------------------------------------------------------------ */

/**
 * The handle passed to a transaction callback. Deliberately the same shape the
 * repositories' optional `tx` argument expects, so a repository call can be
 * enlisted in a caller's transaction by passing `tx` straight through.
 */
const wrapClient = (client) => ({
  query: async (text, params = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  },
  async rows(text, params = []) {
    return (await this.query(text, params)).rows;
  },
  async one(text, params = []) {
    return (await this.rows(text, params))[0] ?? null;
  },
});

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * any throw.
 *
 * This is the seam Phase 6 will use for booking. Two properties matter:
 *   1. the callback receives a handle whose queries all run on ONE
 *      connection, so they see each other's uncommitted writes;
 *   2. a constraint violation anywhere in the callback rolls the whole thing
 *      back, so a partially-booked state is unrepresentable.
 *
 * Nesting: calling `withTransaction` from inside a transaction reuses the
 * SAME connection and wraps the inner unit in a SAVEPOINT, so the inner
 * failure is recoverable and the outer transaction keeps whatever it had
 * already done. Without this the nested call would take a second pooled
 * connection, which deadlocks at DB_POOL_MAX=1 and — worse — would let the
 * inner COMMIT end the outer transaction.
 *
 * Verified by src/db/scripts/verify-schema.js.
 *
 * @template T
 * @param {(tx: {query: Function, rows: Function, one: Function}) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export const withTransaction = async (fn) => {
  const existing = txStore.getStore();

  /* ---- nested: same connection, SAVEPOINT-delimited ---- */
  if (existing) {
    const savepoint = `sp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await existing.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(wrapClient(existing.client));
      await existing.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      // Undo only the inner unit; the outer transaction stays open and keeps
      // the work it had already done.
      try {
        await existing.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch (rollbackErr) {
        log.error(`savepoint rollback failed: ${rollbackErr.message}`);
      }
      throw err;
    }
  }

  /* ---- outermost: own connection, real BEGIN/COMMIT ---- */
  const client = await getPool().connect();
  const tx = wrapClient(client);

  try {
    await client.query("BEGIN");
    const result = await txStore.run({ client }, () => fn(tx));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      log.error(`rollback failed: ${rollbackErr.message}`);
    }
    throw err;
  } finally {
    client.release();
  }
};

/* ------------------------------------------------------------------ *
 *  Health + lifecycle                                                *
 * ------------------------------------------------------------------ */

/**
 * Verify the connection is usable.
 * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
 */
export const healthCheck = async () => {
  // One retry: a pooled connection can be handed back in a bad state after a
  // dropped socket, and the pool replaces it on the next checkout. Reporting
  // the database as down because of one stale socket would make the health
  // endpoint flap.
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await one("select current_setting('server_version') as version");
      return { ok: true, version: r.version };
    } catch (err) {
      lastError = err;
      if (!["ECONNRESET", "EPIPE", "ECONNREFUSED", "08006", "08003"].includes(err.code)) {
        break;
      }
      // A connection that has lost its protocol stream is not safe to reuse.
      // Drop the pool so the retry gets a brand-new one rather than the same
      // broken client.
      log.warn(`discarding pool after ${err.code}`);
      try {
        await closePool();
      } catch {
        /* pool already gone */
      }
    }
  }
  return { ok: false, error: lastError?.message };
};

/** Close the pool (used on graceful shutdown and by scripts). */
export const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    log.info("pool closed");
  }
};

/**
 * Map a PostgreSQL error to a domain error code.
 *
 * The database is now the final arbiter of booking correctness, so its
 * constraint violations are meaningful outcomes, not internal faults.
 * `23505` and `23P01` are the two that make double booking impossible.
 */
export const DB_ERROR_CODES = {
  UNIQUE_VIOLATION: "23505",
  EXCLUSION_VIOLATION: "23P01",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  NOT_NULL_VIOLATION: "23502",
};

export default {
  getPool,
  query,
  rows,
  one,
  exec,
  withTransaction,
  healthCheck,
  closePool,
};