# Healthcare Appointment Platform

A patient-centric healthcare appointment prototype: discover doctors, check live
availability, book / reschedule / cancel appointments, and track status — with
AI-assisted recommendations, provider scheduling tools, and an admin analytics
dashboard.

Built as a **working prototype** (React + Express, in-memory datastore), no
external services or API keys required.

---

## Quick start

Two terminals, from the project root.

```bash
# 1) API server  -> http://localhost:5000
cd server
npm install
npm run dev

# 2) Web client  -> http://localhost:5173
cd client
npm install
npm run dev
```

Open **http://localhost:5173**.

Verify the API end-to-end (with the server running):

```bash
cd server
npm test              # 35 assertions across auth, discovery, booking, AI, admin
```

> The datastore is PostgreSQL. `server/.env` points at it; see
> `server/.env.example`. `npm run db:migrate` applies migrations and
> `npm run db:seed` loads the demo data.

---

## Verifying the build

Two kinds of check live here, and they need different things running.

**Browser checks** drive the real production bundle with Playwright. They need
the API up on `:5000`, a production build, and the two servers below:

```bash
# terminal 1 - the API
cd server && npm run dev            # http://localhost:5000

# terminal 2 - the production preview (the app the browser checks drive)
cd client && npx vite preview --port 4173

# terminal 3 - the dev server, which serves the harness page only
cd client && npx vite dev --port 5174
```

Then, from the repository root:

| Command | What it covers |
| --- | --- |
| `npm run test:client` | Hooks, notifications, directory, dashboard, appointment card, detail, booking, reschedule, lazy routes, error boundary |
| `npm run test:routing` | Route guards, per-role landing pages, redirects, direct loads and refreshes |
| `npm run test:walkthrough` | A full click-through of the patient journey, with screenshots |
| `npm test` | All three of the above, in that order |

Both browser runners honour `APP_URL`, `HARNESS_URL` and `TZ`. `test:client`
additionally needs `HARNESS_URL` on the **dev** server, because only the dev
server transforms JSX for `checks.html`.

**Backend suites** run against the API on `:5000` from `server/`:

| Command | What it covers |
| --- | --- |
| `npm --prefix server run test` | Smoke: auth, discovery, booking, AI, admin |
| `npm --prefix server run test:auth` | Registration, sign-in, refresh rotation |
| `npm --prefix server run test:security` | Authorization and input handling |
| `npm --prefix server run test:directory` | Doctor directory and filters |
| `npm --prefix server run test:slots` | Slots, availability, timezone |
| `npm --prefix server run test:appointments` | Booking, conflicts, lifecycle, check-in |
| `npm --prefix server run test:queue` | Queue positions, ordering, authorization |
| `npm --prefix server run test:room` | The Phase 9 waiting room, deterministically |
| `npm --prefix server run test:notifications` | Every event, duplicates, privacy, reminders |
| `npm --prefix server run test:assistant` | Capabilities, injection, limits, no credentials |
| `npm --prefix server run test:flow` | One patient's visit, end to end, from the doctor |
| `npm --prefix server run test:schema` | Migrations are applied and consistent |
| `npm --prefix server run test:all` | Schema, queue and appointment suites |

`test:flow` walks the whole visit in order — sign in, open the workspace, open a
slot, a patient books it, check in once it has started, the patient appears in
the doctor's queue, the doctor completes it, and the schedule and queue both
reflect that. It asserts the refusals on the way too, so "it worked" means
something: an illegal transition, a second patient checking in on someone else's
visit, and another doctor reaching in are all expected to fail.

`test:room` builds the situation the old per-slot model got wrong — three patients
holding three *different* slots with the same doctor, all checked in — and drives the
room through its whole life: ranks, call-next, a completion, a no-show, a
cancellation, and a call-next racing itself. It asserts computed positions rather
than the stored ones, and it is deterministic: it builds its own clock and its own
fixtures instead of waiting for the seed to be in a convenient state.

`test:queue` checks patients in through the real endpoint. A queue entry only
exists for a slot that has already started, so when the seed happens to leave
none check-in-able it opens a slot in the next free window and waits for it;
`QUEUE_CHECK_MAX_WAIT_MS` bounds that wait, and the checks are **skipped with a
printed reason** rather than silently passing if the bound is exceeded.

**Re-running.** `test:appointments` and `test:slots` insert real rows, so they
remove their own fixtures when they finish (and on the crash path too). That
makes them repeatable against the same database. The auth rate limiter counts
logins per process, so restart the API between heavy suites if you see 429s.

