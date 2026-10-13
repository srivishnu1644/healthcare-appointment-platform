import { analyzeSymptoms, aiProvider } from "../services/aiService.js";
import { ask, describe } from "../services/assistantService.js";
import { sendSuccess, asyncHandler } from "../utils/responses.js";

/* ------------------------------------------------------------------ *
 *  POST /api/ai/triage                                              *
 *  Symptom description -> department + urgency + recommended doctors *
 * ------------------------------------------------------------------ */
export const triage = asyncHandler(async (req, res) => {
  const { description, symptoms, reason, age, gender, history, consent } = req.body;

  const result = await analyzeSymptoms(description, {
    symptoms,
    reason,
    age,
    gender,
    history: Array.isArray(history) ? history : [],
    // Forwarded so the service can refuse. The refusal lives there rather than
    // here on purpose: a second caller reaching this service must not be able to
    // skip the check by not going through this controller.
    consent: consent === true,
  });

  return sendSuccess(res, result, "Analysis complete");
});

/* ------------------------------------------------------------------ *
 *  GET /api/ai/provider                                             *
 * ------------------------------------------------------------------ */
export const provider = asyncHandler(async (req, res) =>
  sendSuccess(res, {
    provider: aiProvider,
    isLive: aiProvider.startsWith("google-gemini"),
    note: aiProvider.startsWith("google-gemini")
      ? "Gemini is configured - using live model responses."
      : "No GEMINI_KEY set - using the built-in rule-based triage engine.",
  }),
);

/* ------------------------------------------------------------------ *
 *  POST /api/ai/assist                                              *
 *  How MediCare works + general healthcare information                *
 * ------------------------------------------------------------------ */
export const assist = asyncHandler(async (req, res) => {
  // Only the question crosses into the service. No appointment, no profile, no
  // queue state is passed, because the assistant is never permitted to hold
  // them - see assistantService for why that matters.
  const result = await ask({
    question: req.body?.question,
    role: req.user?.role ?? "patient",
  });
  return sendSuccess(res, result, "Answered");
});

/* ------------------------------------------------------------------ *
 *  GET /api/ai/assist                                               *
 *  What the assistant is, before anyone asks it anything             *
 * ------------------------------------------------------------------ */
export const assistInfo = asyncHandler(async (_req, res) =>
  sendSuccess(res, describe()),
);
