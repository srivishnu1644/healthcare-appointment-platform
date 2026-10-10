# MediCare — API Inventory

Every endpoint in this document was read out of `server/src/routes/*.js` and, where marked
✅ verified, executed against a running server during the Phase 0 audit.

**Status legend**

| Mark | Meaning |
| --- | --- |
| ✅ Verified | Executed over HTTP; the recorded status codes are observed, not predicted |
| ⚠️ Partial | Works, but with a defect reproduced during the audit |
| ❌ Broken | Reproduced failure |
| 🔓 Unauthenticated | Reachable with no credentials |

**Roles** are the roles the code enforces, not the roles that would ideally be allowed.

---

## 1. Endpoint table

### 1.1 Meta

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/health` | Liveness + row counts + `seededAt` | 🔓 No | any | ✅ Verified 200 | Modify — drop counts in prod, add DB ping |
| GET | `/api/demo-accounts` | Returns 3 demo **plaintext passwords** | 🔓 No | any | ✅ Verified 200 | **Remove** — see [security-audit.md](./security-audit.md) S-01 |

### 1.2 Auth — `routes/authRoutes.js`

Rate limited: 30 requests / 10 min, **only when `NODE_ENV === "production"`**
(`authRoutes.js:12-22`).

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| POST | `/api/auth/register` | Create account, returns token | 🔓 No | any | ⚠️ Verified 201 — `role:"provider"` yields a doctor | Replace — bcrypt, patient-only self-registration |
| POST | `/api/auth/login` | Exchange credentials for JWT | 🔓 No | any | ✅ Verified 200 / 401 | Replace — bcrypt verify, refresh tokens |
| GET | `/api/auth/me` | Current user | Yes | any | ⚠️ Verified 200 — leaks `doctor.user.password` | Modify |
| PATCH | `/api/auth/me` | Update name / phone / profile | Yes | any | ⚠️ Verified 200 — unvalidated `profile` merge | Modify — schema-validate |

### 1.3 Doctors — `routes/doctorRoutes.js`

Rows 15–25 are public by design (browsing before sign-in is a core patient journey, per the
in-code comment). `router.use(requireAuth)` is applied from line 28 onward.

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/doctors/specialties` | List specialties | 🔓 No | any | ✅ Verified 200 | Keep |
| GET | `/api/doctors/services` | List services | 🔓 No | any | ✅ Verified 200 | Keep |
| GET | `/api/doctors/facilities` | List facilities; filters `city`, `search` | 🔓 No | any | ✅ Verified 200 | Keep |
| GET | `/api/doctors/recommended` | Scored doctor ranking; filters `specialty`, `city`, `maxFee`, `mode`, `limit` | 🔓 No | any | ✅ Verified 200 | Modify — SQL ranking |
| GET | `/api/doctors` | Search / filter / sort | 🔓 No | any | ⚠️ Verified 200 — `limit` ignored, no pagination | Modify — real pagination |
| GET | `/api/doctors/:id` | Profile + facility + services + availability + stats | 🔓 No | any | ⚠️ Verified 200 — `upcomingAppointments` is a count, not a list | Modify |
| GET | `/api/doctors/:id/slots` | Slots for a doctor; filters `date`, `from`, `to`, `mode` | 🔓 No | any | ✅ Verified 200 | Modify |
| GET | `/api/doctors/me/schedule` | Provider's own day view | Yes | doctor | ✅ Verified 200 / 403 for patient | Modify |
| PATCH | `/api/doctors/:id/slots/:slotId` | Block / free / reprice a slot | Yes | doctor, admin | ✅ Verified 200 (correct 403 for patient) | Modify |
| POST | `/api/doctors/:id/slots` | Bulk-create slots for a date | Yes | doctor, admin | ✅ Verified 201 (correct 403 for patient) | Modify — enforce `isOwnDoctorOrAdmin` |

**Filter parameters actually read by `listDoctors`** (`doctorController.js:40-50`):
`search, specialty, city, maxFee, minRating, language, mode, acceptingOnly, sort`.
`specialty` and `city` accept comma-separated lists. `sort` ∈
`fee-low | experience | rating | soonest`; default is rating desc, then reviewCount desc.

> **Note:** the client sends the API parameter `search`. The URL query key it uses for
> bookmarking is `q` (`DoctorDirectory.jsx` reads `params.get("q")`, then maps it to
> `search`). Both work; they are simply different names for the same thing.

### 1.4 Appointments — `routes/appointmentRoutes.js`

