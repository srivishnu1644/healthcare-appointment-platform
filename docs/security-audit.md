# MediCare — Security Audit

**Phase 0 deliverable. Nothing in this document has been fixed.** Every finding below was
either read directly from source with a file:line citation, or reproduced against a running
instance of the server. Reproduction steps and observed output are included for each.

Severity scale:
**CRITICAL** — credential compromise or cross-tenant data access.
**HIGH** — privilege escalation or unauthorized mutation.
**MEDIUM** — exploitable weakness requiring a precondition.
**LOW** — hardening gap.
**INFO** — defence-in-depth / correctness note.

---

## Summary

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| S-01 | **CRITICAL** | `/api/demo-accounts` serves plaintext passwords, unauthenticated | Reproduced |
| S-02 | **CRITICAL** | Passwords stored as `` `hashed:${plaintext}` `` — reversible, not hashed | Source-verified |
| S-03 | **CRITICAL** | `GET /api/appointments/:id` returns the doctor's password hash | Reproduced |
| S-04 | **CRITICAL** | `GET /api/auth/me` + login response return the doctor's password hash | Reproduced |
| S-05 | **HIGH** | Self-registration accepts `role:"provider"` → escalates to doctor | Reproduced |
| S-06 | **HIGH** | IDOR: `POST /appointments/:id/check-in` has no ownership check | Reproduced |
| S-07 | **HIGH** | IDOR: `GET /notifications?patientId=` honoured for non-admins | Reproduced |
| S-08 | **HIGH** | `PATCH /api/auth/me` merges `profile` unvalidated → arbitrary key injection | Reproduced |
| S-09 | **MEDIUM** | Hardcoded fallback JWT secret in two locations | Source-verified |
| S-10 | **MEDIUM** | Rate limiting disabled unless `NODE_ENV === "production"` | Source-verified |
| S-11 | **MEDIUM** | `CORS_ORIGIN || true` → reflect-any-origin with `credentials: true` | Source-verified |
| S-12 | **MEDIUM** | 7-day JWT, no refresh, no revocation, no server-side logout | Source-verified |
| S-13 | **MEDIUM** | No security headers (no Helmet, no CSP, no HSTS) | Source-verified |
| S-14 | **MEDIUM** | `bcryptjs` installed but the hash branch is unreachable — false sense of security | Source-verified |
| S-15 | **LOW** | `/api/health` exposes row counts and `seededAt` unauthenticated | Reproduced |
| S-16 | **LOW** | Queue readable for any doctor by any authenticated user | Reproduced |
| S-17 | **LOW** | Admin can set a doctor's `rating` directly | Source-verified |
| S-18 | **LOW** | Public doctor profile returns synthetic "patients treated" / "repeat rate" | Source-verified |
| S-19 | **LOW** | Patient PHI (email, phone, blood group, allergies) exposed to admin with no audit log | Source-verified |
| S-20 | **INFO** | Client build is broken (`vite` 8 vs `@vitejs/plugin-react` 4) | Reproduced |
| S-21 | **INFO** | `.env` files committed with no `.gitignore` and no `.env.example` | Source-verified |
| S-22 | **INFO** | JWT payload carries `email`/`name` — PII in a client-readable token | Source-verified |

---

## S-01 — CRITICAL — Plaintext demo credentials served without authentication

**Location** `server/src/app.js:72-82`

```js
app.get("/api/demo-accounts", (req, res) =>
  res.json({ success: true, message: "OK", data: [
    { role: "patient", email: "patient@demo.com", password: "patient123" },
    { role: "doctor",  email: "doctor1@demo.com", password: "doctor123" },
    { role: "admin",   email: "admin@demo.com",  password: "admin123" },
  ]}));
```

**Reproduced**

```
GET /api/demo-accounts      (no Authorization header)
HTTP/1.1 200 OK
{"success":true,"message":"OK","data":[
  {"role":"patient","email":"patient@demo.com","password":"patient123"},
  {"role":"doctor","email":"doctor1@demo.com","password":"doctor123"},
  {"role":"admin","email":"admin@demo.com","password":"admin123"}]}
```

Anyone on the internet can obtain a working **admin** credential. Combined with S-05
(self-registration as a doctor) and the complete absence of an audit trail, an attacker
reaches admin in one request.

