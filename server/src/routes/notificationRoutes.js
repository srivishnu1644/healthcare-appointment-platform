import { Router } from "express";
import * as ctrl from "../controllers/notificationController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";

const router = Router();
router.use(requireAuth);

// The literal paths come BEFORE "/:id/read" so "read-all" can never be parsed as
// an id. Express matches in order, so the order of these three lines is load
// bearing, not cosmetic.
router.get("/", ctrl.listNotifications);
router.patch("/read-all", ctrl.markRead);

router.post("/reminders/sweep", requireRole("admin"), ctrl.sweep);
router.post("/outbox/drain", requireRole("admin"), ctrl.drain);
router.get("/scheduler", requireRole("admin"), ctrl.scheduler);

router.patch("/:id/read", ctrl.markOne);

export default router;