Each section of `test:appointments` needs fixture patients that no other section
has booked. Every fixture sits at a controlled instant around "now", so two
sections that happen to land on overlapping times would collide and the loser
would be refused with `PATIENT_CLASH` — a clash between two fixtures, not the
rule under test. That is why the run creates five throwaway patients rather than
three and hands each section its own pair.

`test:security` also books a real appointment, because check-in cannot be
asserted against a fixture row. It needs a slot dated today that has already
started, which depends on the hour, so it prefers a slot an earlier run left
behind, opens one in the earliest free window if there is none, and cancels the
appointment when it finishes — otherwise the patient would clash with the next
suite. It is therefore repeatable, and it leaves at most one slot behind.

`scripts/hook-checks.mjs` creates two slots per run to exercise slot creation
and has no delete endpoint to undo them with. It reads the free windows of each
day from the API and walks to the next date when a day fills up, so it stays
green across repeated runs, but a long-lived local database does accumulate
slots from it.

Its queue checks run twice, in two separate parts. The provider part books **two**
appointments and checks both patients in, because an ordering assertion over one
row proves nothing. The Phase 9 part books **three** — three different slots, one
doctor — and walks the room through its whole life: call-next, a repeated
call-next, two call-nexts racing each other, a completion, a no-show and a
cancellation. Everything it creates is cancelled in a `finally`, which returns the
slots to `available` so the next run reuses them.

Run one part on its own while iterating with `PART=12` (the Phase 9 part) or any
other part number; the whole suite is quick, but a single part is quicker.

Completed appointments are the exception to that cleanup: `completed` is a
terminal status with no transition back, and no endpoint deletes an appointment,
so a completed one stays in the day's queue for the rest of the day. That is
intended — a finished visit is history — and it is why the patient-facing payload
picks the caller's *live* entry rather than the first one that matches. Both parts
stop the morning from running out of check-in-able slots, at which point
`test:appointments` reports that the day is full and needs a fresh database —
recreate with `db:migrate` and `db:seed` rather than treating it as a failure.

The suites that assert seed invariants (`test:schema`) want a database that has
not been used by the others, so point `DATABASE_URL` at a fresh one:

```bash
createdb medicare_schema_verify
DATABASE_URL=... node server/src/db/migrate.js
DATABASE_URL=... node server/src/db/seed.js
DATABASE_URL=... npm --prefix server run test:schema
```

---

## Demo accounts

| Role    | Email                                    | Password     |
| ------- | ---------------------------------------- | ------------ |
| Patient | `patient@demo.com`                       | `patient123` |
| Patient | `ishita@demo.com`                        | `patient123` |
| Patient | `aman@demo.com`                          | `patient123` |
| Doctor  | `doctor1@demo.com` … `doctor12@demo.com` | `doctor123`  |
| Admin   | `admin@demo.com`                         | `admin123`   |

Sign in as each role to see the role-specific dashboards.

---

## Tech stack

**Client** — React 18, React Router 6, Vite 5. No UI framework; styling is a
hand-written design system in `client/src/styles/index.css`.

**Server** — Node.js, Express 4, JWT auth (`bcryptjs` + `jsonwebtoken`),
`express-rate-limit` on credential routes, `cors`, `morgan`.

**Data** — in-memory store with JSON file persistence
(`server/src/config/db.js`). No external database, so the prototype runs
anywhere. Swapping in MongoDB means replacing that one module.

**AI** — a deterministic, rule-based symptom triage engine
(`server/src/services/aiService.js`). No external LLM key needed; it maps
symptoms → urgency, suggested departments, and ranked doctors.

---

## Project layout

```
healthcare-appointment-platform/
├── client/
│   └── src/
│       ├── api/client.js          # typed fetch wrapper, token handling
│       ├── components/            # Layout, DoctorCard, SymptomChecker, ui primitives
│       ├── context/               # AuthContext, ToastContext
│       ├── hooks/                 # useNotifications (shared unread badge)
│       ├── pages/                 # patient + provider screens
│       │   └── admin/             # 5 admin screens
│       ├── styles/index.css       # design tokens + components
│       └── utils/format.js
└── server/
    ├── index.js                   # entry point
    ├── scripts/smoke.js           # end-to-end API test suite
    └── src/
        ├── app.js                 # express app wiring
        ├── config/                # env, db + seed data
        ├── controllers/           # auth, doctor, appointment, ai, notification, admin
        ├── middlewares/           # auth, validation, error handler
        ├── routes/                # one router per domain
        ├── services/              # appointment/slot logic, ai, notifications
        └── utils/                 # logger, response envelope
```

