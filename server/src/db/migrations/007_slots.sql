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