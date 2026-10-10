# MediCare — Architecture

Current architecture as verified, then the target MediCare v2 architecture with the
responsibility of each layer.

---

# PART A — CURRENT ARCHITECTURE

## A.1 System shape

A two-package monolith: a Vite-built React SPA and an Express REST API, both in one
repository, sharing no build system (no workspaces) but a single `package.json` with
`install:all` / `dev` / `build` / `start` scripts and `concurrently` for local dev.

```
┌──────────────────────────────────────────────────────────────────┐
│  BROWSER                                                           │
│  React 18 SPA (Vite build → client/dist, served by Express)        │
│    main.jsx → BrowserRouter → ToastProvider → AuthProvider → App  │
│    AuthContext   : token + user in localStorage, /auth/me revalid │
│    ToastContext  : transient toasts                               │
│    api/client.js : single fetch wrapper, unwraps {success,...,data}│
│    useNotifications : 30 s polling (instantiated twice)            │
│    14 routes, inline <Routes> in App.jsx                          │
│    Styling: 908-line hand-written CSS (NO Tailwind)               │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP/JSON, Bearer JWT in header
                            │ in dev: CORS, because client/.env sets an
                            │ absolute VITE_API_URL and bypasses the proxy
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  NODE.JS / EXPRESS 4                                               │
│  index.js        listen + graceful shutdown                        │
│  app.js          cors → json(1mb) → morgan → timing log            │
│                  → /api/health → /api/demo-accounts                │
│                  → 6 routers → static SPA → 404 → errorHandler     │
│                                                                   │
│  routes/ (6)      auth doctor appointment notification admin ai     │
│       │  requireAuth → requireRole(...) → validate({...})          │
│       ▼                                                           │
│  controllers/ (6) thin: read req, call service, sendSuccess        │
│       │                                                           │
│       ▼                                                           │
│  services/ (3)    appointmentService  slots, booking, queue,       │
│                             status machine                         │
│                   aiService          Gemini + rule-based triage    │
│                   notificationService SMS/email (console or API)   │
│       │                                                           │
│       ▼                                                           │
│  config/db.js    single in-memory object, no interface, no ORM      │
│       │  db.users / doctors / slots / appointments / …            │
│       ▼  fs.writeFileSync(JSON.stringify(db)) on every mutation   │
│  server/.data/db.json     468 KB, committed to the tree            │
└───────────────────────────────────────────────────────────────────┘
       │ optional, all absent in this checkout
       ├── Gemini REST API   (rule-based fallback)
       ├── Twilio REST API   (console-log fallback)
       ├── Resend REST API   (console-log fallback)
       └── Supabase          (declared in env, never imported)
```

## A.2 Request lifecycle (verified against source)

```
1  request
2    app.js: cors → express.json → express.urlencoded → morgan → timing log
3    router match:
4      /api/health            → inline handler
5      /api/demo-accounts     → inline handler  ⚠️ unauthenticated
6      /api/<group>/*         → router
7        requireAuth           jwt.verify(token, SECRET) + reload user from db
8        requireRole(...)       403 if role not in list
9        validate(rules)        declarative type/enum/length checks → 422
10       asyncHandler(controller)
11         controller: read req → call service(s) → sendSuccess / throw AppError
12       service: business rules, mutates the shared in-memory db, calls persist()
13       persist(): JSON.stringify(db, null, 2) → server/.data/db.json
14     response { success, message, data }
15   app.use('/api', notFound)  → 404 envelope
16   app.use(errorHandler)      → AppError passthrough | 23505 → 409 | else generic 500
```

## A.3 Data layer as it actually is

There is **no data-access abstraction**. Every controller and service imports the same
module-level singleton and operates on it directly:

```js
import db, { id, persist } from "../config/db.js";
const doctor = db.doctors.find((d) => d.id === req.params.id);
```

`db.js` exports the live object as default. Consequences:

