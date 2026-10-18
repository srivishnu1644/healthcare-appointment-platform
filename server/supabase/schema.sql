-- ==========================================================================
--  BookMyDoc v2 — the complete PostgreSQL schema, in one file.
--
--  This file IS the schema. It is the source of truth, maintained by hand
--  and checked in. There is no generator behind it.
--
--  HOW TO APPLY IT
--    Supabase        : Dashboard -> SQL Editor -> New query -> paste -> Run
--    Plain Postgres  : psql "$DATABASE_URL" -f supabase/schema.sql
--    This repository : npm run db:schema       (uses DATABASE_URL)
--
--  The whole file runs as ONE script, in order, and it is **not reversible**:
--  most of it is plain CREATE. Apply it to a FRESH database. Re-running it is
--  safe — it records itself in `schema_migrations` and does nothing on a
--  second pass.
--
--  Additive changes to a database that already has this schema are applied
--  automatically at boot by `src/db/ensureSchema.js`.
--
--  Then, optionally, the demo data:  npm run db:seed
--
--  WHAT IT CONTAINS
--    23 tables, 8 enum types, RLS enabled on EVERY table.
--
--  SUPABASE NOTES
--    * btree_gist and citext are both available on Supabase. When
--      they already exist in the `extensions` schema, IF NOT EXISTS makes
--      the statement a no-op.
--    * The anon key can read only the public directory tables; every
--      other table returns zero rows to it, and non-owner roles hold no
--      write privilege on anything.
--    * The API connects over DATABASE_URL as the table owner, so RLS is
--      defence in depth for the database's HTTP surface, not a filter
--      the API runs through.
-- ==========================================================================

-- Bookkeeping: which schema revision this database is on. Created here,
-- before anything else, because RLS guards it like every other table in
-- public and because the section at the end writes to it.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0
);

-- ==========================================================================
--  001_extensions.sql
-- ==========================================================================
-- ============================================================
--  001_extensions.sql — PostgreSQL extensions
--
--  btree_gist : required so an EXCLUDE constraint can mix a scalar
--               equality (uuid) with a range overlap (tstzrange).
--               This is what makes concurrency-safe booking possible
--               at the database level.
--  citext     : case-insensitive email uniqueness, replacing the
--               case-insensitive comparison previously done in JS.
--  pgcrypto   : NOT required. gen_random_uuid() has been part of
--               PostgreSQL core since v13, and Supabase provisions v15+.
--               Deliberately not installed: some minimal builds do not ship
--               it, and a missing extension would abort the whole migration
--               for no benefit.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ==========================================================================
--  002_enums.sql
-- ==========================================================================
-- ============================================================
--  002_enums.sql — domain enumerations
--
--  Replaces the free-form status strings that were previously only
--  validated in some Express routes and unvalidated in others.
--  An invalid status is now impossible to store rather than merely
--  discouraged by application code.
-- ============================================================

-- user_role replaces the 'patient' | 'doctor' | 'admin' free text,
-- and eliminates the 'provider' alias that registration previously
-- mapped onto the privileged 'doctor' role.
CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');

CREATE TYPE consult_mode AS ENUM ('in-person', 'video');

CREATE TYPE slot_status AS ENUM ('available', 'booked', 'blocked');

CREATE TYPE appt_status AS ENUM (
  'scheduled',
  'confirmed',
  'in-progress',
  'completed',
  'cancelled',
  'no-show'
);

CREATE TYPE queue_state AS ENUM ('waiting', 'in-consultation', 'completed', 'left');

CREATE TYPE notify_channel AS ENUM ('in-app', 'sms', 'email');

CREATE TYPE delivery_status AS ENUM ('queued', 'sent', 'delivered', 'failed', 'simulated');

-- Which side cancelled. Was previously a bare role string
-- ('provider' | 'admin' | 'patient') stored on the appointment.
CREATE TYPE cancelled_by_role AS ENUM ('patient', 'provider', 'admin', 'system');

-- ==========================================================================
--  003_identity.sql
-- ==========================================================================
-- ============================================================
--  003_identity.sql — users, patient profiles, allergies
--
--  Replaces the single polymorphic `users` array in the JSON datastore.
--  The untyped `users[].profile` blob becomes typed columns, which is
--  what allowed arbitrary key injection (Phase 0 finding S-08).
--
--  ID strategy: existing IDs from db.json are preserved verbatim
--  (they look like 'usr_a1b2c3'), so relationships survive the
--  migration untouched. New rows get a UUID cast to text, giving a
--  consistent text key space.
-- ============================================================

CREATE TABLE users (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         citext NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'patient',
  full_name     text NOT NULL,
  phone         text,
  is_active     boolean NOT NULL DEFAULT true,
  -- Bumped on password change / role change so existing JWTs stop working.
  token_version integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_email_format
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT users_name_length
    CHECK (char_length(full_name) BETWEEN 2 AND 120),
  -- The single most important constraint in this migration: a password
  -- must be a bcrypt hash. The prototype stored 'hashed:${plaintext}',
  -- which was reversible. This makes that unrepresentable.
  CONSTRAINT users_password_is_bcrypt
    CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$')
);

CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_role_idx ON users (role) WHERE is_active;

-- One-to-one profile, only meaningful for patients. Kept separate so a
-- doctor's record has no empty demographic columns.
CREATE TABLE patient_profiles (
  user_id           text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth     date,
  gender            text,
  blood_group       text,
  address_line      text,
  emergency_contact text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT profiles_gender_valid
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to-say')),
  CONSTRAINT profiles_blood_group_valid
    CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'))
);

-- Was `users[].profile.allergies[]`, an array inside a JSON blob that
-- could not be queried, indexed or constrained. (A caller previously
-- corrupted it into a string.)
CREATE TABLE patient_allergies (
  patient_id text NOT NULL REFERENCES patient_profiles(user_id) ON DELETE CASCADE,
  allergen   text NOT NULL,
  PRIMARY KEY (patient_id, allergen)
);

