# MediCare v2 — Implementation Roadmap

**Phase 0 deliverable. This is a plan, not work performed.**

19 phases, ordered by dependency. Each phase lists its objective, dependencies, major tasks,
expected files, acceptance criteria and required tests.

Two ordering principles run through the whole plan:

1. **Security fixes come before the migration, not after.** Four defects (S-01, S-03, S-04,
   S-06) are independently exploitable against a running deployment today.
2. **Every phase leaves the app runnable.** No big-bang rewrites. The existing smoke suite must
   stay green throughout.

---

## Phase dependency map

```
Phase 1  Foundation & cleanup ──────────────────────────────┐
   │                                                          │
   ├──▶ Phase 16  Docker & deployment ───────────────────────┤
   │                                                          │
   ├──▶ Phase 2  Supabase PostgreSQL ◀──────────────────────┘
   │         │
   │         ├──▶ Phase 3  Auth & security
   │         │         └──▶ Phase 4  Doctor / specialty / facility APIs
   │         │                   └──▶ Phase 5  Slots & availability
   │         │                             └──▶ Phase 6  Appointments ★
   │         │                                       ├──▶ Phase 7  Patient dashboard
   │         │                                       └──▶ Phase 8  Doctor dashboard
   │         │                                                 └──▶ Phase 9  Realtime queue
   │         ├──▶ Phase 10  Notifications                       ──────┘
   │         ├──▶ Phase 11  Gemini AI triage
   │         └──▶ Phase 12  Admin dashboard
   │
   ├──▶ Phase 13  Validation & error handling (hardening sweep across all phases)
   ├──▶ Phase 14  Testing
   ├──▶ Phase 15  Swagger / OpenAPI
   ├──▶ Phase 17  CI/CD
   └──▶ Phase 18  Final QA & security ──▶ Phase 19  README / GitHub / resume
```

Phase 3 is deliberately listed *after* Phase 2 but the **S-01/S-06/S-07 fixes do not need the
database** — land them in Phase 1.

---

## PHASE 1 — Foundation & project cleanup

### Objective
Make the repository installable, buildable, runnable and git-tracked — and close the
exploitable holes that need no database work.

### Depends on
Nothing. **Start here.**

### Major tasks

| # | Task | Rationale |
| --- | --- | --- |
| 1.1 | Bump `@vitejs/plugin-react` → `^6` | **TD-01 blocker.** `npm ci` currently fails |
| 1.2 | Add `.gitignore` (`node_modules/`, `dist/`, `.data/`, `.env`, `recordings/*.webm`) | TD-22; `git init` must come after |
| 1.3 | `git init`, first commit | Establish history |
| 1.4 | Delete the committed `client/dist/` and `server/.data/` | Build artifact + 468 KB of plaintext passwords |
| 1.5 | Add `.env.example` (server + client) | No documentation of required variables |
| 1.6 | Convert to npm workspaces; root `install:all` → single `npm install` | Two lockfiles today |
| 1.7 | **Delete `GET /api/demo-accounts`** | S-01 CRITICAL |
| 1.8 | **Add ownership check to `POST /appointments/:id/check-in`** — wire up the already-written `requireSelfOrAdmin` | S-06 HIGH; the unused middleware is the fix |
| 1.9 | **Restrict `/api/notifications?patientId=` to admin** | S-07 HIGH |
| 1.10 | `npm run test` → runs `node server/scripts/smoke.js` | Any CI needs a command |
| 1.11 | Add ESLint + Prettier with a flat config | TD-23: 5 stray disable comments, no config |
| 1.12 | Add a `type: module`-consistent Node version pin (`.nvmrc`, `engines`) | Reproducible builds |
| 1.13 | Fix `logger.tag()` nested-array output | TD-21 |
| 1.14 | Fix `notificationController.markRead` → call `persist()` | D8 |
| 1.15 | Fix `EVENT_ICON` keys + the `channels.simulated` branch | D4, D5 |
| 1.16 | Remove dead code: `requireSelfOrAdmin` *(after 1.8)*, `markAllRead`, `listSpecialties`, 3 re-export lines, 11 unused imports | TD-15 |
| 1.17 | Add `test`/`lint`/`format` scripts and `dev`, `build`, `start` at the workspace root | Consistency |

### Expected files

```
.gitignore                     .nvmrc                        .env.example
package.json (workspaces)      eslint.config.js             .prettierrc
client/package.json            client/.env.example
server/package.json            server/.env.example
server/src/app.js                            # demo-accounts route removed
server/src/middlewares/authMiddleware.js     # requireSelfOrAdmin wired in
server/src/controllers/appointmentController.js
server/src/controllers/notificationController.js
server/src/utils/logger.js
client/src/components/SymptomChecker.jsx     # unused import
client/src/components/DoctorCard.jsx         # unused import
client/src/pages/Notifications.jsx           # EVENT_ICON keys
client/src/pages/admin/AdminNotifications.jsx
client/src/pages/{Home,DoctorDirectory,ProviderDashboard,Profile}.jsx
client/src/pages/admin/{AdminPatients,AdminDashboard}.jsx
```

### Acceptance criteria

- [ ] `npm install` succeeds from a clean clone, **for both workspaces**
- [ ] `npm run build` produces `client/dist` with no errors
- [ ] `npm run dev` starts API + client with one command
- [ ] `GET /api/demo-accounts` → **404**
- [ ] `POST /api/appointments/:id/check-in` as a non-owner → **403**
- [ ] `GET /api/notifications?patientId=<other>` as a doctor → returns only the caller's own
- [ ] `npm test` passes 35/35
- [ ] `npm run lint` clean
- [ ] No `node_modules`, `dist`, `.data`, or `.env` tracked by git
- [ ] `git status` clean after a build

### Tests required

- Extend the smoke suite with **3 negative authz assertions** (the 1.7–1.9 fixes), each
  verified to fail before the fix
- Fresh-clone install/build check in CI (arrives in Phase 17; verify manually here)

---

## PHASE 2 — Supabase PostgreSQL

### Objective
Replace the JSON datastore with a real relational schema, and introduce the repository layer
that makes the swap possible.

### Depends on
Phase 1.

### Major tasks

