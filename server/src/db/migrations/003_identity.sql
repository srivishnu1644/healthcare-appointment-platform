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