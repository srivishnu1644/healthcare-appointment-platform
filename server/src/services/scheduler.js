/**
 * Background passes: appointment reminders and the notification outbox.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * Both jobs are ordinary functions on a timer. There is no queue broker and no
 * separate worker process, because the monolith has one node and one database.
 *
 * The honest limitations, stated plainly because "it runs on a timer" hides them:
 *
 *   * TIMING IS APPROXIMATE. A pass runs every SWEEP_INTERVAL_MINUTES, so a
 *     reminder is delivered within one interval of becoming due - at most about
 *     15 minutes late, and never early. Nothing promises "exactly 24 hours
 *     before", because nothing here can promise that.
 *   * IT IS IN-PROCESS. Restarting the API stops the timer, and the next start
 *     resumes it. A reminder that came due during the downtime is sent at the
 *     next pass, not lost: the sweep selects by `reminder_sent_at IS NULL`, so
 *     the set of due appointments is derived from the database rather than from
 *     anything the timer was holding in memory.
 *   * IT IS NOT SAFE TO RUN IN SEVERAL PROCESSES. Two API instances would each
 *     run a sweep. They would not send duplicates - `claimReminder` is a guarded
 *     UPDATE and only one of them wins each row - but the loser would waste work.
 *     A single node is assumed, which is what this deployment is.
 *   * IT IS NOT DURABLE ACROSS A CRASH MID-PASS. The reminder claim and the
 *     message commit together, so the worst case is a skipped pass, not a lost
 *     message: the row is claimed first and the claim is released if the message
 *     could not be built.
 *
 * `unref()` is called on the timer so a pending sweep never keeps the process
 * alive on shutdown, and the pass is guarded against re-entry so a slow pass
 * cannot stack up behind itself.
 */
import {
  runReminderSweep,
  drainOutbox,
  schedulerStatus,
  SWEEP_INTERVAL_MINUTES,
  SCHEDULER_ENABLED,
} from "./notificationService.js";
import logger from "../utils/logger.js";

const log = logger.tag("scheduler");

let timer = null;
let running = false;
let passes = 0;
let lastError = null;
let lastStartedAt = null;

/**
 * Run both passes once.
 *
 * Reminders first: a reminder that creates a notification adds rows to the
 * outbox, and draining immediately afterwards delivers it in the same pass. The
 * reverse order would leave it queued until the next tick.
 */
export const runOnce = async ({ hours = 24 } = {}) => {
  if (running) {
    // Re-entry guard. Without it, a pass that takes longer than the interval
    // starts a second concurrent pass, and the two fight over the same rows.
    log.warn("a pass is already running; skipping this tick");
    return { skipped: true };
  }
  running = true;
  lastStartedAt = new Date();
  try {
    const reminders = await runReminderSweep(hours);
    const outbox = await drainOutbox();
    passes += 1;
    lastError = null;
    return { reminders: reminders.length, outbox, skipped: false };
  } catch (err) {
    // A failing pass must not kill the timer. The next tick tries again, and the
    // rows it did not get to are still queued.
    lastError = err.message;
    log.error(`pass failed: ${err.message}`);
    return { skipped: true, error: err.message };
  } finally {
    running = false;
  }
};

/**
 * Start the timer. Idempotent, and a no-op when DISABLE_SCHEDULER=1.
 *
 * The first pass is deliberately NOT immediate. Firing during boot would race the
 * database preflight and, in a test run, would produce notifications at moments
 * the suite does not control.
 */
export const startScheduler = () => {
  if (!SCHEDULER_ENABLED) {
    log.info("background passes disabled (DISABLE_SCHEDULER=1)");
    return null;
  }
  if (timer) return timer;

  const ms = SWEEP_INTERVAL_MINUTES * 60 * 1000;
  timer = setInterval(() => {
    runOnce().catch((err) => log.error(`unhandled scheduler error: ${err.message}`));
  }, ms);

  // Do not hold the event loop open just to wait for the next sweep.
  timer.unref?.();

  log.info(
    `background passes every ${SWEEP_INTERVAL_MINUTES} minute(s): ` +
      "appointment reminders and the notification outbox",
  );
  return timer;
};

export const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

/** What the status endpoint reports: is the timer alive, and what did it do. */
export const schedulerState = async () => {
  const base = await schedulerStatus();
  return {
    ...base,
    running: Boolean(timer),
    passes,
    lastStartedAt,
    lastError,
    note:
      "Timing is approximate: a pass runs every interval, so a reminder is at " +
      "most one interval late and never early. Passes are in-process, so they " +
      "stop while the API is down and resume on the next start.",
  };
};

export default { runOnce, startScheduler, stopScheduler, schedulerState };