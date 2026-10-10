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