-- Rotating refresh tokens (issued in Phase 3). The table exists now so the
-- schema is complete; nothing writes to it yet.
CREATE TABLE refresh_tokens (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ==========================================================================
--  004_reference_data.sql
-- ==========================================================================
-- ============================================================
--  004_reference_data.sql — specialties, facilities, services
--
--  These become the authoritative source for the names that were
--  previously denormalised onto every doctor and appointment row
--  (doctors.specialtyName, doctors.facilityName, doctors.city,
--  doctors.address, appointments.doctorName, ...).
--
--  Those columns are dropped here and re-derived by JOIN, so a rename
--  or re-assignment no longer requires touching every row.
-- ============================================================

CREATE TABLE specialties (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  icon        text,

  CONSTRAINT specialties_name_not_blank CHECK (char_length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX specialties_name_key ON specialties (lower(name));
CREATE UNIQUE INDEX specialties_slug_key ON specialties (slug);

CREATE TABLE facilities (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          text NOT NULL,
  city          text NOT NULL,
  address       text NOT NULL,
  type          text,
  phone         text,
  open_hours    text,
  rating        numeric(2,1),
  queue_enabled boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT facilities_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT facilities_rating_range CHECK (rating IS NULL OR rating BETWEEN 0 AND 5)
);

CREATE UNIQUE INDEX facilities_name_key ON facilities (lower(name));
CREATE INDEX facilities_city_idx ON facilities (city);

CREATE TABLE services (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             text NOT NULL,
  description      text,
  duration_minutes integer NOT NULL,
  price            numeric(10,2) NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'INR',

  CONSTRAINT services_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT services_duration_range CHECK (duration_minutes BETWEEN 5 AND 480),
  CONSTRAINT services_price_non_negative CHECK (price >= 0)
);

CREATE UNIQUE INDEX services_name_key ON services (lower(name));

-- NOTE: doctor_services and doctor_languages live in 006, after `doctors`
-- exists, because a foreign key cannot reference a table that has not been
-- created yet.

-- ==========================================================================
--  005_doctors.sql
-- ==========================================================================
-- ============================================================
--  005_doctors.sql — provider records
--
--  Note: `doctors.user` (a full embedded copy of the users row,
--  including the password hash) is NOT reproduced. That embedded copy
--  was the root cause of three Phase 0 data leaks (S-03, S-04 and the
--  /admin/doctors variant). Here a doctor references its login account
--  by id, and every response is built by JOIN plus an explicit
--  projection.
--
--  Also absent: the JSON `rating` and `reviewCount`. Those were
--  synthetic seed numbers that an admin could overwrite at will
--  (Phase 0 finding S-17). `005b_reviews.sql` is intentionally NOT
--  created in this phase; the API keeps serving the seed rating from
--  its own response mapping until a reviews table is designed.
-- ============================================================

CREATE TABLE doctors (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Authoritative references. specialtyName / facilityName / city / address
  -- are derived by JOIN instead of being stored per doctor.
  specialty_id     text NOT NULL REFERENCES specialties(id),
  facility_id      text NOT NULL REFERENCES facilities(id),
  qualification    text,
  experience_years integer,
  bio              text,
  consultation_fee numeric(10,2) NOT NULL,
  is_accepting_new boolean NOT NULL DEFAULT true,
  avatar_color     text,
  -- Snapshot of the seed-only display rating. Read-only from Phase 2:
  -- the admin update allow-list no longer includes it.
  seed_rating      numeric(2,1),
  seed_review_count integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT doctors_one_account_per_doctor UNIQUE (user_id),
  CONSTRAINT doctors_fee_non_negative CHECK (consultation_fee >= 0),
  CONSTRAINT doctors_experience_range CHECK (experience_years IS NULL OR experience_years BETWEEN 0 AND 70),
  CONSTRAINT doctors_rating_range CHECK (seed_rating IS NULL OR seed_rating BETWEEN 0 AND 5)
);

-- Directory queries filter on specialty and facility together.
CREATE INDEX doctors_specialty_facility_idx ON doctors (specialty_id, facility_id);
-- Partial index: the hot discovery filter is "accepting new patients".
CREATE INDEX doctors_accepting_idx ON doctors (is_accepting_new) WHERE is_accepting_new;
CREATE INDEX doctors_fee_idx ON doctors (consultation_fee);
CREATE INDEX doctors_seed_rating_idx ON doctors (seed_rating DESC);

-- ==========================================================================
--  006_doctor_links.sql
-- ==========================================================================
-- ============================================================
--  006_doctor_links.sql — many-to-many doctor relations
--
--  Split out from 004 so the foreign keys have a `doctors` table to
--  reference.
-- ============================================================

-- Replaces the doctors.serviceIds[] array, which was unindexable and
-- therefore unfilterable.
CREATE TABLE doctor_services (
  doctor_id  text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  service_id text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  PRIMARY KEY (doctor_id, service_id)
);

CREATE INDEX doctor_services_service_idx ON doctor_services (service_id);

-- Replaces the doctors.languages[] array, so `?language=Hindi` becomes an
-- indexed lookup instead of a JavaScript array scan.
CREATE TABLE doctor_languages (
  doctor_id text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  language  text NOT NULL,
  PRIMARY KEY (doctor_id, language)
);

CREATE INDEX doctor_languages_lang_idx ON doctor_languages (lower(language));

-- ==========================================================================
--  007_slots.sql
-- ==========================================================================
-- ============================================================
--  007_slots.sql — bookable time windows
--
--  The JSON slot stored `date` ("2030-01-01") and `startTime` ("09:00")
--  as separate strings with no timezone. Comparisons were lexical,
--  which happened to work only because ISO-8601 sorts correctly as text.
--  Here a slot is a real timestamptz range.
--
--  APP_TIMEZONE (default Asia/Kolkata) is the display/business timezone.
--  Timestamps are stored as absolute instants; the local date and clock
--  time are derived from them with `AT TIME ZONE`, which is what the
--  repositories return in the `date` / `startTime` / `endTime` fields so
--  the existing API response shape is preserved exactly.
-- ============================================================

CREATE TABLE slots (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  doctor_id  text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  -- Denormalised from the doctor on purpose: every availability query
  -- filters on it, and a doctor has exactly one facility.
  facility_id text NOT NULL REFERENCES facilities(id),
  service_id text REFERENCES services(id),
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  mode       consult_mode NOT NULL DEFAULT 'in-person',
  status     slot_status NOT NULL DEFAULT 'available',
  fee        numeric(10,2),
  max_queue  integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Generated range so overlap can be expressed as an exclusion constraint.
  period tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at)) STORED,

  CONSTRAINT slots_time_order CHECK (ends_at > starts_at),
  CONSTRAINT slots_max_queue_positive CHECK (max_queue > 0),
  CONSTRAINT slots_fee_non_negative CHECK (fee IS NULL OR fee >= 0)
);

-- ★ The structural guarantee behind concurrency-safe booking.
-- Two slots for the same doctor may never overlap in time. Previously
-- a provider could generate 09:00-09:30 and 09:15-09:45, and a patient
-- could book both (Phase 0 finding D-B1).
ALTER TABLE slots
  ADD CONSTRAINT slots_no_doctor_overlap
  EXCLUDE USING gist (doctor_id WITH =, period WITH &&);

-- Belt-and-braces for the common case of an identical start time.
CREATE UNIQUE INDEX slots_doctor_start_key ON slots (doctor_id, starts_at);

-- The hot path: "next available slot for this doctor from now".
CREATE INDEX slots_doctor_available_idx
  ON slots (doctor_id, starts_at)
  WHERE status = 'available';

CREATE INDEX slots_facility_idx ON slots (facility_id, starts_at);
CREATE INDEX slots_status_idx ON slots (status);
-- Supports the `?mode=video` discovery filter.
CREATE INDEX slots_mode_idx ON slots (mode, starts_at);

-- ==========================================================================
--  008_appointments.sql
-- ==========================================================================
-- ============================================================
--  008_appointments.sql — booking records
--
--  Normalisation decisions:
--
--  * patientName / doctorName / specialtyName / facilityName are NOT
--    stored. They were denormalised copies that went stale on rename.
--    They are re-derived by JOIN in the repository layer.
--
--  * date / startTime / endTime are NOT stored. The slot is the
--    authority; these are derived from the joined slot.
--
--  * The bidirectional slot<->appointment link is BROKEN. Previously
--    slots.appointmentId and appointments.slotId both existed with
--    nothing enforcing agreement, and they demonstrably diverged: a
--    cancellation through PATCH /:id/status left the slot stuck as
--    'booked' forever (Phase 0 finding D-B2). Now only
--    appointments.slot_id exists, with a real foreign key.
--
--  * specialty_id and facility_id ARE stored as a deliberate snapshot,
--    so historical records stay stable if a doctor later changes
--    specialty or moves facility.
-- ============================================================

CREATE TABLE appointments (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  patient_id   text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  doctor_id    text NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  slot_id      text NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  -- Snapshots, kept stable across later doctor changes.
  specialty_id text NOT NULL REFERENCES specialties(id),
  facility_id  text NOT NULL REFERENCES facilities(id),
  mode         consult_mode NOT NULL,
  status       appt_status NOT NULL DEFAULT 'confirmed',
  reason       text,
  -- Distinct from reason (the seed duplicated them, which was a bug).
  symptoms     text,
  -- Snapshot of the price at booking time.
  fee          numeric(10,2),
  cancel_reason  text,
  cancelled_at   timestamptz,
  cancelled_by   cancelled_by_role,
  checked_in_at  timestamptz,
  completed_at   timestamptz,
  -- Was the boolean `reminderSent`; a timestamp is idempotent and
  -- records when the reminder actually went out.
  reminder_sent_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Denormalised time window, kept in sync with the slot inside the same
  -- transaction, so the overlap exclusion below has something to index.
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,

  period tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at)) STORED,

  CONSTRAINT appointments_time_order CHECK (ends_at > starts_at),
  CONSTRAINT appointments_fee_non_negative CHECK (fee IS NULL OR fee >= 0),
  -- A cancelled appointment must carry the audit fields, and vice versa.
  CONSTRAINT appointments_cancel_consistent CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  )
);

