import { Router } from "express";
import * as ctrl from "../controllers/aiController.js";
import { requireAuth } from "../middlewares/authMiddleware.js";
import validate from "../middlewares/validateRequest.js";
import rateLimit from "express-rate-limit";

const router = Router();

// AI calls cost money upstream: throttle them.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many AI requests, please slow down",
  },
});

router.get("/provider", ctrl.provider);

router.post(
  "/triage",
  requireAuth,
  aiLimiter,
  validate({
    description: { required: true, type: "string", min: 3, maxLength: 2000 },
    symptoms: { type: "string", maxLength: 2000 },
    reason: { type: "string", maxLength: 500 },
    age: { type: "number" },
    gender: { type: "string" },
    history: { type: "array" },
  }),
  ctrl.triage,
);

export default router;
