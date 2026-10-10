import app from "./src/app.js";
import logger from "./src/utils/logger.js";
import { healthCheck, closePool } from "./src/config/database.js";

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
      "    node src/db/migrate.js",
      "  Has it been seeded or migrated?",
      "    node src/db/seed.js                 # fresh database",
      "    node src/db/scripts/migrate-json.js  # from the JSON datastore",
      "",
    ].join("\n"),
  );
  return false;
};

const start = async () => {
  if (!(await preflight())) process.exit(1);

  const server = app.listen(PORT, () => {
    log.info(`API listening on http://localhost:${PORT}`);
    log.info(`Health check: http://localhost:${PORT}/api/health`);
  });

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
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