**V2 remediation:** delete the route. If demo credential hints are wanted for a reviewer,
serve them from the frontend build or gate them behind an explicit non-production flag that
refuses to start when `NODE_ENV === "production"`.

---

## S-02 — CRITICAL — Passwords are stored as reversible strings, not hashed

**Location** `server/src/config/db.js:250-253` (seed; the return is at line 252) and
`server/src/controllers/authController.js:48` (registration)

```js
// db.js
function hashPassword(plain) {
  // deterministic, no external dep needed at seed time
  return `hashed:${plain}`;
}

// authController.register
password: `hashed:${password}`,
```

**This is not hashing.** The stored value *is* the plaintext with a `hashed:` prefix. Anyone
with read access to `server/.data/db.json` — which is **committed to the repository** — has
every password in cleartext. Because the repository is not currently a git repo this has not
been pushed, but the file is present on disk and in the working tree.

The committed `db.json` contains all 16 credentials verbatim:

```json
"password": "hashed:patient123"   /  "hashed:doctor123"  /  "hashed:admin123"
```

**Verification path exists but never runs.** `authController.js:9-14`:

```js
async function verifyPassword(plain, stored) {
  if (String(stored).startsWith("hashed:")) return stored === `hashed:${plain}`;
  const bcrypt = (await import("bcryptjs")).default;
  return bcrypt.compare(plain, stored);
}
```

The `bcrypt.compare` branch is correct and would work — it is **unreachable**, because no
code path in the entire application ever produces a bcrypt hash. `bcrypt.hash` appears
**zero** times in the repository.

**V2 remediation:** `bcrypt.hash(password, 12)` at registration and at seed time; migrate
existing `hashed:` values on first successful login (detect the prefix, compare, re-hash).
Delete the `hashed:` branch once every account is migrated.

---

## S-03 — CRITICAL — Password hash leaked by `GET /api/appointments/:id`

**Location** `server/src/controllers/appointmentController.js:74-79`

```js
return sendSuccess(res, {
  appointment: a,
  doctor: db.doctors.find((d) => d.id === a.doctorId) || null,   // <-- raw object
  ...
});
```

The response runs the **raw** `db.doctors` record through, not the whitelisted
`shape()` helper that `doctorController` uses everywhere else. Seeded doctor records embed a
full copy of their user row under `user`, which includes `password`.

**Reproduced**

```
POST   /api/appointments  {"doctorId":"doc_...","slotId":"slot_..."}   -> 201
GET    /api/appointments/:id    (patient token)
HTTP/1.1 200 OK
{
  "doctor": {
    "id":"doc_cc3ab42b91b7", "userId":"usr_...", "name":"Dr. ...", ...
    "user": { "email":"doctor10@demo.com", "password":"hashed:doctor123", "role":"doctor" }
  }
}
```

Any patient who books with a doctor can read that doctor's password hash, and therefore
their password. Note the doctor here is **not even the doctor for that appointment** — the
leak surfaces on *any* appointment detail whose `doctorId` matches.

**V2 remediation:** every response must be built from an explicit projection. Never return a
persistence object directly.

---

## S-04 — CRITICAL — Password hash leaked by `GET /api/auth/me` and the login response

**Location** `server/src/controllers/authController.js:16-28`

```js
const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone,
  profile: u.profile, createdAt: u.createdAt,
  doctor: u.role === "doctor" ? db.doctors.find((d) => d.userId === u.id) || null : undefined,
});
```

Despite the name, `publicUser` is not public-safe: for a doctor it attaches the **raw**
doctor record, which contains `user.password`.

**Reproduced**

```
POST   /api/auth/login  {"email":"doctor1@demo.com","password":"doctor123"}
HTTP/1.1 200 OK
{ "data": { "user": { ..., "doctor": { ..., "user": {
    "email":"doctor1@demo.com", "password":"hashed:doctor123" } } } } }

GET    /api/auth/me      (doctor token)   -> same leak
```

The doctor receives their own credential material back on every login and on every session
restore (`AuthContext` calls `/auth/me` on every page load).

**V2 remediation:** `publicUser` must project the doctor through the same whitelist used by
`GET /api/doctors`. Never attach an entity object to a user projection.

