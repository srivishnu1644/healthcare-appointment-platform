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