# Gemini Live Verification — Recorded Evidence

**Status: COMPLETE.** Both AI features produced real `gemini-3-flash-preview`
responses. This file is the durable record of those live calls, kept separate
from the mocked regression tests so the two can never be confused.

**Date:** 2026-10-13
**Model:** `gemini-3-flash-preview` (set via `GEMINI_MODEL`)
**Key:** supplied in `server/.env` as `GEMINI_KEY`. Never printed, never
committed, never sent to the frontend.

---

## Why this file exists

The regression suites run with the model **disabled** (or mocked) so they are
deterministic and consume no quota. That is the right default for CI, but it
means a green suite is not evidence that the live integration works.

The calls below were made against the real API and are the evidence that it
does. They are recorded here rather than only in a terminal scrollback.

---

## 1. Model availability

`GET /v1beta/models` with the key returned **HTTP 200**, 50 models visible, 45
supporting `generateContent`.

The previous default, `gemini-2.0-flash`, is **retired**:

```
HTTP 404
"This model models/gemini-2.0-flash is no longer available."
```

`gemini-2.5-flash` is closed to new users. `gemini-3-flash-preview` is
available and returns real text.

## 2. Minimal real request

```
POST /v1beta/models/gemini-3-flash-preview:generateContent
HTTP 200
text: "pong"
```

## 3. Chatbot — live model answer

`POST /api/ai/assist` with `"Why do I feel dizzy after standing up?"`

| Field | Value |
|---|---|
| `intent` | `general-health` |
| `sourcedFrom` | **`model`** |
| `generatedByModel` | **`true`** |
| `provider` | `google-gemini:gemini-3-flash-preview` |
| `latencyMs` | 15894 |

The answer was a complete, untruncated explanation of orthostatic hypotension
that explicitly declined to diagnose and directed the user to a clinician.

## 4. Triage — consent gate

**Without consent:**

```
HTTP 428  CONSENT_REQUIRED
"Sending your description to an AI service needs your explicit consent.
 Nothing has been sent."
elapsed: 0.017s
```

The 17-millisecond response is the proof that nothing was transmitted: a real
model call takes 13–21 seconds.

**With consent**, `"sharp chest pain radiating to the left arm and jaw"`:

| Field | Value |
|---|---|
| `provider` | `google-gemini:gemini-3-flash-preview` |
| `elapsed` | 14.5s |
| `urgency` | `high` |
| `departments` | `["Cardiology", "General Medicine"]` |
| `redFlags` | chest pain, radiation to arm, breathing difficulty, sweating, fainting |

Clinically correct for the symptom described.

## 5. Failure handling

Verified two ways: live during the verification run, and by stubbing `fetch`
in an isolated process (no network, no quota).

| Failure | Assistant | Triage |
|---|---|---|
| `400` invalid credentials | honest "not available" | `rule-based-fallback` |
| `429` quota exhausted | honest "not available" | `rule-based-fallback` |
| `503` service overloaded | honest "not available" | `rule-based-fallback` |
| `404` model unavailable | honest "not available" | `rule-based-fallback` |
| timeout / abort | honest "not available" | `rule-based-fallback` |
| no key configured | honest "not available" | `rule-based-fallback` |

In every case `generatedByModel` stayed `false` and the provider label never
claimed a model answered. The free-tier limit is **20 `generateContent`
requests per minute**, which is why the regression suites must not call the
live model.

## 6. Key containment

Checked by extracting the key from `server/.env` into memory and searching for
it — never printing it:

| Location | Result |
|---|---|
| API log | clean |
| Built client bundle | clean |
| All source and docs | clean |
| Git index, `HEAD`, all git objects | clean |
| `server/.env` | gitignored, not tracked |

## 7. Known limitation

`gemini-3-flash-preview` is a **preview** model and a reasoning one: it spends
385–617 output tokens on thinking and takes 13–21s to answer. The application's
budgets were raised to match (`GEMINI_TIMEOUT_MS=30000`,
`maxOutputTokens=2000`). A GA model would be faster and cheaper; a
`-latest` alias would be less volatile than a versioned name.