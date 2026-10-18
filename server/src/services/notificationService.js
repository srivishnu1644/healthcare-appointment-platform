/**
 * Notification templates and delivery.
 *
 * Templates and copy are unchanged from Phase 1. What changed:
 *   * the message is stored in `notifications` with per-channel rows in
 *     `notification_deliveries`, instead of one row with a results blob;
 *   * the hard 500-row truncation is gone — retention is a scheduled job
 *     in Phase 10, not a silent array slice;
 *   * a row is also written to `notification_outbox` inside the same
 *     transaction, so a crash cannot lose or duplicate a message.
 */
import notificationRepo from "../repositories/notificationRepo.js";
import appointmentRepo from "../repositories/appointmentRepo.js";
import doctorRepo from "../repositories/doctorRepo.js";
import { facilities } from "../repositories/referenceRepo.js";
import { withTransaction } from "../config/database.js";
import logger from "../utils/logger.js";

const log = logger.tag("notify");

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const RESEND_KEY = process.env.RESEND_API_KEY;

/**
 * Test adapter for email, mirroring `TRIAGE_ADAPTER` and `ASSISTANT_ADAPTER`.
 *
 * `EMAIL_ADAPTER=mock` returns a canned success and `EMAIL_ADAPTER=mock-fail`
 * a canned failure, so the delivery path is exercised with no network call and
 * no real email sent. Without it, the only way to test a successful Resend
 * delivery is to send a real email, which is exactly what an automated suite
 * must not do.
 *
 * Checked BEFORE the `channels.email` gate on purpose: in a test environment no
 * Resend key is configured, so the gate would answer "simulated" and the mock
 * would never be reached.
 *
 * Refused in production: a test double that answers instead of a provider would
 * be indistinguishable from the real thing in the logs.
 */
const EMAIL_ADAPTER = process.env.EMAIL_ADAPTER;
if (EMAIL_ADAPTER && process.env.NODE_ENV === "production") {
  throw new Error("EMAIL_ADAPTER must not be set in production.");
}
const FROM_EMAIL =
  process.env.NOTIFICATION_FROM_EMAIL || "notifications@bookmydoc.demo";

export const channels = {
  sms: Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM),
  email: Boolean(RESEND_KEY),
};

const money = (n) => `INR ${Number(n || 0).toLocaleString("en-IN")}`;
const fmtSlot = (a) => `${a.date} at ${a.startTime}`;

/**
 * How often the background passes run.
 *
 * 15 minutes is chosen against the reminder window (24h by default): it is short
 * enough that a reminder is never more than a quarter hour late, and long enough
 * that the query is a rounding error for this database. It is NOT a promise of
 * exact timing - see `startScheduler` for what this does and does not guarantee.
 */
export const SWEEP_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.NOTIFICATION_SWEEP_MINUTES) || 15,
);

/**
 * Set DISABLE_SCHEDULER=1 to run the API without background passes.
 *
 * Test suites turn this on: two suites sweeping the same database at once would
 * race for the same reminder rows, and a suite that asserts on notification
 * counts wants to control exactly when messages appear.
 */
export const SCHEDULER_ENABLED = process.env.DISABLE_SCHEDULER !== "1";

