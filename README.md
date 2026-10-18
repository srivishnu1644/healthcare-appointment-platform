<p align="center">
  <img src="client/public/logo-mark.svg" alt="BookMyDoc" width="100" />
</p>

# BookMyDoc v2 — Healthcare Appointment Platform

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

BookMyDoc addresses the three gaps that follow a booking:

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
- Swipe a notification **left** to remove it and **right** to toggle it between read
  and unread — both act the moment the finger lifts, with a timed undo for the
  destructive one
- Clear the whole inbox, or only the read half of it, from one menu
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

Two concurrent booking attempts resolve through the database, not through
application code: the loser receives `409 SLOT_TAKEN` from a constraint it cannot
bypass, and `npm run test:schema` proves each of those constraints actually fires
by attempting the violation and requiring PostgreSQL to refuse it.

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

`NotificationsContext` owns a single poller for the whole client — running only
while the tab is visible, never overlapping itself, and discarding stale
responses via a ticket. A component that needs no live notifications mounts no
poller at all.

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

### Read state toggles in both directions

`PATCH /api/notifications/:id/read` takes an optional `{ "read": boolean }`,
defaulting to `true`, so the bodyless call keeps its original meaning while a swipe
on a row the reader has already seen can send it back to the unread pile. One
`UPDATE` with a `CASE`, not two statements — and deliberately without
`AND read_at IS NULL`, which made "already read" indistinguishable from "not yours"
and answered 404 the second time anyone tapped a row that was already read.

### Notification ids are TEXT, and that is load-bearing

`notifications.id` is `text PRIMARY KEY DEFAULT gen_random_uuid()::text`. Rows the
application creates look like UUIDs, which is exactly what makes it tempting to
validate them as `uuid` — and wrong for any database that came through the JSON
import, which preserved every existing id verbatim (`notif_1`, `n-9f3ab21c`). The
inbox then rendered rows the API refused to act on: the client was holding an id
the validator had just seen in its own response, and rejected. The route validates a
bounded string instead; the value only ever reaches a bound parameter, so there is
nothing to inject either way.

### Removal is soft, and reversible

`DELETE /api/notifications/:id` stamps `deleted_at` rather than dropping the row,
and every inbox query skips stamped rows. Two reasons:

- **Undo is a real operation, not a decoration.** The client shows a timed undo;
  if the row were really deleted, that button would be a lie. Un-stamping is one
  `UPDATE`, and `POST /api/notifications/restore-all` puts a whole cleared inbox
  back.
- **The admin log stays honest.** A message being dismissed says nothing about
  whether it was sent, so `GET /api/admin/notifications` keeps dismissed rows and
  flags them.

The `dedupe_key` is deliberately NOT released by a dismissal: the event still
happened, so a retried booking must not be able to send the same message twice.

Bulk clear is `DELETE /api/notifications?scope=read|all`, scoped to the caller in
the `WHERE` clause like every other notification write.

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
`DISABLE_SCHEDULER=1` turns it off, which is what you want on every instance but
one if you ever run more than a single API process.

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
| Client state | React Context | Three contexts — auth, notifications, toasts — where a store library would be excess |
| Styling | Hand-written CSS with design tokens | No Tailwind, no component library |
| API | Node.js + Express | Small, well understood |
| Validation | Hand-written declarative middleware | No Zod/Joi |
| Database | PostgreSQL 16 | Needs transactions, row locks and constraints |
| Auth | JWT access tokens + rotating opaque refresh tokens | No session store |
| Tests | One standalone schema-verification script | No Jest/Supertest |

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

There is one automated suite, and it is deliberately unusual: instead of asserting
that valid input succeeds, it **attempts the violation and requires PostgreSQL to
refuse it**. A constraint that exists but does not fire is the failure mode this
catches, and it is the one an assertion on the happy path can never detect.

```bash
npm --prefix server run test:schema
```

It covers the structural claims (every table present, every enum created, RLS
enabled on *every* table, the hot query paths index-servable) and then the
behavioural ones: overlapping slots, double-booked appointments, double check-in,
cancellation without `cancelled_at`, and the seeded-data invariants. Fixtures are
created and removed by the suite, so it leaves no residue.

There is no unit-test framework and no mocking library. The value the constraints
and the transaction boundaries provide is that most of what a unit test would
mock here is a real database anyway.

---

## Database overview

**23 tables**, 8 enum types, and row-level security on every table — the anon key
can read the public directory and nothing else
(see [`supabase/README.md`](server/supabase/README.md)).

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
> silently, with no error anywhere to tell you it is off. Connect as the table
> owner, not `SUPERUSER`, and confirm with
> `SELECT rolsuper FROM pg_roles WHERE rolname = '<your role>';`

### Schema

The schema is a **single file** —
[`server/supabase/schema.sql`](server/supabase/schema.sql) — and it is the only
route to it. It is written for platforms whose entry point is a SQL editor
(Supabase, Neon, any hosted PostgreSQL) and for anyone who prefers one readable
artifact to a directory of migrations. Apply it once, to a **fresh** database:

