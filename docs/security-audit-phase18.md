# MediCare v2 — Security Audit (Phase 18)

**This system is not "secure".** Passing automated checks means specific,
enumerated attacks were tried and did not succeed. It does not mean penetration
testing was performed, because it was not.

This document separates four things that are easy to blur together:

| Section | Meaning |
|---|---|
| [1. Fixed this cycle](#1-fixed-this-cycle) | Real defects found and repaired, with a regression test |
| [2. Tested protections](#2-tested-protections) | Attacks attempted by an automated suite; the suite passes |
| [3. Unverified risks](#3-unverified-risks) | Plausible problems **no test covers** |
| [4. Deferred improvements](#4-deferred-improvements) | Known gaps, deliberately left |

---

## 1. Fixed this cycle

Each of these was found by this audit and now has a test that fails without the
fix.

### 1.1 The published test secret was accepted in production

`INSECURE_SECRETS` listed four placeholder values and did not include
`test-only-secret-not-for-production` — the deterministic secret every test run
signs with, which is **published in this repository**.

That value is 37 characters, so it also satisfied the "at least 32 characters"
rule. A production deployment that copied it from a README or a compose example
would have booted normally and signed every token with a secret anyone can read.

**Fix:** the value is now in the list. The check is skipped under `NODE_ENV=test`,
which is the only environment where it is the intended secret — refusing it there
would stop every suite from booting.

**Verified** by booting the application in four configurations:

| Configuration | Result |
|---|---|
| production, no `JWT_SECRET` | `FATAL: JWT_SECRET is required in production.` |
| production, no `CORS_ORIGIN` | `FATAL: CORS_ORIGIN is required in production.` |
| production, published test secret | `FATAL: JWT_SECRET is a known placeholder value.` |
| production, 5-character secret | `FATAL: JWT_SECRET must be at least 32 characters` |
| production, generated secret | boots |
| test, published test secret | boots (correctly) |

> Verification required a copy of the source tree with no `.env`, because
> `dotenv` repopulates variables from that file and silently defeats
> `env -u JWT_SECRET`. The repository's `.env` was never modified.

### 1.2 Malformed input could reach SQL and produce a 500

Two paths turned a caller's typo into a server fault:

- **`GET /api/notifications?limit=-1`** — `Math.min(Number(limit) || 50, 200)` has
  no lower bound, and `|| 50` does not catch `-1` because a negative number is
  truthy. `-1` reached `LIMIT -1` and PostgreSQL raised *"LIMIT must not be
  negative"*.
- **`GET /api/appointments/queue?date=2026-02-31`** — a shape-only regex
  (`^\d{4}-\d{2}-\d{2}$`) let a day that does not exist through to a `::date`
  cast.

A fourth instance of the same class existed in a new repository written during
this cycle: `DATE_EXPR` returns `TEXT`, and comparing it to a `date` fails with
*"operator does not exist: text >= date"*. It produced four `500`s across the
admin endpoints before being consolidated into one helper.

**Fix:** route-level validation, plus repository-level clamps with bounds on both
sides. The validation suite now fails if **any** malformed input produces a 5xx.

### 1.3 Two validator rules were silently ignored

The hand-written validator supported neither `pattern` nor nested field rules.
A route could declare either and get **no error and no check**.

This is the most dangerous class of bug in a validation layer: the code reads as
if it validates something it does not.

**Fix:** both are implemented, and `maxKeys` was added because an object has no
`.length` so existing length bounds could not see it. The suite asserts that a
nested rule **fires**, not merely that it parses.

### 1.4 Profile fields were silently truncated instead of rejected

`PATCH /api/auth/me` sliced a 500-character name to 120 and answered `200`. The
user believed their name had been saved; most of it had been discarded.

**Fix:** `maxLength` at the route, so over-long input is a `422`.

---

## 2. Tested protections

`npm run test:audit` — **65 assertions**, all passing. Each section notes what a
vacuous result would look like, because a suite that only proves refusals is
satisfied by a route that refuses everyone.

### SQL injection

**96 payloads** (8 classic injection strings × 12 list filters) across
`search`, `sort`, `status`, `specialty`, `city` and `patientId` on the admin and
public list endpoints.

- No payload produced a 5xx.
- The `users` row count is identical before and after.
- The application is still healthy afterwards.
- `appointments` is non-empty — a truncation "attack" would leave a healthy but
  empty app, so this is asserted separately.

**Also:** `sort` is matched against a whitelist and the matched *constant* is
interpolated. The request text never reaches SQL. A hostile `sort` is ignored,
not executed.

### Broken object-level authorisation (IDOR)

Four cases, because a suite that only proves refusals passes against a route that
refuses everyone:

| Actor | Result |
|---|---|
| Unrelated patient | `403` |
| Unrelated doctor | `403` |
| **Owning patient** | **`200`** |
| **Assigned doctor** | **`200`** |
| Admin | `200` |

Mutation paths are refused too (`PATCH /status`, `POST /check-in` → `403`), and
the appointment's status is re-read from the database afterwards to prove it is
genuinely unchanged rather than merely reported as such.

Notification reads are scoped in the `UPDATE`'s `WHERE`, and another user's
notification returns `404` rather than `403` — a `403` would confirm the id
exists.

### Mass assignment

`PATCH /auth/me` with `{ role: "admin", isAdmin: true, id: <other user>,
email: <attacker>, password: <new> }`:

- role stays `patient`
- id unchanged
- email unchanged
- the **original** password still works
- the **injected** password is rejected with `401`

The last two are the decisive ones. Asserting only that the response body looks
right would pass even if the password had been changed.

### Prototype pollution

Registration with `__proto__` and `constructor.prototype` payloads sets
`role: "admin"`. The resulting account is a `patient`, and `Object.prototype`
carries no injected property afterwards.

### Token handling

| Vector | Result |
|---|---|
| No `Authorization` header | `401` |
| Empty bearer | `401` |
| Malformed JWT | `401` |
| **`alg: none` token with an admin payload** | `401` |
| Basic auth instead of bearer | `401` |

### Error information leakage

Six error paths scanned for stack frames, SQL text, driver names, filesystem
paths and password hashes. None leak. The `500` handler returns
`"Something went wrong on our side"` and logs the detail server-side.

### Secrets in payloads

Five admin and public payloads scanned for JWTs, bcrypt hashes and private-key
material. None present. The patient directory additionally carries no
`reason`, `symptoms` or `diagnosis` field.

### CORS

An unlisted origin, the `null` origin, and a subdomain of a listed origin are all
refused. There is no `origin: true` fallback and no `*`.

### Admin surface is read-only for appointments

`POST`/`PATCH`/`DELETE` under `/api/admin/appointments`, and
`POST /api/admin/queue/next`, all return `404`. There is **no** administrative
path that writes an appointment, so the ownership, transition and room-lock rules
cannot be bypassed by using one.

### XSS

The client contains **no** `dangerouslySetInnerHTML`, no `innerHTML`, no
`document.write` and no `eval`. React escapes by default. Input containing
`<script>` is stored verbatim, which is correct — escaping belongs to the renderer.

### AI boundary

An injection attempt does not return a system prompt, and the assistant does not
disclose the caller's email or an appointment id. Triage consent is asserted in
**both** configurations (§3.1).

---

## 3. Unverified risks

These are real possibilities that **no automated check covers**. They are listed
because their absence from the sections above is not evidence of safety.

### 3.1 No penetration testing

Every finding above came from reasoning about the code and probing known
techniques. Nobody has attempted an unanticipated attack. Treat the automated
suite as a floor, not a ceiling.

### 3.2 No live model has ever been reached

No Gemini credential has ever worked. A placeholder key was used to prove the
consent gate fires (`428 CONSENT_REQUIRED`) and the assistant suite passes in both
configurations. **The model's actual behaviour under injection has never been
observed**, because the prompt-injection refusals are enforced by the
application before any call. If the injection matcher misses a phrasing, nothing
downstream has been tested.

### 3.3 Rate limiting is per process

`express-rate-limit` keeps counters in memory. Three API processes allow three
times the intended rate. This is not currently a problem because the system is
documented as single-process, but it is a trap for anyone who scales out.

### 3.4 No audit log of privileged reads

The application records AI turns (without user or appointment ids) and records
notification sweeps. It does **not** record who viewed which patient's data.
An administrator reading the patient directory leaves no trace. For a healthcare
system this is a genuine gap, not a stylistic one.

### 3.5 Session invalidation is limited

Refresh tokens are single-use and reuse revokes the session. There is no global
"sign out everywhere", no password-change invalidation of other sessions, and no
administrative ability to revoke a user's sessions.

### 3.6 No TLS, no encryption at rest

The application serves plain HTTP and assumes a terminating proxy. Nothing is
encrypted at rest beyond whatever the database provides. A backup on unencrypted
disk contains every patient's data.

### 3.7 No lockout, no MFA, no password policy enforcement beyond length

Only rate limiting. No account lockout, no breached-password check, no second
factor. Password rules are length-only (`8–128`).

### 3.8 RLS depends on the database role

Row-level security is bypassed silently by a superuser connection. Nothing in the
application can detect this; it was verified by inspection, not at runtime.

### 3.9 Untested under concurrency across many clients

Concurrency **is** tested for the two operations that matter — simultaneous
booking of one slot, and simultaneous `call-next` on one room. Load and behaviour
under many concurrent clients generally is not.

---

## 4. Deferred improvements

Gaps that are known, documented and deliberately not implemented.

| Gap | Why |
|---|---|
| **Waiting-room capacity** (`slots.max_queue`) stored but not enforced | Deferred rather than half-implemented. A room can exceed its configured capacity. |
| **Triage rate limiter is keyed by IP**, unlike the assistant limiter beside it | Found in this cycle, documented, **not fixed**. Every patient in a clinic shares one IP, so 20 patients asking about symptoms in a minute throttles uninvolved people. The fix is one `keyGenerator`, mirroring `assistLimiter`. Left unfixed to keep the change surface small and reviewable. |
| **AI output is not moderated** | No moderation service is in scope. Output is labelled as machine-generated. |
| **Scheduler is single-process** | Documented constraint, not a defect. Scaling out requires disabling the scheduler on all but one instance. |
| **External notification delivery is at-least-once** | Inherent to an external call. Only in-app rows are exactly-once, via the dedupe index. |
| **Reminder timing is approximate** | At most one interval late, never early. |
| **No CSRF tokens** | Safe while the API is token-authenticated. Switching to cookie auth would require revisiting this. |
| **No account lockout** | Rate limiting only. |
| **No privileged-access audit log** | See §3.4. |

---

## 5. Summary

| Category | Count |
|---|---|
| Defects found and fixed | 4 |
| Assertions in the audit suite | 65 |
| Injection payloads attempted | 96 |
| Unverified risks documented | 9 |
| Deferred improvements documented | 8 |

The honest summary: the authentication, authorisation, injection and
error-handling paths are well covered by automated tests, and this cycle fixed
four real defects. Everything in §3 is a genuine unknown, and the most important
of them — no penetration testing, no live model ever reached, and no privileged
read audit — is exactly the kind of gap that a green test run hides.