---

## S-05 — HIGH — Self-registration escalates to the doctor role

**Location** `server/src/controllers/authController.js:49`

```js
role: role === "provider" ? "doctor" : "patient",
```

`authRoutes.js:32` validates `role: { enum: ["patient", "provider"] }` — so `"provider"` is
an explicitly accepted value that is then mapped to the privileged `doctor` role.

**Reproduced**

```
POST /api/auth/register
{"name":"Fake Provider","email":"probe-provider@x.com","password":"probe123","role":"provider"}
HTTP/1.1 201 Created
{"success":true,"message":"Account created",
 "data":{"token":"<valid JWT with role:doctor>","user":{"id":"usr_...","role":"doctor", ...}}}
```

A valid doctor JWT is issued immediately. The account has no linked `doctors` record, so
`GET /api/doctors/me/schedule` returns 404 `NO_DOCTOR_PROFILE` — but the role is `doctor`,
so every `requireRole("doctor", …)` gate downstream is satisfied. Any future endpoint that
relies only on `req.user.role` becomes accessible to self-registered strangers.

**V2 remediation:** public registration creates **patients only**. Doctor accounts are
provisioned by an admin (invite flow) and carry a doctor record before any JWT is issued.
The role must be derived server-side, never accepted from the request body.

---

## S-06 — HIGH — IDOR: check-in has no ownership or role check

**Location** `server/src/routes/appointmentRoutes.js:59` and
`server/src/controllers/appointmentController.js:179-182`

```js
router.post("/:id/check-in", ctrl.checkIn);          // no requireRole, no owner check

export const checkIn = asyncHandler(async (req, res) => {
  const result = joinQueue(req.params.id);           // req.params.id used directly
  return sendSuccess(res, result, "Checked in to the queue");
});
```

Every other per-appointment route in the same file performs an ownership check
(`getAppointment`, `reschedule`, `cancel`). `checkIn` has none.

**Reproduced — a different patient**

```
Setup:   patient "Ishita Desai" books today's 16:00 slot  -> 201 confirmed
Attack:  POST /api/appointments/<ishita's id>/check-in   (patient "Rahul Verma" token)
Result:  HTTP/1.1 200 OK
         {"success":true,"message":"Checked in to the queue",
          "data":{"queuePosition":2,"appointment":{...,"status":"in-progress"}}}
```

Ishita's appointment was silently moved to `in-progress` and she was placed in a queue she
never joined. A patient can also spam check-in to inflate their own queue position
(`joinQueue` increments `slot.currentQueue` and never decrements it).

**Reproduced — an unrelated doctor**

```
POST /api/appointments/<ishita's id>/check-in   (doctor5 token, a different doctor)
Result:  HTTP/1.1 200 OK
```

**V2 remediation:** require the caller to be the appointment owner, the assigned doctor, or
an admin. Add a reusable `requireAppointmentAccess` ownership middleware rather than
re-implementing the check per controller — the duplication is what caused this.

---

## S-07 — HIGH — IDOR: any authenticated user can read another patient's notifications

**Location** `server/src/controllers/notificationController.js:11-17`
(the trust boundary is line 15)

```js
const targetId =
  req.user.role === "patient" ? req.user.id
                              : req.query.patientId || req.user.id;
const mine = db.notifications.filter((n) => n.patientId === targetId);
```

Patients are correctly pinned to their own id. For every other role the caller-supplied
`?patientId=` is trusted, with no verification.

**Reproduced**

```
Setup:  patient "Ishita Desai" books -> notification created
Attack: GET /api/notifications?patientId=<ishita's userId>   (doctor5 token)
Result: HTTP/1.1 200 OK
        {"data":{"notifications":[
          {"subject":"Appointment confirmed","patientName":"Ishita Desai",
           "email":"ishita@demo.com","phone":"+91 90000 10002","body":"Hi Ishita Desai, ..."}],
         "unread":1}}
```

Any doctor can enumerate patient ids and harvest patient names, email addresses, phone
numbers, and the content of appointment notifications. Admin access is legitimate; doctor
access is not.

**V2 remediation:** ignore `?patientId=` unless `req.user.role === "admin"`. Return the
caller's own notifications otherwise.