```bash
npm run db:schema           # apply the single file to a FRESH database
```

The file records its own revision in `schema_migrations`, so re-running it is a
no-op and the applied state stays auditable. Applying it is **not reversible**;
to start over on a disposable database, drop the schema first:

```sql
DROP SCHEMA public CASCADE; CREATE SCHEMA public;
```

`db:schema` refuses to run against a database that already holds the schema, and
every statement in it is plain `CREATE`. **Later additions are therefore
self-applying**: `src/db/ensureSchema.js` asks `information_schema` what is missing
and applies only that, once per process, before the server accepts traffic. It runs
on every boot (`npm start`, `npm run dev`) and can be run by hand:

```bash
npm run db:ensure     # apply what is missing, then exit
```

Check first, DDL second. `ADD COLUMN IF NOT EXISTS` is idempotent but not free — it
takes an `ACCESS EXCLUSIVE` lock on the table even when it changes nothing — so a
steady-state restart issues no DDL and takes no lock on a live table.

It never throws. A role without DDL rights, or a slow catalogue query, produces a
loud warning naming the exact statement to run, and a server that still starts: a
boot that hangs on a slow database is indistinguishable from a crash. That is worth
stating plainly because this exists to fix one specific failure — a query naming a
column the database does not have is a **500**, and a 500 on the notification inbox
is indistinguishable from an inbox with nothing in it. One missing column emptied the
patient screen and the provider screen at once, with the data sitting there the whole
time.

### Supabase

The API reaches Supabase as ordinary PostgreSQL over `DATABASE_URL` — no client
library, no service-role key, nothing to rewrite. To stand a project up: create
it, put the **Session pooler** connection string in `server/.env`, then either
paste [`supabase/schema.sql`](server/supabase/schema.sql) into the SQL Editor or run
`npm run db:schema`. [`supabase/README.md`](server/supabase/README.md) covers the
connection-string pitfalls and the RLS model (the anon key reads the public
directory and nothing else).

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
createdb bookmydoc
psql bookmydoc -c "CREATE ROLE bookmydoc_app LOGIN PASSWORD 'local-only';"

# 2. point the API at it
export DATABASE_URL="postgresql://bookmydoc_app:local-only@localhost:5432/bookmydoc"
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
export CORS_ORIGIN="http://localhost:5173"

# 3. schema and demo data
npm --prefix server run db:schema
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

These are **published deliberately** as a demo convenience, which is exactly why
`npm run db:seed` must never be run against a production database — it would
create working accounts whose passwords are written above.

To be precise about what the application *does* enforce at boot: it refuses a
production start without a `JWT_SECRET`, with one under 32 characters, or with
one of a known list of placeholder secrets. It does **not** check these account
passwords, and the seed script has no production guard of its own. Seeding
production is prevented by procedure, not by code.

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
| `JWT_EXPIRES_IN` | `15m` | Access-token lifetime, as a duration string |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime |
| `JWT_ISSUER` | `bookmydoc-api` | Claim added to issued tokens |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `CORS_ORIGIN` | — | See above |

### Database

`DATABASE_URL` on its own is enough; the `DB_*` variables are only consulted when
`DB_HOST` is set.

| Variable | Default |
|---|---|
| `DATABASE_URL` | — (overrides all `DB_*`) |
| `DB_HOST` | — (no `DB_*` path when unset) |
| `DB_PORT` | `5432` |
| `DB_NAME` | `postgres` |
| `DB_USER` | `postgres` |
| `DB_PASSWORD` | — |
| `DB_SSL` | auto for any non-localhost host |
| `DB_POOL_MAX` | `10` |
| `DB_ALLOW_POOLED_QUERY_IN_TX` | off |

### Notifications (all optional)

`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
`RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, `NOTIFICATION_SWEEP_MINUTES`

Unset means delivery is **simulated**, and the API says so.

### AI (all optional)

`GEMINI_KEY`, `GEMINI_MODEL`, `ASSIST_MAX_PER_MINUTE` (60)

Unset means the assistant answers from the knowledge base only and triage uses
the local rule engine.

### Scheduler

