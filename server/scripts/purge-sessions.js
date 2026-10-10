/**
 * Remove refresh tokens that expired long ago.
 *
 *   npm run db:purge-sessions
 *   GRACE_HOURS=48 npm run db:purge-sessions
 *
 * Why a grace period matters
 * --------------------------
 * Revoking a token and deleting a row are different things, and only the first
 * is a security action. A token that expired an hour ago can still be replayed,
 * and while its row exists the server recognises that replay and revokes the
 * whole family. Delete the row immediately and the same replay looks like a
 * token that was never issued — a silent pass instead of a detected theft.
 *
 * So expired rows are kept for a grace period before deletion. This job is
 * retention, not security; run it on a schedule from wherever jobs live.
 */
import sessionRepo from "../src/repositories/sessionRepo.js";
import { closePool, query } from "../src/config/database.js";
import logger from "../src/utils/logger.js";

const log = logger.tag("purge-sessions");

const GRACE_HOURS = Number(process.env.GRACE_HOURS) || 24;

const run = async () => {
  console.log("\n=== Purging expired refresh tokens ===\n");

  const before = await query(
    "SELECT count(*)::int AS c FROM refresh_tokens",
  );
  const liveBefore = await query(
    "SELECT count(*)::int AS c FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()",
  );

  const removed = await sessionRepo.purgeExpired(GRACE_HOURS);

  const after = await query("SELECT count(*)::int AS c FROM refresh_tokens");
  const liveAfter = await query(
    "SELECT count(*)::int AS c FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at > now()",
  );

  console.log(`  grace period        ${GRACE_HOURS}h past expiry`);
  console.log(`  rows before         ${before.rows[0].c}`);
  console.log(`  rows removed        ${removed}`);
  console.log(`  rows remaining      ${after.rows[0].c}`);
  console.log(
    `\n  live sessions preserved: ${liveBefore.rows[0].c} -> ${liveAfter.rows[0].c}` +
      (liveBefore.rows[0].c === liveAfter.rows[0].c ? " (unchanged, as required)" : " (CHANGED - BUG)"),
  );
  console.log("");

  if (liveBefore.rows[0].c !== liveAfter.rows[0].c) {
    log.error("purging altered the set of live sessions");
    await closePool();
    process.exit(1);
  }

  await closePool();
};

run().catch(async (err) => {
  console.error(`\n  Purge failed: ${err.message}\n`);
  await closePool();
  process.exit(1);
});