- Business logic cannot be unit-tested without mutating real state.
- Filtering, sorting and pagination happen in memory, in the request path.
- There is no query planner, no index, no join. `adminController.overview` alone performs
  ~130 full-array scans per request.
- Every mutation rewrites the entire 468 KB file synchronously, blocking the event loop.
- Two Node processes would corrupt each other's file.

`README.md` states "Swapping in MongoDB means replacing that one module." That is an
understatement: the *seam exists physically* but not *structurally* — 10 source files import
the singleton and hold **118** `db.<collection>` references between them, so the replacement is
a rewrite of every query site, not a module swap.

## A.4 State management, frontend

| Concern | Mechanism | Assessment |
| --- | --- | --- |
| Auth | `useState` + `localStorage` in `AuthContext` | Fine for a monolith |
| Server data | `useState` + `useEffect` in each page, ~2 KB per page | No caching, no dedupe, no invalidation |
| Toasts | `ToastContext` | Good |
| Notifications | `useNotifications` hook, 30 s `setInterval` | Mounted in both `App.jsx` and `Home.jsx` → two pollers |
| Forms | Local `useState` per page | No shared form layer |

## A.5 Architecture strengths to preserve

1. **Layer discipline on the server.** `routes → controllers → services` is genuine. The
   service layer holds slot allocation, the status state machine and the queue.
2. **One response envelope** plus a stable machine-readable error `code` on every path.
3. **A centralised error handler that does not leak internals.**
4. **Composable auth middleware** (`requireAuth`, `requireRole`) rather than ad-hoc checks.
5. **Declarative validation middleware** — the pattern is right even if the implementation
   needs replacing.
6. **A whitelist-projection idiom** (`publicUser`, `shape`, `withAccount`). It exists and is
   used correctly in most places; it is simply not universal.
7. **A 35-assertion end-to-end smoke suite** that genuinely exercises the happy paths and
   the role gates.
8. **Frontend resilience patterns** — loading, empty, and error states are present and
   consistent on every page.

## A.6 Architectural weaknesses

