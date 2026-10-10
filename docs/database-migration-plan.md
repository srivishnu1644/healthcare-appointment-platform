# MediCare — Database Migration Plan (JSON → Supabase PostgreSQL)

**Phase 0 deliverable. This is a design document. Nothing here has been executed.**

Target: Supabase PostgreSQL. The application remains a single Node/Express service connecting
over the `pg` pool (or the Supabase JS client) — Supabase is the *hosting platform and data
layer*, not a new architectural tier.

---

## 1. Why the JSON datastore has to go

The current store cannot support the v2 feature set, for reasons that are structural rather
than stylistic:

| Requirement | Why JSON cannot deliver it |
| --- | --- |
| Concurrency-safe booking | No transactions, no locks, no constraints. Correctness depends on a single-process event loop. Two Render instances corrupt each other. |
| Overlap prevention | Needs `tstzrange` + `EXCLUDE USING gist`. Expressible in application code only, and only within one process. |
| "one active appointment per slot" | Needs a partial unique index. Impossible in a JSON array. |
| Query performance at scale | Every read is a full-array scan. `adminController.overview` does ~40 scans per request; that is already slow at 45 rows. |
| Referential integrity | Orphaned `doctorId`, dangling `slotId`, duplicate emails are all silently accepted today. |
| Data types | Dates and times are `"2026-10-08"` and `"09:00"` strings. No timezone. Sorts work by luck of ISO formatting; anything else does not. |
| Realtime | Supabase Realtime is built on Postgres logical replication. No Postgres, no Realtime. |
| Auditing / status history | Requires an append-only table. |
| Concurrent writers | The whole file is rewritten with `writeFileSync` on every mutation — 468 KB, blocking the event loop. |

**Conclusion: the migration is not optional, and it is not primarily about polish — booking
correctness and Realtime both depend on it.**

---

## 2. Entity mapping

Verified from `server/src/config/db.js` and `server/.data/db.json`.

| Current entity | Proposed table(s) | Notes |
| --- | --- | --- |
| `users` (role=patient) | `users` + `patient_profiles` | Split 1:1 out of the untyped blob |
| `users` (role=doctor) | `users` + `doctors` + `doctor_services` | `doctors.userId` FK to `users.id` |
| `users` (role=admin) | `users` | No profile table |
| `users.profile{}` | `patient_profiles` | Typed columns; `allergies` → separate table |
| `doctors` | `doctors` | Drop all duplicated name/denormalised columns |
| `doctors[].user{}` (embedded copy) | **deleted** | Root cause of S-03/S-04 |
| `doctors.specialtyName` | **deleted** — derive via `specialties` JOIN | |
| `doctors.facilityName` | **deleted** — derive via `facilities` JOIN | |
| `doctors.city`, `doctors.address` | **deleted** — derive from `facilities` | |
| `doctors.serviceIds[]` | `doctor_services` | Proper many-to-many |
| `doctors.languages[]` | `doctor_languages` | Queryable, filterable |
| `specialties` | `specialties` | unchanged + slug |
| `facilities` | `facilities` | unchanged |
| `services` | `services` | `duration_minutes`, `price`, `currency` |
| — | `doctor_availability` | **NEW** — recurring weekly templates. Does not exist today. |
| `slots` | `slots` | `tstzrange`, status enum, FK to availability |
| `appointments` | `appointments` | Drop duplicated name/date/time/fee columns |
| `appointments.statusNote/updatedAt/rescheduledAt/cancelledBy/cancelReason/reminderSent` | `appointment_status_history` + columns on `appointments` | **NEW** — status history does not exist today |
| — | `appointment_status_history` | Append-only audit trail |
| `notifications` | `notifications` | + `notification_deliveries` per channel |
| — | `notification_outbox` | **NEW** — durable delivery queue |
| `queue[]` | `queue_entries` | Replaces `db.queue` + `slot.currentQueue` + `appointment.queuePosition` |
| — | `refresh_tokens` | **NEW** |
| — | `audit_logs` | **NEW** — admin PHI access trail |
| `meta.seededAt` | dropped | Runtime concern, not data |
| `doctors.rating`, `reviewCount` | **NEW** `reviews` table | Synthetic integers today; honest reviews in v2 |
| — | `triage_sessions` | **NEW** — persists AI triage for analytics + safety audit |

---

## 3. Proposed schema

### 3.1 Enums

```sql
CREATE TYPE user_role        AS ENUM ('patient', 'doctor', 'admin');
CREATE TYPE slot_status      AS ENUM ('available', 'booked', 'blocked');
CREATE TYPE consult_mode     AS ENUM ('in_person', 'video');
CREATE TYPE appt_status      AS ENUM ('scheduled','confirmed','in_progress',
                                      'completed','cancelled','no_show');
CREATE TYPE queue_state      AS ENUM ('waiting','in_consultation','completed','left');
CREATE TYPE notify_channel   AS ENUM ('in_app','sms','email');
CREATE TYPE delivery_status  AS ENUM ('queued','sent','delivered','failed','simulated');
CREATE TYPE outbox_status    AS ENUM ('pending','processing','done','failed');
```

