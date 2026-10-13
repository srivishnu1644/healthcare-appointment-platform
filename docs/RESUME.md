# MediCare v2 — Resume-Ready Project Summary

---

## Project title

**MediCare v2 — Healthcare Appointment Platform with Live Waiting Rooms and
Database-Enforced Notification Deduplication**

A production-shaped monolith for clinic appointment management: React + Vite
client, Express API, PostgreSQL 16. 58 endpoints, 23 tables, 18 forward-only
migrations, row-level security on 16 tables, and 1,211 automated assertions
across 17 backend suites, plus 422 client hook checks.

---

## Technology stack

| Layer | Choice |
|---|---|
| Frontend | React 18, Vite, React Router, React Context, hand-written CSS |
| Backend | Node.js (ESM), Express |
| Database | PostgreSQL 16 — transactions, row locks, constraints, RLS |
| Auth | JWT access tokens + rotating opaque refresh tokens, bcrypt |
| Validation | Hand-written declarative middleware (no Zod/Joi) |
| Testing | Hand-written assertion suites (no Jest/Supertest) |
| AI | Google Gemini adapter with a local rule-based fallback |

Deliberately absent: Docker, Kubernetes, Redis, Kafka, GraphQL, MongoDB,
Tailwind, and every CI/CD or schema-generation tool.

---

## Technical achievements

### 1. Concurrency correctness proven, not asserted

Booking and queue advancement both race. Two patients booking one slot produce
exactly one `201` and one `409`, enforced by a row lock taken inside the
booking transaction and re-read under it. Two providers calling "next" on one
room serialise on a transaction-scoped advisory lock.

Lock ordering is fixed — room advisory lock, then appointment row, then slot
row — because taking the advisory lock *after* a row lock inverts against other
paths and deadlocks. All five queue-mutating paths follow that order, and the
suite exercises the concurrent case rather than describing it.

### 2. Notification deduplication moved into the database

A partial unique index on `notifications.dedupe_key`, not an application check —
two concurrent transactions can both read "not yet" and both commit, so only the
database can prevent the duplicate.

The instructive part is what it replaced. The original code caught PostgreSQL
error `23505` and ignored it. That is wrong: **a failed statement aborts the
surrounding transaction**, so the booking was silently rolled back at `COMMIT`
while the API reported success. `ON CONFLICT DO NOTHING` returning `null` is the
correct primitive.

### 3. A waiting-room model that renumbers itself

A room is `(doctor_id, clinic_date)`, not a per-slot line. Positions are computed
with `row_number()` ordered by `joined_at, id` — contiguous, self-renumbering,
starting at 1, with no stored counter to compact and therefore no way to leave a
gap. The patient in consultation is excluded from the ranking and returned
separately, so "you are 2nd" never silently changes meaning. Legacy per-slot
columns survive for compatibility and are never used for ranking.

### 4. A validation layer whose rules cannot be silently ignored

Two rule types were missing, and their absence was quiet: the validator supported
neither `pattern` nor nested field rules, so a route could declare either and
receive no error and no check. That is the worst failure mode in a validation
layer — code that reads as if it validates something it does not.

Both are implemented, along with `maxKeys` (an object has no `.length`, so
existing bounds could not see it). More importantly, **existing contracts were
preserved rather than "improved"**: making the shared `date` type stricter
silently changed `/doctors/:id/slots` from `400 INVALID_DATE` to a generic `422`.
The existing test caught the regression, the change was reverted, and a
configuration-specific type was added instead.

### 5. Tests that had to be proven non-vacuous

Three tests were found passing for the wrong reason and rewritten: an injection
test that reloaded the page after dispatching (killing the in-flight request), a
visibility measurement that zeroed its counter after dispatching, and an
inspection that measured nothing. Mutation testing was used as the proof
mechanism — removing a deduplication guard produced three failures including a
booking rollback; removing the injection refusals produced eleven.

The documentation is checked too: `test:docs` parses `docs/API.md` against the
live Express router and fails if an endpoint is invented, missing, or promises an
error code the source does not contain.

---

## Architecture

```
client (React/Vite)
   │  fetch + Bearer token
   ▼
routes ──► controllers ──► services ──► repositories ──► PostgreSQL
             (HTTP only)   (business   (SQL only,      (constraints,
                            + txn)      parameterised)  RLS, indexes)
```

**Routes** declare path, role gate and validation. **Controllers** translate HTTP
and never write to the database. **Services** own business rules and transaction
boundaries. **Repositories** contain all SQL, always parameterised.

`withTransaction(fn)` propagates an explicit transaction context, so a service
calling another service **joins** the caller's transaction instead of opening a
second one against the same rows.

The administrative surface over appointments is deliberately **read-only**: a
status change goes through the same endpoint a provider uses, so ownership,
transition and lock rules apply identically and cannot be bypassed by using an
admin route.

---

## Engineering challenges and solutions

### A 500 is never the right answer to a typo

Auditing what a `500` means surfaced four real defects: a negative `limit` whose
clamp had no lower bound reaching `LIMIT -1`; a shape-only date regex letting
`2026-02-31` reach a `::date` cast; and the same `text >= date` type mismatch at
four sites in a new repository. All are now covered by a suite that fails if any
malformed input produces a 5xx.