| # | Weakness | Consequence |
| --- | --- | --- |
| 1 | No data-access layer; the `db` singleton is imported by 10 files (118 references) | Cannot swap the store without rewriting every query site; cannot unit-test services |
| 2 | No transactions or locking | Booking correctness is enforced by application code only; see [current-state.md §7](./current-state.md#7-booking-behaviour--verified-matrix) |
| 3 | No constraints of any kind | Every reference, status and uniqueness rule is advisory |
| 4 | Denormalised duplicates | `specialty`+`specialtyName`, `facilityName`+`facilityId`, `city`+`address`, `slotId`↔`appointmentId`, `fee`, `patientName`, `symptoms`≡`reason` |
| 5 | Embedded full user copy inside each doctor record | Root cause of S-03/S-04 |
| 6 | Dates and times as free-text strings | `"2026-10-08"` + `"09:00"`, no timezone, no timestamptz |
| 7 | Untyped `users.profile` blob | No schema; injectable (S-08) |
| 8 | Whole-file synchronous persistence | 468 KB rewrite per mutation; blocks the event loop |
| 9 | Polling for "real-time" | 30 s latency; duplicate pollers |
| 10 | No frontend data layer | Every page hand-rolls fetch + loading + error |
| 11 | No route-level code splitting | One 262 KB bundle |
| 12 | No error boundary | A render throw blanks the app |
| 13 | 908-line CSS, heavy inline `style={{}}` | Off-target-stack, hard to maintain |

---

# PART B — TARGET MEDICARE V2 ARCHITECTURE

## B.1 System shape

```
┌───────────────────────────────────────────────────────────────────────┐
│  VERCEL — frontend (CDN, static assets)                                │
│                                                                       │
│  React 19 + Vite + React Router 7 + Tailwind CSS                      │
│                                                                       │
│  app/                                                               │
│    router.jsx              route table + lazy()                        │
│    routes/guards.jsx       <Protected roles={[...]}> <GuestOnly>       │
│    providers/              AuthProvider · ToastProvider               │
│                             QueryProvider (TanStack Query)            │
│                             RealtimeProvider (Supabase Realtime)       │
│    features/               one folder per domain (see B.4)            │
│    components/ui/          Button Input Card Modal Table Badge …       │
│    lib/api/                fetch wrapper + Zod response parsing        │
│    lib/realtime/           channel names + subscribe helpers           │
│    lib/validation/         shared schemas (mirrored from the server)   │
│                                                                       │
│  AuthContext   : access token in memory + refresh token in memory,     │
│                  silent refresh, optimistic logout                     │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ HTTPS  ·  Bearer access token
                               │ CORS allow-list = Vercel domain(s)
                               ▼
┌───────────────────────────────────────────────────────────────────────┐
│  RENDER — backend (single Node service, stateless)                     │
│                                                                       │
│  src/server.js            boot: validate env → connect DB → listen     │
│  src/app.js               express app factory (no side effects)        │
│                                                                       │
│  ┌── middleware (cross-cutting, outermost first) ───────────────────┐  │
│  │ helmet · cors(allow-list) · express.json · morgan · requestId   │  │
│  │ rateLimit(auth, ai) → requireAuth → requireRole → validate(Zod)   │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── routes/            URL shape only, no logic ───────────────────┐  │
│  │ auth · doctors · appointments · slots · notifications · triage    │  │
│  │ · admin · queue · health                                          │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── controllers/       HTTP adapter only ─────────────────────────┐  │
│  │ parse validated input · call ONE service · map to envelope       │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── services/          all business rules + transaction boundaries ─┐  │
│  │ authService      bcrypt, JWT issue/refresh/revoke                │  │
│  │ doctorService    search, filters, ranking                       │  │
│  │ slotService      availability templates, slot lifecycle          │  │
│  │ appointmentService  ★ booking / reschedule / cancel in ONE txn   │  │
│  │ queueService     check-in, position, advance                    │  │
│  │ notificationService  in-app rows + outbox for SMS/email          │  │
│  │ triageService    Gemini + rule fallback, "recommendation" only  │  │
│  │ analyticsService SQL aggregates                                 │  │
│  │ adminService     CRUD + audit logging                           │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── repositories/  *** the new layer ***  pure data access ───────┐  │
│  │ userRepo · doctorRepo · specialtyRepo · facilityRepo             │  │
│  │ serviceRepo · availabilityRepo · slotRepo · appointmentRepo      │  │
│  │ notificationRepo · queueRepo · auditRepo                         │  │
│  │   · SQL only · no business rules · no req/res                    │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── integrations/  external systems, behind interfaces ──────────┐  │
│  │ supabase (pg pool + realtime publish)                            │  │
│  │ gemini   (fetch, timeout, retry, schema-validated output)         │  │
│  │ sms / email  (outbox drain; no provider = log to console)        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│  ┌── shared/  AppError · logger · env (validated) · crypto · ids ─┐  │
│                                                                       │
│  errorHandler (terminal)  ·  notFound                                 │
│  openapi/               OpenAPI 3.1 spec (single source of truth)      │
│  db/                    migrations/*.sql · seeds/*.sql                  │
│  tests/                 jest + supertest                               │
└──────────────────────────────┬────────────────────────────────────────┘
                               │  SQL (transactional)          │ Realtime publish
                               ▼                               ▼
                    ┌──────────────────────┐        ┌──────────────────────┐
                    │ SUPABASE POSTGRESQL  │◀──────▶│ SUPABASE REALTIME    │
                    │ RLS enabled          │        │ Postgres Changes     │
                    │ constraints enforced  │        │ (slot / appt / queue │
                    │                      │        │  / notification)     │
                    └──────────────────────┘        └──────────────────────┘
```

## B.2 Layer responsibilities

### `src/middleware/` — cross-cutting concerns
One job per middleware, applied outermost-first, never containing business logic.

| Middleware | Responsibility | Must not |
| --- | --- | --- |
| `helmet` | security headers + CSP | — |
| `cors` | strict origin allow-list from validated env | fall back to `true` |
| `requestId` | attach/propagate an id; include it in every log line | — |
| `authLimiter` / `aiLimiter` | brute-force and cost control; **always on**, store-shared when scaled | depend on `NODE_ENV` silently |
| `requireAuth` | verify JWT; load the user; attach `req.user`; verify the session is not revoked | touch the database more than once |
| `requireRole(...roles)` | role gate, 403 otherwise | perform its own data lookup |
| `validate(schema, source)` | parse with a **strict** Zod schema → 422 on failure; strips unknown keys | coerce silently |
| `requireAppointmentAccess` | resolves `:id` to `{appointment, isOwner, isProvider, isAdmin}` | duplicate per controller |
| `errorHandler` | terminal: `AppError` → status/code/details; `23505` → 409; unknown → generic 500 + full log | send a stack trace to a client |

### `src/routes/` — URL shape only
Declare method, path, middleware chain, and nothing else. No logic, no `db` import.
Swagger JSDoc annotations live here so the spec and the routing cannot drift.

### `src/controllers/` — HTTP adapter
Four responsibilities, in order:
1. Read validated input (`req.validated`), never `req.body` directly.
2. Call exactly **one** service method.
3. Map the result to the standard envelope via `sendSuccess`.
4. Translate thrown `AppError`s by letting them propagate to `errorHandler`.

No business rules. No SQL. The current `adminController.overview` (120 lines of analytics)
and `appointmentController.changeStatus` (which fires a notification inline) both violate
this and must move down a layer.

### `src/services/` — all business rules and transaction boundaries
The only layer allowed to open a transaction. Responsibilities:

- Enforce business invariants (`isAcceptingNew`, slot in the future, mode matches the slot).
- Own the status state machine (`ALLOWED_TRANSITIONS`) as a single source of truth.
- Wrap multi-write operations in `withTransaction()`.
- Call repositories for persistence, integrations for external effects.
- Never see `req`/`res`.

**`appointmentService` is the critical one.** Booking, rescheduling and cancelling must each
be one transaction:

```js
// booking.service.js — the shape Phase 6 must deliver
export const bookAppointment = (db, { patientId, slotId, reason, mode }) => {
  // 1. SELECT ... FOR UPDATE on the slot row  ← the whole concurrency story
  const slot = slotRepo.lockById(db, slotId);
  if (!slot) throw new AppError('Selected slot no longer exists', 404, 'SLOT_NOT_FOUND');
  if (slot.status !== 'available') throw new AppError('This slot was just taken', 409, 'SLOT_TAKEN');
  if (slot.startsAt < now()) throw new AppError('That time has already passed', 400, 'SLOT_IN_PAST');

  // 2. partial unique indexes catch anything the checks above miss
  const appt = appointmentRepo.insert(db, { patientId, slotId, doctorId: slot.doctorId, ... });
  //    → INSERT raises 23P01/23505 on (active slot) or (patient, time) overlap → 409

  // 3. history + outbox rows in the same transaction
  appointmentStatusHistoryRepo.insert(db, { appointmentId: appt.id, toStatus: 'confirmed', ... });
  outboxRepo.insert(db, { type: 'appointment_booked', aggregateId: appt.id });
  return appt;
};
```

Because the unique index is the final arbiter, correctness does not depend on the read
having been correct — a lost update surfaces as a constraint violation, not a double booking.

### `src/repositories/` — pure data access
- SQL only. No business rules, no `req`/`res`, no `AppError`.
- Every function is individually unit-testable against a test database.
- This is the layer that lets `config/db.js` actually be swapped for Supabase: controllers and
  services above it never change shape, only the SQL beneath.
- Explicit column lists on every `SELECT` (never `SELECT *`) — this is the structural fix
  for S-03/S-04.

### `src/integrations/` — external systems behind interfaces
| Integration | Interface | Failure policy |
| --- | --- | --- |
| Supabase pg | `query(sql, params)` + `withTransaction(fn)` | Throw → 500; never swallow |
| Supabase Realtime | `publish(channel, event, payload)` | Fire-and-forget; clients also refetch on reconnect |
| Gemini | `triage(input) → output` | 8 s timeout → fall back to the rule engine; output validated against a Zod schema before use |
| SMS / Email | `send(message)` | Always via the **outbox**, drained by a worker; no provider configured → log to console and mark `simulated` |

`aiService`'s current external call is already close to this shape and mostly needs
hardening: the API key must move out of the query string, and the model must be updated off
the retired `gemini-1.5-flash`.

### `src/shared/`
`AppError` (status + code + details), `logger` (structured JSON, `requestId`), `env`
(**validate on boot; abort if a production variable is missing** — the fix for S-09),
`crypto` (bcrypt/scrypt, token generation), `ids` (UUIDs).

---

## B.3 Frontend responsibilities

| Unit | Responsibility |
| --- | --- |
| `lib/api/` | fetch wrapper: bearer injection, envelope unwrapping, `ApiError`, 401 → refresh → retry once, Zod validation of responses in dev |
| `providers/Auth` | in-memory access token, rotating refresh token, `/auth/me` on boot, optimistic logout |
| `providers/Query` | TanStack Query: caching, dedupe, retries, invalidation — replaces every hand-rolled `useState`+`useEffect` fetch |
| `providers/Realtime` | one Supabase Realtime connection; channel registry keyed by resource |
| `lib/realtime/` | channel name constants + `useSubscription(channel, handler)` |
| `features/<domain>/` | colocated components + hooks + local schemas, e.g. `features/appointments/` |
| `components/ui/` | Tailwind-based primitives, replacing `components/ui.jsx` and all inline `style={{}}` |
| `routes/guards` | `<Protected roles>`, `<GuestOnly>` — the existing semantics, extracted and tested |

**Design principles**
- No page calls `fetch` directly. Pages call hooks; hooks call the API client.
- No component holds a raw entity in state after first load — render from the query cache.
- No `style={{}}`. Tailwind utilities; design tokens as Tailwind theme extensions.
- Every list has loading, empty, and error states — an existing strength, now uniform.

---

## B.4 Target folder layout

```
healthcare-appointment-platform/
├── package.json                  npm workspaces (root)
├── README.md
├── .env.example
├── .gitignore
├── docs/                         ← Phase 0 output
├── client/
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── router.jsx
│       ├── styles/index.css
│       ├── app/
│       │   ├── providers/{Auth,Toast,Query,Realtime}Provider.jsx
│       │   └── ErrorBoundary.jsx
│       ├── components/
│       │   ├── ui/  (Button, Input, Card, Modal, Table, Badge, Spinner,
│       │   │          Skeleton, EmptyState, Alert, Stat, Tabs)
│       │   └── layout/ (Header, Footer, PageShell)
│       ├── features/
│       │   ├── auth/        login, register, guards
│       │   ├── discovery/   directory, profile, filters, slot picker
│       │   ├── appointments/ list, booking, reschedule, cancel, history
│       │   ├── queue/       check-in, live queue, wait estimate
│       │   ├── notifications/
│       │   ├── triage/      symptom checker
│       │   └── admin/       dashboard, doctors, facilities, patients, logs
│       ├── hooks/
│       └── lib/
│           ├── api/         client.js, endpoints.js, errors.js
│           ├── realtime/    channels.js, useSubscription.js
│           └── validation/  response schemas
│
└── server/
    ├── package.json
    ├── .env.example
    ├── render.yaml
    ├── Dockerfile
    ├── src/
    │   ├── server.js
    │   ├── app.js
    │   ├── config/{env.js, db.js, supabase.js, logger.js}
    │   ├── middleware/       (see B.2)
    │   ├── routes/           (see B.2)
    │   ├── controllers/
    │   ├── services/
    │   ├── repositories/
    │   ├── integrations/{gemini,sms,email,realtime}.js
    │   ├── schemas/          Zod request schemas, shared field definitions
    │   ├── openapi/          openapi.yaml + swagger.js
    │   └── db/
    │       ├── migrations/   001_init.sql … N
    │       └── seeds/        seed.sql
    └── tests/
        ├── unit/  integration/  e2e/  fixtures/  setup.js
```

---

## B.5 Request lifecycle (target)

```
POST /api/appointments  {doctorId, slotId, reason}
 1 helmet                       security headers
 2 cors                         strict allow-list
 3 express.json                 100 kb limit
 4 requestId                    correlated id
 5 authLimiter                  shared-store rate limit
 6 requireAuth                  jwt.verify → session check → req.user
 7 requireRole('patient')       403 if not a patient
 8 validate(bookSchema)         strict Zod → 422 with field-level detail
 9 requireAppointmentAccess     not applicable on create
10 controller.createAppointment
11     service.bookAppointment  ← opens ONE transaction
12        SELECT slot FOR UPDATE
13        validate: exists · available · future · doctor matches · mode matches
14        INSERT appointment      (unique index is the final guard)
15        INSERT appointment_status_history
16        INSERT outbox row
16       COMMIT
17     integration.realtime.publish('appointment', ...)   ← post-commit only
18   sendSuccess(201, { appointment })
19 errorHandler (only on failure)   AppError → status/code | 23505 → 409 | else 500
20 morgan + requestId in the access log
```

Note step 17: Realtime publishes happen **after** commit, so a subscriber can never observe
a change that later rolls back.

---

## B.6 Layer dependency rule

```
routes ──▶ controllers ──▶ services ──┬──▶ repositories ──▶ PostgreSQL
                    │                 ├──▶ integrations ──▶ Gemini / SMS / email
                    │                 └──▶ shared
                    └──▶ schemas, shared
middleware: depends on shared + schemas only. Never on services or repositories.
```

Enforced by an ESLint `import/no-restricted-paths` rule. This is what keeps the monolith from
silently growing into a distributed system, and what makes every layer testable in isolation.

---

## B.7 What is explicitly not being introduced

Per the v2 constraints, and for the record:

No microservices · no GraphQL · no Kafka · no Redis · no Kubernetes · no blockchain ·
no Convex · no MongoDB · no repository-pattern-for-its-own-sake. This stays one deployable
backend and one deployable frontend. `repositories/` is justified because it is the layer that
makes Supabase swappable and services unit-testable — not because "layers" sounds
professional.

---

## B.8 Migration path from current to target

| Step | From | To | Phase |
| --- | --- | --- | --- |
| 1 | two independent `package.json` | npm workspaces at the root | 1 |
| 2 | inline `style={{}}`, 908-line CSS | Tailwind tokens + utilities | 1 |
| 3 | `fetch` per page | `lib/api` + TanStack Query | 1 |
| 4 | `requireRole` + per-controller ownership checks | + `requireAppointmentAccess` | 3 |
| 5 | controllers calling `db.*` directly | controllers → services → repositories | 2–6 |
| 6 | `config/db.js` singleton | `db.js` pg pool + repositories | 2 |
| 7 | 30 s polling | Supabase Realtime | 9 |
| 8 | `GET /api/doctors` in-memory filtering | SQL filtering + pagination | 4 |
| 9 | JSDoc only | OpenAPI 3.1 spec + Swagger UI | 15 |
| 10 | `scripts/smoke.js` | Jest + Supertest (smoke retained as an e2e smoke) | 14 |