import { Router } from "express";
import * as ctrl from "../controllers/notificationController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

const router = Router();
router.use(requireAuth);

/**
 * How a notification id is validated, and why it is NOT `uuid`.
 *
 * `notifications.id` is a `text` column (`DEFAULT gen_random_uuid()::text`),
 * not a `uuid` one. Rows created by the application therefore look like UUIDs,
 * which is exactly what makes the stricter rule look safe here — but the JSON
 * import preserved every existing id VERBATIM, so any database that came through
 * it still holds the old datastore's ids: `notif_1`, `n-3f9a`, and so on.
 *
 * Declaring `type: "uuid"` made both the read and the remove endpoints answer
 * 422 VALIDATION_ERROR for those rows, so the inbox rendered a message the
 * server then refused to act on: the client held an id the validator had
 * already seen in its own list and rejected. The rule has to describe the
 * COLUMN, not the common case.
 *
 * Bounded string is sufficient defence rather than a retreat: the value only
 * ever reaches a bound parameter (`WHERE id = $1`), so there is nothing to
 * inject, and an unknown or malformed id is answered 404 by the repository's
 * WHERE clause rather than reaching the database at all.
 */
const NOTIFICATION_ID = { required: true, type: "string", minLength: 1, maxLength: 64 };

// The literal paths come BEFORE "/:id/read" so "read-all" can never be parsed as
// an id. Express matches in order, so the order of these three lines is load
// bearing, not cosmetic.

/**
 * Phase 13: `limit` is bounded here rather than only in the repository.
 *
 * The repository clamps too, and it has to - but a repository clamp is a
 * consequence of the request, not an answer to it. `?limit=-1` used to become
 * `LIMIT -1` and a 500 from PostgreSQL. `patientId` is validated for shape too,
 * because it is an id that reaches the ownership check below.
 */
router.get(
  "/",
  validate(
    {
      limit: { type: "number", min: 1, max: 200 },
      patientId: { type: "string", maxLength: 64 },
    },
    "query",
  ),
  ctrl.listNotifications,
);
router.patch("/read-all", ctrl.markRead);

/**
 * Bulk dismissal. `scope=read` keeps the unread ones, which is what a reader
 * clearing their inbox usually wants; anything else clears the lot.
 *
 * `DELETE /` is registered before `DELETE /:id` purely for readability — the two
 * cannot collide, since one has an empty path segment and the other does not —
 * but the literals-first rule above is not a rule about Express, it is a rule
 * about the next person editing this file.
 */
router.delete(
  "/",
  validate({ scope: { type: "string", maxLength: 16 } }, "query"),
  ctrl.removeAll,
);

/**
 * Undo for the two endpoints above. Both are scoped to `req.user.id` in the
 * repository's WHERE clause, so there is no id an admin could pass here to
 * restore another patient's message.
 */
router.post("/restore-all", ctrl.restoreAll);

// `hours` bounds the look-back window. An unbounded or negative window would ask
// the sweep to consider every appointment ever made.
router.post(
  "/reminders/sweep",
  requireRole("admin"),
  validate({ hours: { type: "number", min: 1, max: 720 } }, "body"),
  ctrl.sweep,
);

router.post(
  "/outbox/drain",
  requireRole("admin"),
  validate({ limit: { type: "number", min: 1, max: 500 } }, "body"),
  ctrl.drain,
);

router.get("/scheduler", requireRole("admin"), ctrl.scheduler);

// Read state. The body is optional: `{ read: false }` marks it unread, and
// omitting it keeps the original "mark read" meaning. Both directions in one
// endpoint, because a toggle is what the swipe gesture performs.
router.patch(
  "/:id/read",
  validate({ id: NOTIFICATION_ID }, "params"),
  validate({ read: { type: "boolean" } }, "body"),
  ctrl.markOne,
);

// Dismissal. Soft rather than destructive so the client can offer an undo; see
// notificationRepo.removeOne. Scoped to the caller inside the UPDATE.
router.delete(
  "/:id",
  validate({ id: NOTIFICATION_ID }, "params"),
  ctrl.removeOne,
);

router.post(
  "/:id/restore",
  validate({ id: NOTIFICATION_ID }, "params"),
  ctrl.restoreOne,
);

export default router;