---

## S-08 — HIGH — Unvalidated `profile` merge allows arbitrary key injection

**Location** `server/src/controllers/authController.js:111-114`

```js
const { name, phone, profile } = req.body;
if (name) user.name = name;
if (phone) user.phone = phone;
if (profile) user.profile = { ...user.profile, ...profile };   // wholesale merge
```

`PATCH /api/auth/me` has **no `validate()` middleware at all** (see `authRoutes.js:48`) and
the merge is unconditional on every key of the supplied object.

**Reproduced**

```
PATCH /api/auth/me   (patient token)
{"profile":{"role":"admin","isAdmin":true,"allergies":"not-an-array","junk":{"deep":1}}}
HTTP/1.1 200 OK
{"data":{"user":{"role":"patient","profile":{
  "dateOfBirth":"1994-06-15","gender":"male","bloodGroup":"O+",
  "address":"45 Park Street, Bengaluru","emergencyContact":"+91 90000 11111",
  "allergies":"not-an-array",         <-- type contract broken
  "role":"admin","isAdmin":true,      <-- attacker-controlled keys persisted
  "junk":{"deep":1}}}}}
```

`role` on the user was *not* escalated (the controller does not copy it), but the arbitrary
keys **were persisted verbatim** and `allergies` was corrupted from `string[]` to `string`.
Any column or field added to the profile object in future is attacker-settable by default.

**V2 remediation:** apply a schema with `.strict()` (reject unknown keys) to `PATCH
/api/auth/me`. Validate the nested `profile` object field by field with explicit types and
an `array<string>` constraint on `allergies`.

---

## S-09 — MEDIUM — Hardcoded fallback JWT signing secret

**Two independent locations:**

`server/src/config/env.js:38`
```js
const DEFAULTS = { ..., JWT_SECRET: "medicare-prototype-dev-secret", JWT_EXPIRES_IN: "7d", ... };
```

`server/src/middlewares/authMiddleware.js:6`
```js
const SECRET = process.env.JWT_SECRET || "medicare-prototype-dev-secret";
```

`server/.env` **does not define `JWT_SECRET`**, so the fallback is in active use in this
checkout. Anyone reading the source can forge a token for any user id — including an admin
id, whose id is discoverable via `GET /api/admin/patients`.

The `env.js` comment ("so a fresh clone runs with no manual setup") means the app **starts
successfully with an insecure secret and no warning**.

**V2 remediation:** delete the fallback. If `JWT_SECRET` is absent in production, exit
non-zero at boot. Generate with `openssl rand -base64 48`; document rotation.

---

## S-10 — MEDIUM — Rate limiting is disabled outside production

**Location** `server/src/routes/authRoutes.js:17`

```js
skip: () => process.env.NODE_ENV !== "production",
```

The README discloses this, which is good. The risk is operational: `server/.env` ships
`NODE_ENV=development`. If the backend is deployed to Render without explicitly setting
`NODE_ENV=production`, **all brute-force protection on `/login` and `/register` is silently
off**. There is no startup assertion to catch the mistake.

Note the `/api/ai/triage` limiter has no such `skip`, so it applies everywhere.

**V2 remediation:** keep the development skip, but add a boot-time check that logs a loud
warning when the limiter is disabled, and make `NODE_ENV` an explicit Render env var. Use a
persistent store if more than one instance is run.

---

## S-11 — MEDIUM — CORS degrades to reflect-any-origin with credentials

**Location** `server/src/app.js:26-31`

```js
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(",") || true,   // <-- true = reflect request Origin
  credentials: true,
}));
```

`origin: true` tells the `cors` package to echo the caller's `Origin` header, paired with
`credentials: true`. That is the classic permissive-CORS misconfiguration.

**Current status is masked.** `server/.env` does not define `CORS_ORIGIN`, so `env.js:40`
backfills `"http://localhost:5173"` and the effective allow-list is a single origin. Verified:

```
GET /api/health   (Origin: https://evil.example.com)
access-control-allow-origin: (absent)
```

So today it is *closed*, but by accident — one removed default away from open. And it is
closed **in the wrong direction**: a Vercel-hosted frontend will be blocked until someone
sets `CORS_ORIGIN`, with no error explaining why.

