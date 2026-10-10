import notificationRepo from "../repositories/notificationRepo.js";
import { sendSuccess, AppError, asyncHandler } from "../utils/responses.js";
import { runReminderSweep } from "../services/notificationService.js";
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