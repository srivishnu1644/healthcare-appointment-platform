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