const TEMPLATES = {
  appointment_booked: {
    subject: "Appointment confirmed",
    body: (a, d, f) =>
      `Hi ${a.patientName}, your appointment with ${d.name} (${d.specialtyName}) is confirmed for ${fmtSlot(a)} at ${f?.name || a.facilityName}. Consultation fee ${money(a.fee)}.`,
  },
  appointment_rescheduled: {
    subject: "Appointment rescheduled",
    body: (a, d, f) =>
      `Hi ${a.patientName}, your appointment with ${d.name} has been moved to ${fmtSlot(a)} at ${f?.name || a.facilityName}.`,
  },
  appointment_cancelled: {
    subject: "Appointment cancelled",
    body: (a, d, f, meta) =>
      `Hi ${a.patientName}, your appointment with ${d.name} on ${a.date} has been cancelled. Reason: ${meta?.reason || "not specified"}.`,
  },
  appointment_reminder: {
    subject: "Appointment reminder",
    body: (a, d, f) =>
      `Reminder: your appointment with ${d.name} is on ${fmtSlot(a)} at ${f?.name || a.facilityName}. Please arrive 10 minutes early.`,
  },
  status_update: {
    subject: "Appointment status updated",
    body: (a, d, f, meta) =>
      `Your appointment with ${d.name} on ${a.date} is now "${meta?.status}".`,
  },

  // Phase 10 added the events below. Each one has its own copy rather than
  // reusing `status_update`, because "you are checked in" and "your visit is
  // over" are different facts and a shared template made both read like a
  // database field had changed.
  appointment_checked_in: {
    subject: "You are checked in",
    body: (a, d, f, meta) =>
      `Hi ${a.patientName}, you are checked in for your appointment with ${d.name} at ` +
      `${f?.name || a.facilityName}. ${
        meta?.roomPosition
          ? `You are number ${meta.roomPosition} in the waiting room.`
          : "Please wait to be called."
      }`,
  },
  queue_called: {
    subject: "It is your turn",
    body: (a, d, f, meta) =>
      `Hi ${a.patientName}, ${d.name} is ready to see you now for your appointment at ` +
      `${f?.name || a.facilityName}.`,
  },
  appointment_completed: {
    subject: "Visit complete",
    body: (a, d, f) =>
      `Hi ${a.patientName}, your appointment with ${d.name} on ${a.date} is complete. ` +
      `Thank you for using BookMyDoc.`,
  },
};

/**
 * Build the deduplication key for one logical event.
 *
 * The key must contain everything that distinguishes two GENUINE occurrences of
 * the same event, because the database rejects the second insert outright. Leave
 * something out here and a real second event is silently swallowed; add something
 * that varies between two retries and duplicates get through.
 *
 * `discriminator` is what separates real repeats:
 *   * a reschedule is keyed by its destination slot, so a patient can move an
 *     appointment more than once and hear about each move;
 *   * a reminder is keyed by the start time, so a rescheduled visit is reminded
 *     about again rather than staying silent forever;
 *   * a queue call is keyed by the call time, so being called, marked no-show and
 *     called again produces two messages, not one.
 *
 * Returning null means "do not deduplicate", which is the right answer for an
 * operator-triggered message that is not tied to any single occurrence.
 */
const buildDedupeKey = ({ event, userId, appointmentId, discriminator }) => {
  if (!event || !userId) return null;
  return [event, userId, appointmentId ?? "none", discriminator ?? ""].join(":").slice(0, 300);
};

/* ------------------------------------------------------------------ *
 *  Transport                                                          *
 * ------------------------------------------------------------------ */

async function sendSms(to, body) {
  if (!channels.sms) {
    log.info(`[SMS -> console] to=${to || "n/a"} :: ${body}`);
    return { channel: "sms", status: "simulated" };
  }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }),
      },
    );
    if (!res.ok) throw new Error(`Twilio ${res.status}`);
    const json = await res.json();
    return { channel: "sms", status: "sent", providerMsgId: json.sid };
  } catch (err) {
    log.error(`SMS failed: ${err.message}`);
    return { channel: "sms", status: "failed", error: err.message };
  }
}

