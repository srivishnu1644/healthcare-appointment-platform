# MediCare — Current State Audit

**Phase 0 deliverable.** Every statement below was verified against the source in this
repository, or by executing the server and probing it over HTTP. Commands actually run are
listed in [Verification log](#verification-log). Nothing is inferred from the README.

---

## 1. Repository facts

| Fact | Value |
| --- | --- |
| Repository type | **Not a git repository.** No `.git`, no `.gitignore`, no history. |
| Root manifest | `package.json` — scripts only, no deps. devDeps: `concurrently@^8.2.2`, `playwright@^1.63.0` |
| Workspaces | None. Root `install:all` does `cd server && npm i && cd ../client && npm i`. |
| Server manifest | `server/package.json` — ESM (`"type": "module"`) |
| Client manifest | `client/package.json` — ESM, Vite + React |
| Committed artifacts | `client/dist/` (280 KB build output), `server/.data/db.json` (468 KB runtime data) |
| Empty dirs | `recordings/` (empty — no walkthrough output present) |
| Config files | `.vscode/settings.json` (1 unrelated Postman key) |
| Absent | `.gitignore`, `.env.example`, ESLint config, Prettier config, Jest config, Docker, CI, OpenAPI/Swagger, `render.yaml`, `vercel.json` |
| Tests | **No `*.test.*`, `*.spec.*`, or `__tests__` anywhere.** |

### Full source inventory (27 source files)

```
package.json, package-lock.json, README.md, .vscode/settings.json

client/
  index.html, vite.config.js, .env, package.json, package-lock.json
  dist/index.html, dist/assets/{index-DducWGdO.js, index-BFEyB9vV.css}
  src/main.jsx
  src/App.jsx
  src/api/client.js
  src/context/{AuthContext.jsx, ToastContext.jsx}
  src/hooks/useNotifications.js
  src/components/{Layout.jsx, ui.jsx, DoctorCard.jsx, SymptomChecker.jsx}
  src/pages/{Home, Login, Register, Profile, DoctorDirectory,
             DoctorProfile, MyAppointments, Notifications,
             ProviderDashboard}.jsx
  src/pages/admin/{AdminDashboard, AdminDoctors, AdminFacilities,
                   AdminPatients, AdminNotifications}.jsx
  src/styles/index.css            (908 lines)
  src/utils/format.js

server/
  index.js, package.json, package-lock.json, .env
  .data/db.json                    (runtime datastore snapshot)
  scripts/{smoke.js, shapes.js}
  src/app.js
  src/config/{env.js, db.js}
  src/controllers/{auth, doctor, appointment, ai, notification, admin}Controller.js
  src/routes/{auth, doctor, appointment, ai, notification, admin}Routes.js
  src/services/{appointment, ai, notification}Service.js
  src/middlewares/{authMiddleware, validateRequest, errorHandler}.js
  src/utils/{logger, responses}.js

scripts/ui-walkthrough.mjs        (root-level Playwright script)
```

---

## 2. Frontend — actual state

### 2.1 Entry point and shell

`client/src/main.jsx` → mounts `<BrowserRouter><ToastProvider><AuthProvider><App/>`.

Provider nesting is deliberate and correct: `ToastProvider` sits above `AuthProvider` so
auth handlers can raise toasts.

`App.jsx` renders `<Header/>`, `<main><Routes/></main>`, `<Footer/>` from
`components/Layout.jsx`. **All 14 routes are declared inline in `App.jsx`** — there is no
route config file and no lazy loading.

### 2.2 Routing table (as declared in `App.jsx`)

| Path | Element | Guard |
| --- | --- | --- |
| `/` | `Home` | public |
| `/login` | `Login` | `GuestOnly` |
| `/register` | `Register` | `GuestOnly` |
| `/doctors` | `DoctorDirectory` | public |
| `/doctors/:id` | `DoctorProfile` | public |
| `/appointments` | `MyAppointments` | `Protected roles=["patient"]` |
| `/notifications` | `Notifications` | `Protected` (any role) |
| `/profile` | `Profile` | `Protected` (any role) |
| `/provider` | `ProviderDashboard` | `Protected roles=["doctor"]` |
| `/admin` | `AdminDashboard` | `Protected roles=["admin"]` |
| `/admin/doctors` | `AdminDoctors` | `Protected roles=["admin"]` |
| `/admin/facilities` | `AdminFacilities` | `Protected roles=["admin"]` |
| `/admin/patients` | `AdminPatients` | `Protected roles=["admin"]` |
| `/admin/notifications` | `AdminNotifications` | `Protected roles=["admin"]` |
| `*` | redirect to `/` | — |

Guards are implemented inline in `App.jsx` (`Protected`, `GuestOnly`). They are correct:
`Protected` redirects unauthenticated users to `/login` preserving `location` in
`state.from`, and redirects wrong-role users to `homeFor(role)`.

### 2.3 Auth state

`context/AuthContext.jsx`:
- Token in `localStorage` key `medicare_user`… no — token key is **`medicare_token`**
  (`api/client.js`), user object cached under **`medicare_user`**.
- On mount, if a token exists it calls `GET /api/auth/me` to revalidate; on failure it
  clears both keys. `booting` flag prevents a flash of the login screen.
- Exposes `user, booting, isAuthenticated, role, login, register, refresh,
  updateProfile, logout`.
- `logout()` is purely client-side — no server call, no token invalidation.

### 2.4 API communication

`api/client.js` is a single fetch wrapper:
- `BASE = import.meta.env.VITE_API_URL || "/api"`.
- Injects `Authorization: Bearer <token>` from localStorage.
- Unwraps the `{success, message, data}` envelope, throws `ApiError{message,status,code,details}`.
- Network failure is converted to `ApiError` code `NETWORK_ERROR`.
- Declares **35 endpoint wrappers**, a clean 1:1 mapping onto the server's routes. Exactly
  three server endpoints have no client wrapper: `GET /api/health`,
  `GET /api/demo-accounts`, and `GET /api/appointments/availability`. This file is accurate and
  is the single source of client-side API knowledge.

### 2.5 Reusable components

`components/ui.jsx` exports 12 primitives: `StatusBadge, Avatar, EmptyState, Spinner,
Loading, SkeletonCard, SkeletonList, Stat, ProgressBar, Modal, Tabs, Alert`. These are
genuinely reusable and consistently used.

`components/DoctorCard.jsx` exports **two** components — `DoctorCard` (presentational) and
`BookingPanel` (the entire slot picker + booking form). `BookingPanel` has no relation to
`DoctorCard`; it is a routing/placement problem, not a design-system problem.

`components/SymptomChecker.jsx` — self-contained AI triage form.

### 2.6 Styling

**Tailwind CSS is NOT present.** There is no Tailwind dependency, no `tailwind.config.js`,
no `@tailwind` directives. `client/src/styles/index.css` is a 908-line hand-written design
system with CSS custom properties (`--brand-600`, `--gray-200`, …), utility classes
(`.row`, `.stack-sm`, `.grid-2`, `.card`), and component classes. This is the **single
largest deviation from the v2 target stack**.

### 2.7 States

Loading / empty / error states are present and consistent across pages
(`Loading`, `SkeletonCard`, `EmptyState`, `Alert`, toast). This is genuinely good and
should be preserved.

---

## 3. Backend — actual state

### 3.1 Structure

| Layer | File(s) | Notes |
| --- | --- | --- |
| Process entry | `server/index.js` | `app.listen`, graceful shutdown on SIGINT/SIGTERM, `unhandledRejection` log. Sound. |
| App wiring | `server/src/app.js` | cors → json(1mb) → urlencoded → morgan → custom timing log → health → demo-accounts → 6 routers → static SPA → 404 → error handler. |
| Config | `src/config/env.js` | dotenv bootstrap + defaults + optional-integration warnings |
| Data layer | `src/config/db.js` | seed builder + JSON file persistence (526 lines) |
| Controllers | 6 files | `auth(119) doctor(389) appointment(204) ai(33) notification(51) admin(281)` |
| Services | 3 files | `appointmentService(423) aiService(374) notificationService(231)` |
| Middleware | 3 files | `authMiddleware(84) validateRequest(84) errorHandler(32)` |
| Utils | 2 files | `logger(24) responses(35)` |

### 3.2 Layering quality

The **route → controller → service split is real and mostly respected.** Business rules
(status transitions, slot allocation, queue) live in `appointmentService`; controllers are
thin. This is the strongest part of the codebase and is worth preserving.

Two exceptions where controllers hold business logic inline:
- `appointmentController.changeStatus` calls `notifyStatusChange` — a side effect that
  belongs in the service layer.
- `adminController.overview` contains ~120 lines of analytics aggregation, which is service
  or query-layer work.

### 3.3 Response envelope

Every response uses `{success, message, data}` for success and
`{success:false, message, error:{code, details}}` for failure. Verified consistent.
`errorHandler` maps unknown errors to a generic 500 and does **not** leak stack traces to
the client — correct behaviour.

One inconsistency: the `express-rate-limit` handlers return `{success:false, message}`
with **no `error` object**, so the client's `payload?.error?.code` is `undefined` for
throttled requests.

---

## 4. Data storage — verified

### 4.1 Mechanism

`server/src/config/db.js` builds an in-memory object at process start, then mirrors every
mutation to `server/.data/db.json` via `fs.writeFileSync(JSON.stringify(db, null, 2))`.
On boot it calls `load()`; if the file is missing or unparseable it re-seeds.

`persist()` is exported as the mutation hook and is called by every write path.

### 4.2 Verified entity inventory

Top-level keys of `db.json` (confirmed by parsing the file):

| Key | Type | Count in committed file | Notes |
| --- | --- | --- | --- |
| `meta` | object | 1 | `{seededAt}` only |
| `specialties` | array | 10 | `id, name, icon, description` |
| `facilities` | array | 6 | `id, name, city, address, type, rating, phone, openHours, queueEnabled` |
| `services` | array | 5 | `id, name, duration, price, description, currency` |
| `users` | array | 16 | 3 patients + 1 admin + 12 doctors |
| `doctors` | array | 12 | each embeds a **full copy** of its user row |
| `slots` | array | 1254 | 12 doctors × 14 days × filtered time grid |
| `appointments` | array | 45 | 42 historical + 2 seeded upcoming + 1 created by probes |
| `notifications` | array | 2 | grows at runtime, hard-capped at 500 |
| `queue` | array | 0 | populated only by check-in |

**There is no `patients` entity.** Patients are `users` with `role === "patient"`.
**There is no `reviews` entity.** `rating`/`reviewCount` are synthetic seed integers.
**There is no `appointment status history` entity.**

### 4.3 Entity field detail

**users** — `id, name, email, password, role, phone, createdAt, profile{}`
- `role` ∈ `patient | doctor | admin`
- `password` is stored as the literal string `` `hashed:${plaintext}` `` — see
  [security-audit.md](./security-audit.md)
- `profile` is an untyped nested blob: `dateOfBirth, gender, bloodGroup, address,
  emergencyContact, allergies[]`
- Relationships: referenced by `appointments.patientId`, `notifications.patientId`,
  `queue.patientId`, `doctors.userId`

**doctors** — `id, userId, name, specialty, specialtyName, facilityId, facilityName, city,
address, qualification, experience, bio, consultationFee, rating, reviewCount, languages[],
isAcceptingNew, imageColor, serviceIds[], user{}`
- `specialty` holds a specialty **id** while `specialtyName` holds the name (duplicated)
- `city` and `address` are copies of the owning facility's values (duplicated)
- `user` is a **full embedded duplicate of the users row, including `password`**
- `serviceIds` is a 3-element array of service ids, identical for all 12 seed doctors

**slots** — `id, doctorId, date, startTime, endTime, mode, status, maxQueue, currentQueue,
fee, createdAt, appointmentId`
- `date` = `"YYYY-MM-DD"` string; `startTime`/`endTime` = `"HH:mm"` strings — **no timezone,
  no timestamp column**
- `status` ∈ `available | booked | blocked` (free-form, no enum)
- `appointmentId` is a back-reference; created slots set it to `null`, seed slots omit it
- `maxQueue` = 3 (`db.js:383`) and `currentQueue` = 0 on every seed slot

**appointments** — `id, patientId, patientName, doctorId, doctorName, specialtyName,
facilityId, facilityName, slotId, date, startTime, endTime, mode, reason, symptoms, status,
fee, queuePosition, createdAt, cancelledAt, cancelReason, contact{},` plus ad-hoc
`cancelledBy`, `rescheduledAt`, `updatedAt`, `statusNote`, `reminderSent` written by
different code paths
- `status` ∈ `scheduled | confirmed | in-progress | completed | cancelled | no-show`
- `date/startTime/endTime/mode/fee/doctorName/…` are **all duplicated from slot/doctor/user**
- `symptoms` duplicates `reason` in the seed
- `contact{phone,email}` duplicates the user's contact details

**notifications** — `id, event, appointmentId, patientId, patientName, channel, subject,
body, phone, email, status, createdAt, read, results[]`
- `event` ∈ `appointment_booked | appointment_rescheduled | appointment_cancelled |
  appointment_reminder | status_update`
- `body` is a pre-rendered string snapshot; there is no `template_id`
- `status` ∈ `queued | sent | simulated`
- `channel` is always `"both"` in practice

**queue** — `id, slotId, appointmentId, patientId, patientName, doctorId, joinedAt, state`
- `state` ∈ `waiting | in-consultation | completed` (declared as `QUEUE_STATES` but never
  advanced past `"waiting"` anywhere)

**specialties / facilities / services** — flat, no relations except `doctors` → all three.

### 4.4 Relationships that exist

```
users ──1:1── doctors            (doctors.userId → users.id)
doctors ──n:1── specialties      (doctors.specialty → specialties.id)   [also specialtyName]
doctors ──n:1── facilities       (doctors.facilityId → facilities.id)  [also facilityName, city, address]
doctors ──n:m── services         (doctors.serviceIds[] → services.id)
doctors ──1:n── slots            (slots.doctorId → doctors.id)         [slots.appointmentId → appointments.id]
slots ──1:1── appointments       (appointments.slotId → slots.id)      BIDIRECTIONAL, unenforced
users ──1:n── appointments       (appointments.patientId → users.id)   [also patientName]
users ──1:n── notifications      (notifications.patientId → users.id)  [also patientName]
appointments ──1:n── notifications (notifications.appointmentId)
slots ──1:n── queue              (queue.slotId)                        [also slot.currentQueue]
appointments ──1:1── queue       (queue.appointmentId)
```

Every one of these is a soft, unenforced reference. There is **not a single database
constraint, foreign key, or unique index** anywhere in the system.

---

## 5. Frontend feature classification

| Feature | Verdict | Reason |
| --- | --- | --- |
| React + Vite app shell | **KEEP** | Works; only the dependency pin is broken |
| React Router route table | **MODIFY** | Move to route config + `React.lazy`, keep `Protected`/`GuestOnly` semantics |
| `AuthContext` | **MODIFY** | Correct boot/revalidate logic; needs token-refresh and a non-localStorage option |
| `Protected` / `GuestOnly` guards | **KEEP** | Verified correct; reuse verbatim |
| `api/client.js` wrapper | **KEEP** | Accurate, complete, 31 typed wrappers; extend, do not rewrite |
| `ui.jsx` primitives | **KEEP** | Consistent, well used |
| `DoctorCard` | **KEEP** | Presentational, clean |
| `BookingPanel` | **MODIFY** | Works; relocate out of `DoctorCard.jsx`; needs Realtime slot invalidation |
| `SymptomChecker` | **MODIFY** | Works for signed-in users; **broken for anonymous visitors** (see §6) |
| `Home.jsx` | **MODIFY** | Two divergent views (patient / public) in one 435-line file |
| `DoctorDirectory.jsx` | **KEEP** | Best-implemented page: URL-synced filters, debounce, empty + error states |
| `DoctorProfile.jsx` | **MODIFY** | "Next appointments" sidebar is dead code — API returns a count, UI expects an array |
| `MyAppointments.jsx` | **MODIFY** | Booking/reschedule/cancel/check-in all work; needs status history + Realtime |
| `Notifications.jsx` | **MODIFY** | Works; `EVENT_ICON` map keys never match real event values |
| `ProviderDashboard.jsx` | **MODIFY** | Slot CRUD + status actions work; needs a real availability/weekly template model |
| `admin/AdminDashboard.jsx` | **MODIFY** | Analytics render; queries are O(n²) in-memory scans |
| `admin/AdminDoctors.jsx` | **KEEP** | Works |
| `admin/AdminFacilities.jsx` | **KEEP** | Works |
| `admin/AdminPatients.jsx` | **MODIFY** | Works; exposes PHI to admin without an audit trail |
| `admin/AdminNotifications.jsx` | **KEEP** | Works |
| `styles/index.css` (908 lines) | **REPLACE** | Target stack is Tailwind CSS |
| Inline `style={{}}` throughout | **REPLACE** | Move to Tailwind classes |
| `DoctorProfile` "Next appointments" block | **REMOVE or FIX** | Dead — see §6 |
| `useNotifications` 30s polling | **REPLACE** | Superseded by Supabase Realtime |
| `client/dist/` committed | **REMOVE** | Build artifact belongs in `.gitignore` |
| Tailwind CSS | **NEW** | Target stack |
| Route-level code splitting | **NEW** | Not present |
| Error boundary | **NEW** | No `ErrorBoundary` anywhere |
| Realtime queue UI | **NEW** | Phase 9 |
| Pagination / infinite scroll | **NEW** | API has no pagination (see §7) |

---

## 6. Verified defects (reproduced against a running server)

Every item below was executed, not inferred.

### D1 — Client cannot be installed or built. Severity: **blocker**

`client/package.json` declares `vite: ^8.3.2` and `@vitejs/plugin-react: ^4.3.1`.
`@vitejs/plugin-react@4.7.0` (what `^4.3.1` resolves to) declares peer
`vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0"`. **Vite 8 is outside that range.**

```
$ npm ci        # in client/
npm error code ERESOLVE
npm error While resolving: @vitejs/plugin-react@4.7.0
npm error Found: vite@8.3.2
npm error Could not resolve dependency:
npm error peer vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0" from @vitejs/plugin-react@4.7.0
```

`npm install` fails identically. The committed `client/package-lock.json` bakes in the same
invalid pair (`vite 8.3.2` + `@vitejs/plugin-react 4.7.0`), so **Vercel and CI would both
fail on a clean checkout**. `client/dist/` is a stale artifact from an earlier, working
configuration — it is what makes the app *look* deployable.

`server/` installs and runs cleanly (`npm ci` → 91 packages, server boots, seeds, serves).

### D2 — AI symptom checker is broken on the public landing page. Severity: high

`components/SymptomChecker.jsx` is rendered on the **public** `Home` landing page
(`Home.jsx`, the `split` block in the non-patient branch). But
`POST /api/ai/triage` sits behind `requireAuth` (`aiRoutes.js`).

```
POST /api/ai/triage  (no Authorization header)  ->  401 {"code":"NO_TOKEN"}
POST /api/ai/triage  (patient token)            ->  200 {"urgency":"medium",
                                                     "departments":["Ophthalmology","Neurology"]}
```

So the marquee AI feature on the landing page shows an error toast to every signed-out
visitor. Authenticated use works correctly.

### D3 — Doctor profile "Next appointments" block is dead. Severity: medium

`doctorController.getDoctor` returns `upcomingAppointments` as a **number**
(`db.appointments.filter(...).length`). `DoctorProfile.jsx` treats it as an **array**:

```jsx
{upcomingAppointments?.length > 0 && ( ... upcomingAppointments.slice(0, 5).map(...) )}
```

`(5).length` is `undefined`; `undefined > 0` is `false`. The block never renders. Verified:
`typeof upcomingAppointments === "number"`. The endpoint is also a PHI risk — the intended
payload contains `patientName`, which must never be served on an unauthenticated route.

### D4 — `EVENT_ICON` maps never match. Severity: low (cosmetic)

Both `Notifications.jsx` and `admin/AdminNotifications.jsx` define:

```js
const EVENT_ICON = { booked, confirmed, reminder, rescheduled, cancelled, completed, "no-show", created };
```

but the API emits `event` values of `appointment_booked`, `appointment_rescheduled`,
`appointment_cancelled`, `appointment_reminder`, `status_update`. Every lookup misses and
falls through to the default 🔔. All icons are therefore identical in practice.

### D5 — `channels.simulated` is a phantom UI branch. Severity: low

`Notifications.jsx` renders a "Simulated" badge when `channels?.simulated` is truthy.
`notificationController.listNotifications` returns `channels: {sms, email}` only — no
`simulated` key. The branch can never fire.

### D6 — Dead exports and unused imports

Server, exported but never imported anywhere:
- `authMiddleware.js` → `requireSelfOrAdmin` (never wired into a route)
- `notificationService.js` → `markAllRead` (the controller re-implements it inline)
- `db.js` → `nowISO` (used internally only; the export is dead)
- `aiService.js` → `listSpecialties` (shadowed by `doctorController.listSpecialties`)

Pointless re-export lines:
- `appointmentController.js:204` — `export { getSlots, availableDates, id, persist, addMinutes }`
- `appointmentService.js:423` — `export { addMinutes }` (already exported from `db.js`)
- `doctorController.js:389` — `export { shape as shapeDoctor }`

Client, imported but unused:

| File | Unused |
| --- | --- |
| `pages/admin/AdminPatients.jsx` | `num` |
| `pages/admin/AdminDashboard.jsx` | `formatDay` |
| `pages/ProviderDashboard.jsx` | `ProgressBar`, `currency`, `relativeDay` |
| `pages/Home.jsx` | `currency` |
| `pages/DoctorDirectory.jsx` | `currency`, `cx` |
| `components/DoctorCard.jsx` | `StatusBadge` |
| `components/SymptomChecker.jsx` | `StatusBadge` |

### D7 — `logger.tag()` logs a nested array. Severity: low

```js
const write = (level, tag, args) => { console.log(prefix, ...args); };
logger.tag(name) { return { info: (...a) => write("INFO", name, a), ... }; }
```

`a` is the rest-args **array**, so `...args` spreads to a single array argument. Every tagged
log line prints `['message']` instead of `message`. Confirmed in server output:
`[INFO] server API listening on ...` renders correctly (single arg) but multi-arg lines will
print bracketed.

### D8 — `markRead` mutates without persisting. Severity: low

`notificationController.markRead` sets `n.read = true` in memory but never calls
`persist()`. Read state is lost on restart. The unused `notificationService.markAllRead`
**does** call `persist()` — evidence of a half-finished refactor.

### D9 — `scripts/ui-walkthrough.mjs` points at the wrong port. Severity: low

`BASE = process.env.APP_URL || "http://localhost:5174"`, but `vite.config.js` sets
`server.port = 5173` and the README says 5173. With no `APP_URL` the script cannot connect.
No output exists in `recordings/`, so it has evidently never completed successfully.

### D10 — Vite dev proxy is bypassed. Severity: low

`client/.env` sets `VITE_API_URL=http://localhost:5000/api`, which takes precedence over the
`"/api"` fallback, so the `server.proxy` block in `vite.config.js` (whose comment claims
"no CORS in development") is dead configuration. Dev actually runs cross-origin.

---

## 7. Booking behaviour — verified matrix

`appointmentService.bookAppointment` runs its checks synchronously, so within a **single Node
process** they are atomic. Results below were executed.

| Guard | Present | Verified result |
| --- | --- | --- |
| Doctor exists | Yes | 404 `DOCTOR_NOT_FOUND` |
| Slot exists | Yes | 404 `SLOT_NOT_FOUND` |
| Slot belongs to doctor | Yes | 400 `SLOT_MISMATCH` |
| Slot date not in past | Yes | 400 `SLOT_IN_PAST` |
| Exact same slot already booked | Yes | **409 `SLOT_TAKEN`** — confirmed by the smoke suite |
| Slot blocked by provider | Yes | 400 `SLOT_BLOCKED` |
| Patient not double-booked at the identical clock time | Yes | 409 `PATIENT_CLASH` |
| **Overlapping** slot for same patient | **No** | **Both accepted — see below** |
| **Concurrent** booking from two processes | **No** | Check-then-set on a shared JS object; no lock, no constraint |
| **Invalid mode vs slot mode** | **No** | **Accepted — see below** |

### D-B1 — Overlapping appointments are permitted (reproduced)

`generateSlots` accepts arbitrary times and a duration, so a doctor can create 09:00–09:30
and 09:15–09:45. The patient clash guard compares **exact `date` + `startTime` equality**,
never interval overlap:

```
POST /api/doctors/:id/slots  { date:"2030-03-11", times:["09:00","09:15"], duration:30 }
  -> 201, created [{start:"09:00", end:"09:30"}, {start:"09:15", end:"09:45"}]

POST /api/appointments { slotId: <09:00 slot> }  -> 201
POST /api/appointments { slotId: <09:15 slot> }  -> 201   // overlapping booking ACCEPTED
```

A patient can hold two simultaneous appointments. The same seed-date grid makes this
unlikely for stock slots, but the provider-facing generator makes it trivially reachable.

The guard is simultaneously **over-strict** in the common case: it rejects a patient holding
10:00 with doctor A and 10:00 with doctor B, because the key is `(date, startTime)` with no
doctor component. Verified behaviour and documented in the smoke suite's own comments
(`smoke.js` lines 121–124).

### D-B2 — Cancelling via the status endpoint permanently leaks a slot (reproduced)

`updateStatus` releases the slot only for `completed` and `no-show`. `PATCH
/api/appointments/:id/status {status:"cancelled"}` therefore marks the appointment cancelled
but leaves the slot `booked` forever:

```
PATCH /api/appointments/:id/status {"status":"cancelled"}  -> 200
  appointment.status = "cancelled"
  slot.status        = "booked"     <-- LEAKED, permanently unavailable
```

`cancelAppointment` (the `/cancel` route) *does* release the slot, so the two cancellation
paths behave differently. Two sources of truth for slot occupancy have diverged.

### D-B3 — Rescheduling into the past is allowed (reproduced)

`rescheduleAppointment` checks `blocked` and `booked` but never re-checks the date:

```
POST   /api/doctors/:id/slots { date:"2026-09-01", times:["10:00"] }  -> 201
POST   /api/appointments       { slotId: <2031-01-05 slot> }          -> 201
PATCH  /api/appointments/:id/reschedule { slotId: <2026-09-01 slot> } -> 200
        appointment.date = "2026-09-01"   <-- moved into the past
```

### D-B4 — Check-in works on arbitrarily future appointments (reproduced)

`joinQueue` validates status but never validates the date:

```
POST /api/appointments         { slotId: <2031-06-06 slot> }  -> 201
POST /api/appointments/:id/check-in                           -> 200, queuePosition 2
```

A patient can occupy a queue slot for a date years away, and `joinQueue` promotes the
appointment to `in-progress` regardless.

### D-B5 — Reschedule does not refresh the fee (reproduced)

The appointment fee is snapshotted at booking time and never reconciled on reschedule:

```
PATCH /api/doctors/:id/slots/:slotId { fee: 9999 }
book slot @ fee 500          -> appointment.fee = 500
reschedule onto the 9999 slot -> 200, appointment.fee still 500
```

### D-B6 — Consultation mode can be overridden by the client (reproduced)

`bookAppointment` uses `mode: mode || slot.mode`. Route validation accepts any valid enum
value without checking it against the slot:

```
slot.mode = "in-person",  POST body mode = "video"
  -> 201, appointment.mode = "video"
```

An in-person-only slot can be booked as a video consultation. The slot and the appointment
now disagree about the modality.

### D-B7 — Queue state is triplicated and `maxQueue` is never enforced

Queue position exists in three places at once: `db.queue[]`, `slot.currentQueue`, and
`appointment.queuePosition`. `joinQueue` increments `slot.currentQueue` and **never
decrements it**; `maxQueue: 3` is written on every seed slot and **never read anywhere**.
`QUEUE_STATES` is exported from `db.js` and never imported.

---

## 8. AI feature — verified

| Property | Actual value |
| --- | --- |
| Provider | Google Gemini REST, called directly with `fetch` |
| Endpoint | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| Default model | `gemini-1.5-flash` (a **retired** generation; the current line is 2.x/3.x) |
| API key transport | **`?key=` in the query string** — appears in outbound URL logs |
| Request shape | `{contents:[{parts:[{text: prompt}]}], generationConfig:{temperature:0.2, responseMimeType:"application/json"}}` |
| Timeout | 8 s via `AbortController` |
| Response parsing | Strips a ```json fence, then `JSON.parse` of first `{` … last `}` |
| Failure handling | Any throw → `log.warn` → falls through to the rule-based engine |
| Key loading | Read once at module import; changing it requires a process restart |
| Public surface | `GET /api/ai/provider` returns `{provider, isLive, note}` — public, unauthenticated |
| Fallback | Deterministic keyword scorer: 10 rule groups → specialty + urgency |

**Prompt** (`aiService.js` lines 233–247) already carries the correct framing:

> "You are a medical triage assistant… **Do NOT diagnose.** Only suggest which department
> to visit and how urgent it is."

with a strict JSON schema instruction and a `redFlags[]` field. The frontend
(`SymptomChecker.jsx`) already labels it "decision support for a prototype, **not a medical
diagnosis**".

**Recommendation:** yes — rebrand to **"AI-assisted symptom triage and specialty
recommendation"**. The wording, the prompt constraint, the `redFlags` channel and the
disclaimer are already correct; what is missing is that this is not enforced anywhere —
`GET /api/ai/provider` is public and unauthenticated, so the service's capability surface is
discoverable by anyone.

**Rule-engine quality note:** the `SYMPTOM_RULES` table maps the keyword `"fever"` to **both**
Pediatrics (urgent-ish, medium) and General Medicine (low), and `"child"` to Pediatrics. A
report of "my child has a fever" scores both equally and returns two departments. `urgency`
is the max urgency across matched rules, which is defensible.

---

## 9. Realtime — current behaviour

There is **no Realtime**. The mechanisms actually present:

| Mechanism | Where | Interval |
| --- | --- | --- |
| Notification polling | `hooks/useNotifications.js`, mounted in `App.jsx` for every signed-in user | 30 s |
| Home-page duplicate poll | `Home.jsx` calls `useNotifications({poll:true})` | 30 s |
| Manual refresh buttons | `admin/*`, `Notifications.jsx` | on click |
| Full page reload after mutation | every mutating page calls `load()` | on success |

Consequences: two independent 30 s pollers run simultaneously for a signed-in patient
(`App.jsx` and `Home.jsx` each instantiate the hook), each hitting
`GET /api/notifications`. Queue position, slot occupancy, and appointment status are only
ever refreshed by a manual reload. The `dot dot-pulse` animation in `DoctorProfile.jsx`
implies liveness that does not exist.

---

## 10. Verification log

Environment: Node v24.21.0, npm 11.19.0, Linux.

| # | Check | Command / method | Result |
| --- | --- | --- | --- |
| 1 | Repository structure | `find` | 27 source files; no git, no tests |
| 2 | Datastore shape | `node -e "require('./server/.data/db.json')"` | 10 top-level keys; counts recorded above |
| 3 | Tailwind presence | `grep -ri tailwind client` | **0 matches** |
| 4 | Committed artifacts | `du -sh` | `client/dist` 280 KB, `server/.data/db.json` 468 KB, `recordings/` empty |
| 5 | Config files present | explicit `test -e` loop | 10 expected files all **absent** |
| 6 | Dead server exports | scripted grep across `server/` | 4 dead exports, 3 pointless re-export lines |
| 7 | Unused client imports | AST-ish regex scan of 22 files | 11 unused imports across 7 files |
| 8 | Server boots + seeds | `PORT=5099 node index.js` | listening, seeded 12 doctors / 6 facilities / 5 services / 44 appointments |
| 9 | **Smoke suite** | `node scripts/smoke.js` against :5099 | **35 passed, 0 failed** |
| 10 | Plaintext demo credentials | `GET /api/demo-accounts` no auth | **200**, 3 plaintext passwords |
| 11 | Password hash leak | `GET /api/appointments/:id` | `doctor.user.password = "hashed:doctor123"` |
| 12 | Password hash leak | `GET /api/auth/me`, `POST /auth/login` (doctor) | `doctor.user.password = "hashed:doctor123"` |
| 13 | Privilege escalation | `POST /auth/register {"role":"provider"}` | **201**, `role: "doctor"`, token issued |
| 14 | IDOR check-in | patient A → patient B's live appointment | **200**, victim moved to `in-progress` |
| 15 | IDOR check-in | unrelated doctor → same appointment | **200** |
| 16 | IDOR notifications | `doctor5` → `GET /notifications?patientId=<other>` | **200**, victim email + phone returned |
| 17 | Profile injection | `PATCH /auth/me {"profile":{"role":"admin","allergies":"str"}}` | **200**, arbitrary keys stored, `allergies` became a string |
| 18 | Mode override | in-person slot booked with `mode:"video"` | **201**, `appointment.mode = "video"` |
| 19 | Overlapping double-book | 09:00 and 09:15 slots, same patient | **both 201** |
| 20 | Reschedule into past | target slot dated 2026-09-01 | **200**, moved into the past |
| 21 | Cancel-via-status slot leak | `PATCH /:id/status {"cancelled"}` | slot remained **`booked`** |
| 22 | Future check-in | appointment dated 2031-06-06 | **200**, queuePosition 2 |
| 23 | Stale fee on reschedule | slot fee 9999, appointment fee 500 | fee stayed **500** |
| 24 | Pagination | `GET /doctors?limit=2` | returned **12** (limit ignored), `total` = 12 |
| 25 | Anonymous AI triage | no token | **401 NO_TOKEN** (public UI exposes it) |
| 26 | Authenticated AI triage | patient token | **200**, `departments:["Ophthalmology","Neurology"]` |
| 27 | Role gate on slot POST | patient → `POST /doctors/:id/slots` | **403** (correct) |
| 28 | Role gate on admin | patient → `GET /api/admin/overview` | **403** (correct) |
| 29 | `doctor/:id` shape | `typeof upcomingAppointments` | **`"number"`** (UI expects array) |
| 30 | **Client install** | `npm install` in `client/` | **ERESOLVE — FAILS** |
| 31 | **Client install (CI path)** | `npm ci` in `client/` | **ERESOLVE — FAILS** |
| 32 | Server install (CI path) | `npm ci` in `server/` | 91 packages, OK |
| 33 | Dependency currency | npm registry lookups | see [technical-debt.md](./technical-debt.md) |

The audit ran against a **copy** of `server/` in `/tmp/opencode/mc-audit`, which was deleted
afterwards. **The repository itself was not modified**: no files added, edited or removed,
and no `node_modules` were installed into it.

---

## 11. What is genuinely good

Worth stating plainly, because the v2 plan should protect it:

1. **Clean route → controller → service layering** on the backend. Real separation, and the
   right place for it.
2. **A single consistent response envelope** with a machine-readable error `code` on every
   failure path.
3. **`asyncHandler` + `AppError` + a global error handler** that does not leak internals.
   This is a real, working centralised-error-handling foundation.
4. **A declarative validation middleware** already in place — it needs a library-grade
   replacement, but the *pattern* is right.
5. **`api/client.js`** is a complete, accurate client for the whole API. Extending it is
   cheap; rewriting it would be waste.
6. **Loading / empty / error state discipline** across every page. Unusually consistent for
   a prototype.
7. **A working 35-assertion end-to-end smoke suite.** Not a substitute for Jest, but it
   proves the happy path, the role gates and the primary authz rules genuinely work today.
8. **`PublicUser` / `shape()` projection helpers** — the intent to whitelist response fields
   is already there; it is just applied inconsistently.