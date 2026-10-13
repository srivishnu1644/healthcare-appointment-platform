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

/**
 * The assistant has its own limiter, separate from triage's.
 *
 * They are separated on purpose: they cost different amounts and have different
 * failure modes. Sharing one counter would let a burst of cheap triage calls
 * exhaust the allowance for questions the user is waiting on - or the reverse.
 * This one is tighter, because a single user asking the same question repeatedly
 * is the signature of scraping, not of somebody who needs help.
 */
const assistLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.ASSIST_MAX_PER_MINUTE) || 60,
  // Keyed by the signed-in user, not by IP address.
  //
  // A clinic is a shared network: every patient behind one router shares an IP,
  // so per-IP limiting lets one person exhaust the allowance for everybody else
  // in the building. Keying per account fixes that, and still bounds the total,
  // because each account gets its own bucket.
  keyGenerator: (req) => req.user?.id ?? req.ip,
  // The key is a UUID rather than an address, so the library's IPv6 key
  // validation does not apply to it.
  validate: { ip: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many assistant requests, please slow down",
  },
});

router.get("/provider", ctrl.provider);

// Public: describing the assistant discloses nothing about the caller's
// account, and the UI needs its limits and suggestions before it can render.
router.get("/assist", ctrl.assistInfo);

router.post(
  "/assist",
  requireAuth,
  assistLimiter,
  validate({
    // The service enforces these too. The validator exists so an oversized body
    // is rejected before it is parsed further, not because the service trusts
    // the route to have checked it.
    question: { required: true, type: "string", min: 3, maxLength: 1000 },
    // Optional conversation label echoed back to the client.
    sessionId: { type: "string", maxLength: 64 },
  }),
  ctrl.assist,
);

router.post(
  "/triage",
  requireAuth,
  aiLimiter,
  validate({
    description: { required: true, type: "string", min: 3, maxLength: 2000 },
    symptoms: { type: "string", maxLength: 2000 },
    reason: { type: "string", maxLength: 500 },
    // Phase 13: bounded rather than merely typed. `age` was an unconstrained
    // number, so -5 and 99999 both reached the prompt; `history` was an
    // unbounded array, so a caller could attach megabytes to a request that is
    // billed per token.
    age: { type: "number", min: 0, max: 130 },
    gender: { type: "string", maxLength: 40 },
    history: { type: "array", maxLength: 40 },
    // Explicit consent to send the description to a third-party AI service.
    // Optional in the schema because it is only REQUIRED when a model is
    // configured; the service enforces that and refuses with CONSENT_REQUIRED.
    consent: { type: "boolean" },
  }),
  ctrl.triage,
);

export default router;