`router.use(requireAuth)` at line 7 — every route requires a token.

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/appointments` | List; scopes by role | Yes | patient → own, doctor → own schedule, admin → all | ✅ Verified 200 | Modify — filter by status/date in SQL |
| GET | `/api/appointments/:id` | Single appointment + doctor + facility + wait | Yes | owner / provider / admin | ⚠️ Verified 200 — **returns the raw doctor object incl. `user.password`** | **Replace** — project through a whitelist |
| POST | `/api/appointments` | Book | Yes | patient | ⚠️ Verified 201 — client can override `mode` | Modify — transaction |
| PATCH | `/api/appointments/:id/reschedule` | Move to another slot | Yes | owner / provider / admin | ⚠️ Verified 200 — allows past dates, stale fee | Modify — transaction |
| PATCH | `/api/appointments/:id/cancel` | Cancel, releases the slot | Yes | owner / provider / admin | ✅ Verified 200 | Modify — route through one cancel path |
| PATCH | `/api/appointments/:id/status` | Doctor/admin status transition | Yes | doctor, admin | ⚠️ Verified 200 — `cancelled` leaves the slot `booked` | Modify — single transition service |
| POST | `/api/appointments/:id/check-in` | Join the live queue | Yes | **any role, any owner** | ❌ **IDOR verified 200** — another patient checked in a stranger's appointment | **Replace** — enforce ownership |
| GET | `/api/appointments/queue` | Live queue for a doctor | Yes | any (requires `doctorId`) | ⚠️ Verified 200 — any user, any doctor | Modify — restrict + Realtime |
| GET | `/api/appointments/availability` | Availability summary | Yes | any | ✅ Verified 200 | Modify |

Query params for `GET /api/appointments` (`appointmentController.js:25`):
`scope, status, doctorId, patientId, from, to`.

### 1.5 AI — `routes/aiRoutes.js`

Rate limited: 20 requests / min on `/triage` (independent of `NODE_ENV`).

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/ai/provider` | `{provider, isLive, note}` | 🔓 No | any | ✅ Verified 200 | Modify — auth-gate in prod |
| POST | `/api/ai/triage` | Symptom triage → urgency, departments, doctors | Yes | any | ⚠️ Verified 200 authenticated / **401 anonymous** | Modify + allow anonymous |

> **Broken UX:** `SymptomChecker.jsx` is rendered on the public landing page but `/triage`
> requires auth, so signed-out visitors always get 401. Either the route or the page must
> change in v2.