Enum-typed statuses replace the free-form strings validated only in some routes.

### 3.2 `users`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | `gen_random_uuid()` |
| `email` | `citext` | **`UNIQUE`** — case-insensitive (today only case-insensitive in JS) |
| `password_hash` | `text` | bcrypt, cost 12. **Not** `hashed:${plain}` |
| `role` | `user_role` NOT NULL | Server-assigned only; never from the request body |
| `full_name` | `text` NOT NULL | |
| `phone` | `text` | |
| `is_active` | `boolean` DEFAULT true | Enables suspension without deletion |
| `token_version` | `integer` DEFAULT 0 | Bumped on password change → invalidates all JWTs |
| `created_at`, `updated_at` | `timestamptz` DEFAULT now() | |

```sql
ALTER TABLE users
  ADD CONSTRAINT users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  ADD CONSTRAINT users_name_length   CHECK (char_length(full_name) BETWEEN 2 AND 120);
CREATE UNIQUE INDEX users_email_key ON users (email);
```

### 3.3 `patient_profiles`

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `uuid` PK, FK → `users(id)` ON DELETE CASCADE | 1:1 |
| `date_of_birth` | `date` | |
| `gender` | `text` | `CHECK (gender IN ('male','female','other','prefer_not_to_say'))` |
| `blood_group` | `text` | `CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-'))` |
| `address_line` | `text` | |
| `city` | `text` | |
| `emergency_contact` | `text` | |
| `created_at`, `updated_at` | `timestamptz` | |

`users.profile.allergies[]` becomes:

```sql
CREATE TABLE patient_allergies (
  patient_id uuid NOT NULL REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
  allergen    text NOT NULL,
  PRIMARY KEY (patient_id, allergen)
);
```

This is the correct normalisation: an array inside a JSON blob cannot be queried, indexed,
or constrained. Today an attacker can set it to a string (S-08); a `text` column cannot.

### 3.4 `specialties`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `name` | `text` NOT NULL `UNIQUE` | Replaces `doctors.specialtyName` |
| `slug` | `text` NOT NULL `UNIQUE` | URL-friendly |
| `description` | `text` | |
| `icon` | `text` | |

### 3.5 `facilities`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `name` | `text` NOT NULL `UNIQUE` | `createFacility` already guards this in JS |
| `city` | `text` NOT NULL | |
| `address` | `text` NOT NULL | |
| `type` | `text` | |
| `phone` | `text` | |
| `open_hours` | `text` | |
| `rating` | `numeric(2,1)` | `CHECK (rating BETWEEN 0 AND 5)` |
| `queue_enabled` | `boolean` DEFAULT true | |
| `created_at`, `updated_at` | `timestamptz` | |

```sql
CREATE INDEX facilities_city_idx ON facilities (city);
```

### 3.6 `services`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `name` | `text` NOT NULL `UNIQUE` | |
| `description` | `text` | |
| `duration_minutes` | `integer` NOT NULL | `CHECK (duration_minutes BETWEEN 5 AND 480)` |
| `price` | `numeric(10,2) NOT NULL` | `CHECK (price >= 0)` |
| `currency` | `char(3)` DEFAULT 'INR' | |

### 3.7 `doctors`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `user_id` | `uuid` NOT NULL `UNIQUE` FK → `users(id)` ON DELETE CASCADE | Enforces 1 doctor ↔ 1 account |
| `specialty_id` | `uuid` NOT NULL FK → `specialties(id)` | Replaces `specialty` + `specialtyName` |
| `facility_id` | `uuid` NOT NULL FK → `facilities(id)` | Replaces `facilityId` + `facilityName` |
| `qualification` | `text` | |
| `experience_years` | `integer` | `CHECK (experience_years BETWEEN 0 AND 70)` |
| `bio` | `text` | |
| `consultation_fee` | `numeric(10,2) NOT NULL` | `CHECK (consultation_fee >= 0)` |
| `is_accepting_new` | `boolean` DEFAULT true | |
| `avatar_color` | `text` | Replaces `imageColor` |
| `created_at`, `updated_at` | `timestamptz` | |

**`rating` and `review_count` are deliberately absent.** They are synthetic seed integers and
`rating` is admin-writable (S-17). Replace with a derived view over `reviews`:

```sql
CREATE VIEW doctor_ratings AS
SELECT d.id AS doctor_id,
       COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0) AS rating,
       COUNT(r.id) AS review_count
FROM doctors d LEFT JOIN reviews r ON r.doctor_id = d.id
GROUP BY d.id;
```

