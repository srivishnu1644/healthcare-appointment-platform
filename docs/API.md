# MediCare v2 — API Reference

Every endpoint in this document was read off the running Express router, not
transcribed by hand. Regenerate the endpoint list with:

```bash
cd server && node scripts/dump-routes.js
```

If an endpoint below does not appear in that output, this document is stale.

All example payloads are **fictional**. The structure, field names and status
codes are real; the people, clinics and identifiers are not.

---

## Contents

1. [Conventions](#conventions)
2. [Authentication](#authentication)
3. [Doctors, slots and services](#doctors-slots-and-services)
4. [Appointments](#appointments)
5. [Waiting room (queue)](#waiting-room-queue)
6. [Notifications](#notifications)
7. [AI assistant and triage](#ai-assistant-and-triage)
8. [Administration](#administration)
9. [Health](#health)
10. [Error reference](#error-reference)
11. [Architecture and transaction conventions](#architecture-and-transaction-conventions)

---

## Conventions

### Base URL

Development: `http://localhost:5000/api`

### Envelope

Success:

```json
{
  "success": true,
  "message": "OK",
  "data": { }
}
```

Failure:

```json
{
  "success": false,
  "message": "Validation failed",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      { "field": "limit", "message": "limit must be at least 1" }
    ]
  }
}
```

`error.details` is `null` for every error except a validation failure, where it
carries one entry per rejected field. `message` is written for a human;
`error.code` is the stable, machine-readable discriminator and is what a client
should branch on.

### Authentication

Authenticated endpoints expect a bearer token:

```
Authorization: Bearer <accessToken>
```

Access tokens are short-lived JWTs. Refresh tokens are opaque, single-use, and
rotated on every refresh — presenting a used refresh token invalidates the whole
session (`REFRESH_TOKEN_REUSED`).

### Authorization

| Role | Sees |
|---|---|
| `patient` | Own appointments, own queue position, own notifications, own profile |
| `doctor` | Assigned appointments, own waiting room, own schedule, own notifications |
| `admin` | Cross-clinic views, directory management, operational monitoring |

An endpoint not listed as public requires authentication. Those marked **admin**
also require the `admin` role.

### Pagination

List endpoints accept `limit` and `offset`. `limit` is bounded (maximum 200 on
admin endpoints); a value outside the range is a `422`, not a silent clamp.
Responses that page return `total`, `limit` and `offset` alongside the rows, so
the count always describes the set the page was drawn from.

`GET /api/notifications` is the exception: it returns the most recent `limit`
notifications and has never supported paging.

### Dates and times

Dates are `YYYY-MM-DD` and times are 24-hour `HH:MM`, both in the clinic
timezone (`Asia/Kolkata`, UTC+05:30), not in UTC and not in the client's zone.
This is deliberate: a booking made at 00:30 local must file under the local day,
not under the previous one.

### Validation

Validation happens at the route, in the existing `validateRequest` middleware —
no third-party schema library. Rules support `required`, `type`, `enum`,
`enumList` (comma-separated), `min`, `max`, `minLength`, `maxLength`,
`pattern`, `maxKeys`, `default`, and nested field rules.

Types: `string`, `number`, `boolean`, `array`, `object`, `email`, `date`,
`calendarDate`, `uuid`.

- `date` checks the **shape** only. `calendarDate` checks that the day exists
  (`2026-02-31` is rejected). Both are in use; `date` is used where the
  controller already answers with a more specific `400 INVALID_DATE`.

### Rate limits

| Scope | Limit | Window | Keyed by |
|---|---|---|---|
| `POST /auth/login`, `/auth/register` | 100 | 10 min | IP |
| `POST /auth/refresh`, `/auth/logout` | 600 | 10 min | IP |
| `POST /ai/assist` | 60 (override: `ASSIST_MAX_PER_MINUTE`) | 1 min | **user id** |
| `POST /ai/triage` | 20 | 1 min | **IP** |

The assistant limiter keys on the **user id**, not the IP: clinics sit behind a
shared NAT, so per-IP limiting would let one waiting room exhaust the quota for
everyone in it.

> **Inconsistency worth knowing about:** the triage limiter is still keyed by IP,
> unlike the assistant limiter beside it. Every patient in one clinic shares an
> IP, so a clinic with more than 20 patients asking about symptoms in a minute
> will throttle people who did nothing wrong. This is recorded as a finding in
> the security section rather than quietly documented as intended behaviour.

---

## Authentication

Base path `/api/auth`. Public except where noted.

### `POST /api/auth/register`

Creates a **patient** account. There is no `role` parameter: doctor accounts are
provisioned by an administrator, so a caller cannot escalate by posting
`{"role": "provider"}`.

**Rate limited** (100 / 10 min, per IP).

Request:

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, 2–80 chars |
| `email` | email | required |
| `password` | string | required, 8–128 chars |
| `phone` | string | optional, ≤ 40 chars |

```json
{
  "name": "Priya Menon",
  "email": "priya.menon@example.invalid",
  "password": "correct-horse-battery",
  "phone": "+919812345678"
}
```

`201` — same shape as login, returning `token`, `refreshToken`, `expiresIn`,
`refreshExpiresIn` and `user`.

Errors: `422 VALIDATION_ERROR`, `409 DUPLICATE` (email already registered),
`429` rate limited.

---

### `POST /api/auth/login`

**Rate limited** (100 / 10 min, per IP).

```json
{ "email": "patient@demo.com", "password": "patient123" }
```

`200`:

```json
{
  "success": true,
  "message": "Signed in",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "9f2c...",
    "expiresIn": 900,
    "refreshExpiresIn": 604800,
    "user": {
      "id": "6d1f...",
      "name": "Ishita Desai",
      "email": "patient@demo.com",
      "role": "patient",
      "phone": "+919812345678"
    }
  }
}
```

The JWT payload carries `sub`, `role` and `iat` — **not** the email address.

Errors: `401` bad credentials, `403 ACCOUNT_DISABLED`, `422`, `429`.

The failure message is identical for an unknown email and a wrong password, so
the endpoint cannot be used to enumerate accounts.

---

### `POST /api/auth/refresh`

**Rate limited** (600 / 10 min, per IP). Body: `{ "refreshToken": "..." }`.

Returns a new access token and a **new** refresh token. The presented one is
consumed. Presenting it a second time revokes the entire session
(`401 REFRESH_TOKEN_REUSED`) — a stolen-and-replayed refresh token cannot be
used quietly.

Errors: `401 INVALID_REFRESH_TOKEN`, `401 REFRESH_TOKEN_EXPIRED`,
`401 REFRESH_TOKEN_REUSED`.

---

### `POST /api/auth/logout`

Body: `{ "allDevices": false }` (optional). Revokes the current refresh token, or
the whole session when `true`. Requires authentication, but accepts a missing or
expired access token without erroring — logging out twice is not a failure.

---

### `GET /api/auth/session` 🔒

Validates the presented access token and reports what the server knows about it:
`valid`, `expiresAt`, `role`, and whether the session was invalidated by a
logout or a refresh-token reuse.

Errors: `401 TOKEN_EXPIRED`, `401 NO_TOKEN`, `401 SESSION_INVALIDATED`.

---

### `GET /api/auth/me` 🔒

Returns the caller's own profile: identity, role, `profile` (date of birth,
gender, blood group, address, emergency contact, allergies) and appointment
counts.

Never includes the password hash — the repository never selects it.

---

### `PATCH /api/auth/me` 🔒

Updates the caller's own profile. Unknown top-level keys are **ignored**, not
rejected, so a newer client can send a field this server does not know yet.

| Field | Type | Rules |
|---|---|---|
| `name` | string | 1–120 chars |
| `phone` | string | ≤ 40 chars |
| `profile` | object | ≤ 24 keys |

```json
{ "name": "Priya Menon", "profile": { "bloodGroup": "O+", "gender": "female" } }
```

Profile fields are **sanitised, not rejected**: an unrecognised value is dropped
and the rest of the update is applied. `gender` must be one of `male`, `female`,
`other`, `prefer_not_to-say`; `bloodGroup` must be a real group; `dateOfBirth`
must be a real date; `allergies` must be an array of at most 50 strings. A
rejected field keeps its previous value — this is a merge, not a clear.

Keys outside the allow-list (`role`, `isAdmin`, or anything invented) are never
persisted. That allow-list is what prevents a caller promoting themselves by
posting a `role` key.

Errors: `422`, `404 USER_NOT_FOUND`.

---

## Doctors, slots and services

Base path `/api/doctors`. All public.

### `GET /api/doctors`

The doctor directory.

| Query | Type | Notes |
|---|---|---|
| `search` | string | name, specialty, city |
| `specialty` | string | specialty id or slug |
| `facilityId` | uuid | |
| `city` | string | |
| `accepting` | boolean | |
| `limit` / `offset` | number | bounded |
| `sort` | string | e.g. `rating`, `fee_asc`, `experience` |

```json
{ "search": "cardio", "city": "Chennai", "limit": 20, "sort": "rating" }
```

`200` → `{ "doctors": [ … ], "total": n, "limit": n, "offset": n }`

Each doctor record: `id`, `name`, `specialty` (id), `specialtyName`,
`facilityId`, `facilityName`, `city`, `address`, `qualification`, `experience`,
`bio`, `consultationFee`, `rating`, `reviewCount`, `acceptingNewPatients`,
`imageUrl`.

Errors: `422`.

### `GET /api/doctors/recommended`

Doctors suggested for the caller. Requires authentication to personalise; without
one it returns the general shortlist rather than failing.

### `GET /api/doctors/:id`

One doctor. Errors: `404 DOCTOR_NOT_FOUND`, `422` (malformed id).

### `GET /api/doctors/specialties` · `GET /api/doctors/specialties/:idOrSlug`

Specialty list or one specialty, addressed by id **or** slug.

Errors: `404 SPECIALTY_NOT_FOUND`.

### `GET /api/doctors/services` · `GET /api/doctors/services/:id` · `GET /api/doctors/facilities` · `GET /api/doctors/facilities/:id`

Reference data. Errors: `404 SERVICE_NOT_FOUND`, `404 FACILITY_NOT_FOUND`.

### `GET /api/doctors/:id/availability`

Availability summary for a provider across the open window. Public.

```json
{ "doctorId": "59a4...", "date": "2026-10-13" }
```

```json
{
  "success": true,
  "message": "OK",
  "data": {
    "doctorId": "59a4...",
    "date": null,
    "totalSlots": 310,
    "available": 74,
    "booked": 1,
    "blocked": 202,
    "elapsed": 33,
    "utilizationPercent": 0,
    "nextAvailableSlot": { "date": "2026-10-13", "time": "14:00", "mode": "in-person" },
    "status": "available",
    "timezone": "Asia/Kolkata (UTC+5.50)"
  }
}
```

`date: null` means "the whole window", not "unknown".

### `GET /api/doctors/:id/services`

The services a provider offers.

```json
{ "doctorId": "59a4...", "services": [
  { "id": "a3cc...", "name": "Follow-up Consultation",
    "description": "Review of ongoing treatment and progress",
    "duration": 15, "price": 400, "currency": "INR" }
] }
```

Public. Errors: `404 DOCTOR_NOT_FOUND`.

### `GET /api/doctors/me/schedule` 🔒 doctor

The signed-in provider's own schedule. Scoped by role — a patient calling this
receives `403`.

### `GET /api/doctors/:id/slots`

Bookable slots for a provider. Public — browsing availability needs no account.

| Query | Type | Notes |
|---|---|---|
| `from` / `to` | calendarDate | |
| `mode` | string | `in-person` \| `video` |

### `GET /api/doctors/:id/slots/:slotId`

One slot. Public, like the list.

### `POST /api/doctors/:id/slots` 🔒

Creates slots for a provider.

| Field | Type | Rules |
|---|---|---|
| `date` | string | required, a **real** calendar day |
| `times` | array | required, non-empty, `HH:MM`, each a real clock time |
| `duration` | number | minutes |
| `mode` | string | `in-person` \| `video` |
| `fee` | number | |
| `maxQueue` | number | room capacity |

```json
{
  "date": "2026-10-20",
  "times": ["09:30", "10:00", "10:30"],
  "duration": 30,
  "mode": "in-person",
  "fee": 1850,
  "maxQueue": 8
}
```

`201` → `{ "created": [ { "id": "…", "date": "…", "startTime": "09:30" } ] }`

Errors: `400 INVALID_DATE` (a day that does not exist — deliberately more
specific than the generic validation failure), `400 INVALID_DATE_RANGE`,
`400 INVALID_MAX_QUEUE`, `400 MISSING_TIMES`, `400 TOO_MANY_SLOTS`,
`400 SLOT_BLOCKED`, `403`, `404 DOCTOR_NOT_FOUND`.

### `PATCH /api/doctors/:id/slots/:slotId` 🔒

Updates or blocks one slot.

| Field | Type | Notes |
|---|---|---|
| `status` | string | `available` \| `blocked` |
| `time` | string | reschedule within the day |

Errors: `404 SLOT_NOT_FOUND`, `400 SLOT_UNCHANGED`, `400 SLOT_NOT_STARTED`,
`400 SLOT_IN_PAST`.

---

## Appointments

Base path `/api/appointments`. All authenticated.

A list response:

```json
{ "appointments": [ … ], "count": 2 }
```

An appointment record: `id`, `patientId`, `doctorId`, `slotId`, `date`,
`startTime`, `endTime`, `mode`, `status`, `reason`, `symptoms`, `fee`,
`queuePosition`, `createdAt`, `cancelledAt`, `cancelledBy`, `cancelReason`,
`checkedInAt`, `completedAt`, `startsAt`, `patientName`, `doctorName`,
`specialtyName`, `facilityName`, `queueState`.

Status is one of `scheduled`, `confirmed`, `in-progress`, `completed`,
`cancelled`, `no-show`. Those are exactly the keys of the booking service's
transition table, and the filter on this endpoint validates against that same
table rather than a second copy.

### `POST /api/appointments` 🔒 patient

Books an appointment.

```json
{ "doctorId": "59a4...", "slotId": "7c21...", "reason": "Follow-up consultation" }
```

`201` → `{ "appointment": { … } }`

Booking is the most heavily constrained operation in the system. It runs in a
single transaction that takes a row lock on the slot, and it refuses with:

| Error | Meaning |
|---|---|
| `404 SLOT_NOT_FOUND` | slot does not exist |
| `409 SLOT_TAKEN` | somebody booked it first — the slot was locked and re-read |
| `400 SLOT_IN_PAST` | |
| `400 SLOT_BLOCKED` | provider blocked it |
| `409 PATIENT_CLASH` | the patient already has an overlapping appointment |
| `400 SLOT_MISMATCH` | slot belongs to a different provider |

Concurrent booking of the same slot by two patients yields exactly one `201` and
one `409`. This is enforced by the database, not by an application-side check.

### `GET /api/appointments`

A patient sees their own; a doctor sees their own patients'; an admin sees all.

| Query | Type | Notes |
|---|---|---|
| `status` | enumList | `?status=scheduled,confirmed` |
| `doctorId` / `patientId` | uuid | |
| `from` / `to` | calendarDate | |
| `limit` / `offset` | number | bounded |

Errors: `422` (unknown status value, out-of-range paging, impossible date).

### `GET /api/appointments/:id` 🔒

One appointment. A patient who does not own it, and a doctor who is not assigned
to it, receive the **same** `403` as each other — the response does not confirm
that the id exists.

### `PATCH /api/appointments/:id/reschedule` 🔒

```json
{ "slotId": "9d44..." }
```

Moves the appointment to a different slot, subject to the same conflict rules as
booking. Clears `reminder_sent_at`, so a rescheduled appointment gets a fresh
reminder.

Errors: `404`, `409 SLOT_TAKEN`, `409 PATIENT_CLASH`, `403`.

### `PATCH /api/appointments/:id/cancel` 🔒

```json
{ "reason": "Unavailable that day" }
```

Errors: `403`, `404`, `409` (already closed).

### `PATCH /api/appointments/:id/status` 🔒

Moves an appointment through the lifecycle.

```json
{ "status": "in-progress" }
```

| From | Allowed to | Who may |
|---|---|---|
| `scheduled` | `confirmed`, `in-progress`, `cancelled`, `no-show` | see below |
| `confirmed` | `in-progress`, `cancelled`, `no-show` | |
| `in-progress` | `completed`, `cancelled`, `no-show` | |
| `completed` / `cancelled` / `no-show` | — terminal | |

Role permissions differ per target status and are enforced server-side. An
illegal transition is `400 INVALID_STATUS`; the table above is the only
authority, and it governs every path including cancellation.

**This is the only way to change an appointment's status.** There is no admin
endpoint that writes appointments directly, so the ownership, transition and
room-lock rules cannot be bypassed by using an administrative route.

### `POST /api/appointments/:id/check-in` 🔒

Marks the patient as arrived and joins the waiting room. A patient can check in
only their own appointment.

Errors: `403`, `404`, `409` (wrong status, wrong day).

---

## Waiting room (queue)

### `GET /api/appointments/availability`

Availability summary for one provider, from inside the appointments resource.
Authenticated, and returns the same shape as
[`GET /api/doctors/:id/availability`](#get-apidoctorsidavailability).

| Query | Type | Notes |
|---|---|---|
| `doctorId` | uuid | |
| `date` | date | optional clinic day |

Errors: `400 MISSING_DOCTOR`, `422`.

### `GET /api/appointments/queue`

A waiting room is the pair **(doctor, clinic date)** — not a per-slot line.
Positions are computed with `row_number()` ordered by `joined_at ASC, id ASC`,
so they are contiguous, self-renumbering, and start at 1.

| Query | Type | Notes |
|---|---|---|
| `doctorId` | uuid | required in practice |
| `date` | date | clinic day |

```json
{
  "doctorId": "59a4...",
  "date": "2026-10-13",
  "clinicDate": "2026-10-13",
  "waitingCount": 3,
  "entries": [
    { "id": "…", "patientId": "…", "patientName": "Aman Verma", "state": "waiting", "roomPosition": 1, "joinedAt": "2026-10-13T09:58:00.000Z" },
    { "id": "…", "patientId": "…", "patientName": "Rhea Kapoor", "state": "waiting", "roomPosition": 2, "joinedAt": "2026-10-13T10:01:00.000Z" }
  ],
  "activeConsultation": { "id": "…", "patientName": "Ishaan Rao", "roomPosition": 0, "calledAt": "2026-10-13T10:04:00.000Z" }
}
```

`roomPosition: 1` means "next patient". The patient in consultation is excluded
from `entries` and reported separately as `activeConsultation`.

**A patient sees only themselves.** For a patient the response contains a single
entry and `activeConsultation: null`, and the room-level fields
(`waitingCount`, other patients' names and positions) are omitted rather than
zeroed — a field that says "just you" while looking like "the room" gets
misread. A doctor must be the provider for that room, or be an admin.

Errors: `400 MISSING_DOCTOR` (a specific code, deliberately not replaced by a
generic validation failure), `422` (malformed id, impossible date), `403`.

### `POST /api/appointments/queue/next` 🔒 doctor / admin

Calls the next patient in the room.

```json
{ "doctorId": "59a4...", "date": "2026-10-13" }
```

**Idempotent.** While somebody is in consultation, calling again returns that
same patient rather than advancing, so a double-click, a retry, or two browsers
cannot skip anyone. The room's advisory lock is taken in a fixed order, so
concurrent calls serialise rather than deadlock.

Only the provider the room belongs to, or an admin, may advance it. A patient
asking about someone else's room is refused outright rather than quietly scoped.

Errors: `400 MISSING_DOCTOR`, `400 MISSING_DATE`, `400 INVALID_DATE`,
`403 FORBIDDEN`, `409 QUEUE_FULL`.

---

## Notifications

Base path `/api/notifications`. All authenticated, all scoped to the caller.

An event is deduplicated by a **partial unique index** on
`notifications.dedupe_key`, not by an application-side check — two concurrent
transactions can both read "not sent yet", so only the database can prevent the
duplicate. A duplicate insert is `ON CONFLICT DO NOTHING` and returns `null`;
the caller treats that as "already handled". It is never a caught `23505`,
because a failed statement **aborts** the surrounding PostgreSQL transaction and
the booking would be rolled back at `COMMIT`.

Events: `appointment_booked`, `appointment_rescheduled`, `appointment_cancelled`,
`appointment_reminder`, `queue_joined`, `queue_called`, `queue_cleared`,
`consultation_completed`.

### `GET /api/notifications`

| Query | Type | Rules |
|---|---|---|
| `limit` | number | 1–200 |

```json
{
  "notifications": [
    {
      "id": "b3f1...",
      "event": "appointment_booked",
      "title": "Appointment booked",
      "body": "You are booked with Dr. Sanjay Gupta on 2026-10-14 at 09:30.",
      "readAt": null,
      "createdAt": "2026-10-13T08:41:12.883Z"
    }
  ],
  "unread": 4,
  "channels": { "sms": false, "email": false, "simulated": true }
}
```

`channels.simulated` is reported so the client can show an honest "not actually
delivered" badge rather than implying a message was sent. It is `true` whenever
`TWILIO_ACCOUNT_SID` or `RESEND_API_KEY` is unset.

Errors: `422` (out-of-range `limit`).

### `PATCH /api/notifications/read-all` 🔒

Marks the caller's own notifications read and persists it.

### `PATCH /api/notifications/:id/read` 🔒

```json
{}
```

The caller's id is part of the `UPDATE`'s `WHERE`, so one caller can never mark
another's notification read — not by guessing an id and not by reading one out of
a log. A missing id and someone else's id produce the **same** `404 NOT_FOUND`,
because distinguishing them would confirm the id exists.

Errors: `422` (id is not a UUID), `404 NOT_FOUND`.

### `GET /api/notifications/scheduler` 🔒 admin

Background-pass health: `enabled`, `running`, `intervalMinutes`, `lastRun`,
`lastDrain`, `lastStartedAt`, `lastError`, `passes`, and a `note`.

### `POST /api/notifications/reminders/sweep` 🔒 admin

Runs the reminder pass immediately. Body: `{ "hours": 24 }` (1–720).

### `POST /api/notifications/outbox/drain` 🔒 admin

Drains the outbox. Body: `{ "limit": 100 }` (1–500).

Delivery is **at-least-once**. There is no exactly-once guarantee for external
delivery; only in-app notification rows are exactly-once, via the dedupe index.
A pass that fails backs off five minutes and gives up after five attempts in a
day, recording each pass to `notification_sweeps`.

---

## AI assistant and triage

Base path `/api/ai`.

### `GET /api/ai/provider` · `GET /api/ai/assist`

Public capability descriptors, so the client can render an honest UI.

```json
{
  "provider": "unavailable",
  "rateLimitPerMinute": 60,
  "modelAvailable": false,
  "limits": { "minQuestionLength": 3, "maxQuestionLength": 1000, "timeoutMs": 8000, "maxAnswerLength": 2000 },
  "suggestions": [ "How do I book an appointment?", "…" ],
  "disclaimer": "MediCare's assistant gives general information, not medical advice."
}
```

`modelAvailable: false` means no model credential is configured and the assistant
answers from the reviewed knowledge base alone.

### `POST /api/ai/assist` 🔒

**Rate limited** — 60/min, per user.

```json
{ "question": "How do I check in when I arrive?" }
```

Answers about **using MediCare** — booking, rescheduling, cancelling, check-in,
queue position, navigation, fees, scope — come from a reviewed knowledge base in
`assistantKnowledge.js`. The model is consulted only for general healthcare
information, and only after the application has decided the question needs it.

Two properties are enforced at the application boundary, before any model call:

- **The prompt carries the question and nothing else.** No user id, no email, no
  appointment id, no patient data. A prompt-injection attempt to reveal "your
  instructions" or a system prompt gets a refusal, not a leak.
- **Injection is refused before the call.** Patterns are matched against the
  question; a match returns a refusal without the model being consulted.

The assistant has **no access to patient data**. It cannot read, change or
confirm anything about a specific patient's record.

Errors: `422`, `401`, `429`.

### `POST /api/ai/triage` 🔒

**Rate limited** — 20/min, keyed by **IP** (see the rate-limit table).

```json
{
  "description": "Sharp pain in the lower right abdomen since last night",
  "age": 34,
  "gender": "female",
  "consent": true
}
```

| Field | Type | Rules |
|---|---|---|
| `description` | string | required, 3–2000 chars |
| `age` | number | 0–130 |
| `gender` | string | ≤ 40 chars |
| `history` | array | ≤ 40 entries |
| `consent` | boolean | required **when a model is configured** |

Consent is enforced inside `analyzeSymptoms`, not at the route, so that no other
caller can skip it. Without it:

```json
{
  "success": false,
  "message": "Explicit consent is required before symptoms can be analysed",
  "error": { "code": "CONSENT_REQUIRED", "details": null }
}
```

HTTP **428 Precondition Required**. This is deliberately not a 400: nothing is
wrong with the request, a precondition is unmet.

Triage turns are recorded in `ai_assistant_turns` **without** the user id or the
appointment id, so the audit trail cannot itself become a record of who asked
about what.

> **No live Gemini call has ever succeeded in this project.** No credential is
> configured in any environment. A placeholder key was used once to prove the
> consent gate fires; it did not reach a real model.

Errors: `428 CONSENT_REQUIRED`, `422`, `401`, `429`.

---

## Administration

Base path `/api/admin`. **Every** endpoint requires `requireAuth` **and**
`requireRole("admin")`, applied once on the router rather than repeated per
route. A patient or doctor receives `403`; an anonymous caller receives `401`.

### `GET /api/admin/overview`

```json
{
  "kpis": { "totalAppointments": 44, "completed": 12, "cancelled": 3, "noShows": 1 },
  "counts": { … },
  "trend": [ { "date": "2026-10-02", "value": 7 } ],
  "bySpecialty": [ … ],
  "topDoctors": [ … ],
  "queue": { "rooms": 2, "waiting": 3, "inConsultation": 1, "oldestWaitingAt": "…" },
  "notifications": { "total": 33, "unread": 32, "last24h": 33,
                     "deliveries": { "queued": 0, "failed": 0, "sent": 0, "simulated": 66 } },
  "scheduler": { "enabled": true, "running": true, "intervalMinutes": 15, "lastRun": {…}, "lastDrain": {…}, "note": "…" }
}
```

### `GET /api/admin/appointments`

Cross-clinic appointment view. **Read-only.**

| Query | Type | Notes |
|---|---|---|
| `search` | string | patient name, doctor name, email, appointment id |
| `status` | enumList | comma-separated |
| `doctorId` / `patientId` | uuid | |
| `from` / `to` | calendarDate | |
| `sort` | string | `newest`, `oldest`, `patient`, `doctor`, `status` |
| `limit` / `offset` | number | 1–200 |

`200` → `{ "appointments": [ { …, "queueState": "waiting", "roomPosition": 2 } ], "total": n, "limit": n, "offset": n }`

`sort` is matched against a **whitelist** and the matched constant is used. An
unrecognised value falls back to the default column; the request text never
reaches SQL.

There is deliberately **no** `POST`, `PATCH` or `DELETE` under
`/api/admin/appointments`. An administrator changes an appointment through
`PATCH /api/appointments/:id/status`, which enforces the same ownership,
transition and lock rules a provider gets.

### `GET /api/admin/queue`

Every waiting room with somebody in it, counting the room the same way the
patient-facing API does so the two can never disagree.

```json
{ "rooms": [ { "doctorId": "…", "doctorName": "Dr. Sanjay Gupta", "clinicDate": "2026-10-13",
               "waiting": 3, "inConsultation": 1, "oldestWaitingAt": "…",
               "activeConsultation": { "appointmentId": "…", "patientName": "…", "calledAt": "…" } } ],
  "total": 2, "limit": 50, "offset": 0 }
```

Read-only. Advancing a room belongs to the provider dashboard, so there is only
one caller per room's advisory lock.

### `GET /api/admin/doctors/:id/availability`

One provider's day as capacity counts rather than rows:
`{ total, available, booked, blocked, withActiveAppointment, availableFees }`.

Counts slots, not appointment joins, so one slot with two active appointments is
still counted once. An unknown provider is `404 DOCTOR_NOT_FOUND`, never a
zeroed report.

### `GET /api/admin/doctors` · `PATCH /api/admin/doctors/:id`

Directory with `search`, `specialty`, `city`, `facilityId`, `accepting`,
`limit`, `offset`. PATCH updates `isAcceptingNew` and `consultationFee`.

### `GET /api/admin/patients`

The patient directory, privacy-conscious by construction. Exposes name, email,
phone, blood group, allergies and appointment **counts** — never a diagnosis,
symptom description, or appointment reason.

Without paging parameters it returns the unpaginated dashboard shape
(`{ patients, count }`). With any of `search`, `sort`, `limit`, `offset` it
returns `{ patients, count, total, limit, offset }`.

The repository never selects a password column, and `stripSecrets` runs as a
**second** pass so a future column cannot leak from this view.

### `GET /api/admin/facilities` · `POST /api/admin/facilities` · `PATCH /api/admin/facilities/:id` · `GET /api/admin/services`

Reference-data management.

### `GET /api/admin/notifications`

Platform-wide dispatch log. Errors: `422` (out-of-range `limit`).

### `GET /api/admin/scheduler`

Background-pass state plus notification delivery counters.

---

## Health

### `GET /api/health`

Public. Used by the deployment guide's health checks.

```json
{
  "success": true,
  "message": "OK",
  "data": {
    "status": "healthy",
    "uptime": 2,
    "database": "connected",
    "counts": { "doctors": 12, "facilities": 6, "services": 5, "appointments": 44 },
    "integrations": {
      "gemini": { "configured": false, "mode": "rule-based" },
      "twilio": { "configured": false },
      "resend": { "configured": false }
    }
  }
}
```

Two different failure modes, with two different answers:

| When | Behaviour |
|---|---|
| Database unreachable **at boot** | The process retries five times, logs `[server] FATAL: cannot reach the database.` and **exits 1**. It never begins listening, so no load balancer ever routes to a process that cannot serve. |
| Database becomes unreachable **while running** | `503` with `{ "status": "unhealthy", "database": "unreachable" }`, so a probe can act on it immediately. |

There is deliberately no "start anyway and serve errors" mode.

Integration flags describe **configuration**, not delivery: a configured provider
still does not mean a message was delivered.

---

## Error reference

| Status | Codes |
|---|---|
| `400` | `BAD_REQUEST`, `MISSING_DOCTOR`, `MISSING_DATE`, `INVALID_DATE`, `INVALID_STATUS`, `INVALID_DATE_RANGE`, `INVALID_MAX_QUEUE`, `MISSING_TIMES`, `SLOT_MISMATCH`, `SLOT_IN_PAST`, `SLOT_BLOCKED`, `SLOT_UNCHANGED`, `SLOT_NOT_STARTED`, `TOO_MANY_SLOTS` |
| `401` | `NO_TOKEN`, `TOKEN_EXPIRED`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_EXPIRED`, `REFRESH_TOKEN_REUSED`, `SESSION_INVALIDATED`, `ACCOUNT_DISABLED` |
| `403` | `FORBIDDEN` |
| `404` | `NOT_FOUND`, `APPOINTMENT_NOT_FOUND`, `DOCTOR_NOT_FOUND`, `SLOT_NOT_FOUND`, `USER_NOT_FOUND`, `FACILITY_NOT_FOUND`, `SERVICE_NOT_FOUND`, `SPECIALTY_NOT_FOUND` |
| `409` | `DUPLICATE`, `CONFLICT`, `SLOT_TAKEN`, `STALE_REFERENCE`, `PATIENT_CLASH`, `QUEUE_FULL`, `QUEUE_BUSY`, `QUEUE_JOIN_FAILED` |
| `422` | `VALIDATION_ERROR` (the only one carrying `details`) |
| `428` | `CONSENT_REQUIRED` |
| `429` | rate limited |
| `500` | `INTERNAL_ERROR` — never returned with a stack trace, SQL text or an internal message |

A `500` is never the correct answer to bad input. Two defects found in Phase 13
were exactly that — an impossible date and a negative `limit` reaching a SQL
cast — and both are now covered by a suite that fails if any malformed input
produces a 5xx.

---

## Architecture and transaction conventions

### Layers

```
routes  ->  controllers  ->  services  ->  repositories  ->  PostgreSQL
```

- **Routes** declare the path, the role gate and the validation rules. They hold
  no business logic.
- **Controllers** translate HTTP to and from service calls. They perform **no**
  database writes of their own — every mutation goes through a service.
- **Services** own business rules and transaction boundaries. A service method is
  the unit of atomicity.
- **Repositories** are the only place SQL is written, and every value is
  parameterised. No request value is ever concatenated into a query string.

### Transactions

`withTransaction(fn)` is explicit about propagation: a transaction context is
carried through the call chain rather than assumed, so a service that calls
another service joins the caller's transaction rather than opening a second one
against the same rows.

Lock ordering is fixed and consistent. Where two transactions can contend — the
room advisory lock, the slot row during booking — they take locks in the same
order, so concurrent requests serialise instead of deadlocking.

### Invariants the database enforces

These are not application conventions; the schema rejects the violation:

- A slot cannot hold two active appointments.
- A patient cannot hold two overlapping appointments.
- Appointments cannot change status outside the transition table.
- `notifications.dedupe_key` is unique where present (partial unique index).
- Appointment ownership, slot/doctor agreement and queue-entry agreement are all
  constrained.

### Waiting room model

A room is `(doctor_id, clinic_date)`. `queue_entries.position` and
`queue_unique_position` survive as legacy per-slot columns; they are **never**
used for ranking. Ranking is the computed `row_number()`.

### Background passes

The scheduler is **in-process**, single-process and best-effort. It runs roughly
every 15 minutes. `DISABLE_SCHEDULER=1` turns it off, and the test suites assert
that it is off rather than assuming it.

It is not a distributed scheduler: running more than one API process would mean
multiple timers. The documented single-process constraint is what makes the
in-process design safe; a multi-process deployment would need an external
scheduler, which is out of scope here.

Reminder timing is **approximate** — at most one interval late, never early.