| # | Task |
| --- | --- |
| 2.1 | Create a Supabase project; capture `DATABASE_URL`, `SUPABASE_URL`, anon + service-role keys, `JWT_SECRET` |
| 2.2 | Add `pg`; create `server/src/config/db.js` as a **pool factory** (not a data module) |
| 2.3 | Author migrations `001`–`013` exactly as specified in [database-migration-plan.md §3](./database-migration-plan.md#3-proposed-schema) |
| 2.4 | `EXCLUDE USING gist` constraints on `slots` and `appointments` (enable `btree_gist`) |
| 2.5 | Partial unique index `appointments_one_active_per_slot` |
| 2.6 | Write `db/seeds/seed.sql` + `db/seeds/hash-passwords.js` (bcrypt cost 12) |
| 2.7 | Slot generator job materialising 14 days from `doctor_availability` |
| 2.8 | Create `src/repositories/` — SQL only, explicit column lists, `AppError`-free |
| 2.9 | Port `referenceRepo` (specialties, facilities, services) — first slice, lowest risk |
| 2.10 | Port `userRepo` + `doctorRepo` + `availabilityRepo` + `slotRepo` |
| 2.11 | Port `appointmentRepo` + `notificationRepo` + `queueRepo` + `auditRepo` |
| 2.12 | Write the `export-json.js` / `import-postgres.js` migration scripts (mapping table §4) |
| 2.13 | Enable RLS with restrictive policies (migration §9) |
| 2.14 | Add `withTransaction(fn)` helper |

### Expected files

```
server/package.json                          # +pg, +supabase
server/.env.example                          # +DATABASE_URL, +SUPABASE_*
server/src/config/{db.js, supabase.js}       # rewritten: pool, not data
server/src/db/migrations/001…013_*.sql
server/src/db/seeds/{seed.sql, hash-passwords.js}
server/src/db/scripts/{export-json.js, import-postgres.js}
server/src/db/jobs/generateSlots.js
server/src/repositories/{user,doctor,specialty,facility,service,
                         availability,slot,appointment,notification,
                         queue,audit}Repo.js
server/src/db/transaction.js
server/scripts/shapes.js                     # extended: SQL-backed parity check
```

### Acceptance criteria

- [ ] All 13 migrations apply cleanly to an empty database
- [ ] `seed.sql` is idempotent — two runs give identical counts
- [ ] Counts: 10 specialties, 6 facilities, 5 services, 16 users, 12 doctors, ≥1254 slots, 45 appointments
- [ ] `GET /api/doctors`, `/api/doctors/:id`, `/api/doctors/:id/slots` return **byte-identical shapes** to the pre-migration capture
- [ ] `scripts/smoke.js` 35/35 against the PostgreSQL-backed API
- [ ] No service or controller imports `config/db.js` as data any more
- [ ] `EXPLAIN ANALYZE` shows index usage on doctor search and availability
- [ ] Anon key reads **zero** rows from every RLS-enabled table
- [ ] Original `db.json` untouched on disk throughout (deleted only in 2.14)

### Tests required

- **Repository integration tests** against a local Supabase, run per repo: one create, read,
  update, delete each
- **Constraint tests**: inserting a duplicate `(doctor_id, starts_at)` raises `23505`;
  an overlapping slot raises `23P01`; a second active appointment on one slot raises `23505`
- **Migration test**: `supabase db reset && seed` twice → identical counts
- **RLS test**: query with the anon key returns 0 rows
- **Parity test**: diff `shapes.js` output against the captured pre-migration JSON

---

## PHASE 3 — Authentication & security

### Objective
Make authentication genuinely secure. Closes the remaining S-0x findings.

### Depends on
Phase 2 (bcrypt migration needs `users.password_hash`).

### Major tasks

| # | Task | Closes |
| --- | --- | --- |
| 3.1 | `bcrypt.hash(password, 12)` in `authService.register`; `bcrypt.compare` in `login` | S-02 |
| 3.2 | Lazy migration: on successful login, if the stored hash starts with `hashed:`, compare then **re-hash with bcrypt** | S-02 |
| 3.3 | Add `CHECK (password_hash ~ '^\$2[aby]\$')` to `users` — makes `hashed:` **unstorable** | S-02 |
| 3.4 | Whitelist-project `publicUser`; take the doctor through `shape()` | S-04 |
| 3.5 | Whitelist-project the doctor in `GET /api/appointments/:id` | S-03 |
| 3.6 | **Never** project a persistence object directly — grep-enforce this | S-03, S-04 |
| 3.7 | Remove the `role` field from the register schema; server assigns `patient` | S-05 |
| 3.8 | Add an admin doctor-invite flow creating user **and** doctor row | S-05 |
| 3.9 | `helmet` with a CSP suited to a cross-origin SPA + API | S-13 |
| 3.10 | CORS from a **required** validated env var; drop `credentials` (bearer tokens, not cookies) | S-11 |
| 3.11 | Rate limiters always on; boot-time warning if disabled | S-10 |
| 3.12 | Access token 15 min + rotating refresh token; `refresh_tokens` table (store the hash) | S-12 |
| 3.13 | `POST /auth/refresh`, `POST /auth/logout` | S-12 |
| 3.14 | `token_version`; bump on password change / role change → invalidates all JWTs | S-12 |
| 3.15 | Sign `{sub}` only; drop `email`/`name`/`role` from the payload | S-22 |
| 3.16 | Remove the `JWT_SECRET` fallback; **abort boot** if missing in production | S-09 |
| 3.17 | Validate env with a schema at boot | S-09, S-11 |
| 3.18 | Remove the `bcryptjs` dependency if `crypto.scrypt` was chosen | S-14 |
| 3.19 | Frontend: token in memory, refresh on boot, silent refresh, optimistic logout | S-12 |

### Expected files

```
server/src/services/authService.js           # NEW
server/src/repositories/userRepo.js          # +refresh tokens, tokenVersion
server/src/controllers/authController.js     # rewritten
server/src/routes/authRoutes.js              # +refresh, +logout
server/src/middlewares/authMiddleware.js     # +refresh verify, session check
server/src/middlewares/errorHandler.js
server/src/config/env.js                     # validated, no secret fallbacks
server/src/app.js                            # +helmet, strict cors
server/db/migrations/014_auth_hardening.sql
server/.env.example                          # JWT_SECRET documented as required
client/src/app/providers/AuthProvider.jsx   # rewritten
client/src/lib/api/client.js                 # 401 → refresh → retry once
client/src/features/auth/Login.jsx, Register.jsx
```

### Acceptance criteria

- [ ] No `hashed:` value anywhere in the database
- [ ] `GET /api/auth/me` and `POST /api/auth/login` contain **no** `password` key at any depth
- [ ] `POST /api/auth/register {"role":"provider"}` → **422**
- [ ] No password field is reachable on any endpoint, verified by an automated response scan
- [ ] Boot **fails** without `JWT_SECRET` when `NODE_ENV=production`
- [ ] Rate limiting active in development too (or warns loudly)
- [ ] `CORS_ORIGIN` unset in production → boot fails
- [ ] Access token expires in ≤15 min; refresh rotates; logout revokes server-side
- [ ] Security headers present on every response

### Tests required

- **Unit**: `authService.register` hashes with cost 12; `login` verifies both formats
- **Unit**: `publicUser` output contains no `password` key (recursive key assertion)
- **Integration**: register → login → `/me` → refresh → logout → refresh now fails
- **Integration**: `role:"provider"` → 422
- **Integration**: missing `JWT_SECRET` in production → process exits non-zero
- **Integration**: password change invalidates existing tokens
- **Regression**: smoke suite still 35/35

---

## PHASE 4 — Doctor / specialty / facility APIs

### Objective
Move discovery from in-memory `.filter()` chains to indexed SQL with real pagination,
through the repository layer.

### Depends on
Phase 2 (repositories), Phase 3 (auth middleware is final).

### Major tasks

| # | Task |
| --- | --- |
| 4.1 | `specialtyRepo`, `facilityRepo`, `serviceRepo` — full CRUD |
| 4.2 | `doctorRepo.search()` — SQL `ILIKE`, `IN (…)` for comma-separated multi-filters, joins for specialty/facility/language/mode |
| 4.3 | Real pagination: `page`, `limit`, `total` — `total` = the full match count, distinct from `count` |
| 4.4 | SQL `ORDER BY` for fee / experience / rating / soonest |
| 4.5 | Recommended doctors — SQL scoring (rating, fee, experience, language, soonest availability) |
| 4.6 | Doctor profile — joins for specialty, facility, services, languages |
| 4.7 | Fix `upcomingAppointments`: return **counts** (aggregate) *and* a separate, properly authorised list; never `patientName` publicly |
| 4.8 | Replace the synthetic `patientsTreated` / `repeatRate` stats | S-18 |
| 4.9 | Facilities endpoint with `doctorCount` / `specialtyCount` via `LEFT JOIN` |
| 4.10 | Remove `rating` / `reviewCount` from `doctors`; serve from the `doctor_ratings` view | S-17 |
| 4.11 | Extend the client query-key factory to include filter params |

### Expected files

```
server/src/repositories/{specialty,facility,service,doctor}Repo.js
server/src/services/doctorService.js         # NEW
server/src/controllers/doctorController.js    # rewritten
server/src/routes/doctorRoutes.js
server/db/migrations/015_reviews.sql
client/src/features/discovery/{Directory,Profile,Filters,DoctorCard}.jsx
client/src/features/discovery/useDoctors.js
```

### Acceptance criteria

- [ ] `GET /api/doctors?page=2&limit=5` returns 5 with `total` = full match count
- [ ] Every filter — `search, specialty, city, maxFee, minRating, language, mode, acceptingOnly, sort` — is applied in SQL
- [ ] `EXPLAIN ANALYZE` uses `doctors_specialty_facility_idx`; no sequential scan on `doctors`
- [ ] `GET /api/doctors/:id` returns no `patientName`
- [ ] `stats.patientsTreated` and `stats.repeatRate` are either real or removed
- [ ] Discovery response time at 10,000 seeded doctors stays under 200 ms

### Tests required

- **Integration**: one test per filter, asserting the exact result set
- **Integration**: pagination boundaries — page 1, middle, last, past-the-end
- **Integration**: multi-value `specialty=Cardiology,Dermatology`
- **Integration**: `GET /api/doctors/:id` response contains no patient identity field
- **Regression**: smoke suite

---

## PHASE 5 — Slots & availability system

### Objective
Introduce recurring availability templates and a real slot lifecycle, so slots are generated
rather than hand-maintained.

### Depends on
Phase 4 (doctor and facility APIs), Phase 2 (schema).

### Major tasks

| # | Task |
| --- | --- |
| 5.1 | `availabilityRepo` — CRUD weekly templates |
| 5.2 | `POST /doctors/me/availability` — provider defines a weekly schedule |
| 5.3 | Generator job materialising `slots` from templates N days ahead; idempotent (unique index makes it free) |
| 5.4 | **Delete the hand-rolled `SLOT_TIMES` / `dayOffset` seed grid** |
| 5.5 | `slotService` — availability summary, next-open slot, date list; SQL aggregates |
| 5.6 | Slot blocking / unblocking — refuse if an active appointment exists |
| 5.7 | Bulk slot generation — dedupe enforced by the unique index, not by read-then-write |
| 5.8 | Surface `service_id` on slots so `services.duration_minutes` / `price` are actually used |
| 5.9 | Retire `slot.max_queue` as a dead field, or enforce it (Phase 6) |
| 5.10 | Availability preview endpoint for the provider UI |

### Expected files

```
server/src/repositories/availabilityRepo.js
server/src/services/slotService.js           # NEW
server/src/controllers/doctorController.js
server/src/routes/doctorRoutes.js
server/src/db/jobs/generateSlots.js
server/src/db/seeds/availability.sql
client/src/features/discovery/AvailabilityTab.jsx
client/src/features/availability/WeeklyScheduleEditor.jsx   # NEW
client/src/features/availability/AvailabilitySettings.jsx   # NEW
```

### Acceptance criteria

- [ ] A provider defines a weekly template; slots appear automatically for the next 14 days
- [ ] Running the generator twice creates **zero** duplicates (unique index)
- [ ] Overlapping template times are rejected (EXCLUDE constraint)
- [ ] `GET /api/doctors/:id/slots` filters by `date`, `from`, `to`, `mode` in SQL
- [ ] Availability summary reports available / booked / blocked / utilisation via SQL
- [ ] Blocking a slot that has an active appointment → **409**
- [ ] `server/src/config/db.js` seed constants (`SLOT_TIMES`, `dayOffset`, `addMinutes`) deleted

### Tests required

- **Unit**: generator materialises exactly the expected slot count from a template
- **Integration**: idempotency — run the generator twice, assert an unchanged row count
- **Integration**: an overlapping template raises `23P01`
- **Integration**: `?mode=video` returns only video slots
- **Integration**: blocking a booked slot → 409
- **Time-based**: a slot whose `starts_at` is in the past is never offered as bookable

---

## PHASE 6 — Appointment system ★

**The critical phase.** Booking becomes transactionally correct and concurrency-safe.

### Depends on
Phase 5 (slots), Phase 2 (constraints).

### Major tasks

| # | Task | Closes |
| --- | --- | --- |
| 6.1 | `bookingService.book()` in **one transaction** | D-B1…D-B6 |
| 6.2 | `SELECT … FROM slots WHERE id=$1 FOR UPDATE` | TD-03 |
| 6.3 | Map `23505` → 409 `SLOT_TAKEN`; `23P01` → 409 `PATIENT_CLASH` | TD-03 |
| 6.4 | `reschedule()` — one transaction: validate the new slot, release the old, claim the new, **re-price from the new slot** | D-B3, D-B5 |
| 6.5 | `cancel()` — **one** path; also reachable via the status machine | D-B2 |
| 6.6 | Status machine as the single owner of transitions; `→ cancelled` routes through cancellation | D-B2 |
| 6.7 | `mode` taken from the slot only; ignore the client value | D-B6 |
| 6.8 | Derive `doctor_id` from the slot; do not trust the request body | TD-07 |
| 6.9 | Write `appointment_status_history` on every transition | TD-30 |
| 6.10 | `joinQueue()` in a transaction: reject future appointments, respect capacity | D-B4, B7 |
| 6.11 | Queue position derived from `queue_entries`, never incremented | D-B4 |
| 6.12 | `getAppointment` — whitelisted projection | S-03 |
| 6.13 | Ownership middleware: owner / assigned doctor / admin | S-06 |
| 6.14 | `GET /api/appointments/:id/history` | New |
| 6.15 | Admin analytics: SQL aggregates instead of ~130 array scans | TD-10 |

### Expected files

```
server/src/services/appointmentService.js    # rewritten around withTransaction
server/src/services/bookingService.js        # NEW: book/reschedule/cancel
server/src/services/queueService.js          # NEW
server/src/services/analyticsService.js     # NEW (Phase 12 consumes it)
server/src/repositories/{appointment,queue}Repo.js
server/src/middlewares/appointmentAccess.js  # NEW: requireAppointmentAccess
server/src/controllers/appointmentController.js
server/src/utils/dbErrors.js                 # NEW: mapDbError
client/src/features/appointments/{AppointmentList,BookingModal,
                                  RescheduleModal,CancelModal,
                                  StatusTimeline}.jsx
```

### Acceptance criteria

- [ ] **20 concurrent bookings at one slot → exactly 1 × 201, 19 × 409**
- [ ] Overlapping-slot double booking → **409** `PATIENT_CLASH`
- [ ] Reschedule into the past → **400**
- [ ] Reschedule refreshes `fee` from the new slot
- [ ] Cancelling via **any** path releases the slot
- [ ] Client-supplied `mode` is ignored
- [ ] Check-in on a future appointment → **400**
- [ ] Check-in beyond capacity → **409**
- [ ] Every status change writes a history row
- [ ] `GET /api/appointments/:id` returns no password field
- [ ] A non-owner receives **403** on read / reschedule / cancel / check-in
- [ ] Admin overview runs entirely in SQL

### Tests required — **the most important suite in the project**

- **`booking.concurrency.test.js`** — 20 parallel `POST /api/appointments` at one slot; assert
  exactly 1 success and 19 × 409, and exactly 1 active appointment row
- **`booking.overlap.test.js`** — book 09:00 then 09:15 (overlapping slots) → 409
- **`booking.invalid.test.js`** — past slot, blocked slot, wrong doctor, bad mode, non-patient role
- **`reschedule.test.js`** — past date, occupied slot, different doctor, fee refresh, history row
- **`cancel.test.js`** — every cancellation path releases the slot; completed cannot cancel
- **`status.test.js`** — the full transition matrix, valid and invalid
- **`queue.test.js`** — capacity, duplicate check-in, position stability, future-date rejection
- **`authz.test.js`** — the full ownership matrix across read/reschedule/cancel/check-in
- **`idempotency.test.js`** — a retried request cannot create a duplicate appointment

---

## PHASE 7 — Patient dashboard

### Objective
Turn the patient experience into a coherent, data-layer-backed set of screens.

### Depends on
Phase 6 (correct appointment API).

### Major tasks

| # | Task |
| --- | --- |
| 7.1 | Split `Home.jsx` (435 lines, two divergent views) into `PublicHome` + `PatientHome` |
| 7.2 | Migrate `MyAppointments.jsx` to TanStack Query |
| 7.3 | Upcoming / History / All tabs driven by the server, not client-side filtering |
| 7.4 | Status history timeline from `appointment_status_history` (the README already promises this) |
| 7.5 | Booking modal extracted from `DoctorCard.jsx` into `features/appointments/BookingModal.jsx` |
| 7.6 | Reschedule modal: reuse the slot picker; show the current appointment inline |
| 7.7 | Optimistic updates with rollback on failure |
| 7.8 | Extract the duplicated appointment card from `Home`, `MyAppointments`, `ProviderDashboard` |
| 7.9 | Tailwind migration for every patient screen |
| 7.10 | Profile page — strict Zod schema; typed blood group / gender selects |
| 7.11 | Fix the public AI checker 401 (D2) — either make the route public or gate the component |
| 7.12 | Error boundary + `React.lazy` route splitting |

### Expected files

```
client/src/features/appointments/{AppointmentList,AppointmentCard,
                                  BookingModal,RescheduleModal,
                                  CancelModal,StatusTimeline}.jsx
client/src/features/dashboard/{PublicHome,PatientHome}.jsx
client/src/features/profile/ProfileForm.jsx
client/src/components/layout/ErrorBoundary.jsx
client/src/app/ErrorBoundary.jsx            # NEW
```

### Acceptance criteria

- [ ] No page calls `fetch` directly — all data flows through hooks
- [ ] Exactly one `useNotifications` consumer (TD-18)
- [ ] Booking, rescheduling, cancelling and checking in all work end to end
- [ ] The status timeline renders real history
- [ ] The anonymous AI checker no longer 401s
- [ ] Every patient screen is loading-, empty- and error-complete
- [ ] A render throw shows the error boundary, not a blank page
- [ ] Main bundle < 200 KB gzip

### Tests required

- **Component**: appointment card renders each status correctly
- **Component**: slot picker disables booked/blocked slots and resets on date change
- **Component**: timeline orders history ascending
- **Hook**: `useAppointments` invalidates on mutation
- **E2E (Playwright)**: book → reschedule → cancel → check in

---

## PHASE 8 — Doctor dashboard

### Objective
Give providers a real working day view, a recurring schedule editor, and the status controls
they need.

### Depends on
Phase 6 (status API), Phase 5 (availability templates).

### Major tasks

| # | Task |
| --- | --- |
| 8.1 | Migrate `ProviderDashboard.jsx` to TanStack Query |
| 8.2 | Today / Upcoming / History buckets from the server |
| 8.3 | **Derive allowed status actions from the server state machine** — delete the hand-copied `STATUS_ACTIONS` map (TD-25) |
| 8.4 | `GET /api/doctors/me/schedule` returns `allowedActions` per appointment |
| 8.5 | Weekly availability template editor (Phase 5) |
| 8.6 | Slot blocking / unblocking with optimistic updates |
| 8.7 | Patient context panel: reason, symptoms, contact |
| 8.8 | **Queue view** — the waiting list for today, per slot, with advance/call-next |
| 8.9 | Tailwind migration |
| 8.10 | Provider KPI tiles: today, open slots, utilisation, no-show rate |

### Expected files

```
server/src/controllers/doctorController.js   # allowedActions in mySchedule
server/src/services/doctorService.js
client/src/features/provider/{ProviderDashboard,ScheduleTimeline,
                              WeeklyScheduleEditor,SlotGrid,
                              QueuePanel,PatientCard}.jsx
```

### Acceptance criteria

- [ ] Allowed status actions come from the server, never a client constant
- [ ] A provider can define a weekly schedule and see generated slots
- [ ] Blocking a slot is reflected immediately
- [ ] The queue panel lists today's waiting patients and supports "call next"
- [ ] A doctor cannot see or act on another doctor's appointments
- [ ] Every provider screen is loading-, empty- and error-complete

### Tests required

- **Integration**: `mySchedule.allowedActions` matches the server transition matrix
- **Integration**: doctor A receives **403** for doctor B's schedule
- **Component**: slot grid reflects optimistic block/unblock
- **Component**: queue panel advances state and recomputes positions

---

## PHASE 9 — Supabase Realtime queue

### Objective
Replace polling and manual refresh with genuine Realtime for queue, slot availability,
appointment status and notifications.

### Depends on
Phase 6 (queue + appointments), Phase 8 (queue UI).

### Major tasks

| # | Task |
| --- | --- |
| 9.1 | Add `@supabase/supabase-js` to both workspaces |
| 9.2 | `RealtimeProvider` — one connection, a channel registry |
| 9.3 | `lib/realtime/channels.js` — typed channel names and filters |
| 9.4 | `useSubscription(channel, handler)` — auto (re)subscribe, auto cleanup |
| 9.5 | **Appointment status** channel — patient's own appointment updates live |
| 9.6 | **Queue** channel — live position for patients, live waiting list for doctors |
| 9.7 | **Slots** channel — a booked slot greys out in the picker for everyone, instantly |
| 9.8 | **Notifications** channel — replaces the 30 s poll |
| 9.9 | Server-side `publish` **after commit only** |
| 9.10 | RLS so subscriptions cannot leak other patients' rows |
| 9.11 | Refetch on reconnect and on tab refocus (missed-event recovery) |
| 9.12 | Remove `setInterval` polling from `useNotifications` |
| 9.13 | Connection-status indicator in the UI |
| 9.14 | Delete the `dot dot-pulse` "liveness" affordance if Realtime cannot back it |

### Expected files

```
client/src/lib/realtime/{channels.js, useSubscription.js}
client/src/app/providers/RealtimeProvider.jsx
client/src/features/realtime/RealtimeStatus.jsx
client/src/features/queue/LiveQueue.jsx
client/src/features/appointments/StatusTimeline.jsx   # realtime-driven
server/src/integrations/realtime.js
server/src/services/appointmentService.js           # publish post-commit
```

### Acceptance criteria

- [ ] A patient's appointment status updates **without a reload** (<2 s)
- [ ] Queue position updates live for the patient and the doctor
- [ ] A slot taken by another patient disappears from the picker immediately
- [ ] New notifications appear without polling
- [ ] `setInterval` is gone from the notification path
- [ ] Subscriptions are scoped — no cross-patient data is received
- [ ] Reconnect + tab-refocus triggers a refetch, so no event is permanently lost
- [ ] No row data is broadcast that the subscriber is not entitled to

### Tests required

- **Integration**: subscribing to another patient's appointment yields no rows
- **E2E (Playwright)**: two browser contexts — patient A books, patient B's picker updates
  without a reload
- **E2E**: doctor calls the next patient → the patient's queue position updates live
- **Component**: reconnect triggers a refetch
- **Manual**: 5-minute soak — no leaked channels, no unbounded memory growth

---

## PHASE 10 — Notifications

### Objective
Make notification delivery transactional and durable, with a real provider abstraction.

### Depends on
Phase 6 (appointment events), Phase 2 (outbox table).

### Major tasks

| # | Task |
| --- | --- |
| 10.1 | Transactional outbox: write the outbox row **inside** the booking transaction |
| 10.2 | Outbox drain worker — poll, claim with `FOR UPDATE SKIP LOCKED`, process, mark done |
| 10.3 | `notification_deliveries` — one row per channel (sms / email / in_app) |
| 10.4 | Retries with exponential backoff; dead-letter after N attempts |
| 10.5 | Scheduled reminder job — replace the manual sweep as the primary path |
| 10.6 | Dedupe reminders on `appointments.reminder_sent_at` |
| 10.7 | `template_key` + `template_version`; re-render rather than store a stale string |
| 10.8 | Retention job — delete read notifications older than N days (replaces the hard 500 cap) |
| 10.9 | `POST /notifications` — send an in-app notification; `PATCH /:id/read` individually |
| 10.10 | Keep `POST /notifications/reminders/sweep` as an admin test trigger |
| 10.11 | Email (Resend) + SMS (Twilio) adapters; no key → log and mark `simulated` |
| 10.12 | Fix `EVENT_ICON` keys; return `channels.simulated` (D4, D5) |
| 10.13 | `mark-read` as `UPDATE … SET read_at` (fixes D8) |

### Expected files

```
server/src/repositories/{notification,outbox}Repo.js
server/src/services/notificationService.js   # rewritten around the outbox
server/src/integrations/{email,sms}.js
server/src/db/jobs/{drainOutbox,sendReminders,pruneNotifications}.js
server/src/controllers/notificationController.js
server/db/migrations/016_notifications.sql
client/src/features/notifications/{NotificationList,NotificationItem,
                                   ChannelBadge}.jsx
```

### Acceptance criteria

- [ ] A notification cannot be lost by a crash between commit and delivery (outbox)
- [ ] A retried booking does not duplicate a notification
- [ ] Reminders send automatically once per appointment
- [ ] `read_at` survives a restart (fixes D8)
- [ ] Delivery status is tracked per channel
- [ ] No 500-row cap; retention is a scheduled job
- [ ] Notification icons render per event type
- [ ] A user can read only their own notifications

### Tests required

- **Integration**: notification row created in the same transaction as the appointment
- **Integration**: a failed outbox row retries then dead-letters
- **Integration**: reminder sweep is idempotent (second run sends nothing)
- **Integration**: non-owner gets **403** on another user's notifications
- **Component**: optimistic mark-all-read rolls back on failure

---

## PHASE 11 — Gemini AI triage

### Objective
Harden the AI feature and rebrand it precisely as **"AI-assisted symptom triage and specialty
recommendation"** — never diagnosis.

### Depends on
Phase 3 (auth), Phase 4 (doctor data for grounding).

### Major tasks

| # | Task |
| --- | --- |
| 11.1 | `integrations/gemini.js` behind a `TriageProvider` interface |
| 11.2 | **Move the API key out of the query string** into a header |
| 11.3 | Upgrade off the retired `gemini-1.5-flash`; make the model configurable |
| 11.4 | Zod-validate the model output; discard and fall back on any deviation |
| 11.5 | Constrain departments to the **specialties table** — already done, keep and test |
| 11.6 | Tighten the prompt: explicitly forbid diagnosis; require `redFlags`; discourage prescribing |
| 11.7 | Add a retry/backoff wrapper; keep the 8 s timeout |
| 11.8 | Rule-based engine stays as the deterministic fallback — **never remove it** |
| 11.9 | Persist every triage to `triage_sessions` (provider, urgency, latency, red flags) |
| 11.10 | Auth-gate `GET /api/ai/provider` in production |
| 11.11 | Fix the anonymous-landing-page 401 (D2) — decide public vs authenticated, then agree |
| 11.12 | `age` / `gender` / `history` plumbed through and shown in the UI |
| 11.13 | Copy pass: "triage", "recommendation", "not a diagnosis" everywhere |
| 11.14 | Emergency escalation banner on `urgency === "high"` |
| 11.15 | Prompt-injection note: free text is untrusted; output stays schema-constrained |
| 11.16 | Per-user daily triage quota, on top of the IP rate limit |

### Expected files

```
server/src/integrations/gemini.js            # NEW
server/src/services/triageService.js          # NEW
server/src/services/aiService.js             # rules + ranking retained
server/src/repositories/triageRepo.js         # NEW
server/src/controllers/aiController.js
server/src/routes/aiRoutes.js
server/db/migrations/017_triage_sessions.sql
client/src/features/triage/{SymptomChecker,TriageResult,
                            RecommendedDoctors,EmergencyBanner}.jsx
```

### Acceptance criteria

- [ ] The API key never appears in a URL, log line or error message
- [ ] The model is configurable and off the retired version
- [ ] Malformed model output falls back cleanly to the rule engine
- [ ] `departments` are always real specialties from the database
- [ ] `recommendedDoctorIds` always resolve to real doctors
- [ ] `provider` accurately reports which engine answered
- [ ] Every triage is recorded in `triage_sessions`
- [ ] With no API key, the feature works fully on the fallback
- [ ] A latency figure is recorded per request
- [ ] No UI copy implies diagnosis
- [ ] `urgency === "high"` shows a prominent escalation banner

### Tests required

- **Unit**: rule-based scoring — "chest pain" → Cardiology/high; "child fever" → Pediatrics
- **Unit**: no keyword match → General Medicine, urgency `low`
- **Unit**: `parseModelJson` handles fenced, prose-wrapped and malformed output
- **Integration**: an unreachable Gemini endpoint → rule-based fallback, HTTP 200
- **Integration**: the key is absent from every log line
- **Integration**: every triage writes one `triage_sessions` row
- **Integration**: rate limit and daily quota enforced

---

## PHASE 12 — Admin dashboard

### Objective
Complete admin CRUD, add audit logging, and replace the in-memory analytics with SQL.

### Depends on
Phase 4 (reference data), Phase 6 (analytics service), Phase 3 (auth).

### Major tasks

| # | Task |
| --- | --- |
| 12.1 | `analyticsService` — SQL aggregates: `COUNT FILTER (WHERE …)`, `generate_series` for the trend |
| 12.2 | KPIs: totals, completed, cancelled, no-show rate, utilisation, revenue |
| 12.3 | By-specialty and by-facility breakdowns |
| 12.4 | Top doctors by completed volume and revenue |
| 12.5 | Date-range selector; cache in Redis-free memory for 60 s |
| 12.6 | Doctor CRUD — **create**, update, deactivate (`is_active`), reassign facility |
| 12.7 | Facility CRUD — update, deactivate |
| 12.8 | Specialty and service CRUD |
| 12.9 | **Remove `rating` from the admin allow-list** (S-17) |
| 12.10 | Patient administration — paginated, **with an `audit_logs` write on every PHI read** |
| 12.11 | Audit log viewer UI |
| 12.12 | Appointment oversight — filterable across the whole platform |
| 12.13 | Optional: a charting library (Recharts) instead of the hand-rolled SVG sparkline |
| 12.14 | Tailwind migration for all admin screens |

### Expected files

```
server/src/services/adminService.js
server/src/services/analyticsService.js
server/src/repositories/auditRepo.js
server/src/controllers/adminController.js     # rewritten
server/src/routes/adminRoutes.js
server/db/migrations/018_admin.sql
client/src/features/admin/{AdminDashboard,KpiTiles,TrendChart,
                           SpecialtyBreakdown,TopDoctors,
                           DoctorManager,FacilityManager,
                           PatientDirectory,AuditLogViewer,
                           AppointmentOversight}.jsx
```

### Acceptance criteria

- [ ] The admin overview runs entirely in SQL — no full-table scans in JavaScript
- [ ] Response time at 10,000 appointments stays under 500 ms
- [ ] Admins can create, edit and deactivate doctors and facilities
- [ ] `rating` cannot be set via the API → **422**
- [ ] Every admin read of patient PHI writes an `audit_logs` row
- [ ] The audit log is filterable by actor, resource and date
- [ ] Analytics respect the selected date range

### Tests required

- **Integration**: admin analytics match a hand-computed fixture exactly
- **Integration**: `PATCH /admin/doctors/:id {"rating": 5}` → **422**
- **Integration**: creating a doctor creates the user + doctor rows atomically
- **Integration**: reading patient PHI writes exactly one audit row
- **Performance**: 10,000 appointments → overview < 500 ms
- **Component**: KPI tiles and the trend chart render the fixture data

---

## PHASE 13 — Validation & error handling

### Objective
Harden request validation and error handling across every endpoint. A consolidation phase.

### Depends on
Runs **continuously** from Phase 3; finalised after Phase 12.

### Major tasks

| # | Task |
| --- | --- |
| 13.1 | Replace `validateRequest.js` with Zod schemas in `server/src/schemas/` |
| 13.2 | `.strict()` everywhere → unknown keys rejected (closes S-08 permanently) |
| 13.3 | Validate `body`, `query` **and** `params` — today only `body` |
| 13.4 | Consistent `422` shape: `{field, message, code}` |
| 13.5 | Re-export schemas for the client to validate responses in dev |
| 13.6 | `mapDbError` — `23505`/`23P01`/`23503` → 409 with friendly messages |
| 13.7 | `errorHandler` — preserve `requestId` in the response |
| 13.8 | Rate-limiter responses conform to the standard envelope (TD-31) |
| 13.9 | Structured JSON logging with `requestId`; PHI redacted from logs |
| 13.10 | 404 handler distinguishes `/api` from SPA routes |
| 13.11 | Audit every route for a missing ownership check |
| 13.12 | Assert no endpoint returns a raw persistence object |
| 13.13 | `AppError` catalogue — one documented code per failure mode |
| 13.14 | Global body-size limit (100 kb) |

### Expected files

```
server/src/schemas/{auth,doctor,appointment,slot,notification,admin,
                    triage,common}.schema.js
server/src/middleware/{validate,errorHandler,notFound,requestId}.js
server/src/utils/{dbErrors,AppError}.js
server/src/utils/logger.js
server/src/app.js
client/src/lib/validation/responseSchemas.js
```

### Acceptance criteria

- [ ] Every mutating route validates `body` **and** `params` with a strict schema
- [ ] An unknown field in any request → **422**
- [ ] Every failure uses the standard envelope, including rate-limit responses
- [ ] Every error response carries a `requestId` that also appears in the logs
- [ ] No log line contains a password, token or full phone number
- [ ] No endpoint returns a raw persistence object (automated check)
- [ ] Every per-resource route has an ownership check (automated check)

### Tests required

- **Integration**: unknown field → 422 for each of the ~12 mutating routes
- **Integration**: malformed body → 422 with field-level detail
- **Integration**: `23505` / `23P01` → the correct 409 and a friendly message
- **Automated sweep**: iterate every route, assert the envelope and the absence of secrets
- **Unit**: `logger` redacts password/token/phone

---

## PHASE 14 — Testing

### Objective
Build the Jest + Supertest suite that keeps the v2 correct.

### Depends on
Phase 13 (final validation and error contracts).

### Major tasks

| # | Task |
| --- | --- |
| 14.1 | Jest config: `node` for the server; `jsdom` + RTL for the client |
| 14.2 | `supertest` against the Express app (no port) |
| 14.3 | Test DB factory; per-test transaction rollback; seeded fixtures |
| 14.4 | **Unit** — services, validators, formatters, state machine |
| 14.5 | **Integration** — every route: happy path, authn, authz, validation, not-found |
| 14.6 | **Concurrency** — the 20-parallel-bookings test (Phase 6) |
| 14.7 | **Component** — React Testing Library for shared components |
| 14.8 | **E2E** — Playwright; promote `scripts/ui-walkthrough.mjs` and fix its port bug |
| 14.9 | Retain `scripts/smoke.js` as a deployed-instance health check |
| 14.10 | Coverage targets: services ≥90%, repositories ≥80%, routes ≥85% |
| 14.11 | `test:unit`, `test:integration`, `test:e2e`, `test:all` scripts |
| 14.12 | Tests must be deterministic — no reliance on wall-clock "today" |
| 14.13 | Seed the AI and notification providers as fakes in tests |

### Expected files

```
jest.config.js                 server/tests/
server/tests/setup.js
server/tests/factories/{user,doctor,slot,appointment,facility}.js
server/tests/unit/{bookingService,authService,triageService,
                   validateRequest,appointmentStatusMachine,format}.test.js
server/tests/integration/{auth,doctors,slots,appointments,queue,
                          notifications,admin,triage}.test.js
server/tests/integration/booking.concurrency.test.js
client/vitest.config.js
client/src/**/__tests__/*.test.jsx
e2e/{auth,booking,reschedule,cancel,checkin,realtime,admin}.spec.js
playwright.config.js
```

### Acceptance criteria

- [ ] `npm test` runs the whole suite locally with one command
- [ ] No test depends on the current date/time — fixed clock or injected `now`
- [ ] The 20-concurrent-bookings test proves exactly one winner
- [ ] Every route in [api-inventory.md](./api-inventory.md) has at least one integration test
- [ ] Every S-0x finding has a regression test that fails without its fix
- [ ] Coverage thresholds are enforced, not merely reported
- [ ] E2E covers all three roles end to end
- [ ] The suite is deterministic across 10 consecutive runs

### Tests required

This phase **is** the tests. Priority order:

1. **Booking concurrency** — the highest-value test in the project
2. **Authz matrix** — ownership across every per-resource route
3. **Auth** — hashing, refresh rotation, revocation, role assignment
4. **Slot lifecycle** — generation, blocking, booking, release
5. **Status machine** — the complete transition matrix
6. **Notifications** — outbox, retries, dedupe
7. **Triage** — rules, fallback, output validation
8. **Admin** — CRUD, audit logging, analytics fixtures

---

## PHASE 15 — Swagger / OpenAPI

### Objective
Produce a live, accurate OpenAPI 3.1 specification served as interactive documentation.

### Depends on
Phase 13 (final routes and schemas).

### Major tasks

| # | Task |
| --- | --- |
| 15.1 | OpenAPI 3.1 spec at `server/src/openapi/openapi.yaml` |
| 15.2 | Per-route JSDoc → schema, so docs cannot drift from code |
| 15.3 | Security scheme: bearer JWT |
| 15.4 | Document all 38+ endpoints, including every error code |
| 15.5 | `components.schemas` from the Zod definitions — **one source of truth** |
| 15.6 | Serve Swagger UI at `/api/docs`; the JSON spec at `/api/docs.json` |
| 15.7 | Tag by domain: Auth, Doctors, Slots, Appointments, Queue, Notifications, Triage, Admin |
| 15.8 | Request/response examples from the real fixtures |
| 15.9 | Document the standard envelope and the error-code catalogue |
| 15.10 | Gate the docs route in production behind auth |
| 15.11 | Postman collection generated from the spec, for reviewers |
| 15.12 | `lint:openapi` in CI |

### Expected files

```
server/src/openapi/openapi.yaml
server/src/openapi/swagger.js
server/src/openapi/schemas/{user,doctor,slot,appointment,
                            notification,triage,admin,envelope}.js
server/src/routes/*.js                        # JSDoc @openapi annotations
server/tests/openapi.spec.js                  # every route documented
docs/api-reference.md                         # generated
```

### Acceptance criteria

- [ ] `GET /api/docs.json` returns a valid OpenAPI 3.1 document
- [ ] **Every** registered Express route appears in the spec — enforced by a test
- [ ] Every documented error code matches `AppError` usage in the code
- [ ] Swagger UI loads and "Try it out" works against the live API with a real token
- [ ] Schemas derive from Zod, not from hand-written duplicates
- [ ] Docs are auth-gated in production

### Tests required

- **Integration**: enumerate Express routes, assert 100% spec coverage
- **Integration**: every `error.code` in the source appears in the spec
- **Validation**: the spec passes a linter
- **Component**: `Try it out` returns a 200 for a documented route

---

## PHASE 16 — Docker & deployment

### Objective
Make the application deployable to Vercel (frontend) and Render (backend), containerised
and reproducible.

### Depends on
Phase 1 (working build), Phase 2 (hosted database).

### Major tasks

| # | Task |
| --- | --- |
| 16.1 | `server/Dockerfile` — multi-stage, non-root, `node --watch` excluded from production |
| 16.2 | `docker-compose.yml` — API + local Supabase (Postgres + Realtime) |
| 16.3 | `.dockerignore` |
| 16.4 | `client/vercel.json` — SPA rewrite `/* → /index.html` |
| 16.5 | `server/render.yaml` — build, start, health-check path, env var declarations |
| 16.6 | Backend env: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `JWT_SECRET`, `CORS_ORIGIN`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `RESEND_API_KEY`, `TWILIO_*`, `NODE_ENV=production`, `PORT` |
| 16.7 | Frontend env: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| 16.8 | Verify the CORS allow-list resolves to the Vercel domain — **fixes the current masked failure** |
| 16.9 | Health check endpoint suitable for Render |
| 16.10 | Production logging; `NODE_ENV=production` verified at boot |
| 16.11 | Production React build + minification verified |
| 16.12 | `docker-compose` smoke test in CI |
| 16.13 | **Service-role keys confirmed server-only** — never in the client bundle |
| 16.14 | Deployment runbook in the README |
| 16.15 | Zero-downtime notes for migrations during deploy |

### Expected files

```
server/Dockerfile
server/.dockerignore
docker-compose.yml
client/vercel.json
server/render.yaml
.env.production.example
docs/deployment.md
```

### Acceptance criteria

- [ ] `docker compose up` yields a working API + local Supabase
- [ ] The image runs as a non-root user and contains no dev dependencies
- [ ] The API deployed on Render passes its health check
- [ ] The Vercel frontend reaches the Render API with **no** CORS errors
- [ ] A hard refresh on any SPA route serves `index.html`
- [ ] `VITE_*` values are baked at build time; secrets are **not** in the bundle
- [ ] The `medicare_token` key never appears in the deployed JS
- [ ] A cold start reaches a ready state within the platform's timeout

### Tests required

- **Integration**: `docker compose up` then the smoke suite → 35/35
- **Manual**: full deploy to Vercel + Render, every role exercised
- **Smoke**: `curl https://<api>/api/health` from outside the network
- **Bundle audit**: grep the production bundle for secrets

---

## PHASE 17 — CI/CD

### Objective
Every push verified automatically; deployment automated.

### Depends on
Phase 14 (tests), Phase 16 (Docker).

### Major tasks

| # | Task |
| --- | --- |
| 17.1 | GitHub Actions: `install` (catches TD-01 the moment it returns) |
| 17.2 | `lint` — ESLint + Prettier check |
| 17.3 | `typecheck` — if TypeScript is adopted |
| 17.4 | `test:unit` + `test:integration` against a Postgres service container |
| 17.5 | `test:e2e` — Playwright, with an artifact upload on failure |
| 17.6 | `build` — client build + a secret scan on the bundle |
| 17.7 | `docker build` to prove the image builds |
| 17.8 | `lint:openapi` |
| 17.9 | `npm audit` with an allowlist for accepted advisories |
| 17.10 | Concurrency group; cancel superseded runs |
| 17.11 | Branch protection: CI green before merge |
| 17.12 | Dependabot for `npm` + `github-actions` |
| 17.13 | Deploy: Vercel on `main`; Render on `main` |
| 17.14 | Cache `node_modules` and the Playwright browser |
| 17.15 | Required status checks configured |

### Expected files

```
.github/workflows/ci.yml
.github/workflows/deploy.yml
.github/dependabot.yml
.github/workflows/codeql.yml         # optional
```

### Acceptance criteria

- [ ] Every PR runs install → lint → test → build → docker
- [ ] CI catches a deliberately reintroduced `hashed:` password (proves the scan works)
- [ ] Integration tests run against a real Postgres, not a mock
- [ ] E2E artifacts (screenshots, traces) upload on failure
- [ ] A green `main` auto-deploys the frontend to Vercel
- [ ] Merging to `main` with a red check is blocked
- [ ] Total pipeline < 10 minutes

### Tests required

- **CI self-test**: open a PR that breaks the build; confirm CI fails
- **CI self-test**: reintroduce `hashed:` in a scratch branch; confirm the scan fails
- **CI self-test**: revert; confirm green again

---

## PHASE 18 — Final QA & security

### Objective
Prove the application is correct and secure before it is shown to anyone.

### Depends on
Phases 3–17.

### Major tasks

| # | Task |
| --- | --- |
| 18.1 | Re-run every [S-0x finding](./security-audit.md) as a regression test; confirm each is closed |
| 18.2 | Verify every `23505` / `23P01` path returns a friendly 409 |
| 18.3 | Authorization matrix test — every endpoint × every role |
| 18.4 | Confirm no endpoint returns password or token material |
| 18.5 | `npm audit`; resolve or document every advisory |
| 18.6 | Confirm no secret is in the client bundle or the git history |
| 18.7 | Confirm the committed `db.json` and `dist/` are gone |
| 18.8 | Load test the booking path |
| 18.9 | Cross-browser check (Chrome, Firefox, Safari, mobile) |
| 18.10 | Keyboard-only pass — focus trap in `Modal`, focus restore |
| 18.11 | Screen-reader pass on the primary flows |
| 18.12 | Lighthouse on the production build |
| 18.13 | Validate all timezones — the current `todayISO()` UTC bug must be gone |
| 18.14 | Verify RLS from the anon key |
| 18.15 | Full manual journey per role, end to end, on the deployed URLs |
| 18.16 | AI safety review: no copy implies diagnosis; the escalation banner works |
| 18.17 | Review that the AI feature is labelled "triage / recommendation" |
| 18.18 | Confirm `.env.example` documents every required variable |

### Acceptance criteria

- [ ] All 22 security findings closed, each with a passing regression test
- [ ] The authorization matrix test passes for every endpoint × role
- [ ] Zero high or critical advisories
- [ ] No secret in git history, in the bundle, or in a log line
- [ ] Booking holds correct under load
- [ ] No timezone-dependent behaviour
- [ ] WCAG AA on the primary flows
- [ ] Lighthouse: performance ≥90, accessibility ≥90, best practices ≥90, SEO ≥90
- [ ] All three role journeys pass on the deployed URLs

### Tests required

- **Security**: the full S-01…S-22 regression suite
- **Matrix**: endpoint × role authorisation, generated automatically
- **Load**: 500 concurrent booking attempts on 50 slots → exactly 50 succeed
- **A11y**: automated axe pass + a manual keyboard and screen-reader pass
- **Visual**: cross-browser screenshots at three breakpoints

---

## PHASE 19 — README, GitHub & resume preparation

### Objective
Make the project legible and credible to a reviewer, hiring manager or resume reader.

### Depends on
Phase 18.

### Major tasks

| # | Task |
| --- | --- |
| 19.1 | Rewrite `README.md` — **verify every claim against the code** (TD-24) |
| 19.2 | Screenshots / GIFs: landing, doctor directory, booking, provider queue, admin dashboard |
| 19.3 | Live demo URL + a 60-second screen recording |
| 19.4 | **Honest limitations section** — AI is advisory, notifications are configurable, data is synthetic |
| 19.5 | Architecture diagram |
| 19.6 | Data-model diagram (ERD) from the live schema |
| 19.7 | The booking-concurrency design, explained — the standout engineering artefact |
| 19.8 | Realtime architecture |
| 19.9 | Setup: prerequisites, `npm install`, `npm run dev`, `docker compose up` |
| 19.10 | Environment-variable table |
| 19.11 | Seeded demo credentials (documented, **not served by an endpoint**) |
| 19.12 | API overview + a link to `/api/docs` |
| 19.13 | Testing overview: how to run each suite, what is covered |
| 19.14 | Deployment instructions |
| 19.15 | **Troubleshooting** — the section most READMEs lack and reviewers notice |
| 19.16 | Tech-stack rationale — *why* each choice |
| 19.17 | GitHub: description, topics, a banner |
| 19.18 | `CONTRIBUTING.md` |
| 19.19 | Clean commit history (squashed, conventional commits) |
| 19.20 | Linked issues/roadmap showing post-v2 thinking |
| 19.21 | `LICENSE` |
| 19.22 | Resume bullets, drafted from what was actually built |

### Expected files

```
README.md                         # rewritten, every claim verified
docs/{architecture,current-state,feature-matrix,api-inventory,
      database-migration-plan,security-audit,technical-debt,
      v2-roadmap}.md              # ← Phase 0 output, updated to reflect the final state
docs/erd.md
docs/screenshots/*.png
CONTRIBUTING.md
LICENSE
.github/{ISSUE_TEMPLATE,PULL_REQUEST_TEMPLATE}.md
```

### Acceptance criteria

- [ ] **Every README claim is verifiable against the code** — a fresh clone follows it successfully
- [ ] The limitations section is candid, not marketing
- [ ] Diagrams render on GitHub
- [ ] A reviewer can go from clone to running app in under 5 minutes
- [ ] Demo credentials are documented but not served by any endpoint
- [ ] No `docs/` file contradicts another
- [ ] `docs/security-audit.md` shows every finding closed
- [ ] Resume bullets describe what exists, with no inflation

### Tests required

- **Documentation**: a fresh clone follows the README verbatim, on a clean machine
- **Link check**: every internal doc link resolves
- **Claim check**: each "feature X exists" line is verified against a route or a file
- **Setup timing**: clone → running app measured and documented

---

## Summary

| Phase | Objective | Depends on | Estimate |
| --- | --- | --- | --- |
| 1 | Foundation & cleanup | — | 2–3 days |
| 2 | Supabase PostgreSQL | 1 | 5–7 days |
| 3 | Auth & security | 2 | 4–5 days |
| 4 | Doctor / specialty / facility APIs | 3 | 3–4 days |
| 5 | Slots & availability | 4 | 3–4 days |
| 6 | **Appointment system ★** | 5 | **5–7 days** |
| 7 | Patient dashboard | 6 | 4–5 days |
| 8 | Doctor dashboard | 6, 5 | 3–4 days |
| 9 | Realtime queue | 8 | 3–4 days |
| 10 | Notifications | 6 | 2–3 days |
| 11 | Gemini AI triage | 3, 4 | 2–3 days |
| 12 | Admin dashboard | 4, 6 | 3–4 days |
| 13 | Validation & errors | continuous | 2–3 days |
| 14 | Testing | 13 | 5–7 days |
| 15 | Swagger / OpenAPI | 13 | 2–3 days |
| 16 | Docker & deployment | 1, 2 | 2–3 days |
| 17 | CI/CD | 14, 16 | 2–3 days |
| 18 | Final QA & security | all | 3–4 days |
| 19 | README / GitHub / resume | 18 | 2–3 days |
| | **Total** | | **≈ 12–15 weeks** |

A tighter schedule is realistic if Phases 7–12 reuse the existing pages' structure (they
mostly do — they are TanStack Query migrations and Tailwind conversions, not rewrites) and if
Tailwind conversion is accepted as a separate cosmetic pass rather than done inline.
**Phases 1, 2, 3, 6 and 14 are non-negotiable**; the rest can be reordered or trimmed without
producing an insecure or incorrect system.

---

**Phase 0 is complete. Awaiting instructions before starting Phase 1.**