-- The doctor must match the slot's owner. PostgreSQL CHECK constraints
-- cannot contain a subquery, so this is a trigger instead. It closes the
-- hole the CHECK could not: a caller could otherwise name doctor A and a
-- slot belonging to doctor B, and the booking would pass every check.
CREATE OR REPLACE FUNCTION appointments_slot_doctor_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  slot_doctor text;
BEGIN
  SELECT doctor_id INTO slot_doctor FROM slots WHERE id = NEW.slot_id;
  IF slot_doctor IS NULL THEN
    RAISE EXCEPTION 'slot % does not exist', NEW.slot_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF slot_doctor IS DISTINCT FROM NEW.doctor_id THEN
    RAISE EXCEPTION 'appointment doctor % does not own slot %', NEW.doctor_id, NEW.slot_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_slot_doctor_match_trg
  BEFORE INSERT OR UPDATE OF doctor_id, slot_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_slot_doctor_match();

-- ★ One active appointment per slot. Cancelled / no-show / completed rows
-- are retained for history, hence the partial predicate. This is the
-- constraint that makes double booking impossible regardless of any
-- application bug.
CREATE UNIQUE INDEX appointments_one_active_per_slot
  ON appointments (slot_id)
  WHERE status IN ('scheduled', 'confirmed', 'in-progress');

-- ★ A patient cannot hold two overlapping appointments. Previously the
-- guard compared exact `date + startTime` strings, so 09:00 and 09:15 both
-- succeeded (Phase 0 finding D-B1).
ALTER TABLE appointments
  ADD CONSTRAINT appointments_patient_no_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    period WITH &&
  )
  WHERE (status IN ('scheduled', 'confirmed', 'in-progress'));

CREATE INDEX appointments_patient_idx ON appointments (patient_id, starts_at DESC);
CREATE INDEX appointments_doctor_idx  ON appointments (doctor_id, starts_at DESC);
CREATE INDEX appointments_status_idx  ON appointments (status, starts_at);
CREATE INDEX appointments_slot_idx    ON appointments (slot_id);

-- ==========================================================================
--  009_appointment_status_history.sql
-- ==========================================================================
-- ============================================================
--  009_appointment_status_history.sql — append-only audit trail
--
--  This concept did not exist at all in the JSON datastore. Status was
--  overwritten in place, with ad-hoc side columns (statusNote, updatedAt,
--  rescheduledAt, cancelledBy, cancelReason) scattered across the
--  appointment record. There was no way to answer "who changed this
--  status, when, and from what".
-- ============================================================