---

## Features, mapped to the brief

| Deliverable                                                         | Where it lives                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Registration & profile management                                   | `pages/Register.jsx`, `pages/Profile.jsx`, `PATCH /api/auth/me`             |
| Doctor & facility discovery                                         | `pages/DoctorDirectory.jsx`, `GET /api/doctors`                             |
| Search & filter by specialty / location / availability / fee / mode | `GET /api/doctors` filters + `DoctorDirectory` controls (synced to the URL) |
| Doctor profile & service info                                       | `pages/DoctorProfile.jsx`, `GET /api/doctors/:id`                           |
| Real-time (simulated) slot availability                             | `server/src/services/appointmentService.js`, `GET /api/doctors/:id/slots`   |
| Booking, rescheduling, cancellation                                 | `pages/MyAppointments.jsx`, `POST/PATCH /api/appointments`                  |
| AI-assisted recommendations                                         | `components/SymptomChecker.jsx`, `POST /api/ai/triage`                      |
| Appointment reminders & notifications                               | `services/notificationService.js`, `pages/Notifications.jsx`                |
| Appointment history & status tracking                               | `pages/MyAppointments.jsx` with status chips + timeline                     |
| Provider scheduling dashboard                                       | `pages/ProviderDashboard.jsx`, `GET /api/doctors/me/schedule`               |
| Admin dashboard (doctors, facilities, services, slots)              | `pages/admin/*`                                                             |
| Queue / waiting-time info                                           | `GET /api/appointments/queue`, check-in flow                                |
| Analytics (appointments, cancellations, no-shows, utilisation)      | `pages/admin/AdminDashboard.jsx`, `GET /api/admin/overview`                 |
| Secure handling of patient data                                     | JWT + bcrypt, role-based `requireRole` guards, field-whitelisted responses  |

---

## API reference

All responses use the envelope `{ success, message, data }`.

### Auth — `/api/auth`

| Method | Path        | Access                |
| ------ | ----------- | --------------------- |
| POST   | `/register` | public (rate-limited) |
| POST   | `/login`    | public (rate-limited) |
| GET    | `/me`       | any signed-in user    |
| PATCH  | `/me`       | any signed-in user    |

### Doctors — `/api/doctors`

| Method     | Path                                       | Access                                                                                                              |
| ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| GET        | `/specialties`, `/services`, `/facilities` | public                                                                                                              |
| GET        | `/recommended`                             | public (personalised when signed in)                                                                                |
| GET        | `/`                                        | public — filters: `search`, `specialty`, `city`, `maxFee`, `minRating`, `language`, `mode`, `acceptingOnly`, `sort` |
| GET        | `/:id`, `/:id/slots`                       | public                                                                                                              |
| GET        | `/me/schedule`                             | doctor                                                                                                              |
| POST/PATCH | `/:id/slots`, `/:id/slots/:slotId`         | doctor, admin                                                                                                       |

### Appointments — `/api/appointments`

| Method | Path                                            | Access                                           |
| ------ | ----------------------------------------------- | ------------------------------------------------ |
| GET    | `/`                                             | signed-in (patient → own; doctor → own schedule) |
| GET    | `/:id`                                          | owner / doctor / admin                           |
| POST   | `/`                                             | patient                                          |
| PATCH  | `/:id/reschedule`, `/:id/cancel`, `/:id/status` | owner (doctor for status)                        |
| POST   | `/:id/check-in`                                 | patient                                          |
| GET    | `/queue`, `/availability`                       | signed-in                                        |
| POST   | `/queue/next`                                   | the assigned doctor (or admin)                   |

`GET /queue` returns the waiting room: `clinicDate`, `waitingCount`,
`activeConsultation`, and each entry's computed `position`. A patient calling it
for a doctor's room receives only their own row — no room aggregate and no other
patient's identity. `POST /queue/next` promotes the first waiting patient and is
idempotent while a consultation is active.

### AI — `/api/ai`

| Method | Path        | Access    |
| ------ | ----------- | --------- |
| GET    | `/provider` | public    |
| GET    | `/assist`   | public    |
| POST   | `/triage`   | signed-in |
| POST   | `/assist`   | signed-in, rate limited |