**V2 remediation:** require `CORS_ORIGIN` in production, parse it, and reject the boot if it
is missing or `*`. Since auth uses a bearer token (not cookies), `credentials: true` is
unnecessary and can be dropped.

---

## S-12 — MEDIUM — Long-lived tokens with no refresh or revocation

- `JWT_EXPIRES_IN` defaults to **`7d`** (`env.js:39`, `authMiddleware.js:7`).
- Payload: `{ sub, email, role, name }` (`authMiddleware.js:11`).
- No refresh token, no rotation, no deny-list, no `tokenVersion` on the user record.
- `logout()` in `AuthContext.jsx:94-97` clears localStorage only; there is no server call.

A stolen token is valid for up to 7 days and cannot be invalidated. Changing a password does
not invalidate existing sessions.

**V2 remediation:** access token ~15 min + rotating refresh token; `auth_sessions` table;
deny-list on password change and on admin role change.

---

## S-13 — MEDIUM — No security headers

`app.js` installs `cors`, `express.json`, `express.urlencoded`, `morgan` and two custom
timing loggers. There is **no `helmet`**, no CSP, no `X-Content-Type-Options`, no
`X-Frame-Options`, no HSTS, no `Referrer-Policy`. The SPA is served from the same origin
(`app.js:100-106`) with no frame protection.

**V2 remediation:** `helmet` with a CSP appropriate to a Vite/React bundle served from a
different origin than the API.

---

## S-14 — MEDIUM — `bcryptjs` gives a false impression of security

`bcryptjs@^2.4.3` is a declared production dependency and `bcrypt.compare` is implemented —
but `bcrypt.hash` is called **nowhere**. The dependency is load-bearing for nothing. Anyone
reading `server/package.json` reasonably concludes passwords are hashed.

**V2 remediation:** wire hashing up (S-02). Also upgrade to `bcryptjs@^3`, or move to
Node's built-in `crypto.scrypt` to remove the dependency entirely.

---

## S-15 — LOW — Unauthenticated information disclosure on `/api/health`

**Reproduced**

```
GET /api/health   (no auth)
{"data":{"status":"healthy","uptime":3,"seededAt":"2026-10-08T13:37:01.490Z",
 "counts":{"doctors":12,"facilities":6,"services":5,"appointments":44}}}
```

Row counts and seed timestamp are public. Useful for the prototype; unnecessary in production.

**V2 remediation:** return `{status}` only in production; move counts behind `/api/admin`.

---

## S-16 — LOW — Queue readable for any doctor by any authenticated user

**Reproduced** `GET /api/appointments/queue?doctorId=<any>` with a patient token → **200**
with queue entries. `getQueue` returns `patientName` for each entry, so any signed-in user
can read the waiting list of any doctor. Compounded by S-06: names can also be inserted by
an attacker.

**V2 remediation:** patients see only their own position; doctors see their own queue; admins
see everything.

---

## S-17 — LOW — Admin can directly set a doctor's rating

**Location** `server/src/controllers/adminController.js:179-188` (the `allowed` array,
line 179)

```js
const allowed = ["isAcceptingNew","consultationFee","facilityId","rating","experience","bio","qualification"];
```

`rating` is customer-review data; an admin-editable rating with no review table behind it is
a data-integrity problem and undermines any analytics built on it.

**V2 remediation:** remove `rating` from the admin allow-list; introduce a `reviews` table
and derive the rating from it.

---

## S-18 — LOW — Public endpoint returns synthetic clinical statistics

**Location** `server/src/controllers/doctorController.js:196-202`

```js
stats: {
  totalReviews: doctor.reviewCount,
  patientsTreated: 500 + doctor.experience * 40,
  repeatRate: 65 + (doctor.id.charCodeAt(doctor.id.length - 1) % 25),
}
```

`patientsTreated` and `repeatRate` are arithmetic on the seed data, served **unauthenticated**
from `GET /api/doctors/:id`. Presenting invented clinical figures on a public healthcare
profile is misleading.

**V2 remediation:** derive from real data, or remove the fields.

---

## S-19 — LOW — Admin PHI access is unaudited