```sql
CREATE INDEX doctors_specialty_facility_idx ON doctors (specialty_id, facility_id);
CREATE INDEX doctors_accepting_idx          ON doctors (is_accepting_new)
  WHERE is_accepting_new;                       -- partial: the hot filter
CREATE INDEX doctors_fee_idx                  ON doctors (consultation_fee);
```

### 3.8 `doctor_services`, `doctor_languages`

```sql
CREATE TABLE doctor_services (
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  PRIMARY KEY (doctor_id, service_id)
);

CREATE TABLE doctor_languages (
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  language   text NOT NULL,
  PRIMARY KEY (doctor_id, language)
);
CREATE INDEX doctor_languages_lang_idx ON doctor_languages (language);
```

Replaces `serviceIds[]` and `languages[]`. Both become filterable — `?language=Hindi`
currently requires a JS scan.

### 3.9 `doctor_availability` — NEW

Today availability is *only* individual pre-generated slot rows; there is no recurring
schedule, so "add slots" is manual per date. This table introduces a weekly template.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `doctor_id` | `uuid` NOT NULL FK → `doctors(id)` ON DELETE CASCADE | |
| `weekday` | `smallint` NOT NULL | `CHECK (weekday BETWEEN 0 AND 6)` (0 = Sunday) |
| `start_time` | `time` NOT NULL | |
| `end_time` | `time` NOT NULL | |
| `slot_duration_minutes` | `integer` NOT NULL DEFAULT 30 | `CHECK (... BETWEEN 5 AND 480)` |
| `mode` | `consult_mode` NOT NULL DEFAULT 'in_person' | |
| `effective_from` | `date` NOT NULL | |
| `effective_to` | `date` | `CHECK (effective_to IS NULL OR effective_to >= effective_from)` |
| `is_active` | `boolean` DEFAULT true | |
| `created_at`, `updated_at` | `timestamptz` | |

```sql
CREATE INDEX doctor_availability_lookup_idx
  ON doctor_availability (doctor_id, weekday) WHERE is_active;
```

A generator job materialises concrete `slots` rows from the templates N days ahead.

### 3.10 `slots`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `doctor_id` | `uuid` NOT NULL FK → `doctors(id)` ON DELETE CASCADE | |
| `facility_id` | `uuid` NOT NULL FK → `facilities(id)` | Denormalised from doctor **deliberately** — the availability query filters on it |
| `service_id` | `uuid` FK → `services(id)` | **NEW** — today services are never linked to slots, so `services.duration`/`price` are dead data |
| `starts_at` | `timestamptz` NOT NULL | **Replaces `date` + `startTime`** |
| `ends_at` | `timestamptz` NOT NULL | |
| `period` | `tstzrange` GENERATED ALWAYS AS (tstzrange(starts_at, ends_at)) STORED | Overlap exclusion |
| `mode` | `consult_mode` NOT NULL | |
| `status` | `slot_status` NOT NULL DEFAULT 'available' | |
| `fee` | `numeric(10,2) | `| NULL` | Snapshot of the doctor's fee at creation |
| `max_queue` | `integer` DEFAULT 3 | `CHECK (max_queue > 0)` |
| `created_at`, `updated_at` | `timestamptz` | |

```sql
ALTER TABLE slots ADD CONSTRAINT slots_time_order
  CHECK (ends_at > starts_at);

-- ★ The core concurrency guarantee.
-- Two slots for the same doctor may never overlap in time, and (doctor, starts_at)
-- must be unique. This makes duplicate generation impossible and turns a
-- read-then-write race into a constraint violation.
ALTER TABLE slots ADD CONSTRAINT slots_no_doctor_overlap
  EXCLUDE USING gist (doctor_id WITH =, period WITH &&);

CREATE UNIQUE INDEX slots_doctor_start_key ON slots (doctor_id, starts_at);
```

```sql
CREATE INDEX slots_doctor_upcoming_avail_idx
  ON slots (doctor_id, starts_at) WHERE status = 'available';