`GET /assist` describes the assistant before anyone asks it anything: its limits,
suggested questions, whether a model is configured, and what it will not do. It
discloses nothing about the caller, so it needs no token.

`POST /triage` takes `{ description, ... , consent }`. `consent` is required only
when an AI model is configured; without it the call is refused with 428 and
nothing is transmitted.

`POST /assist` takes `{ question }`. The response always states its own
provenance — `sourcedFrom` (`knowledge-base` or `model`), `generatedByModel`, and
`provider` — so a client can label AI text honestly instead of assuming.

### Notifications — `/api/notifications`

`GET /` · `PATCH /read-all` · `PATCH /:id/read` (user) ·
`POST /reminders/sweep` · `POST /outbox/drain` · `GET /scheduler` (admin)

`PATCH /:id/read` answers 404 for a notification that does not exist **and** for
one belonging to somebody else, so the response cannot be used to discover which
ids are real.

### Admin — `/api/admin`

`GET /overview` · `GET /doctors` · `PATCH /doctors/:id` · `GET /facilities` ·
`POST /facilities` · `GET /services` · `GET /patients` · `GET /notifications`
— all admin-only.

---

## Notifications (Phase 10)

### What fires, and when

| Event | Sent to | Triggered by |
| --- | --- | --- |
| `appointment_booked` | patient | a booking committing |
| `appointment_rescheduled` | patient | a reschedule committing |
| `appointment_cancelled` | patient | a cancellation committing |
| `appointment_checked_in` | patient | a first arrival joining the room |
| `queue_called` | patient | the doctor calling the next patient |
| `appointment_completed` | patient | a visit finishing |
| `appointment_reminder` | patient | the reminder sweep |
| `status_update` | patient | any other status change |

The message is written **inside the transaction that caused it**, so a crash
cannot leave a patient booked with no confirmation, or checked in with nobody
telling them. Delivery happens only after that transaction commits.

### Duplicate suppression

`notifications.dedupe_key` carries a **partial unique index**, so two concurrent
transactions cannot both write the same logical event: the second violates the
index and is discarded. This is deliberately in the database rather than a
"have I sent this?" check above it — two concurrent transactions both read "not
yet", both insert, and both commit. A check is not atomic; the index is.

The key includes whatever distinguishes two *genuine* occurrences:

- a reschedule is keyed by its destination slot, so moving an appointment twice
  produces two messages;
- a reminder is keyed by the appointment's start time, so a rescheduled visit is
  reminded about again;
- a queue call is keyed by when the patient was called, so being called, marked
  no-show and called again produces two messages — while one promotion retried
  three times produces one.

A notification with **no** key is never deduplicated, so operator-driven messages
still work.

### Reminders, and what the timer does not promise

Reminders run from an in-process timer every `NOTIFICATION_SWEEP_MINUTES`
(default 15). The honest limitations:

- **Timing is approximate.** A reminder is delivered within one interval of
  becoming due — at most about 15 minutes late, never early. Nothing promises
  "exactly 24 hours before", because nothing here can.
- **It stops when the API stops.** The set of due appointments is derived from
  the database (`reminder_sent_at IS NULL`), not from anything the timer holds in
  memory, so a reminder that came due during downtime is sent at the next pass
  rather than lost.
- **It assumes one process.** Two API instances would each run a pass. They would
  not send duplicates — `claimReminder` is a guarded `UPDATE ... WHERE
  reminder_sent_at IS NULL RETURNING`, so only one caller wins each row — but the
  loser would waste work.
- **It is disabled with `DISABLE_SCHEDULER=1`**, which is how the test suites run,
  so they control exactly when messages appear. The notification suite asserts
  this, so a suite cannot silently start running against a live timer.
- **There is no exactly-once guarantee for EXTERNAL delivery.** The in-app message
  is written in the same transaction as the change that caused it, so it is
  exactly-once by construction. An SMS or email is different: it is attempted
  after that commit, and a provider that accepts a message and then fails before
  the result is recorded will be retried, which can deliver twice. The outbox is
  at-least-once for external channels and exactly-once for in-app. Deduplication
  is on *notification creation*, not on *provider delivery*, and those are
  different problems.

A reschedule clears `reminder_sent_at`. Without that, moving an appointment into
next week would leave it permanently un-reminded.

### The outbox

