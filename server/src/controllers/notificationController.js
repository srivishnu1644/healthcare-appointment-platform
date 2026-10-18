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

/**
 * Set one notification read or unread.
 *
 * `read` is optional and defaults to true, so a bodyless `PATCH /:id/read`
 * means exactly what it always meant. Sending `{"read": false}` puts the message
 * back in the unread pile — which is what a swipe-right on a row the reader has
 * already seen is asking for.
 *
 * Ownership is enforced inside the UPDATE's WHERE. A row belonging to someone
 * else matches nothing, so this reports the same 404 as an id that does not
 * exist — answering any other way would confirm that an id is real.
 */
export const markOne = asyncHandler(async (req, res) => {
  const read = req.body?.read === undefined ? true : Boolean(req.body.read);
  const result = await notificationRepo.setOneRead(req.params.id, req.user.id, read);
  if (!result) {
    throw new AppError("Notification not found", 404, "NOT_FOUND");
  }
  return sendSuccess(
    res,
    { ok: true, id: req.params.id, read: result.read },
    read ? "Marked as read" : "Marked as unread",
  );
});

/* ------------------------------------------------------------------ *
 *  Dismissal — the "slide to remove" action                         *
 * ------------------------------------------------------------------ */

/**
 * Dismiss one notification (DELETE /api/notifications/:id).
 *
 * Soft, so the client can offer an undo that actually works; see
 * `notificationRepo.removeOne` for why a hard DELETE could not be undone.
 *
 * Ownership is enforced inside the UPDATE's WHERE. A row belonging to someone
 * else matches nothing, so this reports the same 404 as an id that does not
 * exist — answering any other way would confirm that an id is real.
 */
export const removeOne = asyncHandler(async (req, res) => {
  const removed = await notificationRepo.removeOne(req.params.id, req.user.id);
  if (!removed) {
    throw new AppError("Notification not found", 404, "NOT_FOUND");
  }
  return sendSuccess(
    res,
    { ok: true, id: req.params.id, deleted: 1 },
    "Notification removed",
  );
});

/**
 * Dismiss every notification (DELETE /api/notifications).
 *
 * `scope=read` clears only what the caller has already read, which is the case
 * people actually mean most of the time — nobody empties an inbox to get back
 * the one message they have not opened yet. Anything else is the explicit
 * "remove everything".
 *
 * The count comes back so the client can tell the user exactly what went, and
 * so the undo bar can say "Cleared 12 notifications" rather than a vague
 * "Done".
 */
export const removeAll = asyncHandler(async (req, res) => {
  const scope = req.query.scope === "read" ? "read" : "all";
  const deleted = await notificationRepo.removeAll(req.user.id, { scope });
  return sendSuccess(
    res,
    { ok: true, deleted, scope },
    scope === "read"
      ? `Cleared ${deleted} read notification${deleted === 1 ? "" : "s"}`
      : `Removed ${deleted} notification${deleted === 1 ? "" : "s"}`,
  );
});

/** Take one dismissal back (POST /api/notifications/:id/restore). */
export const restoreOne = asyncHandler(async (req, res) => {
  const restored = await notificationRepo.restoreOne(req.params.id, req.user.id);
  if (!restored) {
    throw new AppError("Notification not found", 404, "NOT_FOUND");
  }
  return sendSuccess(
    res,
    { ok: true, id: req.params.id, restored: 1 },
    "Notification restored",
  );
});

/**
 * Take a bulk dismissal back (POST /api/notifications/restore-all).
 *
 * Restores everything currently dismissed for the caller, which is exactly what
 * an undo on "clear all" means. The client already knows what it removed and
 * re-renders it optimistically, so the response only has to confirm the write.
 */
export const restoreAll = asyncHandler(async (req, res) => {
  const restored = await notificationRepo.restoreAll(req.user.id);
  return sendSuccess(
    res,
    { ok: true, restored },
    `Restored ${restored} notification${restored === 1 ? "" : "s"}`,
  );
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