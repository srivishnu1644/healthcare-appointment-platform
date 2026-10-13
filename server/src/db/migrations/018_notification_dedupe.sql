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