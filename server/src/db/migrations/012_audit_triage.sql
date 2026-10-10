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