CREATE TABLE appointment_status_history (
  id             bigserial PRIMARY KEY,
  appointment_id text NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- NULL for the creation entry.
  from_status    appt_status,
  to_status      appt_status NOT NULL,
  -- NULL for system-initiated transitions.
  changed_by     text REFERENCES users(id) ON DELETE SET NULL,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appt_history_appointment_idx
  ON appointment_status_history (appointment_id, created_at);

-- Append-only: no UPDATE, no DELETE from the application role.
REVOKE UPDATE, DELETE ON appointment_status_history FROM PUBLIC;

-- ==========================================================================
--  010_queue.sql
-- ==========================================================================
-- ============================================================
--  010_queue.sql — live waiting room
--
--  Replaces THREE conflicting sources of truth:
--    1. db.queue[]                       (array of queue entries)
--    2. slots.currentQueue               (a counter, only ever incremented)
--    3. appointments.queue_position      (a denormalised copy)
--
--  Because they could disagree, and because current_queue was never
--  decremented, a patient could inflate their own position by repeatedly
--  calling the check-in endpoint (Phase 0 findings S-06, D-B4).
--
--  Position is now assigned by a partial unique index per slot, so it
--  cannot be forged or duplicated.
-- ============================================================

CREATE TABLE queue_entries (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  appointment_id text NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  slot_id        text NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  doctor_id      text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  patient_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state          queue_state NOT NULL DEFAULT 'waiting',
  position       integer NOT NULL,
  joined_at      timestamptz NOT NULL DEFAULT now(),
  called_at      timestamptz,
  left_at        timestamptz,

  CONSTRAINT queue_position_positive CHECK (position > 0)
);

-- Checking in twice is a no-op, not a second queue entry.
CREATE UNIQUE INDEX queue_one_entry_per_appointment ON queue_entries (appointment_id);

-- Position is unique within a slot while the entry is still waiting. This
-- enforces the capacity rule that `max_queue` never did.
CREATE UNIQUE INDEX queue_unique_position
  ON queue_entries (slot_id, position)
  WHERE state = 'waiting';

CREATE INDEX queue_doctor_state_idx ON queue_entries (doctor_id, state, joined_at);
CREATE INDEX queue_slot_idx ON queue_entries (slot_id);

-- ==========================================================================
--  011_notifications.sql
-- ==========================================================================
-- ============================================================
--  011_notifications.sql — in-app messages + delivery + outbox
--
--  The JSON version stored one row per notification with a `channel`
--  of "both" and a `results[]` blob, and truncated the whole array to
--  500 entries with `db.notifications.length = 500`, silently dropping
--  the oldest messages.
--
--  The outbox is the important structural addition: notification rows are
--  written in the SAME transaction as the appointment change, so a crash
--  can no longer lose or duplicate a message.
-- ============================================================

CREATE TABLE notifications (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id text REFERENCES appointments(id) ON DELETE CASCADE,
  event          text NOT NULL,
  title          text NOT NULL,
  -- Rendered snapshot kept for history.
  body           text NOT NULL,
  -- Lets the message be re-rendered rather than frozen forever.
  template_key   text,
  -- Was a boolean `read`; a timestamp is more informative and allows
  -- "read since" style queries.
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_title_present CHECK (char_length(btrim(title)) > 0)
);

CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
-- Partial index powers the unread badge.
CREATE INDEX notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- One row per delivery channel, replacing the single row + results blob.
CREATE TABLE notification_deliveries (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         notify_channel NOT NULL,
  destination     text,
  status          delivery_status NOT NULL DEFAULT 'queued',
  provider_msg_id text,
  error           text,
  attempted_at    timestamptz,
  delivered_at    timestamptz,

  CONSTRAINT deliveries_channel_unique UNIQUE (notification_id, channel)
);

CREATE INDEX deliveries_pending_idx ON notification_deliveries (status)
  WHERE status = 'queued';

-- Transactional outbox: written inside the booking transaction, drained
-- asynchronously by a worker (Phase 10).
CREATE TABLE notification_outbox (
  id           bigserial PRIMARY KEY,
  event        text NOT NULL,
  aggregate_id text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,

  CONSTRAINT outbox_status_valid CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX outbox_pending_idx ON notification_outbox (available_at) WHERE status = 'pending';

-- ==========================================================================
--  012_audit_triage.sql
-- ==========================================================================
-- ============================================================
--  012_audit_triage.sql — audit log and AI triage records
-- ============================================================

-- Records who accessed whose patient data. GET /api/admin/patients
-- exposes email, phone, blood group and allergies; with no access log,
-- a breach of that view would be undetectable (Phase 0 finding S-19).
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    text REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX audit_actor_idx   ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_resource_idx ON audit_logs (resource, resource_id);

-- Persists every AI triage so the "recommendation, not diagnosis"
-- framing is auditable, and so request latency and fallback rate are
-- measurable.
CREATE TABLE triage_sessions (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  description text NOT NULL,
  provider    text NOT NULL,
  urgency     text NOT NULL,
  departments text[] NOT NULL DEFAULT '{}',
  red_flags   text[] NOT NULL DEFAULT '{}',
  summary     text,
  latency_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT triage_urgency_valid CHECK (urgency IN ('low', 'medium', 'high')),
  CONSTRAINT triage_latency_non_negative CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE INDEX triage_user_idx    ON triage_sessions (user_id, created_at DESC);
CREATE INDEX triage_provider_idx ON triage_sessions (provider, created_at DESC);

-- Replaces db.meta.seededAt, which was the only entry in the JSON
-- `meta` object. Other seed metadata (schema version, counts) becomes
-- app-level bookkeeping rather than a database concern.
CREATE TABLE seed_metadata (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ==========================================================================
--  013_rls.sql
-- ==========================================================================
-- ============================================================
--  013_rls.sql — Row Level Security
--
--  Supabase exposes Postgres over HTTP. Without RLS, a leaked anon key
--  can read every table, including patients' blood groups and allergies.
--
--  The Express API connects with the service-role key (or a direct
--  connection string) and enforces authorization in the service layer,
--  so the application is not blocked by these policies. They are
--  defence in depth: a leaked anon key still reads zero rows.
--
--  Enabling RLS with no policies is deny-by-default. Tables the client
--  will legitimately read directly later (none in Phase 2) would get
--  explicit policies.
-- ============================================================

-- Patient health data and messages: never readable by anon/authenticated.
ALTER TABLE patient_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_allergies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_sessions   ENABLE ROW LEVEL SECURITY;

-- Reference data is public: the doctor directory is browsable before
-- sign-in, exactly as the existing API intends.
ALTER TABLE specialties        ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE services           ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_languages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots              ENABLE ROW LEVEL SECURITY;

-- No policies are created, so the anon and authenticated roles match zero
-- rows in all of the above. The `public` role (which owns the tables when
-- running locally as the superuser) is unaffected, which keeps local
-- development and the API's service-role connection working.
--
-- Verified so far: src/db/scripts/verify-schema.js asserts that
-- pg_class.relrowsecurity is set on 16 tables. That proves RLS is enabled,
-- but NOT that an anon Supabase key reads zero rows -- that check needs a real
-- Supabase project and has not been run. Do it before exposing the project.

-- ==========================================================================
--  014_refresh_token_rotation.sql
-- ==========================================================================
-- ============================================================
--  014_refresh_token_rotation.sql — session rotation support
--
--  Phase 2 created `refresh_tokens` with the right columns for
--  *storing* a session but not for *rotating* one. This migration
--  adds what secure rotation and reuse detection require.
--
--  The access token stays a stateless short-lived JWT. The refresh
--  token is an opaque random string, of which only a SHA-256 digest
--  is stored: a database leak therefore yields no usable session.
--
--  Rotation model
--  --------------
--  One login creates one "family". Every refresh mints a new token
--  in the same family and revokes the one presented:
--
--      login ──> T1 ──refresh──> T2 ──refresh──> T3
--                (revoked)         (revoked)       (live)
--
--  Presenting an already-revoked token means the chain was replayed:
--  either a stolen token or a buggy client. Because we cannot tell which,
--  the entire family is revoked and every device in that chain is signed
--  out. That is the safe direction to fail.
-- ============================================================

-- ---------------------------------------------------------------
--  Family tracking
-- ---------------------------------------------------------------
-- Backfill before NOT NULL: a pre-existing row is its own family, which
-- is the correct interpretation of a lone session.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id text;
UPDATE refresh_tokens SET family_id = id WHERE family_id IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;

-- ---------------------------------------------------------------
--  Rotation bookkeeping
-- ---------------------------------------------------------------
-- `replaced_by` is set the moment a token is rotated. A row with this
-- populated but a NULL revoked_at would be ambiguous; the rotation
-- always sets both, and the CHECK below enforces it.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replaced_by  text REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS used_at       timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_reason text;

-- A rotated token must record both when it was swapped out and for what.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_rotation_consistent;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_rotation_consistent CHECK (
    (replaced_by IS NULL AND used_at IS NULL)
    OR (replaced_by IS NOT NULL AND used_at IS NOT NULL AND revoked_at IS NOT NULL)
  );

-- Why a token stopped being usable. An enum rather than free text so a
-- typo cannot silently create an unknown revocation reason.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_revoked_reason_valid;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revoked_reason_valid CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN (
      'rotated',        -- superseded by its successor (normal)
      'logout',         -- the user signed out
      'reuse_detected', -- an already-revoked token was replayed
      'expired',        -- past expires_at at time of use
      'revoked'         -- administrative / password change
    )
  );

-- A revoked token must say why; a live one must not claim a reason.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_revocation_complete;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  );

-- ---------------------------------------------------------------
--  Binding a session to a password generation
-- ---------------------------------------------------------------
-- Snapshot of users.token_version at issue time. A password change bumps
-- token_version, which invalidates every outstanding session immediately
-- rather than waiting for the access token to expire.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------
--  The digest contract
-- ---------------------------------------------------------------
-- `token_hash` holds a hex SHA-256, so it is always 64 lowercase hex
-- characters. Enforcing it here means a truncated or wrongly-encoded
-- digest can never be stored, which would otherwise silently break
-- lookup and lock the user out.
ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_hash_format;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------
--  Session metadata
-- ---------------------------------------------------------------
-- Lets a user see where their sessions are from, and gives an operator
-- something to look at when investigating reuse detection. Bounded so a
-- hostile User-Agent cannot bloat the table.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS ip inet;

ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_user_agent_length;
ALTER TABLE refresh_tokens
  ADD CONSTRAINT refresh_tokens_user_agent_length
    CHECK (user_agent IS NULL OR char_length(user_agent) <= 512);

-- ---------------------------------------------------------------
--  Indexes for the two hot paths
-- ---------------------------------------------------------------
-- Reuse detection: "revoke this whole family".
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx
  ON refresh_tokens (family_id)
  WHERE revoked_at IS NULL;

-- Scheduled cleanup of expired tokens.
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx
  ON refresh_tokens (expires_at);

-- Listing a user's active sessions. The existing user index covers the
-- revoked_at IS NULL case for (user_id); this one serves the
-- "sessions per user" view used when revoking everything.

-- ---------------------------------------------------------------
--  Row Level Security
-- ---------------------------------------------------------------
-- Already enabled in 013; re-asserted here because this migration
-- adds columns to that table and a table recreated without the flag
-- would silently expose token hashes.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- ==========================================================================
--  015_directory_indexes.sql
-- ==========================================================================
-- ============================================================
--  015_directory_indexes.sql — indexes for the doctor directory
--
--  Phase 2 added `doctors_specialty_facility_idx` on
--  (specialty_id, facility_id). That serves a specialty prefix, so
--  counting or listing doctors per specialty is already covered.
--  It cannot serve a *facility-only* lookup, because facility_id is the
--  second column and is therefore unusable as a leading predicate.
--
--  The directory now filters by facility (`GET /api/doctors?facilityId=`),
--  lists the doctors at a facility, and counts doctors per facility, so the
--  leading-column index is needed.
-- ============================================================

CREATE INDEX IF NOT EXISTS doctors_facility_idx
  ON doctors (facility_id);

-- Doctor lists are always read with the account row for the display name, and
-- filtered on the account being active. A composite index lets that join be
-- satisfied from the index for the common case of browsing a facility.
CREATE INDEX IF NOT EXISTS doctors_facility_active_idx
  ON doctors (facility_id, is_accepting_new);

-- Facility lists are ordered by name and filtered by city. The existing
-- facilities_city_idx covers the filter; this covers the sort-then-slice that
-- a paginated facility list performs.
CREATE INDEX IF NOT EXISTS facilities_city_name_idx
  ON facilities (city, name);

-- The facility list matches the city case-insensitively (`lower(f.city) =
-- lower($1)`), because cities are user-entered and "bengaluru" and
-- "Bengaluru" must both find the same clinic. A plain index on `city` cannot
-- serve a `lower(city)` predicate, so that filter was a sequential scan on
-- every request. This expression index matches the query exactly.
CREATE INDEX IF NOT EXISTS facilities_city_lower_idx
  ON facilities (lower(city));

-- ==========================================================================
--  016_facility_city_lower_index.sql
-- ==========================================================================
-- ============================================================
--  016_facility_city_lower_index.sql
--
--  The facility list matches the city case-insensitively:
--
--      WHERE lower(f.city) = lower($1)
--
--  because cities are user-entered, and "bengaluru" and "Bengaluru" must
--  both find the same clinic.
--
--  015 added facilities_city_name_idx on (city, name). An index on the raw
--  column cannot serve a lower(city) predicate, so the city filter still
--  fell back to a sequential scan on every request.
--
--  Verified by src/db/scripts/verify-schema.js, which disables sequential
--  scans and asserts this predicate becomes index-servable.
--
--  This is a separate migration rather than an edit to 015 because applied
--  migrations are immutable: a database that already ran 015 would never see
--  the change otherwise.
-- ============================================================

CREATE INDEX IF NOT EXISTS facilities_city_lower_idx
  ON facilities (lower(city));

-- ==========================================================================
--  017_queue_room.sql
-- ==========================================================================
-- ============================================================
--  017_queue_room.sql — one waiting room per doctor per clinic day
--
--  WHY THIS EXISTS
--  A queue entry belonged to a SLOT, and a slot holds exactly one active
--  appointment (appointments_one_active_per_slot, migration 008). Position was
--  therefore allocated and enforced per slot:
--
--      join():  COALESCE(max(position),0)+1
--               WHERE slot_id = $1 AND state = 'waiting'
--      index:   UNIQUE (slot_id, position) WHERE state = 'waiting'
--
--  One appointment per slot means one entry per slot, so max(position) over a
--  set of at most one row is always that row's 1, and the unique index makes a
--  second position impossible. Every position in the system was 1. That is a
--  scoping bug, not an arithmetic one, and it was reproduced with three patients
--  waiting in one doctor-day, all reported at position 1.
--
--  The waiting room is really ONE ROOM PER DOCTOR PER CLINIC DAY. Patients hold
--  separate appointment slots, but they all wait for the same person, so their
--  order must come from when they ARRIVED, not from which slot they hold.
--
--  WHAT CHANGES HERE
--  `clinic_date` names the room an entry belongs to, so the room is a real,
--  indexable key rather than something recomputed per query.
--
--  WHAT DELIBERATELY DOES NOT CHANGE
--  * `queue_entries.position` is KEPT. It is now legacy: written for the old
--    per-slot readers, never used to rank the room. Dropping it is a separate,
--    later migration, once every reader has moved to the computed position.
--  * `queue_unique_position` is KEPT, for the same reason. It still guarantees
--    the legacy column stays sane for anything still reading it.
--  * Every appointment constraint is untouched: one active appointment per slot,
--    no overlapping slots for a doctor, no overlapping appointments for a
--    patient. A waiting room is about presence in the room, not slot ownership,
--    so none of them needed to move.
--  * Row-level security is untouched (queue_entries was already enabled in 013).
--
--  ROLLBACK
--  This project applies migrations forward only; there is no `down`, and
--  `--reset` is a destructive DROP SCHEMA CASCADE. This file is therefore NOT
--  reversible in place. Recovery is the pre-migration backup described in the
--  README: restore the dump taken before applying, then redeploy the previous
--  code. The additive steps below are safe to leave in place on their own,
--  because nothing reads `clinic_date` until the code that accompanies it ships.
-- ============================================================

-- ------------------------------------------------------------
--  1. Name the room each entry belongs to
-- ------------------------------------------------------------
--  Nullable first, so the backfill below can be verified before anything
--  becomes mandatory.
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS clinic_date date;

--  Asia/Kolkata is APP_TIMEZONE's default and the zone the repositories label
--  slots with (repositories/base.js DATE_EXPR). A migration is a static file and
--  cannot read the environment, so the verified value is named here and
--  verify-schema.js asserts that stored clinic_date still agrees with the
--  repository expression — so a deployment that changes APP_TIMEZONE fails a
--  check rather than silently mis-dating rooms.
UPDATE queue_entries q
   SET clinic_date = to_char(sl.starts_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')::date
  FROM slots sl
 WHERE sl.id = q.slot_id
   AND q.clinic_date IS NULL;

--  Refuse to continue rather than leave a partially dated table. Every entry
--  references a slot with ON DELETE CASCADE, so this should be impossible; the
--  check turns "impossible" into a failed migration instead of a silent NULL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM queue_entries WHERE clinic_date IS NULL) THEN
    RAISE EXCEPTION
      'queue_entries rows could not be assigned a clinic_date; the table is unchanged';
  END IF;
END $$;

ALTER TABLE queue_entries ALTER COLUMN clinic_date SET NOT NULL;

-- ------------------------------------------------------------
--  2. At most one consultation at a time, per doctor-day
-- ------------------------------------------------------------
--  This is the database backstop for a double "call next". Application logic
--  promotes a patient inside a transaction under the room's advisory lock; this
--  index makes it structurally impossible for two rows to be in consultation in
--  the same room, whoever writes them.
--
--  Validated before creation rather than discovered by a failed CREATE INDEX.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT q.doctor_id || ' @ ' || q.clinic_date::text, ', ')
    INTO offenders
    FROM queue_entries q
   WHERE q.state = 'in-consultation'
   GROUP BY q.doctor_id, q.clinic_date
  HAVING count(*) > 1
  LIMIT 1;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot add the single-consultation rule; these doctor-days already have more than one: %',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS queue_one_active_consultation
  ON queue_entries (doctor_id, clinic_date)
  WHERE state = 'in-consultation';

-- ------------------------------------------------------------
--  3. Ordering for the room
-- ------------------------------------------------------------
--  `joined_at ASC, id ASC` is the arrival order, and `id` makes it total: two
--  patients checked in in the same millisecond still have a defined order. This
--  deliberately is NOT slot start time — a patient who arrived early for a later
--  slot waits behind an on-time patient for an earlier one, which is what a
--  waiting room actually is.
CREATE INDEX IF NOT EXISTS queue_room_order
  ON queue_entries (doctor_id, clinic_date, joined_at, id);

--  The consultation lookup is on its own predicate and is the hot path for
--  "call next", which reads it before deciding whether to promote anyone.
CREATE INDEX IF NOT EXISTS queue_room_active_consultation
  ON queue_entries (doctor_id, clinic_date, joined_at, id)
  WHERE state = 'in-consultation';

-- ==========================================================================
--  018_notification_dedupe.sql
-- ==========================================================================
-- ============================================================
--  018_notification_dedupe.sql — Phase 10 notification plumbing
-- ============================================================
--
--  Everything here is additive. Nothing is dropped and nothing
--  existing is rewritten.
--
--  WHY A dedupe_key
--  ----------------
--  A notification is written inside the same transaction as the
--  change that caused it. That is what makes it reliable, and it
--  also means a RETRIED REQUEST writes the message again: a patient
--  double-tapping "Confirm", or a client retrying a request that
--  actually succeeded the first time, produced two identical rows.
--
--  Application-level "have I told them this?" checks do not fix
--  that. Two concurrent transactions both read "not yet sent", both
--  insert, and both commit - the check was not atomic.
--
--  So the uniqueness is pushed into the database, where two
--  concurrent inserts of the same logical event cannot both win:
--  the second one violates the index and is discarded. That is the
--  only version of this guarantee that survives concurrency.
--
--  WHY IT IS PARTIAL AND NULLABLE
--  -----------------------------
--  A notification with no dedupe key is deliberately never
--  deduplicated, so an operator-driven or one-off message still
--  works. Making the column NOT NULL would force every caller to
--  invent a key and would silently collapse legitimate repeats.
--
--  The key is built by notificationService and includes whatever
--  distinguishes one genuine occurrence from another: the new slot
--  for a reschedule, the new start time for a reminder, the call
--  time for a queue call. A patient called, marked no-show, and
--  called again is two real events and gets two messages; the same
--  request retried three times is one.
-- ============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Partial UNIQUE, so the many key-less rows cannot collide with
-- each other and NULLs never compare equal anyway.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uniq
  ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- The outbox drain asks "what has been sitting in 'queued' longest,
-- and was it ever attempted?". This supports that directly instead
-- of scanning the table.
CREATE INDEX IF NOT EXISTS deliveries_drain_idx
  ON notification_deliveries (status, attempted_at)
  WHERE status = 'queued';

-- One row per notification, so a drain can tell "this message is
-- finished" without re-counting its channels.
CREATE INDEX IF NOT EXISTS notifications_appointment_event_idx
  ON notifications (appointment_id, event)
  WHERE appointment_id IS NOT NULL;

-- ============================================================
--  Sweep bookkeeping
-- ============================================================
--
--  Reminders and outbox draining now run on a timer rather than
--  only when an administrator remembers to POST the endpoint. A
--  timer that fails silently is indistinguishable from a timer
--  that never ran, so each pass records what it did. That is also
--  what makes "did the reminder fire twice?" a question the
--  database can answer.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_sweeps (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  processed       integer NOT NULL DEFAULT 0,
  skipped         integer NOT NULL DEFAULT 0,
  failed          integer NOT NULL DEFAULT 0,
  notes           text,

  CONSTRAINT sweep_kind_valid CHECK (kind IN ('reminders', 'outbox', 'manual'))
);

CREATE INDEX IF NOT EXISTS notification_sweeps_recent_idx
  ON notification_sweeps (kind, started_at DESC);

-- ============================================================
--  Assistant conversation log
-- ============================================================
--
--  Every assistant exchange is recorded so that "what did we send
--  to the model, and what came back" is auditable rather than a
--  matter of trusting the log files.
--
--  Two deliberate omissions, and they are the point of the table:
--
--    * NO user id and NO appointment id. The assistant is not
--      allowed to know who is asking about what, so this row
--      cannot leak a patient's question to anyone reading it.
--    * NO raw model output beyond a bounded excerpt. Model text is
--      untrusted input as far as storage is concerned, and an
--      unbounded column is an invitation to store something
--      enormous.
--
--  `intent` and `sourced_from` are the auditable part: they say
--  which handler answered, and whether the answer came from the
--  application's own knowledge base or from the model.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_assistant_turns (
  id           bigserial PRIMARY KEY,
  role         text NOT NULL,
  intent       text,
  provider     text NOT NULL,
  -- Which surface answered: "knowledge-base" or "model".
  sourced_from text NOT NULL DEFAULT 'knowledge-base',
  question     text NOT NULL,
  answer       text NOT NULL,
  latency_ms   integer,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assistant_role_valid CHECK (role IN ('patient', 'doctor', 'admin')),
  CONSTRAINT assistant_sourced_valid CHECK (sourced_from IN ('knowledge-base', 'model')),
  -- A refusal still gets a row, so attempts to bend the assistant
  -- are visible rather than silent.
  CONSTRAINT assistant_question_present CHECK (char_length(btrim(question)) > 0),
  CONSTRAINT assistant_answer_present CHECK (char_length(btrim(answer)) > 0)
);

