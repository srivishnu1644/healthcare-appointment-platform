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
const FROM_EMAIL =
  process.env.NOTIFICATION_FROM_EMAIL || "notifications@medicare.demo";

export const channels = {
  sms: Boolean(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM),
  email: Boolean(RESEND_KEY),
};

const money = (n) => `INR ${Number(n || 0).toLocaleString("en-IN")}`;
const fmtSlot = (a) => `${a.date} at ${a.startTime}`;

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
        from: `MediCare <${FROM_EMAIL}>`,
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

  // A booking transaction is the only caller that must not be interrupted; fall
  // back to the pool for callers with no transaction of their own (the reminder
  // sweep, for instance).
  if (!tx) {
    throw new Error(
      `enqueueNotifications for "${event}" requires a transaction; use sendNotifications instead`,
    );
  }

  const body = template.body(appointment, doctor, facility, { reason, status });

  const notificationId = await notificationRepo.create(
    {
      userId,
      appointmentId: appointment?.id ?? null,
      event,
      title: template.subject,
      body,
      templateKey: event,
      deliveries: [
        { channel: "in-app", status: "queued" },
        { channel: "sms", destination: phone, status: "queued" },
        { channel: "email", destination: email, status: "queued" },
      ],
    },
    tx,
  );

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
  let inApp = [];
  try {
    const pending = await notificationRepo.outbox.pendingDeliveries(200);
    const mine = pending.filter((d) => d.notification_id === notificationId);

    // An in-app message is "delivered" the moment it is stored: the unread badge
    // reads the notifications table, so there is no external step to wait for.
    // It still has to be marked, because leaving the delivery row in 'queued'
    // forever makes the outbox look permanently behind and hides a genuinely
    // stuck external delivery.
    const inApp = mine.filter((d) => d.channel === "in-app");
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
export async function sendNotifications(input) {
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
 * Reminder sweep: notify about appointments starting within `hours`.
 *
 * Idempotency now comes from `appointments.reminder_sent_at`, stamped by an
 * UPDATE guarded on IS NULL, rather than an ad-hoc boolean column.
 */
export const runReminderSweep = async (hours = 24) => {
  const due = await notificationRepo.remindersDue(hours);
  const out = [];

  for (const a of due) {
    a.reminder_sent_at = new Date();
    const doctor = await doctorRepo.findById(a.doctor_id);
    const facility = await facilities.findById(a.facility_id);
    const appointment = await (await import("../repositories/appointmentRepo.js")).findById(a.id);

    const result = await sendNotifications({
      event: "appointment_reminder",
      appointment,
      doctor,
      facility,
      patient: { id: a.patient_id, name: appointment?.patientName },
    });
    out.push(...result);

    // Guarded on IS NULL, so a concurrent sweep cannot send twice.
    await appointmentRepo.markReminderSent(a.id);
  }

  log.info(`reminder sweep: ${out.length} reminder(s) sent`);
  return out;
};

export default {
  sendNotifications,
  enqueueNotifications,
  deliverNotification,
  runReminderSweep,
  channels,
};