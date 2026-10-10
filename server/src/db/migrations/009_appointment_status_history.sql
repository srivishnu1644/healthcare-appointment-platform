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