CREATE INDEX IF NOT EXISTS ai_assistant_turns_recent_idx
  ON ai_assistant_turns (created_at DESC);

CREATE INDEX IF NOT EXISTS ai_assistant_turns_intent_idx
  ON ai_assistant_turns (intent, created_at DESC);

-- ==========================================================================
--  019_supabase_rls.sql
-- ==========================================================================
-- ============================================================
--  019_supabase_rls.sql — RLS coverage and anon-key policies
--
--  WHY THIS EXISTS
--  ---------------
--  Supabase publishes every table in schema `public` over HTTP
--  (PostgREST) to three built-in roles: `anon` (nobody signed in),
--  `authenticated` (Supabase Auth — unused by this project) and
--  `service_role`. Supabase grants all of them table privileges by
--  default, so RLS is the only thing between the anon key — which is
--  designed to be shipped inside a browser bundle — and the data.
--
--  013 enabled RLS on 16 of the 23 tables. The seven it missed are
--  not equally sensitive, but every one of them is fully readable
--  while RLS is off, and `users` holds password hashes. The Supabase
--  dashboard raises that as a critical advisory. This migration closes
--  the gap and states the invariant the verification suite now asserts:
--
--      EVERY table in schema public has RLS enabled.
--
--  WHAT THE ANON KEY MAY READ
--  --------------------------
--  Exactly the tables this API serves without a session (see the
--  public section of src/routes/doctorRoutes.js): the clinic directory
--  and the bookable calendar. Those get `FOR SELECT ... USING (true)`;
--  no INSERT / UPDATE / DELETE is granted to any non-owner role —
--  writes go through the Express API, which connects over DATABASE_URL
--  as the table owner.
--
--  WHY THERE ARE NO USER-SCOPED POLICIES
--  -------------------------------------
--  This project authenticates with its own JWTs, so Supabase's
--  `auth.uid()` is never populated and a policy keyed on it could
--  never match. A patient still sees only their own rows — that is
--  enforced in the service layer — and not by handing the anon key a
--  policy it cannot use.
--
--  PORTABILITY
--  -----------
--  The policy block is guarded on the Supabase roles existing, so a
--  plain PostgreSQL server (or the bundled local one) applies this
--  file as documented no-ops with a NOTICE instead of failing on an
--  unknown role.
-- ============================================================

