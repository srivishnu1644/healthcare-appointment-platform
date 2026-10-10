import { analyzeSymptoms, aiProvider } from "../services/aiService.js";
import { sendSuccess, asyncHandler } from "../utils/responses.js";

/* ------------------------------------------------------------------ *
 *  POST /api/ai/triage                                              *
 *  Symptom description -> department + urgency + recommended doctors *
 * ------------------------------------------------------------------ */
export const triage = asyncHandler(async (req, res) => {
  const { description, symptoms, reason, age, gender, history } = req.body;

  const result = await analyzeSymptoms(description, {
    symptoms,
    reason,
    age,
    gender,
    history: Array.isArray(history) ? history : [],
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