`notification_outbox` has been written since Phase 1 and never drained. It now is:
a background pass attempts every delivery still in `queued`, with a five-minute
backoff, and abandons anything attempted five times in a day rather than
retrying it for ever. Each pass records what it did in `notification_sweeps`, so
"is the timer alive?" is answerable and a failing pass is visible rather than
silent.

---

## The assistant (Phase 11)

### What it is

A limited help assistant for **how MediCare works** plus **general healthcare
information**. Open at `/help`; it needs a session to ask a question, but reading
it does not.

Four of the five capability groups — booking, rescheduling, cancelling, checking
in — plus queue terminology and navigation, are answered from
`server/src/services/assistantKnowledge.js`. Those answers are about *this
application's* policies, and a model improvising "you can cancel up to two hours
before" would be inventing one. The model is consulted for exactly one class of
question: general healthcare information, where this codebase has no right answer.

### The security properties, and where each one lives

1. **The key never leaves the server.** Read from the environment, used in a
   server-to-server call, never logged and never returned.
2. **Nothing private is sent, by default.** `buildModelPrompt` takes the question
   and nothing else — no user id, name, role, appointment, doctor or queue
   position. That is checkable by reading one function signature rather than by
   auditing every query.
3. **The model cannot act.** It returns a string. There is no tool registry, no
   function calling, and no code path from model output to a database write.
4. **Model output is never authorisation.** Booking, cancelling and queue changes
   go through the existing controllers. If the assistant says a patient may
   cancel, that sentence changes nothing.
5. **Injection is handled at the application boundary.** Telling a model not to
   be injected is a request, not a control. The application classifies the
   question *before* any model is consulted: known topics are answered locally,
   and anything matching an injection pattern is refused outright. The model is
   only reached for a question that matched nothing else. The prompt also strips
   control characters and angle brackets, so a forged `<question>` delimiter
   cannot close the block early.
6. **Without credentials it still works.** Every application question is
   answered, general questions get an honest "not available right now", and the
   response reports `generatedByModel: false` — the UI never dresses an
   application's own answer up as AI output.

### Known behaviour to be aware of

- **`/ai/triage` sends the patient's description to Gemini, and now asks first.**
  When a model is configured, the first press of "Analyse my symptoms" does not
  transmit: it shows exactly what would be sent (the description, and the age if
  given) and who would receive it, and only the second press sends anything. The
  server enforces the same rule — `analyzeSymptoms` refuses with
  **428 CONSENT_REQUIRED** when consent is absent and a key is configured — so the
  gate cannot be bypassed by another client. It lives in the service rather than
  the route so that a second caller cannot skip it.
  With no key configured the engine is entirely local and rule-based, nothing
  leaves the machine, and the extra step is skipped.
  What triage sends: the description, plus age/gender/history supplied on that
  form. Never a name, account, appointment, queue state or record — the function
  is not given them and cannot read them. This is asserted by inspecting the
  prompt it builds, not by reading the UI.
- **Answers are labelled, not moderated.** A model's general-health answer is
  marked `AI-generated · not medical advice` and sits under a permanent
  disclaimer, but nothing filters its medical content. It is guidance, not
  review.
- **Duplicate suppression is on notification CREATION, not on provider delivery.**
  In-app delivery is exactly-once by construction, because the message commits
  with the change that caused it. External channels are at-least-once: a provider
  that accepts a message and then fails before the result is recorded will be
  retried, and can deliver twice. Retries are bounded by a five-minute backoff and
  a five-attempts-per-day abandonment, so a broken provider cannot become an
  unbounded retry loop.
- **A duplicate notification cannot undo the booking that caused it.** This needed
  fixing and is worth recording why. Deduplication is enforced by a unique index,
  and a failed statement ABORTS a PostgreSQL transaction — so handling the
  collision by catching the exception left the transaction poisoned and the
  booking rolled back on COMMIT, despite the code appearing to continue. The
  insert now uses `ON CONFLICT DO NOTHING` and returns null, so nothing raises
  and the transaction stays healthy.

---

## Design notes & known limitations

Prototype-scope trade-offs, deliberately made to keep the project runnable with
zero external dependencies:

- **JSON file datastore** — fine for a demo, not for concurrent writes. The
  `db.js` module is the single seam to swap in a real database.
- **Slot availability is simulated** — a generator seeds slots ahead of the
  current date rather than integrating a real calendar.
- **AI triage is rule-based**, not a trained model. It scores symptom keywords
  against specialties; it does not diagnose.
