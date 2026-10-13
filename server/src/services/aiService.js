/**
 * Doctor ranking used by the AI triage engine and `/doctors/recommended`.
 *
 * Scoring is unchanged from Phase 1; only the data source changed.
 */
import doctorRepo from "../repositories/doctorRepo.js";
import { specialties as specialtyRepo } from "../repositories/referenceRepo.js";
import triageRepo from "../repositories/triageRepo.js";
import { AppError } from "../utils/responses.js";
import logger from "../utils/logger.js";

const log = logger.tag("ai");

// Test adapter for triage, mirroring `ASSISTANT_ADAPTER=stub`.
//
// Declared here, above every use, because `aiProvider` below reads it at module
// evaluation. Declaring it further down put it in the temporal dead zone: the
// module threw "Cannot access TRIAGE_ADAPTER before initialization" on import.
const TRIAGE_ADAPTER = process.env.TRIAGE_ADAPTER;
if (TRIAGE_ADAPTER && process.env.NODE_ENV === "production") {
  throw new Error("TRIAGE_ADAPTER must not be set in production.");
}

const GEMINI_KEY = process.env.GEMINI_KEY;
// `gemini-3-flash-preview`.
//
// The previous default (`gemini-2.0-flash`) was retired by Google: the API now
// answers 404 "This model models/gemini-2.0-flash is no longer available". Every
// triage request was therefore failing over to the rule-based engine while the
// application still reported a live provider - the worst combination, because it
// looks configured and silently is not.
//
// `gemini-3-flash-preview` is the model chosen for this project. A "preview"
// name is less stable than a GA one and may change; if you prefer a name that
// survives retirements, set GEMINI_MODEL=gemini-flash-latest instead. Override
// freely - this is only the default.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export const aiProvider =
  TRIAGE_ADAPTER === "mock"
    ? "mock-adapter"
    : GEMINI_KEY
      ? `google-gemini:${GEMINI_MODEL}`
      : "rule-based-fallback";

/* ------------------------------------------------------------------ *
 *  Rule-based symptom -> specialty map (always available)           *
 *  Acts as the fallback and as grounding for the Gemini prompt.      *
 * ------------------------------------------------------------------ */

const SYMPTOM_RULES = [
  { keywords: ["chest", "heart", "palpitation", "blood pressure", "cholesterol", "bp"], specialty: "Cardiology", urgency: "high" },
  { keywords: ["skin", "rash", "acne", "eczema", "itch", "hair loss", "nail"], specialty: "Dermatology", urgency: "low" },
  { keywords: ["child", "baby", "toddler", "vaccination", "growth", "fever"], specialty: "Pediatrics", urgency: "medium" },
  { keywords: ["knee", "bone", "fracture", "joint", "back pain", "shoulder", "spine", "arthritis"], specialty: "Orthopedics", urgency: "medium" },
  { keywords: ["headache", "migraine", "seizure", "numbness", "tremor", "dizziness", "memory"], specialty: "Neurology", urgency: "medium" },
  { keywords: ["eye", "vision", "blurred", "cataract", "conjunctivitis", "glaucoma"], specialty: "Ophthalmology", urgency: "medium" },
  { keywords: ["tooth", "teeth", "gum", "dental", "cavity", "jaw"], specialty: "Dentistry", urgency: "low" },
  { keywords: ["anxiety", "depression", "stress", "sleep", "panic", "mood", "therapy"], specialty: "Psychiatry", urgency: "medium" },
  { keywords: ["period", "menstrual", "gynec", "pregnan", "uterus", "cervical", "breast"], specialty: "Gynecology", urgency: "medium" },
  { keywords: ["fever", "cough", "cold", "flu", "throat", "infection", "checkup", "general", "weakness", "diabetes"], specialty: "General Medicine", urgency: "low" },
];

const URGENCY_ADVICE = {
  high: "Your symptoms suggest urgency. If you have severe pain, breathing difficulty, or chest pressure, please seek emergency care immediately or call emergency services.",
  medium: "Book an appointment within the next few days. Seek urgent care if symptoms worsen.",
  low: "A routine appointment is appropriate. Consider a video consultation for a first look.",
};

function scoreByRules(text) {
  const haystack = String(text || "").toLowerCase();
  const scores = {};
  let urgency = "low";

  SYMPTOM_RULES.forEach((rule) => {
    rule.keywords.forEach((kw) => {
      if (haystack.includes(kw)) {
        scores[rule.specialty] = (scores[rule.specialty] || 0) + 1;
        const rank = { low: 0, medium: 1, high: 2 };
        if (rank[rule.urgency] > rank[urgency]) urgency = rule.urgency;
      }
    });
  });

  const ranked = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([specialty, score]) => ({ specialty, score }));

  return { ranked, urgency: ranked.length ? urgency : "low" };
}