-- ------------------------------------------------------------
--  1. RLS on every table that did not have it
-- ------------------------------------------------------------
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_services     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_sweeps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_assistant_turns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE seed_metadata       ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations   ENABLE ROW LEVEL SECURITY;

-- Re-assert the seven public tables. 013 already enabled these, but a
-- policy on a table without RLS would be silently permissive, so the
-- switch is stated next to the policies it protects.
ALTER TABLE specialties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE services         ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_languages ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots            ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
--  2. Supabase roles: read the public directory, write nothing
-- ------------------------------------------------------------
DO $supabase_rls$
DECLARE
  tbl text;
  -- The tables the API serves before sign-in. Anything not listed here
  -- keeps RLS with no policy: zero rows for anon and authenticated.
  public_read_tables text[] := ARRAY[
    'specialties',
    'facilities',
    'services',
    'doctors',
    'doctor_services',
    'doctor_languages',
    'slots'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE
      'Supabase roles anon/authenticated are not present; public read policies skipped (plain PostgreSQL)';
    RETURN;
  END IF;

  -- Defense in depth on top of deny-by-default RLS: even if a policy
  -- were later added carelessly, these roles hold no write privilege.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
    FROM anon, authenticated;

  -- Future tables created by this project's migrations should not be
  -- born writable by the anon key either.
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon, authenticated;

  GRANT USAGE ON SCHEMA public TO anon, authenticated;

  FOREACH tbl IN ARRAY public_read_tables LOOP
    -- CREATE POLICY has no IF NOT EXISTS; replace so this is re-runnable.
    EXECUTE format('DROP POLICY IF EXISTS supabase_public_read ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY supabase_public_read ON public.%I FOR SELECT TO anon, authenticated USING (true)',
      tbl
    );
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO anon, authenticated', tbl);
  END LOOP;

  RAISE NOTICE 'Supabase roles detected: public read policies applied to % tables',
    array_length(public_read_tables, 1);
END
$supabase_rls$;

-- ==========================================================================
--  020_notification_deletion.sql
-- ==========================================================================
-- ============================================================
--  020_notification_deletion.sql — a dismissal the reader can take back
--
--  Swiping a message away is not a request for it to be destroyed; it is a
--  request for it to stop being in the way. Those are different requests and
--  a hard DELETE can only honour one of them — the instant it commits the
--  message is gone for good, a mis-tap is unrecoverable, and the inbox is
--  silently shorter with no way back.
--
--  So the dismissal is SOFT: `deleted_at` is stamped and every inbox query
--  stops asking for rows that carry it. The row survives, which is what makes
--  undo an un-stamp rather than a reconstruction — and reconstruction is not
--  possible anyway, because the row's delivery history belongs to channels
--  this client cannot see.
--
--  Two things it deliberately does NOT do:
--
--    * It does not cascade to `notification_deliveries`. Those rows are the
--      dispatch audit trail; a dismissed message was still sent, and the proof
--      of that belongs to the platform rather than to the reader's screen.
--      This is also why the admin log keeps showing dismissed messages while
--      the patient inbox does not.
--
--    * It does not release `dedupe_key`. The key identifies an EVENT that
--      occurred, and it still occurred; letting a dismissal free the key would
--      mean one retried booking could send the same message twice.
-- ============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The inbox reads (user_id, created_at DESC) and must skip dismissed rows.
-- As a partial index of notifications_user_idx it can satisfy filter AND order
-- from the index alone, and it shrinks every time the reader clears their
-- inbox — which is the only thing that ever grows this table unboundedly.
CREATE INDEX IF NOT EXISTS notifications_live_idx
  ON notifications (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Undo restores the whole inbox in one statement, so the filter needs the
-- partial index on the dismissed side too.
CREATE INDEX IF NOT EXISTS notifications_deleted_idx
  ON notifications (user_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

-- ==========================================================================
--  BOOKKEEPING — record this schema revision as applied
--
--  This keeps the applied state auditable: `schema_migrations` says which
--  revision a database is on, and re-running the file records nothing new.
--
--  duration_ms is 0 because the single-file apply is not per-migration;
--  the real number is not known, and inventing one would be worse than a
--  documented zero.
-- ==========================================================================

INSERT INTO schema_migrations (filename) VALUES
  ('001_extensions.sql'),
  ('002_enums.sql'),
  ('003_identity.sql'),
  ('004_reference_data.sql'),
  ('005_doctors.sql'),
  ('006_doctor_links.sql'),
  ('007_slots.sql'),
  ('008_appointments.sql'),
  ('009_appointment_status_history.sql'),
  ('010_queue.sql'),
  ('011_notifications.sql'),
  ('012_audit_triage.sql'),
  ('013_rls.sql'),
  ('014_refresh_token_rotation.sql'),
  ('015_directory_indexes.sql'),
  ('016_facility_city_lower_index.sql'),
  ('017_queue_room.sql'),
  ('018_notification_dedupe.sql'),
  ('019_supabase_rls.sql'),
  ('020_notification_deletion.sql')
ON CONFLICT (filename) DO NOTHING;
