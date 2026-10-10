import { Router } from "express";
import * as ctrl from "../controllers/notificationController.js";
import { requireAuth, requireRole } from "../middlewares/authMiddleware.js";

const router = Router();
router.use(requireAuth);

router.get("/", ctrl.listNotifications);
router.patch("/read-all", ctrl.markRead);
router.post("/reminders/sweep", requireRole("admin"), ctrl.sweep);

export default router;
