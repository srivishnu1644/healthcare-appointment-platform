# MediCare v2 — Healthcare Appointment Platform

A patient-centric healthcare appointment platform: discover doctors, check live
availability, book, reschedule and cancel appointments, check in to a live
waiting room, and receive in-app notifications — with provider scheduling tools
and an administrative operations dashboard.

Built as a single **monolith**: one React client, one Express API, one
PostgreSQL database. No microservices, no message broker, no cache tier, no
container orchestration, and no API keys required.

---

## Contents

- [Problem statement](#problem-statement)
- [Features](#features)
- [The three workflows](#the-three-workflows)
- [Appointment scheduling](#appointment-scheduling)
- [Queue management](#queue-management)
- [Notification system](#notification-system)
- [The AI assistant](#the-ai-assistant)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Database overview](#database-overview)
- [Installation](#installation)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Development commands](#development-commands)
- [Testing](#testing)
- [Documentation](#documentation)
- [Deployment preparation](#deployment-preparation)
- [Security features](#security-features)
- [Known limitations](#known-limitations)
- [Future improvements](#future-improvements)

---

## Problem statement

Booking a medical appointment is easy; everything **after** booking is not.

A patient who books for 11:00 arrives at 10:45 and nobody knows they are there.
Two patients with 11:00 and 11:30 appointments are waiting for the same doctor,
but each one's confirmation implies they will be seen next. Nobody can answer
"how long is the wait?" — and if they are asked to find out, they are phoned.

Meanwhile the clinic has no view of what is happening right now: who is waiting,
which rooms are long, whether the reminder messages actually went out.

MediCare addresses the three gaps that follow a booking:

1. **Waiting is invisible.** A waiting room per provider per clinic day, with a
   computed position, visible to the patient and to the provider.
2. **Notifications are unreliable.** Deduplication enforced by the database
   rather than by a check that two concurrent requests can both pass.
3. **Operations are blind.** A dashboard showing what is happening now, not what
   happened last quarter.

---

## Features

**For patients**

- Register and sign in; refresh tokens rotate on use and reuse revokes the session
- Browse and filter doctors by specialty, city, facility and fee
- See real availability and book, reschedule or cancel
- Check in on arrival and get a live position in the waiting room
- Read in-app notifications and mark them read individually or all at once
- Ask the assistant how the system works
- Optionally triage symptoms — **only with explicit consent**

**For doctors**

- Generate and manage slots, including blocking time
- See the day's appointments and the live waiting room
- Call the next patient; complete the consultation; record a no-show
- Read notifications

**For administrators**

- Operational dashboard: KPIs, trend, specialty mix, live queue, notification
  delivery and scheduler state
- Cross-clinic appointment search with filtering, sorting and pagination
- Waiting-room monitoring across every provider
- Doctor directory and management, provider capacity by day
- Patient directory, privacy-conscious by construction
- Facility and service management
- Notification dispatch log and background-pass health

---

## The three workflows

### Patient

```
sign in -> browse doctors -> see availability -> book
       -> receive notification -> travel to clinic
       -> check in -> see live position -> get called -> consultation
       -> see updated status -> read follow-up notification
```

Every step the patient takes is scoped to their own records. They cannot see
another patient's appointment, another patient's queue position, or the room's
total headcount — a field that reads like "the room" but means "just you" gets
misread, so it is omitted rather than zeroed.

### Doctor

```
sign in -> set availability for a day
       -> see today's appointments
       -> watch the waiting room fill
       -> call next -> consultation -> complete or record a no-show
```

Calling "next" is idempotent: while somebody is in consultation, calling again
returns that same patient. A double click, a retry or two open browsers cannot
skip anyone in the line.

### Administrator

```
sign in -> dashboard: KPIs, live rooms, outbox, scheduler
       -> appointments: search across every clinic, filter, export the view
       -> waiting rooms: see who is waiting where
       -> directories: doctors, patients, facilities, services
       -> operations: notification log, background-pass health
```

The administrative surface over appointments is deliberately **read-only**. A
status change goes through `PATCH /api/appointments/:id/status` — the same
endpoint a provider uses — so the ownership, transition and room-lock rules
apply identically. There is no admin path that writes an appointment.

---

## Appointment scheduling

### Statuses

```
scheduled ──> confirmed ──> in-progress ──> completed
    │             │              │
    └─────────────┴──────────────┴──> cancelled | no-show
```

`completed`, `cancelled` and `no-show` are terminal. The transition table lives in
`bookingService.js` and governs **every** path, including cancellation — there is
no second copy of the rules.

### Conflict protection

Booking is the most heavily constrained operation. It runs in one transaction
that takes a row lock on the slot and re-reads it, so two patients racing for the
same slot produce exactly one `201` and one `409 SLOT_TAKEN`.

Three further rules are enforced by the **schema**, not by application code:

- a slot cannot hold two active appointments;
- a patient cannot hold two overlapping appointments;
- a status change cannot escape the transition table.

Two concurrent booking attempts are asserted by the test suite, not merely
described.

### A lesson worth recording

An early version handled duplicate insertion by catching PostgreSQL error
`23505` and ignoring it. That is wrong: a failed statement **aborts the
surrounding transaction**, so the booking was rolled back at `COMMIT` while the
API reported success. Duplicate suppression now uses `ON CONFLICT DO NOTHING`,
which returns `null` and leaves the transaction intact.

---

## Queue management

### A room is `(doctor_id, clinic_date)`

Patients hold separate slots but wait for the same person, so their order comes
from **when they arrived**, not from which slot they hold.

- **Positions are computed**, with `row_number()` over the waiting set ordered by
  `joined_at ASC, id ASC`. They start at 1, stay contiguous, and renumber the
  moment anyone leaves. There is no stored counter to compact, so there is no way
  to leave a gap.
- **Position 1 is next.** The patient in consultation is excluded from the
  ranking and returned separately as `activeConsultation`, so "you are 2nd" never
  silently changes meaning.
- `queue_entries.position` survives as a **legacy per-slot number**. It is still
  written and still constrained, and is **never** used to rank the room.

### Locking

Every operation that touches a room takes the room's transaction-scoped advisory
lock **first**, then the appointment row, then the slot row. Check-in, call-next,
reschedule, cancellation and status changes all mutate queue entries, so all five
follow that order; booking touches no queue row and never asks for the lock.

Taking the advisory lock *after* a row lock would invert against those paths and
let them deadlock, which is why the order is enforced rather than merely
documented. A partial unique index on
`(doctor_id, clinic_date) WHERE state = 'in-consultation'` is the structural
backstop underneath the application logic.

### Updates

`QueueContext` owns a single poller for the whole client — running only while the
tab is visible, never overlapping itself, and discarding stale responses via a
ticket. A component that needs no live queue mounts no poller at all.

---

## Notification system

### Events

`appointment_booked`, `appointment_rescheduled`, `appointment_cancelled`,
`appointment_reminder`, `queue_joined`, `queue_called`, `queue_cleared`,
`consultation_completed`.

### Deduplication is a database constraint

A **partial unique index** on `notifications.dedupe_key`, not an application
check. Two concurrent transactions can both read "not sent yet" and both commit —
only the database can prevent that.

Dedupe discriminators preserve genuine repeats: the destination slot for a
reschedule, the start time for a reminder, the call time for a queue call.

### Delivery

`notification_outbox` is drained by a background pass with a five-minute backoff
and five-attempts-per-day abandonment. Every pass is recorded to
`notification_sweeps`.

**Delivery to an external provider is at-least-once.** Only in-app rows are
exactly-once, via the dedupe index. Without `TWILIO_ACCOUNT_SID` or
`RESEND_API_KEY`, notifications are still recorded and the API reports
`channels.simulated: true` so the client can show an honest "not delivered"
badge rather than implying a message was sent.

### The scheduler

In-process, roughly every 15 minutes, **single-process and best-effort**.
`DISABLE_SCHEDULER=1` turns it off; the test suites assert that it is off rather
than assuming it.

Reminder timing is approximate: at most one interval late, never early.

---

## The AI assistant

### Two different things

**Application help** — how to book, reschedule, cancel, check in, what a queue
position means, where notifications are, what a consultation costs. These answers
come from a reviewed knowledge base in `assistantKnowledge.js`.

**General healthcare information** — the only case where a model is consulted.

### Two boundaries enforced before any model call

1. **The prompt carries the question and nothing else.** No user id, no email, no
   appointment id, no patient data.
2. **Injection is refused at the application boundary.** Prompt-injection
   patterns are matched against the question; a match returns a refusal without
   the model being consulted.

The assistant has no access to patient data. Model output is never treated as
authorisation.

### Triage consent

Sending a symptom description to a third-party service requires explicit consent,
enforced inside `analyzeSymptoms` rather than at the route — so no other caller
can skip it. Without consent:

```
HTTP 428 Precondition Required
{ "error": { "code": "CONSENT_REQUIRED" } }
```

428 rather than 400 on purpose: nothing is wrong with the request, a precondition
is unmet.

With no model configured, triage falls back to a **local rule-based** engine and
consents to nothing, because nothing leaves the machine.

### Honest status

> **No live Gemini call has ever succeeded in this project.** No credential is
> configured in any environment. A placeholder key was used only to prove the
> consent gate fires. `GET /api/ai/assist` reports `modelAvailable` honestly.

---

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Client | React + Vite | Fast builds; no UI framework dependency |
| Client routing | React Router | Standard |
| Client state | React Context | Two contexts (auth, queue) — a store library would be excess |
| Styling | Hand-written CSS with design tokens | No Tailwind, no component library |
| API | Node.js + Express | Small, well understood |
| Validation | Hand-written declarative middleware | No Zod/Joi |
| Database | PostgreSQL 16 | Needs transactions, row locks and constraints |
| Auth | JWT access tokens + rotating opaque refresh tokens | No session store |
| Tests | Hand-written assertion suites over `node:test`-style runners | No Jest/Supertest |

**Deliberately absent:** Docker, Kubernetes, Redis, Kafka, GraphQL, MongoDB,
Convex, Tailwind, Zod, Jest, Supertest, TanStack Query, Swagger/OpenAPI,
WebSockets, SSE.

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

| Layer | Responsibility | Must not |
|---|---|---|
| **Routes** | Path, role gate, validation rules | Contain business logic |
| **Controllers** | HTTP ⇄ service calls, error translation | Write to the database |
| **Services** | Business rules, transaction boundaries | Build SQL |
| **Repositories** | All SQL, always parameterised | Contain business rules |

### Transactions

`withTransaction(fn)` propagates an explicit transaction context through the call
chain, so a service calling another service **joins** the caller's transaction
rather than opening a second one against the same rows.

### Testing approach

The suites are hand-written assertions, not a framework. The discipline that
matters is **non-vacuity**: several tests were found to be passing for the wrong
reason during development and rewritten. Specifically:

- An injection test reloaded the page after dispatching, killing the in-flight
  request — it asserted on nothing.
- A visibility measurement zeroed its counter after dispatching, so it could only
  ever observe zero.
- Four database cast bugs were found by asking what a `500` means, then written
  as "no malformed input may produce a 5xx".

---

## Database overview

**23 tables**, 18 forward-only migrations, 8 enum types, and row-level security
enabled on 16 tables.

### Core tables

| Table | Holds |
|---|---|
| `users`, `refresh_tokens` | Identity and rotating sessions |
| `patient_profiles`, `patient_allergies` | Patient detail and sensitivities |
| `specialties`, `facilities`, `services` | Reference data |
| `doctors`, `doctor_services`, `doctor_languages` | Provider profile |
| `slots` | Bookable time, with status and capacity |
| `appointments`, `appointment_status_history` | The booking and its lifecycle |
| `queue_entries` | Waiting-room membership |
| `notifications`, `notification_deliveries`, `notification_outbox`, `notification_sweeps` | Notification lifecycle |
| `triage_sessions`, `ai_assistant_turns`, `audit_logs` | AI and audit trails |
| `seed_metadata`, `schema_migrations` | Bookkeeping |

### Enumerated types

`user_role`, `appt_status`, `slot_status`, `consult_mode`, `queue_state`,
`notify_channel`, `delivery_status`, `cancelled_by_role`

### What the database enforces

- A slot cannot hold two active appointments
- A patient cannot hold two overlapping appointments
- Status changes cannot escape the transition table
- `notifications.dedupe_key` is unique where present (partial unique index)
- One `in-consultation` entry per `(doctor_id, clinic_date)`
- Row-level security isolates patient-owned rows

> **RLS requires a non-superuser database role.** A superuser bypasses it
> silently. See the deployment guide.

### Migrations

Forward-only. There is no `down` migration, and `db:migrate:reset` is
`DROP SCHEMA CASCADE`. **Nothing here should be described as reversible.**

```bash
npm run db:migrate:status    # applied and pending
npm run db:migrate           # apply
npm run db:migrate:reset     # DROP SCHEMA CASCADE + reapply - destroys all data
```

---

## Installation

**Requirements:** Node.js 20+, npm 10+, PostgreSQL 14+ (developed against 16).

```bash
npm --prefix server install
npm --prefix client install
```

No global tooling, no database container, no API keys.

---

## Local setup

```bash
# 1. a PostgreSQL database
createdb medicare
psql medicare -c "CREATE ROLE medicare_app LOGIN PASSWORD 'local-only';"

# 2. point the API at it
export DATABASE_URL="postgresql://medicare_app:local-only@localhost:5432/medicare"
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
export CORS_ORIGIN="http://localhost:5173"

# 3. schema and demo data
npm --prefix server run db:migrate
npm --prefix server run db:seed

# 4. run
npm --prefix server run dev     # API   -> http://localhost:5000
npm --prefix client run dev     # client -> http://localhost:5173
```

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Patient | `patient@demo.com` | `patient123` |
| Patient | `ishita@demo.com` | `patient123` |
| Patient | `aman@demo.com` | `patient123` |
| Doctor | `doctor1@demo.com` | `doctor123` |
| Doctor | `doctor2@demo.com` | `doctor123` |
| Admin | `admin@demo.com` | `admin123` |

These are **published deliberately** as a demo convenience. They are rejected as
production secrets: the application refuses to boot with them.

---

## Environment variables

### Required in production

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Signs access tokens. ≥ 32 characters, identical on every instance. |
| `CORS_ORIGIN` | Comma-separated allowed origins. |
| `DATABASE_URL` | Connection string. |

### Server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | |
| `NODE_ENV` | — | `production` enables the strict boot checks |
| `APP_TIMEZONE` | `Asia/Kolkata` | The clinic's business timezone |
| `JWT_EXPIRES_IN` | `900` | Access-token seconds |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | |
| `JWT_ISSUER` | — | Claim added to issued tokens |
| `BCRYPT_ROUNDS` | `12` | |
| `CORS_ORIGIN` | — | |

### Database

| Variable | Default |
|---|---|
| `DATABASE_URL` | — (overrides all `DB_*`) |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` |
| `DB_NAME` / `DB_USER` | `medicare` / `postgres` |
| `DB_PASSWORD` | — |
| `DB_SSL` | — |
| `DB_POOL_MAX` | `10` |
| `DB_ALLOW_POOLED_QUERY_IN_TX` | `0` |

### Notifications (all optional)

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
`RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_SWEEP_MINUTES`

Unset means delivery is **simulated**, and the API says so.

### AI (all optional)

`GEMINI_KEY`, `GEMINI_MODEL`, `ASSISTANT_ADAPTER`, `ASSIST_MAX_PER_MINUTE` (60)

Unset means the assistant answers from the knowledge base only and triage uses
the local rule engine.

### Scheduler

`DISABLE_SCHEDULER=1` stops the in-process timer. The suites assert it is off.

---

## Development commands

```bash
# API
npm --prefix server run dev           # watch mode
npm --prefix server start             # node index.js

# Client
npm --prefix client run dev
npm --prefix client run build         # production bundle
npm --prefix client run preview

# Database
npm --prefix server run db:migrate
npm --prefix server run db:migrate:status
npm --prefix server run db:migrate:reset   # DESTRUCTIVE
npm --prefix server run db:seed
npm --prefix server run db:purge-sessions
```

---

## Testing

Every suite is a standalone script under `server/scripts` — 17 suites,
1,211 assertions in total. Run them **one at a
time**: the auth rate limiter is per process (100 logins / 10 min), so concurrent
suites produce spurious `429`s.

```bash
cd server

npm run test:security      # authz, injection, IDOR, leakage
npm run test:auth          # registration, login, refresh rotation, RBAC
npm run test:directory     # public reference data
npm run test:slots         # generation, availability, blocking
npm run test:flow          # doctor workflow
npm run test:appointments  # booking, conflicts, concurrency, transitions
npm run test:queue         # check-in, positions, call-next, locks
npm run test:room          # waiting-room model and privacy scoping
npm run test:notifications # events, dedupe, claims, outbox, reads
npm run test:assistant     # knowledge base, injection, consent, rate limit
npm run test:admin         # role restrictions, visibility, filters
npm run test:validation    # input validation and error contracts
npm run test:audit         # Phase 18 security audit
npm run test:integration   # the 14-step end-to-end walkthrough
npm run test:docs          # documentation against the live router
npm test                   # smoke
npm run test:schema        # database invariants
```

### Two ordering rules that matter

1. **Restart the API between suites.** The rate limiter is per process.
2. **`test:schema` runs against a freshly seeded database.** Several of its
   checks assert invariants about the *seed data* — a finished appointment is
   never on a future slot, and the recorded booked-slot count matches reality.
   Running the behavioural suites first leaves fixtures that violate them, and
   four checks fail with no defect involved.

### Frontend

The hook checks need **two** servers and the distinction matters:

- the **dev server** serves `checks.html`, the harness page that mounts the real
  hooks;
- the **production preview** serves the built app the checks drive.

`HARNESS_URL` defaults to `APP_URL`, so setting only `APP_URL` to the preview
points the harness at a server that answers `/checks.html` with the SPA
fallback, and the run dies in a timeout that looks like a broken harness. The
harness now detects this and says so.

```bash
# terminal 1 - the API
npm --prefix server run dev

# terminal 2 - the production preview (the app the checks drive)
npm --prefix client run build
npm --prefix client run preview

# terminal 3 - the dev server, which serves the harness page only
npm --prefix client run dev -- --port 5174

# then, from the repository root
HARNESS_URL=http://localhost:5174 \
APP_URL=http://localhost:4173 node scripts/hook-checks.mjs

PART=12 node scripts/hook-checks.mjs   # run a single part while iterating
```

---

## Documentation

| Document | Covers |
|---|---|
| [`docs/API.md`](docs/API.md) | All 58 endpoints, with auth, roles, parameters, examples and errors |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Deployment guide, verified/not-verified table, backup and recovery |
| [`docs/CI-CD-PLAN.md`](docs/CI-CD-PLAN.md) | Proposed pipeline — **pending approval, not implemented** |
| [`docs/security-audit-phase18.md`](docs/security-audit-phase18.md) | Phase 18 findings: fixed, tested, unverified, deferred |
| [`docs/RESUME.md`](docs/RESUME.md) | Resume-ready project summary |

The API reference is checked by `npm run test:docs`, which parses it against the
live Express router: every documented endpoint must exist, every route must be
documented, and every error code it promises must exist in the source.

---

## Deployment preparation

Nothing has been deployed. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the
full guide and the explicit verified / not-verified table.

**Verified locally:** production build, backend startup, health endpoint, refusal
to boot without a database, graceful `SIGTERM` shutdown, all four production
environment guards, migration from empty, and scheduler lifecycle.

**Not verified — and not claimed:** any deployment to a real host, TLS
termination, penetration testing, load performance, rollback, and recovery from a
real backup. RPO and RTO are undetermined.

### Migrations are forward-only

There is no `down` migration. `db:migrate:reset` is `DROP SCHEMA CASCADE`. Rollback
of an **application** is supported as long as migrations are additive; rollback of
a **schema** means restoring a backup.

---

## Security features

**Authentication**
- bcrypt password hashing; repositories never select the hash column
- Short-lived JWT access tokens; opaque refresh tokens rotated on every use
- Refresh-token reuse revokes the entire session
- The `alg: none` bypass is rejected
- Production boot refuses a missing, short or known-placeholder secret

**Authorization**
- Role gates on every admin route, applied once on the router
- Appointment ownership checked by middleware, before the handler
- The admin surface over appointments is read-only
- Queue responses are scoped: a patient sees only themselves

**Input and output**
- Parameterised SQL everywhere; sort keys matched against a whitelist
- Declarative validation with real date and UUID checks
- Errors return a generic message; no stack, SQL or path reaches the client
- `stripSecrets` runs as a second pass on the patient directory

**Data protection**
- Row-level security on 16 tables
- The assistant prompt carries the question and nothing else
- Triage consent enforced in the service, not the route
- AI turns recorded without user or appointment ids

**Rate limiting**
- Credentials 100 / 10 min; session operations 600 / 10 min
- Assistant 60 / min and triage 20 / min

Full findings, including **nine unverified risks**, are in
[`docs/security-audit-phase18.md`](docs/security-audit-phase18.md).

> Automated checks are a floor, not a ceiling. **No penetration test has been
> performed.** See §3 of the Phase 18 audit.

---

## Known limitations

| Limitation | Detail |
|---|---|
| **Scheduler is single-process** | An in-process timer. Two replicas means two sweeps. Disable it on all but one instance. |
| **Rate limits are per process** | N replicas allow N × the intended rate. |
| **External delivery is at-least-once** | Only in-app rows are exactly-once. |
| **Reminder timing is approximate** | At most one interval late, never early. |
| **Room capacity not enforced** | `slots.max_queue` is stored but not applied. Deliberately deferred rather than half-implemented. |
| **Triage limiter keyed by IP** | Unlike the assistant limiter beside it. A clinic behind one NAT can throttle uninvolved patients. Found, documented, unfixed. |
| **AI output not moderated** | Labelled as machine-generated; no moderation service. |
| **No live model verified** | No credential has ever worked. |
| **Migrations forward-only** | No `down`; reset is destructive. |
| **Privileged reads unlogged** | No audit trail of who read which patient's data. |
| **No MFA, lockout or CSRF** | Rate limiting only; CSRF safe while token-authenticated. |
| **RPO/RTO undetermined** | No restore drill performed. |

---

## Future improvements

**Correctness and scale**

- Enforce `slots.max_queue` so a room cannot exceed its configured capacity
- Replace the in-process scheduler with an external job runner, enabling multiple
  replicas
- Move rate-limit counters to a shared store so limits are global rather than
  per process
- Fix the triage limiter's IP keying to match the assistant limiter

**Security**

- Audit-log privileged reads of patient data
- Session invalidation on password change, and a global "sign out everywhere"
- Dependency scanning in CI once CI/CD is approved
- Penetration testing by someone who has not read this codebase

**Product**

- Waiting-room estimates from recorded consultation durations, rather than a flat
  per-patient assumption
- Resend/cancel a reminder from the notification screen
- Doctor-facing analytics: no-show rate, utilisation over time
- Patient-facing reschedule by link, without signing in

**Operations**

- CI/CD, once approved — the pipeline design is already documented
- Structured log shipping with retention limits
- Backup automation with a verified restore drill

---

## Licence and demo data

This is a demonstration project. The demo accounts and their passwords are
published on purpose so the system can be explored, and the application refuses
to start in production with those values as secrets. The seeded names,
clinics and identifiers are fictional.