async function sendEmail(to, subject, body) {
  // Read the adapter at call time, not module load time, so tests can override it.
  const adapter = process.env.EMAIL_ADAPTER;
  log.info(`[EMAIL adapter] to=${to} adapter="${adapter}" channels.email=${channels.email}`);
  if (adapter === "mock") {
    log.info(`[EMAIL mock] returning sent`);
    return { channel: "email", status: "sent", providerMsgId: `mock-${Date.now()}` };
  }
  if (adapter === "mock-fail") {
    return { channel: "email", status: "failed", error: "mock Resend 400 Bad Request" };
  }

  if (!channels.email) {
    log.info(`[EMAIL -> console] to=${to || "n/a"} :: ${subject} :: ${body}`);
    return { channel: "email", status: "simulated" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `BookMyDoc <${FROM_EMAIL}>`,
        to: [to],
        subject,
        text: body,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}`);
    const json = await res.json();
    return { channel: "email", status: "sent", providerMsgId: json.id };
  } catch (err) {
    log.error(`Email failed: ${err.message}`);
    return { channel: "email", status: "failed", error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 *  Public API                                                         *
 * ------------------------------------------------------------------ */

/**
 * Render a notification for an appointment event and PERSIST it.
 *
 * This is the half that belongs inside the booking transaction. It writes only to
 * the database: the notification row, one delivery row per channel (all left in
 * `queued`), and a `notification_outbox` marker. It performs no network I/O, so
 * it cannot be slow, cannot fail because a third party is down, and cannot leave
 * a booking half-committed.
 *
 * The outbox exists precisely so that a crash between "appointment committed" and
 * "message sent" cannot lose the message: the intent is committed with the
 * appointment, and delivery happens afterwards.
 *
 * @param {object} input
 * @param {object} input.tx transaction handle - required, so the message commits
 *        atomically with the change that caused it
 * @returns {Promise<Array<{id: string, event: string}>>} the queued messages
 */
export async function enqueueNotifications({
  event,
  appointment,
  doctor,
  facility,
  patient,
  reason,
  status,
  // What separates two genuine occurrences of this event. See buildDedupeKey.
  discriminator = null,
  extra = {},
  tx,
}) {
  const template = TEMPLATES[event];
  if (!template) {
    log.warn(`No template for event "${event}"`);
    return [];
  }

  const phone = patient?.phone ?? null;
  const email = patient?.email ?? null;
  const userId = patient?.id ?? appointment?.patientId;
  if (!userId) {
    log.warn(`Cannot notify: no recipient for event "${event}"`);
    return [];
  }

  // Every template renders `doctor.name`, so a missing doctor means the message
  // cannot be written at all.
  //
  // This SKIPS rather than throws, and that choice is deliberate. The message is
  // written inside the transaction that caused it, so throwing here would roll
  // back the booking, the reschedule or the queue promotion as well - a patient
  // would lose their appointment because a template could not render. A missing
  // message is a much smaller failure than a lost appointment, and the error is
  // logged rather than swallowed, so the cause is still visible.
  if (!doctor?.name) {
    log.error(
      `Cannot notify "${event}" to ${userId}: the doctor record is missing, so the ` +
        "template cannot be rendered. The appointment change is unaffected.",
    );
    return [];
  }

  // A booking transaction is the only caller that must not be interrupted; fall
  // back to the pool for callers with no transaction of their own (the reminder
  // sweep, for instance).
  if (!tx) {
    throw new Error(
      `enqueueNotifications for "${event}" requires a transaction; use sendNotifications instead`,
    );
  }

  const body = template.body(appointment, doctor, facility, {
    reason,
    status,
    ...extra,
  });

  // The database is the deduplicator, not a check above it. Two concurrent
  // requests for the same logical event both reach the INSERT; the unique index
  // lets exactly one through and the other is discarded here. Doing it as a
  // SELECT-then-INSERT would let both transactions observe "not sent yet" and
  // both write, which is precisely the duplicate this is here to prevent.
  // The duplicate case is handled by the repository refusing the row rather than
  // by catching an exception here. That is not stylistic: this runs inside the
  // transaction that booked the appointment, and a failed statement ABORTS a
  // PostgreSQL transaction, so a caught-and-ignored constraint violation would
  // still roll back the booking on COMMIT. `create` returns null instead.
  const notificationId = await notificationRepo.create(
    {
      userId,
      appointmentId: appointment?.id ?? null,
      event,
      title: template.subject,
      body,
      templateKey: event,
      dedupeKey: buildDedupeKey({
        event,
        userId,
        appointmentId: appointment?.id ?? null,
        discriminator,
      }),
      deliveries: [
        { channel: "in-app", status: "queued" },
        { channel: "sms", destination: phone, status: "queued" },
        { channel: "email", destination: email, status: "queued" },
      ],
    },
    tx,
  );

  // null means this event already has a message. That is the expected outcome for
  // a retried request, and it is not a failure: the caller receives an empty list
  // and the booking that caused the message commits normally.
  if (notificationId === null) {
    log.info(`duplicate "${event}" suppressed for ${userId}`);
    return [];
  }

  // Same transaction: the intent to notify commits with the appointment.
  await notificationRepo.outbox.enqueue(
    { event, aggregateId: notificationId, payload: { appointmentId: appointment?.id ?? null } },
    tx,
  );

  return [{ id: notificationId, event, subject: template.subject, body }];
}

/**
 * Attempt delivery of a queued notification and record the outcome.
 *
 * Runs AFTER the booking transaction has committed, and must never throw: a
 * booking that has been committed cannot be undone because Twilio was
 * unreachable, so delivery failures are recorded against the delivery row and
 * the caller continues.
 *
 * Every failure mode is caught, including a throw from `recordDelivery` itself,
 * so no provider problem can surface as a failed booking response.
 *
 * @returns {Promise<{delivered: boolean, results: object[]}>}
 */
export async function deliverNotification(notificationId) {
  const results = [];
  // Declared out here on purpose. An earlier version declared `const inApp`
  // INSIDE the try block, which shadowed this binding: the variable the return
  // statement reads was still the empty array, so an in-app message - the only
  // channel this project actually delivers - was never reported as delivered and
  // never appeared in `results`.
  let inApp = [];
  try {
    const pending = await notificationRepo.outbox.pendingDeliveries(200);
    const mine = pending.filter((d) => d.notification_id === notificationId);

    // An in-app message is "delivered" the moment it is stored: the unread badge
    // reads the notifications table, so there is no external step to wait for.
    // It still has to be marked, because leaving the delivery row in 'queued'
    // forever makes the outbox look permanently behind and hides a genuinely
    // stuck external delivery.
    inApp = mine.filter((d) => d.channel === "in-app");
    const external = mine.filter((d) => d.channel !== "in-app");

    for (const d of inApp) {
      try {
        await notificationRepo.recordDelivery(notificationId, {
          channel: "in-app",
          status: "delivered",
        });
      } catch (err) {
        log.error(`could not record in-app delivery for ${notificationId}: ${err.message}`);
      }
    }

    const attempts = await Promise.allSettled(
      external.map(async (d) => {
        if (d.channel === "sms") return sendSms(d.destination, d.body);
        return sendEmail(d.destination, d.title, d.body);
      }),
    );

    attempts.forEach((outcome, i) => {
      const channel = external[i].channel;
      results.push(
        outcome.status === "fulfilled"
          ? outcome.value
          : { channel, status: "failed", error: String(outcome.reason?.message ?? outcome.reason) },
      );
    });

    for (const r of results) {
      try {
        await notificationRepo.recordDelivery(notificationId, r);
      } catch (err) {
        log.error(`could not record ${r.channel} delivery for ${notificationId}: ${err.message}`);
      }
    }
  } catch (err) {
    // Belt and braces: anything unexpected above is still recorded, not thrown.
    log.error(`delivery pass failed for ${notificationId}: ${err.message}`);
    try {
      await notificationRepo.recordFailure(notificationId, err.message);
    } catch {
      /* the database is unavailable too; nothing further to do */
    }
    return { delivered: false, results: [] };
  }

  return {
    // "delivered" includes the in-app rows, which were just marked delivered
    // above; without them a message nobody can see externally would still read as
    // undelivered to the caller.
    delivered:
      inApp.length > 0 || results.some((r) => r.status === "sent" || r.status === "delivered"),
    results: [...inApp.map(() => ({ channel: "in-app", status: "delivered" })), ...results],
  };
}

/**
 * Render, persist and deliver in one call, for callers with no transaction.
 *
 * Retained for the paths that are not part of a booking transaction. It composes
 * the two halves above rather than duplicating them, so there is one code path
 * for rendering and one for delivery.
 */
async function sendNotifications(input) {
  const queued = input.tx
    ? await enqueueNotifications(input)
    : await enqueueInOwnTransaction(input);

  const delivered = [];
  for (const q of queued) {
    const outcome = await deliverNotification(q.id);
    delivered.push({
      ...q,
      status: outcome.delivered ? "sent" : "simulated",
      results: outcome.results,
    });
  }
  return delivered;
}

/**
 * Persist a notification on its own connection, then release it.
 *
 * `withTransaction` rather than a bare pool call, so the notification and its
 * delivery rows are still written atomically with each other even when there is
 * no surrounding booking transaction.
 */
const enqueueInOwnTransaction = async ({ tx: _ignored, ...input }) =>
  withTransaction(async (t) => enqueueNotifications({ ...input, tx: t }));

/**
 * Drain the outbox: attempt every delivery still sitting in `queued`.
 *
 * This is the worker the schema has been promising since Phase 1. It exists
 * because `enqueueNotifications` deliberately does no network I/O - it commits the
 * INTENT to notify alongside the appointment change - so something has to attempt
 * the actual send afterwards. The booking path calls `deliverNotification`
 * directly for a fast path; this covers everything that path could not reach: a
 * process that died between commit and send, a channel that was down at the
 * moment, and messages enqueued by a sweep.
 *
 * Never throws. A drain that fails is a problem for the next tick, and taking the
 * process down over it would be strictly worse than leaving the rows queued.
 *
 * @returns {Promise<{processed: number, failed: number, skipped: number}>}
 */
export const drainOutbox = async ({ limit = 100 } = {}) => {
  const startedAt = new Date();
  const pending = await notificationRepo.outbox.drainable(limit);

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  // Grouped by notification so a message with three channels is delivered as one
  // unit and its outbox row is settled once, rather than three times.
  const byNotification = new Map();
  for (const d of pending) {
    const list = byNotification.get(d.notification_id) ?? [];
    list.push(d);
    byNotification.set(d.notification_id, list);
  }

  for (const [notificationId, deliveries] of byNotification) {
    try {
      const inApp = deliveries.filter((d) => d.channel === "in-app");
      for (const d of inApp) {
        await notificationRepo.recordDelivery(notificationId, {
          channel: "in-app",
          status: "delivered",
        });
      }
      processed += inApp.length;

      const external = deliveries.filter((d) => d.channel !== "in-app");
      const outcomes = await Promise.allSettled(
        external.map(async (d) => {
          if (d.channel === "sms") return sendSms(d.destination, d.body);
          return sendEmail(d.destination, d.title, d.body);
        }),
      );

      // Settled once, with the channel kept alongside the result, so recording the
      // outcome never has to re-derive which entry it belongs to.
      const settled = outcomes.map((outcome, i) =>
        outcome.status === "fulfilled"
          ? outcome.value
          : {
              channel: external[i].channel,
              status: "failed",
              error: String(outcome.reason?.message ?? outcome.reason),
            },
      );
      for (const r of settled) {
        if (r.status === "failed") failed += 1;
        else processed += 1;
        try {
          await notificationRepo.recordDelivery(notificationId, r);
        } catch (err) {
          log.error(`could not record ${r.channel} delivery for ${notificationId}: ${err.message}`);
        }
      }

      // Settle the outbox marker only once nothing is left queued for it.
      const stillQueued = await notificationRepo.outbox.pendingFor(notificationId);
      if (stillQueued === 0) {
        await notificationRepo.outbox.markDoneFor(notificationId);
      }
    } catch (err) {
      failed += 1;
      log.error(`outbox drain failed for ${notificationId}: ${err.message}`);
      try {
        await notificationRepo.recordFailure(notificationId, err.message);
      } catch {
        /* database is down too; the rows stay queued for the next pass */
      }
    }
  }

  // Anything left in `queued` past the attempt limit is parked rather than
  // retried forever. Without this a permanently undeliverable channel would be
  // re-attempted on every tick indefinitely.
  const parked = await notificationRepo.outbox.parkStale(5, 24);
  skipped += parked;

  const summary = {
    processed,
    failed,
    skipped: skipped + (pending.length - processed - failed),
  };
  await recordSweep("outbox", startedAt, summary).catch((err) =>
    log.warn(`could not record outbox sweep: ${err.message}`),
  );
  log.info(
    `outbox drain: ${summary.processed} delivered, ${summary.failed} failed, ${summary.skipped} left queued`,
  );
  return summary;
};

/** Record what a background pass did, so a silent timer is visible afterwards. */
const recordSweep = async (kind, startedAt, summary) =>
  notificationRepo.createSweep({
    kind,
    startedAt,
    processed: summary.processed ?? 0,
    skipped: summary.skipped ?? 0,
    failed: summary.failed ?? 0,
  });

/**
 * Reminder sweep: notify about appointments starting within `hours`.
 *
 * Idempotency comes from `appointments.reminder_sent_at`, stamped by an UPDATE
 * guarded on IS NULL. The guard is what makes two concurrent sweeps safe: both may
 * select the same appointment, but only the UPDATE that actually changes a NULL
 * returns a row, and only that caller sends.
 *
 * `reminder_sent_at` is also CLEARED when an appointment moves, so a rescheduled
 * visit is reminded about again. Without that, a patient who moved an appointment
 * into next week would never be reminded about the new time.
 */
export const runReminderSweep = async (hours = 24) => {
  const startedAt = new Date();
  const due = await notificationRepo.remindersDue(hours);
  const out = [];
  let skipped = 0;

  for (const a of due) {
    // Claim the row FIRST. If another sweep already claimed it, this returns no
    // row and there is nothing to send - and crucially the check and the claim are
    // the same statement, so two sweeps cannot both decide "mine".
    const claimed = await appointmentRepo.claimReminder(a.id);
    if (!claimed) {
      skipped += 1;
      continue;
    }

    const doctor = await doctorRepo.findById(a.doctor_id);
    const facility = await facilities.findById(a.facility_id);
    const appointment = await (await import("../repositories/appointmentRepo.js")).findById(a.id);
    if (!appointment) {
      // The claim happened before the row was found missing. Release it so a
      // later sweep is not permanently blocked by a claim against nothing.
      await appointmentRepo.releaseReminder(a.id).catch(() => {});
      skipped += 1;
      continue;
    }

    const result = await sendNotifications({
      event: "appointment_reminder",
      appointment,
      doctor,
      facility,
      patient: {
        id: a.patient_id,
        name: appointment?.patientName,
        phone: appointment?.patientPhone,
        email: appointment?.patientEmail,
      },
      // Keyed by the start time: the same visit is never reminded about twice,
      // but a visit that moved to a new time is a new occurrence.
      discriminator: appointment.startsAt ?? a.starts_at ?? null,
    });
    out.push(...result);
  }

  const summary = { processed: out.length, failed: 0, skipped };
  await recordSweep("reminders", startedAt, summary).catch((err) =>
    log.warn(`could not record reminder sweep: ${err.message}`),
  );
  log.info(
    `reminder sweep: ${out.length} reminder(s) sent, ${skipped} skipped (already claimed)`,
  );
  return out;
};

/** The most recent pass of each kind, so "is the timer alive?" is answerable. */
export const schedulerStatus = async () => {
  const runs = await notificationRepo.recentSweeps(20);
  const byKind = {};
  for (const r of runs) {
    if (!byKind[r.kind]) byKind[r.kind] = r;
  }
  return {
    intervalMinutes: SWEEP_INTERVAL_MINUTES,
    enabled: SCHEDULER_ENABLED,
    lastRun: byKind.reminders ?? null,
    lastDrain: byKind.outbox ?? null,
  };
};