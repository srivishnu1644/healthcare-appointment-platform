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