import app from "./src/app.js";
import logger from "./src/utils/logger.js";
import { healthCheck, closePool } from "./src/config/database.js";
import { startScheduler, stopScheduler } from "./src/services/scheduler.js";
import { ensureSchemaWithTimeout } from "./src/db/ensureSchema.js";

const log = logger.tag("server");
const PORT = Number(process.env.PORT) || 5000;

/**
 * Verify the database before accepting traffic.
 *
 * Starting without a reachable database would produce a process that appears
 * healthy and then fails every request, which is harder to diagnose than a
 * failed boot.
 *
 * Retried a few times: a database that is briefly unavailable - a connection
 * blip during a rolling deploy, or a managed instance still opening - should
 * not permanently kill the process. Retrying costs a few seconds of startup and
 * avoids a crash loop.
 *
 * @param {number} attempts
 * @returns {Promise<boolean>}
 */
const preflight = async (attempts = 5) => {
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const check = await healthCheck();
    if (check.ok) {
      if (attempt > 1) log.info(`database reachable on attempt ${attempt}`);
      log.info(`database connected (PostgreSQL ${check.version})`);
      return true;
    }
    last = check;

    if (attempt < attempts) {
      log.warn(
        `database not reachable (attempt ${attempt}/${attempts}): ${check.error}`,
      );
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  console.error(
    [
      "",
      "[server] FATAL: cannot reach the database.",
      "",
      `  ${last?.error ?? "unknown error"}`,
      "",
      "  Check DATABASE_URL in server/.env - see server/.env.example.",
      "  Has the schema been applied?",
      "    node src/db/apply-schema.js    # fresh database",
      "  Needs demo data?",
      "    node src/db/seed.js",
      "",
    ].join("\n"),
  );
  return false;
};

const start = async () => {
  if (!(await preflight())) process.exit(1);

  // Bring the schema up to this build BEFORE accepting traffic.
  //
  // Not optional housekeeping: a query that names a column the database does not
  // have is a 500, and a 500 on the notification inbox looks exactly like an
  // inbox with nothing in it. Both the patient and the provider screen read
  // that table, so one missing column emptied both at once.
  //
  // It cannot throw and it cannot hang: a role without DDL rights, or a slow
  // catalogue query, produces a loud warning and a server that still starts.
  try {
    const { applied, skipped } = await ensureSchemaWithTimeout();
    if (applied.length) log.info(`schema updated: ${applied.join(", ")}`);
    else if (skipped.length) log.info(`schema already current (${skipped.join(", ")})`);
  } catch (err) {
    // ensureSchema reports its own failures; this only catches the timeout.
    log.warn(`schema check did not complete: ${err.message}`);
  }

  // Only after the preflight passes: a timer started against a database it cannot
  // reach would mark every pass as failing for no reason.
  startScheduler();

  const server = app.listen(PORT, () => {
    log.info(`API listening on http://localhost:${PORT}`);
    log.info(`Health check: http://localhost:${PORT}/api/health`);
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    // Stop the timer first, so a pass cannot start while the pool is closing.
    stopScheduler();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Don't hang forever on lingering keep-alive sockets or a stuck query.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error(`Unhandled rejection: ${reason?.stack || reason}`);
  });

  return server;
};

start().catch((err) => {
  log.error(`Failed to start: ${err.stack || err.message}`);
  process.exit(1);
});