`GET /api/admin/patients` returns patient `email`, `phone`, `bloodGroup` and `allergies`.
A clinical-administration view of blood group and allergies is a legitimate feature, but
there is no record of **who** accessed **whose** record. `morgan` logs method/path/status
only — no actor, no resource id.

**V2 remediation:** an `access_log` table written on every admin read of patient PHI.

---

## S-20 — INFO — Client cannot be installed (deployment/supply-chain blocker)

`client/package.json` pins `vite@^8.3.2` against `@vitejs/plugin-react@^4.3.1`, whose peer
range is `^4.2 || ^5 || ^6 || ^7`.

```
$ cd client && npm ci
npm error code ERESOLVE
npm error While resolving: @vitejs/plugin-react@4.7.0
npm error Found: vite@8.3.2
npm error peer vite@"^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0" from @vitejs/plugin-react@4.7.0
```

`client/package-lock.json` commits the same invalid pair, so Vercel and CI both fail on a
clean checkout. `@vitejs/plugin-react@6.x` supports Vite 8.

---

## S-21 — INFO — Secrets hygiene

- `.gitignore` **does not exist**. `server/.env` and `client/.env` are in the working tree.
- No `.env.example`.
- The repository is **not under version control**, so nothing has been pushed — but there is
  also no ignore file to prevent it once `git init` happens.
- `server/.data/db.json` (468 KB, containing all plaintext passwords per S-02) sits in the
  tree.
- `client/dist/` is committed (280 KB).
- No secret is currently committed *with a value* — `.env` files contain only empty
  optional keys, and `JWT_SECRET` is absent entirely. **This is the one thing being done
  right; protect it with `.gitignore` before `git init`.**

---

## S-22 — INFO — PII inside the JWT payload

`authMiddleware.js:11` signs `{sub, email, role, name}`. `authMiddleware.requireAuth` then
**re-reads the user from the datastore on every request** (line 29), so the extra claims buy
nothing — they only expose PII to anyone who reads the token in devtools.

**V2 remediation:** sign `{sub, role}` (or `{sub}`) only; let the datastore supply the rest.

---

## What is already correct

Stated so the v2 work preserves it:

1. **Passwords are never returned** by `publicUser` or `shape()` **by intent** — the
   whitelist helpers exist and are used correctly in `doctorController` and
   `adminController.listDoctorsAdmin` (which explicitly destructures
   `const { user, ...safe } = d` at line 146). The failures in S-03/S-04 are *inconsistency*,
   not ignorance.
2. **Login errors are uniform** — `"Invalid email or password"` for both unknown email and
   wrong password (`authController.js:83-85`). No user enumeration.
3. **The global error handler does not leak internals** — unknown errors become
   `"Something went wrong on our side"` (`errorHandler.js:26-31`); stacks go to the log only.
4. **Role gates work** — verified 403 for patient → `/api/admin/overview`,
   patient → `/api/doctors/me/schedule`, patient → `POST /api/doctors/:id/slots`.
5. **Ownership checks exist** on `getAppointment`, `reschedule` and `cancel`.
6. **JWT is verified on every request** and the user is re-loaded from the datastore, so
   deleted users are correctly rejected.
7. **Tokens are in `localStorage`, not cookies** — so there is no CSRF surface.
8. **`express-rate-limit`** is present on credentials and AI routes.
9. **Passwords are never logged** anywhere in the codebase.

---

## Remediation priority for Phase 3

| Order | Item | Rationale |
| --- | --- | --- |
| 1 | S-01 delete `/api/demo-accounts` | One request → admin access |
| 2 | S-02 bcrypt hashing | Every other credential fix depends on it |
| 3 | S-06, S-07 ownership checks | Active cross-patient data access |
| 4 | S-03, S-04 response projections | Active credential disclosure |
| 5 | S-05 registration is patient-only | Privilege escalation |
| 6 | S-08 strict profile validation | Prevents re-introduction of S-08 |
| 7 | S-09 remove the JWT fallback secret | Cheap, high value |
| 8 | S-13 Helmet + CSP | Cheap |
| 9 | S-10, S-11, S-12, S-21 env hardening | Deployment blockers |
| 10 | S-15…S-19 hardening items | Before public launch |
| — | S-20 build fix | Required for *any* deployment; do it in Phase 1 |