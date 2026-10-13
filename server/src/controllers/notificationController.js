import notificationRepo from "../repositories/notificationRepo.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { runReminderSweep, drainOutbox } from "../services/notificationService.js";
import { schedulerState } from "../services/scheduler.js";
import logger from "../utils/logger.js";

const log = logger.tag("notify-ctrl");

/**
 * Decide whose notifications the caller may read.
 *
 * Previously any non-patient caller could pass `?patientId=<someone else>`
 * and receive that person's notification bodies, email address and phone
 * number. That parameter is honoured for admins only.
 */
const resolveNotificationOwner = (user, query) => {
  const requested = query?.patientId;

  if (requested && requested !== user.id) {
    if (user.role !== "admin") {
      throw new AppError(
        "You can only view your own notifications",
        403,
        "FORBIDDEN",
      );
    }
    return requested;
  }

  return user.id;
};

/* ------------------------------------------------------------------ *
 *  GET /api/notifications                                           *
 * ------------------------------------------------------------------ */
export const listNotifications = asyncHandler(async (req, res) => {
  const targetId = resolveNotificationOwner(req.user, req.query);

  return sendSuccess(res, {
    notifications: await notificationRepo.listForUser(
      targetId,
      Number(req.query.limit) || 50,
    ),
    unread: await notificationRepo.unreadCount(targetId),
    channels: {
      sms: Boolean(process.env.TWILIO_ACCOUNT_SID),
      email: Boolean(process.env.RESEND_API_KEY),
      // Reported so the client can show an honest "not delivered" badge.
      simulated: !(
        process.env.TWILIO_ACCOUNT_SID && process.env.RESEND_API_KEY
      ),
    },
  });
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/notifications/read-all                                 *
 * ------------------------------------------------------------------ */
export const markRead = asyncHandler(async (req, res) => {
  // Mutates only the caller's own notifications, and persists. This handler
  // previously changed `read` in memory without persisting, so the state was
  // lost on restart.
  const updated = await notificationRepo.markAllRead(req.user.id);
  return sendSuccess(
    res,
    { ok: true, updated },
    "All notifications marked as read",
  );
});

/* ------------------------------------------------------------------ *
 *  POST /api/notifications/reminders/sweep                           *
 * ------------------------------------------------------------------ */
export const sweep = asyncHandler(async (req, res) => {
  const hours = Number(req.body?.hours) || Number(req.query.hours) || 24;
  const sent = await runReminderSweep(hours);
  log.info(`manual sweep triggered (${hours}h window)`);
  return sendSuccess(
    res,
    { sent: sent.length, notifications: sent },
    "Reminder sweep complete",
  );
});

/* ------------------------------------------------------------------ *
 *  PATCH /api/notifications/:id/read                                  *
 * ------------------------------------------------------------------ */
export const markOne = asyncHandler(async (req, res) => {
  // The caller's id is part of the UPDATE's WHERE rather than being checked
  // afterwards, so one caller can never mark another's notification read - not by
  // guessing an id, and not by reading one out of a log.
  const updated = await notificationRepo.markOneReadCounted(req.params.id, req.user.id);
  if (!updated) {
    // The same 404 whether the id does not exist or simply belongs to somebody
    // else. Telling them apart would confirm that an id is real.
    throw new AppError("Notification not found", 404, "NOT_FOUND");
  }
  return sendSuccess(res, { ok: true, id: req.params.id }, "Marked as read");
});

/* ------------------------------------------------------------------ *
 *  POST /api/notifications/outbox/drain        (admin)                *
 * ------------------------------------------------------------------ */
export const drain = asyncHandler(async (req, res) => {
  const limit = Number(req.body?.limit) || 100;
  const summary = await drainOutbox({ limit });
  log.info(`manual outbox drain: ${JSON.stringify(summary)}`);
  return sendSuccess(res, summary, "Outbox drain complete");
});

/* ------------------------------------------------------------------ *
 *  GET /api/notifications/scheduler           (admin)                *
 * ------------------------------------------------------------------ */
export const scheduler = asyncHandler(async (_req, res) =>
  sendSuccess(res, await schedulerState()),
);