The fix for the recurring date bug was one `dateOf()` helper rather than five
casts that can each be forgotten — the same mistake was made three times before
being consolidated.

### Preserving an API contract while adding validation

Adding route validation silently replaced two specific `400`s with generic `422`s.
Both were caught by existing tests. The resolution was not to accept the change
or to delete the tests, but to keep the specific codes, move only *format*
checking to the route, and add assertions that pin the specific behaviour so it
cannot be replaced silently again.

### Detecting a configuration mismatch between two processes

The AI suite failed four assertions with a placeholder key configured. The cause
was instructive: the test process asked its *own* environment whether a key was
configured, while the server — started by a different harness with different
environment variables — said yes. The suite now reads the server's own capability
descriptor, which cannot disagree. It passes 77/77 in both configurations.

### Being honest about what was not verified

The AI consent gate has been proven to fire (`428`) with a placeholder key, and
the suites pass with and without a model configured. **No live Gemini call has
ever succeeded**, because no credential has ever worked. The README, the API
reference and the security audit each state this explicitly rather than implying
an integration exists. `test:docs` fails if the claim is ever upgraded to
something stronger.

---

## Interview explanation

> **"Walk me through the hardest bug."**
>
> Notification deduplication originally caught PostgreSQL's unique-violation
> error and ignored it. It passed every functional test. But a failed statement
> *aborts the transaction*, so the booking that had just inserted the
> notification was rolled back at `COMMIT` while the API reported success. The
> user saw "booked"; the database disagreed.
>
> **"How did you find it?"**
>
> Reading the code with the question "what does a 500 actually mean?" rather than
> "is the happy path covered?". That question found four more: a limit clamp
> with no lower bound that let `-1` reach `LIMIT -1`, and a shape-only date
> regex that let `2026-02-31` reach a `::date` cast. Same bug class as the
> validator rules that were silently ignored.
>
> **"How do you know your tests aren't lying?"**
>
> Three of them were. An injection test reloaded the page after dispatching and
> killed the request it was asserting on; a visibility measurement zeroed its
> counter after dispatching, so it could only ever see zero. I found them by
> asking what a green result would look like *if the code were broken*, and
> rewrote them. Since then I've used mutation testing as the main tool — remove
> the guard, confirm the suite goes red. Removing the deduplication guard gives
> three failures including that booking rollback; removing the injection refusals
> gives eleven.
>
> **"What's your biggest remaining risk?"**
>
> Automated checks are a floor. Nobody has penetration-tested this. No live model
> has ever been reached, so the model's actual behaviour under injection is
> untested — my refusals are enforced before the call, which means if the
> injection matcher misses a phrasing, nothing downstream has been checked. And
> there's no audit log of privileged reads: an administrator reading the patient
> directory leaves no trace. All of it is written down in the security audit
> under "unverified", separate from what's tested.

---

## What to be ready to discuss

**Probably will be asked**

- Why `ON CONFLICT DO NOTHING` and never catch-`23505`
- Lock ordering and why advisory-before-row prevents deadlock
- `row_number()` for queue position versus a stored counter
- Row-level security and the superuser trap
- Refresh-token rotation and why reuse must revoke the session
- Why the admin surface is read-only for appointments
- Incremental SQL migrations and forward-only rollback
- Why the validator rejects `2026-02-31` but `type: "date"` does not

**Honest answers to give**

- **"Have you deployed it?"** No. Deployment readiness is documented and the
  guards were verified locally, but no deployment has occurred and rollback has
  never been performed.
- **"Does the Gemini integration work?"** The consent gate and the application
  boundary are proven. No live model call has ever succeeded — no credential has
  ever worked.
- **"What's the test coverage?"** 1,211 assertions across 17 backend suites.
  There is no coverage *percentage*, because I have not measured line or branch
  coverage and would rather say so than quote a number I have not produced.
- **"How does it scale?"** It is designed for a single process. The scheduler is
  in-process, and rate-limit counters are per process, so scaling out would need
  both addressed first. That constraint is documented rather than discovered
  later.
- **"What would you do next?"** Enforce room capacity (`max_queue` is stored but
  unused), audit-log privileged reads, replace the in-process scheduler, and get
  the pipeline approved and running.

---

## Scale of work

| | |
|---|---|
| Backend endpoints | 58 |
| Database | 23 tables, 8 enums, RLS on 16 tables, 18 migrations |
| Backend assertions | 1,211 across 17 suites |
| Frontend checks | 422 hook-check assertions (13 parts) |
| Documentation | API reference (verified against the router), deployment guide, security audit, CI/CD plan |
| Phases delivered | 0–19 |

---

## Accuracy statement

Every claim in this summary and in the accompanying documentation was verified by
running it. Specifically **not** claimed:

- No deployment has occurred.
- No live Gemini call has ever succeeded.
- No penetration test has been performed.
- No load or performance test has been run, and no performance metrics are quoted.
- No restore-from-backup drill has been performed, so RPO and RTO are undetermined.
- No test-coverage percentage is quoted, because none was measured.