### 1.6 Notifications — `routes/notificationRoutes.js`

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/notifications` | Own notifications + unread count | Yes | patient → own; **others honour `?patientId`** | ⚠️ Verified 200 — **IDOR: a doctor read another patient's email + phone** | **Replace** — ignore `patientId` except for admin |
| PATCH | `/api/notifications/read-all` | Mark all read | Yes | any | ⚠️ Verified 200 — never calls `persist()` | Modify |
| POST | `/api/notifications/reminders/sweep` | Manual reminder sweep | Yes | admin | ✅ Verified 200 | Modify — move to a scheduled job |

### 1.7 Admin — `routes/adminRoutes.js`

`router.use(requireAuth, requireRole("admin"))` at line 9 — every route is double-gated.

| Method | Endpoint | Purpose | Auth | Role | Status | V2 Action |
| --- | --- | --- | --- | --- | --- | --- |
| GET | `/api/admin/overview` | KPIs, 14-day trend, by-specialty, top doctors | Yes | admin | ✅ Verified 200 / 403 for patient | Modify — SQL aggregates |
| GET | `/api/admin/doctors` | Doctor list with linked account email | Yes | admin | ✅ Verified 200 | Modify |
| PATCH | `/api/admin/doctors/:id` | Update fee, accepting flag, rating, bio, … | Yes | admin | ✅ Verified 200 | Modify — **rating must not be admin-settable** |
| GET | `/api/admin/facilities` | Facilities + doctor/appointment counts | Yes | admin | ✅ Verified 200 | Modify |
| POST | `/api/admin/facilities` | Create facility | Yes | admin | ✅ Verified 201 | Modify |
| GET | `/api/admin/services` | Services + doctor counts | Yes | admin | ✅ Verified 200 | Modify |
| GET | `/api/admin/patients` | Patient list incl. email, phone, blood group, allergies | Yes | admin | ✅ Verified 200 | Modify — add an access log |
| GET | `/api/admin/notifications` | Platform-wide notification log | Yes | admin | ✅ Verified 200 | Keep |

---

## 2. Endpoint count

| Group | Count |
| --- | --- |
| Meta | 2 |
| Auth | 4 |
| Doctors | 10 |
| Appointments | 9 |
| AI | 2 |
| Notifications | 3 |
| Admin | 8 |
| **Total** | **38** |

Unauthenticated: **12** of 38.

| # | Endpoint | Why it is public |
| --- | --- | --- |
| 1 | `GET /api/health` | Liveness probe |
| 2 | `GET /api/demo-accounts` | ⚠️ Should not exist — S-01 |
| 3 | `POST /api/auth/register` | Account creation |
| 4 | `POST /api/auth/login` | Credential exchange |
| 5 | `GET /api/ai/provider` | Triage-capability discovery |
| 6 | `GET /api/doctors/specialties` | Filter options |
| 7 | `GET /api/doctors/services` | Filter options |
| 8 | `GET /api/doctors/facilities` | Filter options |
| 9 | `GET /api/doctors/recommended` | Landing-page recommendations |
| 10 | `GET /api/doctors` | Directory |
| 11 | `GET /api/doctors/:id` | Public profile |
| 12 | `GET /api/doctors/:id/slots` | Availability before sign-in |

Endpoints 6–12 are deliberately public: browsing doctors before signing in is the core
patient journey, and the routes file says so explicitly. **10 of the 12 are intentional**;
only `/api/demo-accounts` (2) and `/api/ai/provider` (5) need a decision in v2.

---

## 3. Response shapes

Success: `{ success: true, message: string, data: any }`
Failure: `{ success: false, message: string, error: { code: string, details: any|null } }`

Error codes emitted: `BAD_CREDENTIALS`, `NO_TOKEN`, `INVALID_TOKEN`, `USER_NOT_FOUND`,
`FORBIDDEN`, `EMAIL_TAKEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `DUPLICATE`,
`INTERNAL_ERROR`, plus domain codes `DOCTOR_NOT_FOUND`, `SLOT_NOT_FOUND`, `SLOT_MISMATCH`,
`SLOT_TAKEN`, `SLOT_BLOCKED`, `SLOT_IN_PAST`, `SLOT_IN_USE`, `INVALID_STATUS`,
`INVALID_TRANSITION`, `ALREADY_CANCELLED`, `APPOINTMENT_NOT_FOUND`, `PATIENT_CLASH`,
`NO_DOCTOR_PROFILE`, `MISSING_FIELDS`, `MISSING_DOCTOR`, `EMPTY_INPUT`.

`express-rate-limit` responses omit the `error` object — the only deviation from the
envelope.

---

## 4. Missing endpoints (not in the codebase — do not assume they exist)

None of the following exist today. They are v2 candidates, listed so the inventory is
unambiguous about what is *absent*:

- Password reset / forgot password
- Token refresh, logout, session listing, revocation
- Doctor create / update / deactivate (admin can only patch an existing doctor)
- Patient record CRUD beyond profile
- Appointment **status history** / audit trail endpoint
- Queue advance / dequeue (no endpoint moves a queue entry past `waiting`)
- Reviews or ratings submission
- Availability templates / recurring weekly schedules
- Pagination metadata (`total` is the filtered count, not a catalogue total)
- File upload (prescriptions, reports)
- Search across facilities, or a global search endpoint

---

## 5. API conventions to preserve in v2

These are good and worth keeping:

1. `/api` prefix, plural resource nouns.
2. Public discovery, authenticated mutation — the current split is deliberate and correct.
3. `requireAuth` then `requireRole(...)` as separate composable middleware.
4. One JSON envelope everywhere, with a stable machine-readable `error.code`.
5. PATCH for partial updates, POST for creation — consistently applied.
6. Server-side filtering and sorting via query params on list endpoints.

## 6. API conventions to change in v2

1. Add real pagination (`page`, `limit`, `total`) to every list endpoint.
2. Enforce ownership on `/check-in` and on notification reads.
3. Replace the hand-rolled `validate()` with a real schema validator (Zod or Joi) that
   also **strips unknown keys**, so `profile` can never be injected wholesale.
4. Move all list filtering/sorting/pagination into SQL rather than in-memory `.filter()`
   chains — `adminController.overview` currently scans the full appointments array 40+ times
   per request.
5. Add `GET /api/doctors/:id/reviews` (or drop the synthetic rating entirely).
6. Add `GET /api/appointments/:id/history` backed by a status-history table.