- **Notifications are stored and displayed in-app** — no email/SMS delivery.
- **Auth limiter is skipped when `NODE_ENV !== "production"`** so the smoke
  suite can be re-run freely. Production traffic stays rate-limited.

### The waiting room: one per doctor per clinic day

Patients hold separate appointment slots but wait for the same person, so their
order comes from **when they arrived**, not from which slot they hold.

- A room is `(doctor_id, clinic_date)`. `clinic_date` is stamped on the entry at
  check-in and derived from the slot with the same expression the repositories
  use to label a slot.
- **Positions are computed**, with `row_number()` over the waiting set, ordered by
  `joined_at ASC, id ASC`. They start at 1, stay contiguous, and renumber
  themselves the moment anyone leaves — there is no stored counter to compact and
  therefore no way to leave a gap.
- **Position 1 means the next patient to be seen.** The patient in consultation is
  excluded from the ranking and returned separately as `activeConsultation`, so
  "you are 2nd" never silently changes meaning.
- `queue_entries.position` survives as a **legacy per-slot number** for older
  readers. It is still written and still constrained, and it is never used to
  rank the room.
- `POST /api/appointments/queue/next` promotes the head of the queue. It is
  idempotent: while somebody is in consultation it returns that same patient, so
  a double click, a retry or two browsers cannot skip anyone.
- `averageWaitMinutes` is **an assumption, not a measurement**: the API multiplies
  the head count by a flat 15 minutes per patient, because no per-visit durations
  are recorded. The dashboard therefore labels it as one ("~45 min if each visit
  is 15 min") rather than as an average wait. There is no per-patient estimate on
  this endpoint, so none is shown.

**Locking.** Every operation that touches the room takes the room's
transaction-scoped advisory lock **first**, then the appointment row, then the slot
row. Check-in, call-next, reschedule, cancellation and status changes all mutate
queue entries, so all five follow that order; booking touches no queue row and
never asks for the lock. Taking the advisory lock after a row lock would invert
against those paths and let them deadlock, which is why the order is enforced
rather than merely documented. The partial unique index on
`(doctor_id, clinic_date) WHERE state = 'in-consultation'` is the structural
backstop underneath the application logic.

**The queue updates by polling.** `QueueContext` owns a single five-second poller
for the whole app, running only while the tab is visible, never overlapping itself,
and discarding stale responses via a ticket. A provider-less component mounts no
poller at all.

### Migration 017 — additive, and how to recover

`017_queue_room.sql` adds `queue_entries.clinic_date`, backfills it, and adds the
room indexes. It **drops nothing**: `position` and `queue_unique_position` are left
exactly as they are.

- The backfill refuses to continue if any row cannot be dated, and the
  single-consultation index is validated before it is created, so a partial
  migration fails loudly instead of leaving a half-applied table.
- **This migration is not reversible in place.** Migrations here are forward-only
  and the only built-in rollback is `db:migrate:reset`, which is a destructive
  `DROP SCHEMA CASCADE`. Nothing here should be described as reversible.

**Before applying it to anything you care about, take a backup:**

```bash
# logical backup, preferred - restores into a fresh database
pg_dump --format=custom --file=medicare-before-017.dump "$DATABASE_URL"

# restore into a new database, then deploy the previous code against it
createdb medicare_rollback
pg_restore --dbname=medicare_rollback medicare-before-017.dump
```

**Recovery procedure**

1. Restore the dump into a clean database and point `DATABASE_URL` at it.
2. Deploy the code from before this commit (the Phase 8 checkpoint, `5db3221`).
3. Verify with `npm --prefix server run test:schema` and
   `npm --prefix server run test:queue`.

The additive steps are safe to leave in place on their own: nothing reads
`clinic_date` until the code that accompanies the migration is deployed. If the
old code is still running against the new schema, it keeps using the legacy
`position` column and behaves exactly as it did in Phase 8.

Room capacity is deliberately **not** in this checkpoint. `slots.max_queue` remains
the (per-slot, and in practice unreachable) limit it has always been.

Turning this into a real room — one queue per doctor, positions that mean
something, and a way for a doctor to advance it — is Phase 9 work and needs a
new endpoint, which is why nothing here assumes one.

Accessibility, keyboard-navigable modals, empty/loading/error states, and
responsive layouts are handled in the client; the design tokens in
`styles/index.css` centralise colour and spacing.
