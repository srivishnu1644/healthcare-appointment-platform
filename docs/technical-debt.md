# MediCare — Technical Debt Audit

**Phase 0 deliverable. Nothing has been refactored.** Every item is either a source citation
or a reproduced failure.

---

## 1. Debt inventory by severity

| # | Area | Debt | Severity |
| --- | --- | --- | --- |
| TD-01 | Build | Client `npm ci` fails — Vite 8 vs `@vitejs/plugin-react` 4 peer conflict | **Blocker** |
| TD-02 | Data | No data-access layer; 10 files import the `db` singleton (118 references) | **Critical** |
| TD-03 | Correctness | Booking has no transaction, lock or constraint | **Critical** |
| TD-04 | Security | Passwords stored as `` `hashed:${plain}` ``; 22 findings total | **Critical** |
| TD-05 | Security | 3 IDOR / privilege-escalation defects (S-05, S-06, S-07) | **Critical** |
| TD-06 | Data | Heavy denormalisation; `slots.appointmentId` desyncs (proven) | **High** |
| TD-07 | Data | No constraints, indexes, foreign keys or unique rules anywhere | **High** |
| TD-08 | Data | Dates/times as timezone-less strings | **High** |
| TD-09 | Perf | Whole-file sync `writeFileSync` on every mutation | **High** |
| TD-10 | Perf | In-memory filtering/sorting; ~130 array scans per admin request | **High** |
| TD-11 | Frontend | No Tailwind — 908-line hand-written CSS, target stack requires it | **High** |
| TD-12 | Frontend | No data layer; every page hand-rolls fetch/loading/error | **High** |
| TD-13 | Tests | Zero automated tests | **High** |
| TD-14 | Deploy | No CI, no Docker, no `.gitignore`, no `.env.example` | **High** |
| TD-15 | Quality | 4 dead exports, 3 pointless re-exports, 11 unused imports | Medium |
| TD-16 | Quality | File-size outliers (435/430/428/389/374/281/374-line files) | Medium |
| TD-17 | Duplication | 7 duplicated helpers between `notificationService` and `notificationController` | Medium |
| TD-18 | Duplication | Duplicate `useNotifications` pollers; duplicate slot-picker UIs | Medium |
| TD-19 | Quality | 3 verified UI defects (D3/D4/D5) from contract drift | Medium |
| TD-20 | Consistency | Role naming: `"provider"` / `"doctor"` / `"ProviderDashboard"` | Medium |
| TD-21 | Quality | `logger.tag()` prints a nested array (D7) | Low |
| TD-22 | Repo hygiene | `client/dist` + 468 KB `db.json` committed; `recordings/` empty | Low |
| TD-23 | Quality | Stray `eslint-disable` comments with no ESLint config | Low |
| TD-24 | Docs | README claims that the code does not support | Low |

---

## 2. Build & toolchain

### TD-01 — The client cannot be installed or built. **Blocker**

```json
"devDependencies": { "@vitejs/plugin-react": "^4.3.1", "vite": "^8.3.2" }
```

`@vitejs/plugin-react@4.7.0` declares peer `vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0"`.
Vite 8 is outside the range.

```
$ cd client && npm ci
npm error code ERESOLVE
npm error While resolving: @vitejs/plugin-react@4.7.0
npm error Found: vite@8.3.2
npm error peer vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0" from @vitejs/plugin-react@4.7.0
```

`npm install` fails identically. `client/package-lock.json` commits the same invalid pair, so
**Vercel and CI both fail on a clean checkout.** `server/` installs cleanly (91 packages).

The committed `client/dist/` (Oct 3, 280 KB) predates this and is why the app appears
deployable.

**Fix:** upgrade `@vitejs/plugin-react` to `^6` (supports Vite 8) — one line, unblocks
everything.

### TD-22 — Repository hygiene

- **Not a git repository.** No `.git`, no `.gitignore`, no history.
- `client/dist/` — 280 KB build artifact committed.
- `server/.data/db.json` — 468 KB runtime data committed, containing **every password in
  plaintext** (S-02).