CREATE INDEX slots_facility_idx    ON slots (facility_id, starts_at);
CREATE INDEX slots_status_idx      ON slots (status);
```

> `btree_gist` extension is required for the mixed `uuid =` + `range &&` exclusion. Supabase
> enables it per-project.

### 3.11 `appointments`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `patient_id` | `uuid` NOT NULL FK → `users(id)` | Replaces `patientName` |
| `doctor_id` | `uuid` NOT NULL FK → `doctors(id)` | Replaces `doctorName` |
| `slot_id` | `uuid` NOT NULL FK → `slots(id)` ON DELETE RESTRICT | |
| `specialty_id` | `uuid` NOT NULL FK → `specialties(id)` | Snapshot, for stable history |
| `facility_id` | `uuid` NOT NULL FK → `facilities(id)` | Snapshot |
| `mode` | `consult_mode` NOT NULL | Must equal `slot.mode` — enforced in the service |
| `status` | `appt_status` NOT NULL DEFAULT 'confirmed' | |
| `reason` | `text` | |
| `symptoms` | `text` | Kept separate (distinct from `reason` — the seed duplicating them was a bug) |
| `fee` | `numeric(10,2) NOT NULL` | Snapshot at booking time |
| `cancel_reason` | `text` | |
| `cancelled_at` | `timestamptz` | |
| `cancelled_by` | `uuid` FK → `users(id)` | Was a role *string* (`"provider"`/`"admin"`/`"patient"`) — a FK is correct |
| `checked_in_at` | `timestamptz` | Replaces queue bookkeeping on the appointment |
| `completed_at` | `timestamptz` | |
| `reminder_sent_at` | `timestamptz` | Was a boolean `reminderSent` |
| `created_at`, `updated_at` | `timestamptz` DEFAULT now() | |

**Removed:** `patientName, doctorName, specialtyName, facilityName, date, startTime, endTime,
slotId`-back-reference-on-slot, `queuePosition`. All derivable.

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_cancel_consistent
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
```

```sql
-- ★ One ACTIVE appointment per slot. Cancelled/no-show/completed rows are kept
--   for history, so the index is partial. This is what makes double booking
--   impossible regardless of application bugs.
CREATE UNIQUE INDEX appointments_one_active_per_slot
  ON appointments (slot_id)
  WHERE status IN ('scheduled','confirmed','in_progress');

-- ★ A patient cannot hold two overlapping appointments.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments ADD CONSTRAINT appointments_patient_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(appointment_start, appointment_end) WITH &&
  )
  WHERE (status IN ('scheduled','confirmed','in_progress'));
```

> This exclusion needs the appointment time window. Either store `starts_at`/`ends_at` as
> generated columns from the slot, or denormalise the range onto the appointment and keep it
> in sync inside the booking transaction. The denormalised form is the pragmatic choice and
> is consistent with `fee` already being a snapshot.

```sql
CREATE INDEX appointments_patient_idx ON appointments (patient_id, starts_at DESC);
CREATE INDEX appointments_doctor_idx  ON appointments (doctor_id, starts_at DESC);
CREATE INDEX appointments_status_idx  ON appointments (status, starts_at);
CREATE INDEX appointments_date_range_idx ON appointments USING gist (appointment_period);
```

### 3.12 `appointment_status_history` — NEW

Does not exist in any form today. Every status change is currently an in-place overwrite
with ad-hoc side columns (`statusNote`, `updatedAt`, `rescheduledAt`, `cancelledBy`).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigserial` PK | |
| `appointment_id` | `uuid` NOT NULL FK → `appointments(id)` ON DELETE CASCADE | |
| `from_status` | `appt_status` | NULL on creation |
| `to_status` | `appt_status` NOT NULL | |
| `changed_by` | `uuid` FK → `users(id)` | System actions → NULL |
| `note` | `text` | |
| `created_at` | `timestamptz` DEFAULT now() | |

```sql
CREATE INDEX appt_history_appt_idx ON appointment_status_history (appointment_id, created_at);
```

Append-only — `REVOKE UPDATE, DELETE`.

### 3.13 `queue_entries` — NEW

Replaces three inconsistent copies of queue state (`db.queue[]`, `slot.currentQueue`,
`appointment.queuePosition`). Today `currentQueue` only ever increments and `maxQueue` is
never read.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `appointment_id` | `uuid` NOT NULL FK → `appointments(id)` ON DELETE CASCADE | |
| `slot_id` | `uuid` NOT NULL FK → `slots(id)` | |
| `doctor_id` | `uuid` NOT NULL FK → `doctors(id)` | |
| `patient_id` | `uuid` NOT NULL FK → `users(id)` | |
| `state` | `queue_state` NOT NULL DEFAULT 'waiting' | |
| `position` | `integer` NOT NULL | Assigned per `(slot_id, state='waiting')` |
| `joined_at` | `timestamptz` DEFAULT now() | |
| `called_at`, `left_at` | `timestamptz` | |

```sql
CREATE UNIQUE INDEX queue_one_entry_per_appt ON queue_entries (appointment_id);
CREATE UNIQUE INDEX queue_unique_position
  ON queue_entries (slot_id, position) WHERE state = 'waiting';
```

The second index is the fix for the `joinQueue` IDOR: an attacker can no longer inflate their
own position.

### 3.14 `notifications`, `notification_deliveries`, `notification_outbox`

```sql
CREATE TABLE notifications (
  id             uuid PK,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  event          text NOT NULL,
  title          text NOT NULL,      -- was `subject`
  body           text NOT NULL,      -- rendered snapshot, retained
  template_key   text NOT NULL,      -- NEW: enables re-rendering
  read_at        timestamptz,        -- was boolean `read`
  created_at     timestamptz DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id              uuid PK,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         notify_channel NOT NULL,
  destination     text NOT NULL,
  status          delivery_status NOT NULL DEFAULT 'queued',
  provider_msg_id text,
  error           text,
  attempted_at    timestamptz,
  delivered_at    timestamptz
);

