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