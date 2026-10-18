# Supabase integration

This directory holds the database side of running BookMyDoc on Supabase.

| File | What it is |
|---|---|
| `schema.sql` | The complete PostgreSQL schema in **one file** — generated from `server/src/db/migrations/*.sql`, ready to paste into the Supabase SQL Editor |

The application speaks plain PostgreSQL over `DATABASE_URL`. No Supabase
client library is involved, on the server or in the browser, so there is no
service-role key to distribute and no auth code to rewrite. That is a
deliberate choice, not an omission — see [What the anon key can see](#what-the-anon-key-can-see).

---

## 1. Create the project

Create a project at supabase.com (PostgreSQL 15 or newer) and open
**Project Settings → Database → Connection string**.

Copy the **Session pooler** string:

| Connection | Host | Port | Use |
|---|---|---|---|
| Direct | `db.<ref>.supabase.co` | 5432 | Nothing here — **IPv6-only** on newer projects |
| **Session pooler** | `aws-0-<region>.pooler.supabase.com` | 5432 | The API and migrations |
| Transaction pooler | same host | 6543 | Only for very high concurrency; no session state (`LISTEN/NOTIFY`, temporary tables) |

The transaction pooler holds a server connection for one transaction, which
is enough for this application's transaction-scoped advisory locks — but the
session pooler is the tested, supported path, and it is what the environment
template documents.

## 2. Point the API at it

`server/.env`:

```bash
DATABASE_URL=postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

- **TLS is automatic.** Any host that is not localhost/127.0.0.1 gets SSL;
  you never need `DB_SSL` for Supabase.
- **Percent-encode password characters.** A password containing `@`, `/`,
  `#`, `?` or `%` must be encoded (`@` → `%40`). The URL parser splits the
  authority at the **last** `@`, so some passwords work unencoded by luck —
  encode, and stop relying on luck.
- The full variable list is in [`server/.env.example`](../server/.env.example).

## 3. Create the schema — one file

**Option A — SQL Editor.** Open `supabase/schema.sql`, paste the whole file
into a new query, run it. It executes as one script, in order.

**Option B — from the repository.** With `DATABASE_URL` set:

```bash
cd server
npm run db:schema          # applies supabase/schema.sql in ONE transaction
```

Both options do the same thing. The file ends by recording every migration
it contains in `schema_migrations`, so re-running it is a no-op and the
single-file route cannot run the same DDL twice.

This file is the schema. It is maintained by hand and checked in — there is no
build step that regenerates it, and no directory of migrations behind it. Change
it directly, and apply it to a disposable database to prove it still works.

> **`db:schema` targets a FRESH database only.** It refuses to run against one
> that already has `public.users`, because most of the file is plain `CREATE`
> and would fail halfway. Additive changes to an existing database are applied
> automatically at boot by `src/db/ensureSchema.js`.

## 4. Seed and run (optional)

```bash
npm run db:seed            # demo accounts, doctors, 14 days of slots
npm run dev                # API on http://localhost:5000
```

The demo passwords in the root `README.md` are published on purpose, so
`npm run db:seed` is for development and demos only. Run it against a production
database and it will happily create `admin@demo.com` with a password anyone can
read here. Nothing in the code prevents that — the seed script has no production
guard — so it is on the operator to check `NODE_ENV` and the target connection
string first.

## What the anon key can see

Supabase grants the `anon` and `authenticated` roles access to everything in
`public` by default, so **RLS is the only thing that stands between a
browser-shipped anon key and the data**. `schema.sql` states the rule:

| Surface | Tables | Anon key |
|---|---|---|
| Public directory (the API serves these without a session) | `specialties`, `facilities`, `services`, `doctors`, `doctor_services`, `doctor_languages`, `slots` | `SELECT` allowed (`FOR SELECT USING (true)`) |
| Everything else — identity, health data, appointments, queue, notifications, audit, AI turns, bookkeeping | the other 16 tables | RLS enabled, no policy: **zero rows** |

Additionally, no non-owner role holds `INSERT` / `UPDATE` / `DELETE` /
`TRUNCATE` on any table, including future tables created by these
migrations. Writes go through the Express API, which connects over
`DATABASE_URL` as the table owner.

Two consequences worth stating plainly:

- **There are no user-scoped policies.** This project authenticates with its
  own JWTs, so Supabase's `auth.uid()` is never populated and a policy keyed
  on it could never match. Per-user isolation is enforced in the service
  layer, exactly as before; RLS here is defence in depth for the database's
  own HTTP surface.
- **The anon key is still not a secret.** Treat it as public and expect it
  to be abused: what protects the data is the policy set above, which
  `npm run test:schema` re-asserts (every table in `public` must have RLS
  enabled) on every run.

On plain PostgreSQL the Supabase roles do not exist; the policy block detects
that and applies as a documented no-op, so the same file runs everywhere.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `permission denied to create extension` | Prefer the **Dashboard → Database → Extensions** toggle for `btree_gist` and `citext`; both are pre-configured on Supabase. The schema's `IF NOT EXISTS` statements then no-op. |
| `type "citext" does not exist` | The extension is installed in a schema that is not on the search path. Enable it via the dashboard (installs to `extensions`, which is on Supabase's search path) or run `create extension if not exists citext with schema public;` as `postgres`. |
| `npm run db:schema` refuses: "already has the application schema" | That database is not fresh. Use a new project/database, or drop the schema on a disposable one: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` |
| Connection times out from an IPv4 network | You copied the direct string. Use the pooler string from the dashboard. |
| `password authentication failed` although the password looks right | A special character in the password is not percent-encoded — see step 2. |

## Verified / not verified

Verified locally while this integration was added:

- `supabase/schema.sql` applies to a fresh PostgreSQL instance as one
  transaction; 23 tables and 19 migrations are recorded.
- The seeded database passes `npm run test:schema` (including the new
  every-table-has-RLS check).
- Running `npm run db:schema` a second time is a no-op; it does not re-run the
  DDL.

**Not verified:** end-to-end authentication with the anon key against a
hosted project (the Supabase roles do not exist in local PostgreSQL), and
the SQL Editor paste path itself — the statements are identical to the
verified file, but the editor is Supabase's software. Run the file and
check the result before trusting it with anything.