- `recordings/` — exists, empty.
- No `.env.example`.
- `.vscode/settings.json` — a single unrelated Postman key.

**Fix:** `.gitignore` for `node_modules/`, `dist/`, `.data/`, `.env`, `recordings/*.webm`.
`git init` only after that. The one thing currently right is that no secret has a *value* in
a committed file — protect that.

### TD-14 — No delivery infrastructure

Absent: `.github/`, `.gitlab-ci.yml`, `Dockerfile`, `docker-compose.yml`, `render.yaml`,
`vercel.json`, `jest.config.js`, ESLint config, Prettier config.

`package.json` has no `test`, `lint` or `format` script. The only automation is
`npm run dev`, `build`, `start`, `install:all`.

### TD-23 — Stray lint suppressions

`authController.js:11`, `notificationService.js:193`, `Home.jsx:73`,
`DoctorProfile.jsx:40`, `DoctorCard.jsx:107` contain `eslint-disable-next-line
react-hooks/exhaustive-deps` / `global-require` — but **there is no ESLint configuration in
the repo**. The directives do nothing; they signal an abandoned intent to lint.

---

## 3. Architecture & layering

### TD-02 — No data-access layer

`config/db.js` exports the live object as default. Imported by exactly **10** source files:

- controllers (5): `authController`, `doctorController`, `appointmentController`,
  `adminController`, `notificationController`
- services (3): `appointmentService`, `aiService`, `notificationService`
- middleware (1): `authMiddleware`
- app wiring (1): `app.js` (only for the `/api/health` row counts)

Every one of the nine logic files does ad-hoc queries inline:

```js
db.doctors.filter((d) => d.facilityId === f.id)
db.appointments.filter((a) => a.patientId === u.id)
db.specialties.find((s) => s.name.toLowerCase() === String(n).toLowerCase())
```

`README.md` states "Swapping in MongoDB means replacing that one module." **That claim is
wrong.** The seam is physical, not structural — replacing the store means rewriting the **118**
`db.<collection>` references spread across 10 importing files. The v2 `repositories/` layer is
what makes the claim true.

### TD-16 — Layering exceptions

| Location | Problem |
| --- | --- |
| `adminController.overview` (120 of 281 lines) | Analytics aggregation in an HTTP controller; ~130 full-array scans |
| `appointmentController.changeStatus:171` | Fires `notifyStatusChange` inline — a side effect that belongs in the service |
| `adminController.listDoctorsAdmin:170` | Conditional mapping (`d.email !== undefined ? d : withAccount(d)`) — a code smell that masks a projection bug |
| `notificationController.markRead` | Re-implements logic that already exists in `notificationService.markAllRead` — and does it worse (no `persist()`) |

### TD-21 — `logger.tag()` is broken

```js
// server/src/utils/logger.js:4 and :17
const write = (level, tag, args) => { ... console.log(prefix, ...args); };
tag(name) { return { info: (...a) => write("INFO", name, a), ... }; }   // line 17
```

`a` is the rest-args **array**, so `...args` spreads one array. Every multi-argument tagged log
line prints `['message1', 'message2']`.

---

## 4. Correctness

### TD-03 — Booking has no concurrency protection