-- ★ Transactional outbox: the notification row is written in the SAME transaction
--   as the appointment change, so a crash can never lose or duplicate one.
CREATE TABLE notification_outbox (
  id            bigserial PK,
  event         text NOT NULL,
  aggregate_id  uuid NOT NULL,
  payload       jsonb NOT NULL,
  status        outbox_status NOT NULL DEFAULT 'pending',
  attempts      integer DEFAULT 0,
  last_error    text,
  available_at  timestamptz DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX outbox_pending_idx ON notification_outbox (available_at)
  WHERE status = 'pending';
```

```sql
CREATE INDEX notifications_user_unread_idx
  ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_only_idx
  ON notifications (user_id) WHERE read_at IS NULL;
```

The hard 500-row cap in `notificationService.js:170` (`db.notifications.length = 500`) is
removed — retention becomes a scheduled `DELETE`.

### 3.15 Supporting tables

```sql
CREATE TABLE refresh_tokens (
  id         uuid PK,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,     -- store the hash, never the token
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE reviews (
  id         uuid PK,
  doctor_id  uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (doctor_id, patient_id, appointment_id)
);

CREATE TABLE triage_sessions (
  id            uuid PK,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  description   text NOT NULL,
  provider      text NOT NULL,          -- 'google-gemini:...' | 'rule-based-fallback'
  urgency       text NOT NULL,
  departments   text[],
  red_flags     text[],
  summary       text,
  latency_ms    integer,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE audit_logs (
  id          bigserial PK,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id uuid,
  metadata    jsonb,
  ip          inet,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX audit_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_resource_idx ON audit_logs (resource, resource_id);
```

`triage_sessions` also gives the safety story teeth: an auditable record that the system
produced *recommendations*, not diagnoses.

---

## 4. Relationships to normalise

| Today | Problem | v2 |
| --- | --- | --- |
| `doctors.specialty` + `doctors.specialtyName` | Name duplicated per doctor; rename needs N updates | `specialty_id` FK + JOIN |
| `doctors.facilityId` + `facilityName` + `city` + `address` | 4 columns, 3 duplicated from `facilities` | `facility_id` FK only |
| `doctors[].user{}` | Full embedded user row **including password** (S-03, S-04) | Deleted; `doctors.user_id` FK |
| `doctors.serviceIds[]` / `languages[]` | Arrays: unqueryable, unindexable | `doctor_services`, `doctor_languages` |
| `appointments.patientName/doctorName/…` | Denormalised on write, stale on rename | FKs; join at read time |
| `appointments.date/startTime/endTime/fee` | Copies of the slot | Point at `slot_id`; keep `fee` as an explicit snapshot |
| `appointments.symptoms` ≡ `reason` in seed | Exact duplication | Distinct columns |
| `slots.appointmentId` ↔ `appointments.slotId` | Bidirectional, unenforced, **proven to desync** (D-B2: slot stuck `booked` after cancel) | One direction only: `appointments.slot_id` |
| `db.queue[]` + `slot.currentQueue` + `appointment.queuePosition` | Three sources of truth | `queue_entries` |
| `users.profile.allergies[]` | JSON array | `patient_allergies` |
| `notifications.subject/body` rendered strings | Not re-renderable | + `template_key` |
| `slots.maxQueue` | Written, never read | Enforced by `queue_unique_position` |
| `slot.date` + `startTime` + `endTime` strings | No timezone | `starts_at`/`ends_at` `timestamptz` + `tstzrange` |

## 5. Data that must NOT be duplicated

- Doctor name / specialty name / facility name → **never** denormalise into appointments or
  slots. Join instead. The only denormalisation kept is a deliberate, documented snapshot
  (`fee`, `facility_id`, `specialty_id`) so historical records stay stable if the doctor
  changes specialty or moves facility.
- Patient contact details (`contact{phone,email}` on appointments) → **must be deleted.** Read
  from `users` at delivery time.
- Password hashes → exactly one home, `users.password_hash`, never projected into any response.

## 6. Fields requiring constraints

| Field | Constraint |
| --- | --- |
| `users.email` | `UNIQUE`, `citext`, format regex |
| `users.role` | enum |
| `users.password_hash` | must match `^\$2[aby]\$\d{2}\$` — a `CHECK` that makes `hashed:` values impossible at the storage layer |
| `doctors.user_id` | `UNIQUE` FK — one doctor per account |
| `doctors.consultation_fee` | `>= 0` |
| `slots.starts_at` / `ends_at` | `ends_at > starts_at`; `starts_at` in the future enforced in the service (a DB `CHECK` cannot use `now()`) |
| `slots` | `EXCLUDE (doctor_id, period)`; `UNIQUE (doctor_id, starts_at)` |
| `appointments.slot_id` | `UNIQUE` where status is active |
| `appointments` | `EXCLUDE (patient_id, period)` where status is active |
| `appointments` | `status = 'cancelled'` ⇔ `cancelled_at IS NOT NULL` |
| `appointments.fee` | `>= 0` |
| `doctor_availability` | `0 ≤ weekday ≤ 6`; `end_time > start_time` |
| `queue_entries.position` | unique per slot while `waiting` |
| `reviews.rating` | `BETWEEN 1 AND 5` |
| `patient_profiles.blood_group`, `.gender` | enum `CHECK`s |
| `triage_sessions.urgency` | enum (`low`/`medium`/`high`) |

A `CHECK` on `password_hash` is worth calling out — it makes the S-02 class of bug
**impossible to store**, not merely absent today.

---

## 7. Migration execution plan

> **Do not execute any of this during Phase 0.** Ordered for Phase 2.

### Step 1 — Schema creation

Create `server/src/db/migrations/` with numbered, forward-only SQL:

```
001_extensions.sql      btree_gist, citext, pgcrypto
002_enums.sql           the 8 enum types
003_users.sql           users, patient_profiles, patient_allergies, refresh_tokens
004_reference_data.sql  specialties, facilities, services
005_doctors.sql         doctors, doctor_services, doctor_languages, reviews
006_availability.sql    doctor_availability, slots (+ exclusion constraint)
007_appointments.sql    appointments (+ both exclusion/partial unique indexes)
008_status_history.sql  appointment_status_history
009_queue.sql           queue_entries
010_notifications.sql   notifications, notification_deliveries, notification_outbox
011_audit_triage.sql    audit_logs, triage_sessions
012_views.sql           doctor_ratings, doctor_directory (denormalised read view)
013_rls.sql             row-level security policies
```

Apply with `supabase db push`, or `psql` against the connection string. Track applied
filenames in a `schema_migrations` table. Never edit an applied migration — add a new one.

### Step 2 — Migrations tooling

`supabase db reset` (local), `supabase db push` (hosted), plus a `db:migrate` npm script.
Local development against a local Supabase stack, not a shared hosted database.

### Step 3 — Seed data

`server/src/db/seeds/seed.sql` — deterministic, idempotent (`ON CONFLICT DO NOTHING`):

- 10 specialties, 6 facilities, 5 services (same content as today, re-keyed to UUIDs)
- 1 admin, 3 patients, 12 doctors — **bcrypt hashes generated at seed time by a Node script**,
  because `pgcrypto`'s `crypt()` is not guaranteed available and bcrypt cost must be explicit
- `doctor_availability` weekly templates for all 12 doctors (replaces the hard-coded
  `SLOT_TIMES` grid)
- Slots materialised 14 days ahead from the templates — the same shape as today's 1254 rows,
  but generated rather than hand-rolled
- ~45 appointments across statuses, for analytics parity
- Zero notifications (they are event-driven)

The existing `scripts/shapes.js` and `server/scripts/smoke.js` are the acceptance check: the
seeded API responses must keep the same shapes.

### Step 4 — Data mapping (JSON → SQL)

`server/src/db/scripts/export-json.js` reads `db.json`; `import-postgres.js` writes rows.
Mapping rules:

| JSON | SQL | Transform |
| --- | --- | --- |
| `users[].id` | `users.id` | generate a fresh UUID, keep an `legacy_id` column during migration only |
| `users[].password` | `users.password_hash` | **`hashed:abc` → `bcrypt.hash('abc', 12)`**; plaintext leaves the machine |
| `users[].profile` | `patient_profiles` + `patient_allergies` | split; `allergies[]` → one row each |
| `doctors[].user` | — | **dropped**; `doctors.user_id` links to `users` |
| `doctors[].specialty` | `doctors.specialty_id` | old id → new UUID via a lookup table |
| `doctors[].city/address` | — | dropped; facility is authoritative |
| `doctors[].serviceIds[]` | `doctor_services` | one row per pair |
| `slots[].date + startTime` | `slots.starts_at` | `${date}T${startTime}:00Z` — **the timezone must be decided and recorded; UTC is the honest choice for this seed data** |
| `slots[].endTime` | `slots.ends_at` | same |
| `slots[].appointmentId` | — | dropped; `appointments.slot_id` is authoritative |
| `appointments[].date/startTime/endTime` | `starts_at`/`ends_at` | recomputed from the slot, never from the stored copy |
| `appointments[].*Name` | — | dropped; resolved by FK at read time |
| `appointments[].cancelledBy` ("provider"/"patient"/"admin") | `cancelled_by` uuid | role string → the actual acting user's id |
| `appointments[].reminderSent` | `reminder_sent_at` | boolean → timestamp (`created_at` as an approximation) |
| `queue[]` | `queue_entries` | `state` → `waiting`; position assigned by `joined_at` order |
| `notifications[]` | `notifications` + `notification_deliveries` | `read: true` → `read_at = created_at`; one delivery row per channel |
| `meta.seededAt` | — | dropped |

Every FK is resolved through an `legacy_id → uuid` lookup table built during import.
**The importer must abort if any reference is unresolvable** — a silent NULL would corrupt the
dataset.

### Step 5 — Backend data-access replacement

Do this domain by domain, so the app stays runnable throughout. Never big-bang.

| Order | Slice | Work |
| --- | --- | --- |
| 1 | `specialties`, `facilities`, `services` | `config/db.js` → `repositories/referenceRepo`; no user-visible change |
| 2 | `users`, auth | bcrypt hashing (S-02), `userRepo`, new `authService`. **Delete the `hashed:` branch once all accounts are migrated** |
| 3 | `doctors` | `doctorRepo` + SQL search/filter/sort/pagination. Keep the `shape()` projection, now SQL-driven |
| 4 | `slots`, availability | `availabilityRepo`, `slotRepo`, generator job from `doctor_availability` |
| 5 | `appointments` | ★ `bookingService` with `withTransaction` + `FOR UPDATE` + constraint mapping (**D-B1…D-B6 land here**) |
| 6 | `queue`, `check-in` | `queueService`; **`check-in` gets an ownership check (S-06)** |
| 7 | `notifications` | outbox pattern; drop the 500 cap |
| 8 | `admin`, analytics | SQL aggregates (`COUNT FILTER (WHERE …)`, `generate_series` for the trend) |

Per slice: write the repository, switch the service, update the controller, keep the same
response shape, re-run the smoke suite.

### Step 6 — Validation

| Check | Method |
| --- | --- |
| Row counts | `users` 16, `doctors` 12, `specialties` 10, `facilities` 6, `services` 5, `appointments` 45, `slots` ≥1254 |
| Orphan scan | Every FK resolves; the importer already guarantees this |
| Response parity | `scripts/shapes.js` output diffed against the pre-migration capture, endpoint by endpoint |
| Behaviour parity | `scripts/smoke.js` passes 35/35 against the PostgreSQL-backed server |
| Booking correctness | New Supertest cases: overlapping slots rejected, past-slot reschedule rejected, cancel-via-status releases the slot, fee refreshes on reschedule, mode must match the slot |
| Concurrency | A test firing **20 simultaneous bookings at one slot** — exactly 1 succeeds, 19 get 409 |
| Query plans | `EXPLAIN ANALYZE` on doctor search, availability, and the admin overview; assert index usage |
| Migration idempotency | `supabase db reset` then `seed.sql` twice — identical counts |

### Step 7 — Remove the JSON datastore

Only after step 6 passes:

1. Delete `server/src/config/db.js`.
2. Delete `server/.data/` **and its 468 KB committed `db.json`**.
3. Remove `persist()` and every call site (~15 sites across controllers and services).
4. Remove the `id(prefix)` generator; IDs now come from `gen_random_uuid()`.
5. Remove the seed constants (`SPECIALTIES`, `FACILITIES`, `SERVICES`, `DOCTOR_NAMES`,
   `SLOT_TIMES`, `QUEUE_STATES`, `CITIES`, `buildSeed`, `addMinutes`, `dayOffset`).
6. Add `.gitignore` entries for `.data/`, `dist/`, `node_modules/`, `.env`.
7. `supabase db reset` becomes the only way to reset to a clean state — replacing "delete
   `db.json`".

---

## 8. Post-migration concurrency design

The single most important deliverable. Three independent layers, so correctness never depends
on one mechanism:

**Layer 1 — row lock.** `SELECT … FROM slots WHERE id = $1 FOR UPDATE` inside the booking
transaction. Serialises concurrent bookings for the same slot.

**Layer 2 — partial unique index.**
`CREATE UNIQUE INDEX appointments_one_active_per_slot ON appointments(slot_id) WHERE status IN (…)`.
If two transactions somehow both pass the lock check, one raises `23505` → 409.

**Layer 3 — exclusion constraint.**
`EXCLUDE USING gist (patient_id WITH =, period WITH &&) WHERE status IN (…)`.
Enforces no overlapping appointments for one patient. Resolves D-B1 permanently.

Plus the remaining correctness fixes, all inside the same transaction:

| Defect | Fix |
| --- | --- |
| D-B1 overlapping double-book | Layer 3 |
| D-B2 cancel-via-status leaks a slot | One `cancelAppointment` path; the status machine forbids a bare `→ cancelled` or routes it through the same release logic |
| D-B3 reschedule into the past | `CHECK (new_slot.starts_at > now())` inside the transaction |
| D-B4 future check-in | `CHECK (appointment.starts_at <= now())` in `joinQueue` |
| D-B5 stale fee on reschedule | Re-read `slot.fee` and update `appointments.fee` in the transaction |
| D-B6 mode override | Ignore client `mode`; take `slot.mode` as the only source |
| B7 `maxQueue` never enforced | `queue_unique_position` partial index |

### Expected error mapping

```js
const mapDbError = (err) => {
  switch (err.code) {
    case '23505':  // unique_violation
      return new AppError('That time was just taken. Please pick another slot.',
                          409, 'SLOT_TAKEN');
    case '23P01':  // exclusion_violation
      return new AppError('You already have an appointment at that time.',
                          409, 'PATIENT_CLASH');
    case '23503':  // foreign_key_violation
      return new AppError('Referenced record no longer exists.', 409, 'STALE_REFERENCE');
    default:
      throw err;   // never swallow
  }
};
```

---

## 9. Row Level Security

Supabase exposes Postgres over HTTP; without RLS, the anon key can read everything.

**Decision: the Express API connects as the service-role key (or via the direct connection
string) and enforces authorization in the service layer.** RLS is enabled with restrictive
policies as defence in depth, so a leaked anon key still reads nothing:

```sql
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;
-- no policies on these => anon/authenticated roles get zero rows
```

Realtime respects RLS, so subscription payloads cannot leak either. Grant table privileges to
`authenticated` only for tables the client will read directly (if any).

`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` are **server-only** secrets and must never
reach the client bundle.

---

## 10. Realtime schema requirements

Realtime is Postgres logical replication of `INSERT`/`UPDATE`/`DELETE`. It needs no extra
configuration, but the schema should be shaped for it:

| Table | Payload | Concern |
| --- | --- | --- |
| `slots` | `id, doctor_id, starts_at, status` | Do **not** broadcast `REPLICA IDENTITY FULL` row images to patients — that would leak other patients' booking state. Subscribe with a filter and project in the client. |
| `appointments` | `id, patient_id, doctor_id, status, starts_at` | RLS + client-side filter keeps a patient subscribed to their own rows only |
| `queue_entries` | `id, slot_id, doctor_id, state, position` | Patients see position only |
| `notifications` | `id, user_id, event, title, read_at` | Filter `user_id=eq.<uid>` |

Always `SELECT` explicit columns in Postgres. This is also what prevents S-03/S-04 from
reappearing through a realtime payload.

---

## 11. Migration risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Passwords leave the machine in cleartext during export | Import script hashes in-process and never writes plaintext to disk or logs. The `.data/db.json` file is deleted in step 7. |
| ID remapping breaks FKs | `legacy_id` lookup table; importer aborts on any unresolvable reference |
| Timezone ambiguity (`date` + `startTime` strings) | Decide and document the seed timezone **before** migrating; convert with an explicit offset, never a bare `Z` assumption |
| Big-bang rewrite breaks the app mid-migration | Domain-by-domain slices, each ending with a green smoke suite |
| Unique indexes fail on existing dirty data | Run the importer into a scratch database first; expect and resolve conflicts (`slots_no_doctor_overlap` is the likely one) |
| Lost slot↔appointment consistency (D-B2) | One-direction FK; run a reconciliation query before switching |
| Index-only choices lock in current access patterns | Use `EXPLAIN ANALYZE` in step 6; revisit with real data |
| Realtime leaks PHI via row images | RLS + explicit column lists + client-side filtering (section 10) |

---

## 12. Definition of done

- [ ] All 13 migration files applied cleanly from an empty database
- [ ] `seed.sql` idempotent — two runs produce identical counts
- [ ] Row counts and response shapes match the pre-migration capture
- [ ] `scripts/smoke.js` 35/35 against the PostgreSQL-backed API
- [ ] 20 concurrent bookings at one slot → exactly 1 × 201, 19 × 409
- [ ] Overlapping-slot double booking rejected (D-B1)
- [ ] Reschedule into the past rejected (D-B3)
- [ ] Cancel releases the slot on **every** path (D-B2)
- [ ] Fee refreshes on reschedule (D-B5)
- [ ] Check-in rejected for future appointments (D-B4)
- [ ] `mode` cannot be overridden (D-B6)
- [ ] RLS enabled; anon key reads zero rows
- [ ] `EXPLAIN ANALYZE` shows index usage on the three hot queries
- [ ] `server/src/config/db.js` and `server/.data/` deleted
- [ ] `persist()` and all call sites removed
- [ ] `.gitignore` covers `.data/`, `dist/`, `node_modules/`, `.env`
- [ ] No plaintext password anywhere in the repository