`DISABLE_SCHEDULER=1` stops the in-process timer. Set it on every instance but
one if you ever run more than a single API process.

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
npm --prefix server run db:schema   # apply supabase/schema.sql (fresh database)
npm --prefix server run db:ensure   # apply any pending additive schema change
npm --prefix server run db:seed     # demo data
npm --prefix server run test:schema # verify every constraint actually fires
```

---

## Testing

The schema is verified by a suite that **proves the database rejects bad
states** — it attempts each violation and requires PostgreSQL to refuse it, then
cleans up after itself. Run it against a freshly seeded database:

```bash
npm --prefix server run db:seed
npm --prefix server run test:schema
```

It checks the structural claims (every table exists, every enum type was
created, RLS is enabled on *every* table, the hot query paths are index-servable)
and then the behavioural ones: overlapping slots, double-booked appointments,
double check-in, cancellation without `cancelled_at`, an appointment whose doctor
does not own its slot, and the daylight-sensitive seed invariants.

The seeded-data checks assert invariants about the *seed itself*, so run this
against a fresh database — fixtures left behind by other activity will fail four
of them with no defect involved.

---

## Documentation

| Document | Covers |
|---|---|
| [`server/supabase/README.md`](server/supabase/README.md) | Applying the schema to a hosted PostgreSQL |
| [`server/supabase/schema.sql`](server/supabase/schema.sql) | The complete schema, in one readable file |

---

## Deployment preparation

Nothing has been deployed. The steps below were checked by running them
locally against PostgreSQL 16.

**Verified locally:** production build, backend startup, health endpoint, refusal
to boot without a database, graceful `SIGTERM` shutdown, all four production
environment guards, applying `schema.sql` to an empty database, and scheduler
lifecycle.

**Not verified — and not claimed:** any deployment to a real host, TLS
termination, penetration testing, load performance, rollback, and recovery from a
real backup. RPO and RTO are undetermined.

### Running it in production

The API can serve the built client itself, so a small deployment is one Node
process in front of one PostgreSQL database.

```bash
# build the client — VITE_API_URL is baked in at BUILD time, so changing it
# needs a rebuild, not a restart
cd client && npm ci && VITE_API_URL=https://api.example.com/api npm run build

# start the API; it serves client/dist as well as /api
cd ../server && npm ci && NODE_ENV=production node index.js
```

Run it under a process supervisor. It handles `SIGINT` and `SIGTERM` itself and
gives in-flight requests 10 seconds to finish before exiting.

**Two constraints that bite:**

- **`VITE_API_URL` is baked into the bundle at build time.** A client built
  against a localhost API cannot be fixed at runtime — it needs rebuilding.
- **One process, or the scheduler runs twice.** The reminder sweep is in-process.
  If you run more than one API process, set `DISABLE_SCHEDULER=1` on all but one.

Put TLS termination in front of it, and create a database role that is **not**
`SUPERUSER` — see the RLS note under [Database overview](#database-overview).

### The schema is forward-only

Applying `schema.sql` is **not reversible** — it is plain `CREATE`, applied in one
transaction. Rollback of an **application** is supported as long as schema
changes are additive; rollback of a **schema** means restoring a backup.

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
- Row-level security on every table; the Supabase anon key reads only the
  public directory and holds no write privilege anywhere
- The assistant prompt carries the question and nothing else
- Triage consent enforced in the service, not the route
- AI turns recorded without user or appointment ids

**Rate limiting**
- Credentials 100 / 10 min; session operations 600 / 10 min
- Assistant 60 / min and triage 20 / min

> Automated checks are a floor, not a ceiling. **No penetration test has been
> performed.**

---

## Known limitations

| Limitation | Detail |
|---|---|
| **Scheduler is single-process** | An in-process timer. Two replicas means two sweeps. Disable it on all but one instance. |
| **Rate limits are per process** | N replicas allow N × the intended rate. |
| **External delivery is at-least-once** | Only in-app rows are exactly-once. |
| **Reminder timing is approximate** | At most one interval late, never early. |
| **Triage limiter keyed by IP** | Unlike the assistant limiter beside it. A clinic behind one NAT can throttle uninvolved patients. Found, documented, unfixed. |
| **AI output not moderated** | Labelled as machine-generated; no moderation service. |
| **No live model verified** | No credential has ever worked. |
| **Schema changes are forward-only** | `schema.sql` is plain `CREATE` applied in one transaction; there is no `down`. |
| **Privileged reads unlogged** | No audit trail of who read which patient's data. |
| **No MFA, lockout or CSRF** | Rate limiting only; CSRF safe while token-authenticated. |
| **RPO/RTO undetermined** | No restore drill performed. |

---

## Future improvements

**Correctness and scale**

- Replace the in-process scheduler with an external job runner, enabling multiple
  replicas
- Move rate-limit counters to a shared store so limits are global rather than
  per process
- Fix the triage limiter's IP keying to match the assistant limiter

**Security**

- Audit-log privileged reads of patient data
- Session invalidation on password change, and a global "sign out everywhere"
- Dependency scanning in CI
- Penetration testing by someone who has not read this codebase

**Product**

- Waiting-room estimates from recorded consultation durations, rather than a flat
  per-patient assumption
- Resend/cancel a reminder from the notification screen
- Doctor-facing analytics: no-show rate, utilisation over time
- Patient-facing reschedule by link, without signing in

**Operations**

- CI/CD — the deploy steps below are manual
- Structured log shipping with retention limits
- Backup automation with a verified restore drill

---

## Licence and demo data

This is a demonstration project. The demo accounts and their passwords are
published on purpose so the system can be explored. Nothing in the code prevents
those accounts being created in production — do not run `npm run db:seed` against
a real database. The seeded names, clinics and identifiers are fictional.