Full detail in [current-state.md §7](./current-state.md#7-booking-behaviour--verified-matrix).
Summary of what is and is not protected:

| Guard | Present |
| --- | --- |
| Exact same slot already booked | Yes (in-process only) |
| Slot blocked by provider | Yes |
| Slot in the past | Yes |
| Slot belongs to the doctor | Yes |
| **Overlapping slot, same patient** | **No — reproduced, both accepted** |
| **Concurrent booking across processes** | **No** |
| **Client-supplied `mode` vs slot mode** | **No — reproduced** |
| **Reschedule into the past** | **No — reproduced** |
| **Cancel via `/status` releases the slot** | **No — reproduced, slot stuck `booked`** |
| **Check-in on a future appointment** | **No — reproduced, 2031 date accepted** |
| **Fee refreshed on reschedule** | **No — reproduced, 500 stayed 500** |

### TD-06 — Proven data desync

Two `cancel` paths diverge:

| Path | Appointment | Slot |
| --- | --- | --- |
| `PATCH /:id/cancel` → `cancelAppointment` | `cancelled` | released → `available` ✅ |
| `PATCH /:id/status {"cancelled"}` → `updateStatus` | `cancelled` | **stays `booked` ❌** |

Reproduced. The slot becomes permanently unbookable — a silent capacity leak with no error
and no log.

Root cause: slot occupancy is maintained by whichever code path happens to run, rather than by
a single invariant.

### TD-19 — UI/API contract drift (3 verified defects)

| Defect | Symptom |
| --- | --- |
| `upcomingAppointments` is a `number`, the UI expects an array | "Next appointments" block never renders (`(5).length` is `undefined`) |
| `EVENT_ICON` keys are `booked`/`reminder`/…, real values are `appointment_booked`/… | Every notification icon falls back to 🔔 |
| `channels.simulated` is rendered but never returned | "Simulated" badge can never appear |

There is **no shared schema and no contract test** between client and server, so this class of
bug is invisible until a human clicks. `scripts/shapes.js` exists precisely to catch it and is
not wired into any automated check.

### TD-25 — Page-level logic duplication

| Duplicated | Where |
| --- | --- |
| `STATUS_ACTIONS` / `ALLOWED_TRANSITIONS` | `ProviderDashboard.jsx:26` vs `appointmentService.js:329` — the client cannot drift safely from a hand-copied map |
| Slot picker (date tabs + mode groups + confirm) | `DoctorCard.jsx` `BookingPanel` and `MyAppointments.jsx` reschedule modal |
| Appointment card (date block, badges, status) | `Home.jsx`, `MyAppointments.jsx`, `ProviderDashboard.jsx` |
| `withAccount` projection | `adminController.listDoctorsAdmin` vs `shapeDoctor` |
| `notificationService.listNotifications` / `markAllRead` | Re-implemented inline in `notificationController` |

---

## 5. Frontend

### TD-11 — No Tailwind

The v2 target stack requires Tailwind. The repo has **zero** Tailwind references (verified by
grep). Instead:

- 908-line `client/src/styles/index.css` with hand-written tokens and utilities
- Extensive inline `style={{...}}` in every page — `Layout.jsx` alone has ~15

Migration is mechanical but broad: every component needs its inline styles translated.

### TD-12 — No data layer

Every page hand-rolls the same pattern:

```jsx
const [data, setData] = useState(null);
const [loading, setLoading] = useState(true);
const [error, setError] = useState(null);
const load = useCallback(async () => { try { ... } catch { setError } finally { setLoading(false) } }, []);
useEffect(() => { load(); }, [load]);
```

Repeated in `Home`, `DoctorDirectory`, `DoctorProfile`, `MyAppointments`, `ProviderDashboard`,
`Profile`, and all five admin pages — 12 copies. No caching, no dedupe, no invalidation, no
retry, and two simultaneous pollers when a patient is on the home page.

### TD-13 — Zero automated tests

No `*.test.*`, `*.spec.*`, `__tests__`, or Jest config anywhere. See
[api-inventory / current-state §10](./current-state.md#10-verification-log) for what the manual
smoke suite does cover.

### TD-26 — No error boundary

A throw during render unmounts the whole tree to a blank page. `AsyncBoundary` does not exist.

### TD-27 — No route-level code splitting

All 14 pages are statically imported in `App.jsx`, producing one 262 KB bundle. Admin and
provider screens load for every visitor.

---

## 6. Data layer

### TD-07 — No constraints at all

No foreign keys, no unique indexes, no `CHECK`, no NOT NULL, no enums. Every rule is advisory
JavaScript. Concretely:

- Duplicate emails are only prevented by a JS check in `register`
- Any `doctorId`, `slotId`, `patientId` may dangle
- Status values are free-form strings, validated in *some* routes only
  (`PATCH /:id/status` validates the enum; `joinQueue` does not)
- `rating` can be any value, including negative, via the admin endpoint

### TD-08 — Times as strings

```js
slot:  { date: "2026-10-08", startTime: "09:00", endTime: "09:30" }
```

No timezone, no timestamp. `isBookableDate` compares `date >= todayISO()`, where
`todayISO()` is `new Date().toISOString()` — **UTC**. A user in IST (UTC+5:30) therefore sees
"today" shift by 5.5 hours, and a slot created for "today 09:00 local" is classified against a
UTC date. This is a live correctness bug in an India-focused demo (all cities, INR, `+91`
phones).

### TD-09 — Synchronous whole-file persistence

```js
fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
```

468 KB, fully synchronous, on **every** mutation, blocking the event loop. 14 `persist()`
call sites across 5 files (5 in `appointmentService`, 3 in `notificationService`, 2 each in
`adminController`, `authController`, `doctorController`).
Two Node processes would interleave writes and corrupt the file; there is no locking and no
atomic rename.

### TD-10 — In-memory querying

`adminController.overview` alone runs roughly **130 full-array scans per request**: 6 for the
KPIs, 14 days × 4 for the trend, 10 specialties × 4, 12 doctors × 2, plus ~5 slot counts. At
45 appointments that is fine; at 45,000 it is a timeout.

`listDoctors` has no pagination — `?limit=2` returns 12 (verified).

### TD-30 — `users.profile` is an untyped blob

No schema, no constraints, client-writable (S-08). `allergies` was successfully set to a
string, breaking the array contract that `AdminPatients.jsx` relies on for `.join(", ")`.

---

## 7. Security debt

Full detail in [security-audit.md](./security-audit.md). Consolidated here:

| ID | Severity | Debt |
| --- | --- | --- |
| S-01 | CRITICAL | `/api/demo-accounts` serves plaintext passwords, unauthenticated |
| S-02 | CRITICAL | Passwords stored as `` `hashed:${plain}` `` |
| S-03 | CRITICAL | `GET /api/appointments/:id` leaks `doctor.user.password` |
| S-04 | CRITICAL | `/auth/me` + login leak `doctor.user.password` |
| S-05 | HIGH | `register` accepts `role:"provider"` → doctor + token |
| S-06 | HIGH | `check-in` has no ownership check |
| S-07 | HIGH | `/notifications?patientId=` honoured for non-admins |
| S-08 | HIGH | Unvalidated `profile` merge → key injection |
| S-09 | MEDIUM | Hardcoded fallback JWT secret in two places |
| S-10 | MEDIUM | Rate limiting disabled unless `NODE_ENV=production` |
| S-11 | MEDIUM | `CORS_ORIGIN \|\| true` + `credentials: true` |
| S-12 | MEDIUM | 7-day JWT, no refresh, no revocation |
| S-13 | MEDIUM | No Helmet / CSP / HSTS |
| S-14 | MEDIUM | `bcryptjs` is dead weight — `bcrypt.hash` never called |
| S-15…S-19 | LOW | Health disclosure, queue scoping, admin-set rating, synthetic stats, un-audited PHI |
| S-20 | INFO | Build blocker (TD-01) |
| S-21 | INFO | `.env` committed with no `.gitignore` |
| S-22 | INFO | PII in the JWT payload |

---

## 8. Code quality

### TD-15 — Dead code

**Server exports never imported:**

| Symbol | File |
| --- | --- |
| `requireSelfOrAdmin` | `authMiddleware.js:76` — an ownership guard that was written but never wired in. Its absence is exactly why S-06 exists. |
| `markAllRead` | `notificationService.js:225` |
| `nowISO` | `db.js:26` (export only; used internally) |
| `listSpecialties` | `aiService.js:374` — shadowed by `doctorController.listSpecialties` |

Also exported-but-unused: `QUEUE_STATES` (`db.js:245`), `channels` (`notificationService.js:13`),
`listNotifications` (`notificationService.js:220`).

**Pointless re-export lines:**

| Line | Code |
| --- | --- |
| `appointmentController.js:204` | `export { getSlots, availableDates, id, persist, addMinutes }` |
| `appointmentService.js:423` | `export { addMinutes }` (already exported from `db.js`) |
| `doctorController.js:389` | `export { shape as shapeDoctor }` |

**Unused client imports** (11 across 7 files):

| File | Unused |
| --- | --- |
| `pages/admin/AdminPatients.jsx` | `num` |
| `pages/admin/AdminDashboard.jsx` | `formatDay` |
| `pages/ProviderDashboard.jsx` | `ProgressBar`, `currency`, `relativeDay` |
| `pages/Home.jsx` | `currency` |
| `pages/DoctorDirectory.jsx` | `currency`, `cx` |
| `components/DoctorCard.jsx` | `StatusBadge` |
| `components/SymptomChecker.jsx` | `StatusBadge` |

### TD-16 — File-size outliers

| File | Lines | Issue |
| --- | --- | --- |
| `server/src/config/db.js` | 526 | Seed data + persistence in one module |
| `server/src/services/appointmentService.js` | 423 | Slots + booking + queue + status machine |
| `client/src/pages/Home.jsx` | 435 | Two divergent page variants |
| `client/src/pages/MyAppointments.jsx` | 430 | List + 3 modals |
| `client/src/pages/ProviderDashboard.jsx` | 428 | Dashboard + slot generator modal |
| `server/src/controllers/doctorController.js` | 389 | Discovery + slots + reference data |
| `server/src/services/aiService.js` | 374 | Gemini client + rules + ranking |
| `server/src/controllers/adminController.js` | 281 | 8 unrelated admin concerns |
| `client/src/styles/index.css` | 908 | Whole design system, one file |

Not all large files are bad — `appointmentService.js` is cohesive. `Home.jsx` (two
unrelated views) and `db.js` (seed + persistence) are the clearest split candidates.

### TD-20 — Inconsistent role naming

| Term | Where |
| --- | --- |
| `doctor` | DB `users.role`, all routes, `requireRole("doctor")` |
| `provider` | `register` input enum, `actorRole: "provider"`, README |
| `ProviderDashboard` | Route `/provider`, file name, page title |
| `NO_DOCTOR_PROFILE` | Error code |

Three names for one concept. Pick `doctor` in v2 and use it everywhere.

### TD-31 — Response envelope deviation

The rate-limit handlers return `{success, message}` with **no `error` object**, so
`payload?.error?.code` is `undefined` and the client cannot distinguish a throttle from other
failures.

### TD-24 — README overclaims

| Claim | Reality |
| --- | --- |
| "Appointment history & status tracking … with status chips + timeline" | No timeline exists in `MyAppointments.jsx` |
| "Swapping in MongoDB means replacing that one module" | **118** `db.<collection>` references across 10 importing files |
| "appointmentController … `PATCH /:id/status` (owner (doctor for status))" | Status is doctor/admin only; the owner cannot set it |
| "Express 4, JWT auth (`bcryptjs` + `jsonwebtoken`)" | `bcryptjs` is imported but never used to hash |
| "Real-time (simulated) slot availability" | Accurate — but it should be stated more plainly as "no realtime" |
| Not mentioned | `/api/demo-accounts`, the IDORs, `vite`/plugin-react build failure |

### TD-32 — Validation gaps

`validateRequest.js` flaws:

| Gap | Consequence |
| --- | --- |
| No unknown-key stripping | `profile` injection (S-08) |
| `min` uses `value.length` | Undefined for numbers/booleans → the rule silently never fires |
| `max` compared with `Number(value)` | `"abc"` → `NaN` → comparison is false → passes |
| Applied to `req.body` only | `req.query` and `req.params` are unvalidated everywhere |
| `enum` runs before coercion | A numeric string fails an enum check on a numeric field |
| `PATCH /api/auth/me` has no `validate()` at all | Any shape accepted |

---

## 9. Dependency audit

Declared versions, latest as of 2026-10-08.

### Backend — `server/package.json`

| Dependency | Purpose | Declared | Resolved (lock) | Latest | Verdict | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `express` | HTTP framework | `^4.19.2` | 4.22.3 | **5.2.1** | **KEEP** | Stable and correct for v2. Do not chase 5.x mid-migration — Express 5 changes error semantics and would compete with the service refactor for attention. Reconsider post-v2. |
| `bcryptjs` | Password hashing | `^2.4.3` | 2.4.3 | **3.0.3** | **REPLACE** | 2.x is 3 majors behind and the module is currently unused. Either upgrade to `^3` or drop the dependency entirely in favour of Node's built-in `crypto.scrypt` — fewer deps, no native build. Recommendation: `scrypt`. |
| `jsonwebtoken` | JWT sign/verify | `^9.0.2` | 9.0.3 | 9.0.3 | **KEEP** | Current. Fix usage (S-09, S-12, S-22), not the package. |
| `cors` | CORS | `^2.8.5` | 2.8.6 | 2.8.6 | **KEEP** | Current. Fix configuration (S-11). |
| `dotenv` | Env loading | `^16.4.5` | 16.6.1 | **18.0.6** | **UPGRADE** | 2 majors behind. Low risk — the API surface used here is stable. |
| `morgan` | HTTP logging | `^1.10.0` | 1.12.1 | 1.12.1 | **KEEP** | Current. |
| `express-rate-limit` | Throttling | `^7.4.0` | 7.5.1 | **8.7.1** | **UPGRADE** | Major behind; v8 changes limit-key and `skip` semantics — relevant to S-10. |
| `supabase` / `@supabase/supabase-js` | — | — | — | — | **ADD** | Needed for Realtime (client + server publish). |
| `pg` | Postgres pool | — | — | — | **ADD** | Primary data access. |
| `zod` | Validation | — | — | — | **ADD** | Replaces `validateRequest` (TD-32), validates Gemini output. |
| `swagger-ui-express` / `yaml` | OpenAPI | — | — | — | **ADD** | Phase 15. |
| `jest`, `supertest` | Testing | — | — | — | **ADD** | Phase 14. |
| `nodemon` | Dev reload | — | — | — | **SKIP** | `node --watch` already used. |

### Frontend — `client/package.json`

| Dependency | Purpose | Declared | Latest | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `react` | UI | `^18.3.1` | **19.3.0** | **UPGRADE** | React 19 is 14 months mature with a concurrent-rendering fast path. Pair with the router upgrade. Do it as a dedicated step, not mid-refactor. |
| `react-dom` | DOM renderer | `^18.3.1` | **19.3.0** | **UPGRADE** | With `react`. |
| `react-router-dom` | Routing | `^7.18.4` | 7.18.4 | **KEEP** | **Already latest.** The declared `^7` matches the README's claim of "React Router 6" — the README is out of date, the package is fine. |
| `vite` | Build tool | `^8.3.2` | 8.3.4 | **KEEP** | Current. This is the side of TD-01 that is correct. |
| `@vitejs/plugin-react` | React plugin | `^4.3.1` | **6.1.2** | **REPLACE — urgent** | Peer range excludes Vite 8. `npm ci` fails. Upgrade to `^6`. **Highest-priority dependency change in the repo.** |
| `tailwindcss` + `@tailwindcss/vite` | Styling | — | — | **ADD** | Required by the target stack (TD-11). |
| `@tanstack/react-query` | Data layer | — | — | **ADD** | Replaces 12 hand-rolled fetch hooks (TD-12). |
| `@supabase/supabase-js` | Realtime | — | — | **ADD** | Phase 9. |
| `react-error-boundary` | Error boundary | — | — | **ADD** | TD-26. |
| *chart library* | Admin charts | — | — | **ADD (optional)** | `AdminDashboard` hand-rolls an SVG sparkline and has no bar charts. Recharts is the natural choice. |

### Root — `package.json`

| Dependency | Purpose | Declared | Latest | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `concurrently` | `npm run dev` | `^8.2.2` | **10.0.6** | **UPGRADE** | 2 majors behind; dev-only. |
| `playwright` | UI walkthrough | `^1.63.0` | 1.64.0 | **KEEP** | Near current. Keep for manual walkthroughs; add `@playwright/test` only if E2E is formalised. |

### Not required

Explicitly **not** adding: GraphQL, Redis, Kafka, a queue broker, a logger library (the
built-in one is adequate once fixed), a UUID library (`crypto.randomUUID` exists), an ORM
(repositories are sufficient and an ORM would hide the SQL that the concurrency story depends
on).

---

## 10. Prioritised remediation

### Blockers — fix before anything ships

1. **TD-01** — bump `@vitejs/plugin-react` to `^6`. One line; unblocks Vercel and CI.
2. **S-01** — delete `/api/demo-accounts`. One request currently yields admin access.
3. **S-06 / S-07** — add the ownership checks that `requireSelfOrAdmin` was written for.

### Critical — before the migration starts

4. **S-02 / S-03 / S-04** — bcrypt hashing plus response projections.
5. **S-05 / S-08** — patient-only registration; strict profile validation.
6. **S-09 / S-10 / S-11 / S-13** — env hardening and security headers.

### High — during Phases 1–6

7. **TD-02** — repositories layer.
8. **TD-03 / TD-06** — transactional booking.
9. **TD-07 / TD-08** — constraints and real timestamps.
10. **TD-09 / TD-10** — stop rewriting the file; push filtering into SQL.
11. **TD-11 / TD-12** — Tailwind and a query layer.
12. **TD-13** — Jest + Supertest.
13. **TD-14** — CI, Docker, `.gitignore`.

### Medium / Low — Phases 7–19

14. **TD-15** — remove dead code, including the misleading `requireSelfOrAdmin`.
15. **TD-16 / TD-25** — split `Home.jsx` and `db.js`; extract the duplicated card and slot picker.
16. **TD-19** — fix the three contract-drift defects; add contract tests so they cannot recur.
17. **TD-20 / TD-31 / TD-32** — consistent naming; envelope and validation fixes.
18. **TD-21 / TD-22 / TD-23 / TD-24** — logger fix, repo hygiene, real linting, honest README.

---

## 11. Net assessment

**Estimated effort to a professional v2:** roughly **7–9 weeks** of focused work for one
developer, dominated by Phases 2, 5, 6 and 14 (data model, availability, booking, tests).

**What should not be thrown away:**

| Asset | Why it is valuable |
| --- | --- |
| Route → controller → service layering | Correct already; v2 adds a repository layer beneath, not a rewrite |
| `ALLOWED_TRANSITIONS` state machine | A genuinely well-designed invariant; just move it into the service |
| `AppError` + `asyncHandler` + `errorHandler` | A working centralised-error foundation |
| Response envelope + error codes | Stable contract; the client depends on it |
| `api/client.js` | Complete and accurate — 35 wrappers, a 1:1 mapping onto the server's 38 routes (3 server endpoints intentionally unwrapped). Extend, do not rewrite |
| `ui.jsx` primitives | 12 consistent, well-used primitives; re-skin with Tailwind, keep the API |
| `DoctorDirectory.jsx` | The best page in the repo — URL-synced filters, debounce, all states |
| `useNotifications` hook shape | Correct abstraction; swap polling for Realtime |
| 35-assertion smoke suite | Honest evidence the happy path works; becomes the e2e smoke |
| Notification templates | Good copy; needs an outbox, not a rewrite |
| Gemini prompt + disclaimer framing | Already correct ("do NOT diagnose") — protect this |

**The realistic temptation to resist:** the JSON datastore makes the project *look* finished
because every feature is clickable. It is not finished — four of its defects are actively
exploitable and the booking path is not concurrency-safe. Migrating the data layer is what
turns a prototype into a system, and it is the highest-leverage work in the whole migration.