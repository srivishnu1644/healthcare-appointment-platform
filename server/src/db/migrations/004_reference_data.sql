-- ============================================================
--  004_reference_data.sql — specialties, facilities, services
--
--  These become the authoritative source for the names that were
--  previously denormalised onto every doctor and appointment row
--  (doctors.specialtyName, doctors.facilityName, doctors.city,
--  doctors.address, appointments.doctorName, ...).
--
--  Those columns are dropped here and re-derived by JOIN, so a rename
--  or re-assignment no longer requires touching every row.
-- ============================================================

CREATE TABLE specialties (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  icon        text,

  CONSTRAINT specialties_name_not_blank CHECK (char_length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX specialties_name_key ON specialties (lower(name));
CREATE UNIQUE INDEX specialties_slug_key ON specialties (slug);

CREATE TABLE facilities (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          text NOT NULL,
  city          text NOT NULL,
  address       text NOT NULL,
  type          text,
  phone         text,
  open_hours    text,
  rating        numeric(2,1),
  queue_enabled boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT facilities_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT facilities_rating_range CHECK (rating IS NULL OR rating BETWEEN 0 AND 5)
);

CREATE UNIQUE INDEX facilities_name_key ON facilities (lower(name));
CREATE INDEX facilities_city_idx ON facilities (city);

CREATE TABLE services (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name             text NOT NULL,
  description      text,
  duration_minutes integer NOT NULL,
  price            numeric(10,2) NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'INR',

  CONSTRAINT services_name_not_blank CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT services_duration_range CHECK (duration_minutes BETWEEN 5 AND 480),
  CONSTRAINT services_price_non_negative CHECK (price >= 0)
);

CREATE UNIQUE INDEX services_name_key ON services (lower(name));

-- NOTE: doctor_services and doctor_languages live in 006, after `doctors`
-- exists, because a foreign key cannot reference a table that has not been
-- created yet.