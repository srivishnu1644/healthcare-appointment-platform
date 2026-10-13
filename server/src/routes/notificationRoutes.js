import { Router } from "express";
import * as ctrl from "../controllers/notificationController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";

const router = Router();
router.use(requireAuth);

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

// The id is a `uuid` column, so a non-UUID value is a database error during the
// cast rather than a miss - it has to be refused before the query.
router.patch(
  "/:id/read",
  validate({ id: { required: true, type: "uuid" } }, "params"),
  ctrl.markOne,
);

export default router;