/** Pull JSON out of a model response that may be wrapped in prose or fences. */
function parseModelJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// How long to wait for the model before giving up and using the rule-based
// engine. Was a hardcoded 8000ms, which was never enough for a reasoning model:
// measured on `gemini-3-flash-preview`, a realistic triage prompt takes 13-21s,
// so every call was aborting and silently falling back. See `assistantService`
// for the same change and the numbers behind it.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 30_000;

/**
 * Canned reply for `TRIAGE_ADAPTER=mock`.
 *
 * Valid, well-formed model JSON so the parse-and-ground path — the part that
 * turns raw model text into departments, urgency and recommended doctor ids — is
 * exercised with no network call, no latency and no quota. Without it that path
 * can only be reached by talking to a real model, which is what makes an AI test
 * suite expensive and flaky.
 */
const MOCK_GEMINI_REPLY = JSON.stringify({
  urgency: "high",
  departments: ["Cardiology", "General Medicine"],
  summary: "Sharp chest pain radiating to the arm needs urgent assessment.",
  followUpQuestions: ["How long has the pain lasted?", "Any shortness of breath?"],
  redFlags: ["Chest pain or pressure", "Pain radiating to the arm"],
});

async function askGemini(prompt) {
  if (TRIAGE_ADAPTER === "mock") {
    // A little latency so the latency measurement still means something.
    await new Promise((r) => setTimeout(r, 5));
    return MOCK_GEMINI_REPLY;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    // The key goes in a HEADER, not `?key=` in the URL.
    //
    // This call previously appended the key to the query string. Node's fetch
    // errors do not echo the URL, so that was not leaking through `err.message`
    // (verified: both a DNS failure and a connection refusal report only the
    // host). But a URL is a fragile place for a credential - anything that
    // logs request lines at the HTTP layer, which `app.js` already does for
    // inbound requests, would capture it. `assistantService.js` has always
    // used this header; the two call paths are now the same.
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const json = await res.json();
    return json?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 *  Symptom analysis                                                   *
 * ------------------------------------------------------------------ */

/**
 * Whether a live model is configured, i.e. whether anything leaves the machine.
 *
 * With no key the triage engine is entirely rule-based and local, so nothing is
 * transmitted and asking for consent would be theatre.
 *
 * The mock adapter counts as "sends data": it stands in for a configured model,
 * so the consent gate must fire exactly as it does for the real one. Otherwise a
 * test with the mock would quietly skip the gate it is meant to be checking.
 */
export const triageSendsData = () => Boolean(GEMINI_KEY) || TRIAGE_ADAPTER === "mock";

/**
 * Symptom description -> department, urgency and recommended doctors.
 *
 * @param {string} description what the patient typed
 * @param {object} extra
 * @param {boolean} extra.consent the patient explicitly agreed to send this to a
 *        third-party AI service. Required when a model is configured, and checked
 *        here rather than in the route so that no caller can skip it.
 */
export const analyzeSymptoms = async (description, extra = {}) => {
  const startedAt = Date.now();
  const text = [description, extra.symptoms, extra.reason].filter(Boolean).join(". ");
  if (!text.trim())
    throw new AppError("Please describe your symptoms", 400, "EMPTY_INPUT");

  // Before anything is read, assembled or sent. Nothing is transmitted without
  // this, and the failure is explicit rather than a silent fallback.
  if (triageSendsData() && extra.consent !== true) {
    throw new AppError(
      "Sending your description to an AI service needs your explicit consent. " +
        "Nothing has been sent.",
      428,
      "CONSENT_REQUIRED",
    );
  }

  const rules = scoreByRules(text);

  // Ground the recommendations in real doctors from the database.
  const recommend = async (specialtyNames) => {
    const names = specialtyNames.map((s) => s.toLowerCase());
    const all = await doctorRepo.search({ acceptingOnly: "false" });
    const matched = all
      .filter((d) => names.includes(d.specialtyName.toLowerCase()))
      .sort((a, b) => b.rating - a.rating || a.consultationFee - b.consultationFee);

    if (!matched.length) {
      return [...all]
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 3)
        .map((d) => d.id);
    }
    return matched.slice(0, 5).map((d) => d.id);
  };

  let result;

  if (GEMINI_KEY || TRIAGE_ADAPTER === "mock") {
    try {
      const specList = await specialtyRepo.all();
      const specialtyList = specList.map((s) => s.name).join(", ");
      // WHAT IS SENT: the description the patient typed, and the age, gender and
      // history they supplied on this form. Nothing else - no name, no account,
      // no appointments, no queue state, no records. The function receives none
      // of those and cannot read them: its whole input is `description` and
      // `extra`, both supplied by this form.
      const prompt = [
        "You are a medical triage assistant for a hospital appointment booking platform.",
        "Do NOT diagnose. Only suggest which department to visit and how urgent it is.",
        `Available departments: ${specialtyList}`,
        "",
        `Patient description: "${text}"`,
        extra.age ? `Age: ${extra.age}` : "",
        extra.gender ? `Gender: ${extra.gender}` : "",
        extra.history?.length ? `History: ${extra.history.join(", ")}` : "",
        "",
        "Respond with JSON only, in exactly this shape:",
        '{"urgency":"low|medium|high","departments":["..."],"summary":"one sentence","followUpQuestions":["..."],"redFlags":["..."]}',
      ].filter(Boolean).join("\n");

      const raw = await askGemini(prompt);
      const parsed = parseModelJson(raw);
      if (parsed && Array.isArray(parsed.departments) && parsed.departments.length) {
        const allSpecs = await specialtyRepo.all();
        const departments = parsed.departments
          .map((n) => allSpecs.find((s) => s.name.toLowerCase() === String(n).toLowerCase())?.name)
          .filter(Boolean);

        const finalDepartments = departments.length
          ? departments
          : rules.ranked.map((r) => r.specialty);

        result = {
          provider: aiProvider,
          urgency: parsed.urgency || rules.urgency,
          departments: finalDepartments,
          summary: parsed.summary || "Based on your description, here are the recommended departments.",
          followUpQuestions: parsed.followUpQuestions || [
            "How long have you been experiencing these symptoms?",
            "Are the symptoms constant or intermittent?",
          ],
          redFlags: parsed.redFlags || [],
          advice: URGENCY_ADVICE[parsed.urgency || rules.urgency],
          recommendedDoctorIds: await recommend(finalDepartments),
        };
      } else {
        throw new Error("Unparseable model response");
      }
    } catch (err) {
      log.warn(`Gemini unavailable (${err.message}); using rule-based triage`);
    }
  }

  if (!result) {
    const departments = rules.ranked.length
      ? rules.ranked.map((r) => r.specialty)
      : ["General Medicine"];
    result = {
      provider: "rule-based-fallback",
      urgency: rules.urgency,
      departments,
      summary: departments.length
        ? `Your symptoms best match ${departments.slice(0, 2).join(" or ")}.`
        : "We could not match your symptoms precisely, so we suggest a general physician.",
      followUpQuestions: [
        "How long have you been experiencing these symptoms?",
        "Is the pain constant or does it come and go?",
        "Are you currently taking any medication?",
      ],
      redFlags:
        rules.urgency === "high"
          ? ["Severe or worsening pain", "Difficulty breathing", "Loss of consciousness"]
          : [],
      advice: URGENCY_ADVICE[rules.urgency],
      recommendedDoctorIds: await recommend(departments),
    };
  }

  // Persist every triage so the "recommendation, not diagnosis" framing is
  // auditable and latency is measurable.
  try {
    await triageRepo.record({
      userId: extra.userId ?? null,
      description,
      provider: result.provider,
      urgency: result.urgency,
      departments: result.departments,
      redFlags: result.redFlags,
      summary: result.summary,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    // Never fail a triage because the audit write failed.
    log.warn(`triage audit write failed: ${err.message}`);
  }

  return result;
};

/* ------------------------------------------------------------------ *
 *  Doctor recommendation (ranking, no LLM needed)                    *
 * ------------------------------------------------------------------ */

export const recommendDoctors = async ({
  specialty,
  city,
  maxFee,
  mode,
  limit = 6,
} = {}) => {
  const list = await doctorRepo.search({
    specialty,
    city,
    maxFee,
    mode,
    acceptingOnly: "true",
  });

  const scored = list.map((d) => {
    let score = d.rating * 10;
    if (d.consultationFee < 800) score += 4;
    if (d.experience >= 12) score += 3;
    if (d.languages?.includes("Hindi")) score += 1;
    if (mode) score += 2;
    return { doctor: d, score: Number(score.toFixed(1)) };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
};

export const listSpecialties = () => specialtyRepo.all();