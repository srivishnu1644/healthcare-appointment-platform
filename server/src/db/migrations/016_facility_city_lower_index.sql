-- ============================================================
--  016_facility_city_lower_index.sql
--
--  The facility list matches the city case-insensitively:
--
--      WHERE lower(f.city) = lower($1)
--
--  because cities are user-entered, and "bengaluru" and "Bengaluru" must
--  both find the same clinic.
--
--  015 added facilities_city_name_idx on (city, name). An index on the raw
--  column cannot serve a lower(city) predicate, so the city filter still
--  fell back to a sequential scan on every request.
--
--  Verified by src/db/scripts/verify-schema.js, which disables sequential
--  scans and asserts this predicate becomes index-servable.
--
--  This is a separate migration rather than an edit to 015 because applied
--  migrations are immutable: a database that already ran 015 would never see
--  the change otherwise.
-- ============================================================

CREATE INDEX IF NOT EXISTS facilities_city_lower_idx
  ON facilities (lower(city));