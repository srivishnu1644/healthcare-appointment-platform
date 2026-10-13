# MediCare v2 — Deployment Guide

**This project has not been deployed.** Nothing in this document describes a
system that exists somewhere; it describes how to deploy this one, and every
"verified" item below was checked by running it locally against PostgreSQL 16.

Where something could not be verified, it says so rather than implying it was.

---

## Contents

1. [What is verified and what is not](#what-is-verified-and-what-is-not)
2. [Requirements](#requirements)
3. [Environment variables](#environment-variables)
4. [Database](#database)
5. [Build and start](#build-and-start)
6. [Health checks and graceful shutdown](#health-checks-and-graceful-shutdown)
7. [Hosting the frontend](#hosting-the-frontend)
8. [Security configuration](#security-configuration)
9. [Logging](#logging)
10. [Backup and recovery](#backup-and-recovery)
11. [Deployment checklist](#deployment-checklist)
12. [Troubleshooting](#troubleshooting)

---

## What is verified and what is not

| Item | Status |
|---|---|
| Client production build | **Verified** — builds clean |
| Backend starts and serves | **Verified** |
| Health endpoint answers | **Verified** |
| Refuses to boot without a database | **Verified** |
| Graceful shutdown on `SIGTERM` | **Verified** |
| Refuses to boot in production without `JWT_SECRET` | **Verified** |
| Refuses to boot in production without `CORS_ORIGIN` | **Verified** |
| Refuses a known placeholder secret in production | **Verified** (fixed during this phase) |
| Scheduler starts and stops with the process | **Verified** |
| Migrations run against a fresh PostgreSQL 16 | **Verified** |
| **Deployment to any real host** | **NOT verified — nothing has been deployed** |
| **TLS termination** | **NOT verified — requires a host that terminates TLS** |
| **Hostile-penetration testing** | **NOT verified — only automated checks exist** |
| **Live Gemini integration** | **NOT verified — no credential has ever worked** |
| **Load / performance under traffic** | **NOT verified — no load test was run** |
| **Multi-process scheduler behaviour** | **NOT supported — see [Single-process constraint](#single-process-constraint)** |

---

## Requirements

| Component | Version | Notes |
|---|---|---|
| Node.js | 20 LTS or newer | ESM; uses `??`, top-level await in places |
| PostgreSQL | 14 or newer | Developed and verified against **16** |
| npm | 10+ | Ships with Node 20 |

No container runtime, no Redis, no message broker. The application is a single
Node process plus one PostgreSQL database.

### Package installs

```bash
npm --prefix server install
npm --prefix client install
```

Both already have lockfiles. **Do not add dependencies without review** — the
dependency set is deliberately small and every package in it is there for a
reason that was worth stating.

---

## Environment variables

Placeholders only. **Never commit a real value.** The application loads
`server/.env` if present; real environment variables always win, so a container
or process-manager injected variable overrides the file.

### Required in production

| Variable | Purpose | Example |
|---|---|---|
| `JWT_SECRET` | Signs access tokens | `openssl rand -base64 48` — must be ≥ 32 chars |
| `CORS_ORIGIN` | Comma-separated allowed origins | `https://medicare.example.com` |
| `DATABASE_URL` | Connection string | `postgresql://user:pass@host:5432/medicare` |

> `JWT_SECRET` must be the **same value on every instance**. With more than one
> process, a per-instance secret means a token minted by one is rejected by
> another.

### Required in development

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Defaults to a local database if `DB_*` are set |
| `JWT_SECRET` | Optional. Without it, development gets a **random per-process** secret and warns: tokens will not survive a restart. |
| `CORS_ORIGIN` | Optional in development |

### Database

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | Overrides all `DB_*` when set |
| `DB_HOST` | `localhost` | |
| `DB_PORT` | `5432` | |
| `DB_NAME` | `medicare` | |
| `DB_USER` | `postgres` | |
| `DB_PASSWORD` | — | |
| `DB_SSL` | — | Set to enable TLS to the database |
| `DB_POOL_MAX` | `10` | Pool size per process |
| `DB_ALLOW_POOLED_QUERY_IN_TX` | `0` | See [Pooled queries in a transaction](#pooled-queries-in-a-transaction) |

### Server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | |
| `NODE_ENV` | — | **`production` turns on the strict boot checks** |
| `APP_TIMEZONE` | `Asia/Kolkata` | The clinic's business timezone. **All dates and times in the system are interpreted here.** |
| `JWT_EXPIRES_IN` | `900` | Access-token lifetime, seconds |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | |
| `JWT_ISSUER` | — | Claim added to issued tokens |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `CORS_ORIGIN` | — | See above |

### Notifications (all optional)

| Variable | Effect when unset |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | SMS is **not** sent. Notifications are still recorded in-app and the API reports `channels.simulated: true` so the UI can say so honestly. |
| `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL` | Same for email. |
| `NOTIFICATION_SWEEP_MINUTES` | Reminder sweep window |

### AI (all optional)

| Variable | Effect when unset |
|---|---|
| `GEMINI_KEY` | The assistant answers from the reviewed knowledge base only, and triage is unavailable. `GET /api/ai/provider` reports `modelAvailable: false`. |
| `GEMINI_MODEL` | Default model id |
| `ASSISTANT_ADAPTER` | Forces an adapter, for tests |
| `ASSIST_MAX_PER_MINUTE` | Default `60` |

**Never invent a key to "make it work".** The application is fully functional
without one, and reports its own degraded state honestly.

### Scheduler

| Variable | Effect |
|---|---|
| `DISABLE_SCHEDULER` | Set to `1` to stop the in-process background timer. The test suites set this and **assert** it is off. |

---

## Database

### PostgreSQL configuration

The application relies on PostgreSQL, not on application logic, for:

- **exclusive slot booking** — a slot cannot hold two active appointments;
- **patient non-overlap** — a patient cannot hold two overlapping appointments;
- **row-level security** on patient-owned tables;
- **notification deduplication** — a partial unique index on `dedupe_key`;
- **queue uniqueness** — one entry per patient per room.

**Row-level security requires a non-superuser role.** A superuser bypasses RLS
silently, so creating the application role as a superuser would leave the
patient-data isolation disabled with no error anywhere. Create a dedicated role:

```sql
CREATE ROLE medicare_app LOGIN PASSWORD '...';
-- Grant only what the migrations need; do not make it SUPERUSER.
```

> **Not verified:** the exact minimal grant set. Deriving it was out of scope, so
> grant generously but **not** `SUPERUSER`, and re-check RLS behaviour with
> `SELECT rolsuper FROM pg_roles WHERE rolname = 'medicare_app';`.

### Migrations

```bash
cd server
npm run db:migrate            # apply pending migrations
npm run db:migrate:status     # list applied and pending
```

Migrations are **forward-only**. There is no `down`.

`npm run db:migrate:reset` is `DROP SCHEMA CASCADE` followed by a full re-apply.
It is a development convenience and **destroys all data**. Never run it against
a database holding anything you want to keep.

### Seeding

```bash
npm run db:seed
```

Seeds demo accounts, facilities, specialties, services, doctors, patients and
appointments. Intended for development and demos. Do not run it against a
production database — the demo passwords are published in this repository.

---

## Build and start

### Frontend

```bash
cd client
VITE_API_URL=https://api.example.com/api npm run build
```

Output goes to `client/dist`. `VITE_API_URL` is **baked into the bundle at build
time** — changing it requires a rebuild, not a restart. This is the single most
common misconfiguration: a client built with a localhost API URL cannot be fixed
at runtime.

### Backend

```bash
cd server
npm run db:migrate
NODE_ENV=production node index.js
```

Run it under a process supervisor. It handles `SIGINT` and `SIGTERM` itself, so
the supervisor only has to send the signal and wait.

Recommended systemd unit:

```ini
[Service]
WorkingDirectory=/srv/medicare/server
ExecStart=/usr/bin/node index.js
Environment=NODE_ENV=production
EnvironmentFile=/etc/medicare/medicare.env
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15
```

`EnvironmentFile` keeps secrets out of the unit file and out of the repository.

---

## Health checks and graceful shutdown

### Liveness

```bash
curl -fsS http://127.0.0.1:5000/api/health
```

Answers `200` with `status: healthy` and a database check.

### Database unavailable

| When | Behaviour |
|---|---|
| At boot | Retries five times, logs `[server] FATAL: cannot reach the database.`, exits `1`. **Never starts listening.** |
| While running | Answers `503` with `status: unhealthy`. |

Point a load balancer's readiness probe at `/api/health`. Because the process
does not listen until the database answers, a starting instance will fail
connection-refused until it is genuinely ready — which is the correct signal.

### Graceful shutdown

On `SIGTERM` or `SIGINT` the process:

1. stops the scheduler **first**, so no background pass can start while the
   connection pool is closing;
2. stops accepting new connections;
3. closes the pool;
4. exits `0`.

A 10-second hard timeout forces exit `1` if a keep-alive socket or a stuck query
holds things open. Give the supervisor at least 15 seconds of stop grace.

Verified locally: the process exits cleanly on `SIGTERM` with the health endpoint
answering `200` beforehand.

---

## Single-process constraint

**The scheduler is in-process.** It is a timer inside the Node process, not an
external job runner.

Running **two** API processes means two timers and therefore two concurrent
reminder sweeps and outbox drains. The database protects notification *inserts*
(the dedupe index is the source of truth), but the sweep would still do the work
twice.

This is safe by construction **only** at one replica. If you need more than one,
either disable the scheduler on all but one instance (`DISABLE_SCHEDULER=1`) and
run that instance alone, or replace it with an external scheduler. Do not simply
scale out.

---

## Hosting the frontend

`client/dist` is static files. Any static host works.

Required:

- **SPA fallback.** Every unknown path must return `index.html`, or a deep link
  such as `/admin/appointments` will 404 on refresh. The API is on a different
  origin, so `/api/*` must **not** fall through to `index.html`.
- **HTTPS**, with HTTP redirected to HTTPS.
- The API origin must be listed in the backend's `CORS_ORIGIN`.

nginx:

```nginx
root /srv/medicare/client/dist;

location / {
  try_files $uri $uri/ /index.html;
}

location /api/ {
  proxy_pass http://127.0.0.1:5000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

gzip on;
gzip_types text/css application/javascript application/json;
```

Hashed asset filenames are safe to cache immutably; `index.html` must not be.

---

## Security configuration

### What the application enforces

- **Boot refuses to start** in production without `JWT_SECRET` or `CORS_ORIGIN`,
  with a secret shorter than 32 characters, or with a known placeholder value —
  including the test secret published in this repository.
- **CORS** is an explicit allow-list. There is no `origin: true` fallback and no
  `*`.
- **Passwords** are bcrypt-hashed. The repositories never select the hash
  column, so it cannot leak through a query, and `stripSecrets` is a second pass
  on the patient directory.
- **SQL** is parameterised in every repository. Identifiers for sorting are
  matched against a whitelist, and the matched constant is interpolated — never
  the request text.
- **Rate limiting** on credentials (100 / 10 min), session operations
  (600 / 10 min) and AI endpoints (60 and 20 / min).
- **Errors** returned to a client are generic. The `500` handler logs the detail
  server-side and sends `"Something went wrong on our side"` with no stack, SQL
  or internal message.

### What it does NOT do

- **No TLS.** Termination is the host's job. The application serves plain HTTP
  and expects a proxy in front.
- **No CSRF tokens.** Safe because the API is token-authenticated and
  cross-origin, but it means the API must not be switched to cookie
  authentication without revisiting this.
- **No account lockout**, only rate limiting.
- **No refresh-token rotation on a schedule** — a refresh token is single-use and
  rotated on use, and reuse revokes the session.
- **No encryption at rest** beyond the database's own.

### Known limitations worth stating plainly

| Limitation | Why it exists |
|---|---|
| Waiting-room capacity (`slots.max_queue`) is stored but **not enforced** | Deliberately deferred; documented rather than half-implemented |
| The triage rate limiter is keyed by **IP**, unlike the assistant limiter beside it | A clinic behind one NAT can throttle uninvolved patients. Found in this phase, not yet fixed. |
| The scheduler is single-process | See above |
| AI text is labelled as machine-generated but not **moderated** | No moderation service is in scope |
| External notification delivery is **at-least-once** | No exactly-once guarantee is possible for an external call |

---

## Logging

Structured, line-oriented logs to stdout via the project's own logger — no log
framework dependency.

At startup the application prints its **integration status**, which is how you
confirm what is actually configured rather than assuming:

```
[env] Google Gemini (live AI triage) - using rule-based engine (GEMINI_KEY not set)
[env] Twilio SMS - logging notifications to console (TWILIO_ACCOUNT_SID not set)
[env] Resend email - logging notifications to console (RESEND_API_KEY not set)
```

**Do not log request bodies or headers.** They carry tokens, names and symptom
descriptions. The application does not log them; a reverse proxy must not either.

Send stdout to the platform's log collector and keep retention bounded — these
logs contain identifiers.

---

## Backup and recovery

### What to back up

| Object | Required | Why |
|---|---|---|
| PostgreSQL database | **Yes** | Every appointment, user, queue entry, notification and audit row |
| `server/.env` | **Yes, separately** | Not in the database and not in the repository |
| `JWT_SECRET` | **Yes, separately** | Changing it invalidates every session |
| `client/dist` | No | Rebuildable from source |

### Logical backup

```bash
pg_dump --format=custom --file=medicare-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"
```

### Physical backup

Preferred for a large database. `pg_basebackup` with WAL archiving.

### Restore

```bash
pg_restore --dbname="$DATABASE_URL" --clean --if-exists medicare-YYYYMMDDTHHMMSSZ.dump
```

**Migrations are forward-only.** There is no down migration, so restoring to a
schema that is ahead of the application is the risky direction. Restore the
database and the matching application build **together**.

### RPO / RTO

Not determined — no recovery drill has been performed. Treat any target as
unverified until you have restored a backup and measured it.

### Things a backup does not capture

- Ephemeral state is genuinely ephemeral: an in-memory rate-limit counter resets,
  and a restart regenerates the development `JWT_SECRET` (production requires a
  real one precisely so this cannot happen).
- External delivery attempts. A notification row exists whether or not the
  message was ever delivered; re-running a drain can re-attempt delivery, which
  is why external delivery is documented as at-least-once.

---

## Deployment checklist

**Before**

- [ ] `JWT_SECRET` is random, ≥ 32 characters, and **not** any value in this repository
- [ ] The same `JWT_SECRET` is configured on every instance
- [ ] `CORS_ORIGIN` lists **exactly** the deployed origins, with no trailing `/` mismatch
- [ ] `NODE_ENV=production`
- [ ] `DATABASE_URL` points at the target, over TLS if it leaves the host
- [ ] The database role is **not** a superuser (RLS depends on it)
- [ ] `npm --prefix server audit` reviewed
- [ ] The client was built with the production `VITE_API_URL`
- [ ] TLS is terminated in front of both services
- [ ] Backups are running and a restore has actually been tested
- [ ] Supervisor stop grace ≥ 15 s

**Deploy**

```bash
cd server && npm ci
cd ../client && npm ci && VITE_API_URL=https://api.example.com/api npm run build
cd ../server && npm run db:migrate
sudo systemctl restart medicare-api
```

**After**

- [ ] `GET /api/health` answers `200` and reports `"database": "connected"`
- [ ] The startup log shows the integration status you expect
- [ ] Log in as each role and load one page from each section
- [ ] Book a test appointment and confirm the notification appears
- [ ] Check in, confirm the queue position, call next, complete
- [ ] Confirm the admin overview renders queue and notification figures
- [ ] Confirm a patient still **cannot** reach `/api/admin/*` (expect `403`)
- [ ] Confirm an expired token is rejected (expect `401`)
- [ ] Confirm the AI assistant answers and that `modelAvailable` is what you expect
- [ ] Check the logs for secrets
- [ ] Verify one rollback works **before** you need it

---

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `FATAL: JWT_SECRET is required in production` | Not set, or set to an empty string | Generate one; do not disable the check |
| `FATAL: JWT_SECRET is a known placeholder value` | A published placeholder, including the test secret | Generate a real one |
| `FATAL: CORS_ORIGIN is required in production` | Not set | Set it to the deployed client origin |
| `FATAL: cannot reach the database` | Wrong `DATABASE_URL`, or the database is down | The process exits `1` **by design**. Fix connectivity, then start again |
| `FATAL: JWT_SECRET must be at least 32 characters` | Too short | Generate a longer one |
| `blocked by CORS policy` | Client origin not in `CORS_ORIGIN` | Add the exact origin, scheme included |
| Client talks to localhost in production | `VITE_API_URL` was not set at build time | It is baked in at build time — rebuild |
| Deep link 404s on refresh | Missing SPA fallback | Add `try_files $uri $uri/ /index.html`, excluding `/api/` |
| 429 during load testing | Per-process rate limiter | The limit is per process and per IP; several instances do not raise it |
| Logins stop working after every deploy | A new `JWT_SECRET` each time | Pin it — this invalidates every session |
| Reminders fire twice | More than one API process | Single-process constraint above |
| RLS appears not to apply | Application role is a superuser | Create a non-superuser role |
| Outbox grows without draining | Scheduler disabled | Check `DISABLE_SCHEDULER`, and `GET /api/notifications/scheduler` as an admin |

### Pooled queries in a transaction

`DB_ALLOW_POOLED_QUERY_IN_TX` guards a real hazard: a query executed on a pooled
connection **outside** the transaction's own client can read uncommitted or
wrong data, and the transaction does not roll it back. It is off by default for
that reason. Do not enable it to silence a symptom — find the query that escaped
the transaction instead.