-- ============================================================
--  015_directory_indexes.sql — indexes for the doctor directory
--
--  Phase 2 added `doctors_specialty_facility_idx` on
--  (specialty_id, facility_id). That serves a specialty prefix, so
--  counting or listing doctors per specialty is already covered.
--  It cannot serve a *facility-only* lookup, because facility_id is the
--  second column and is therefore unusable as a leading predicate.
--
--  The directory now filters by facility (`GET /api/doctors?facilityId=`),
--  lists the doctors at a facility, and counts doctors per facility, so the
--  leading-column index is needed.
-- ============================================================

CREATE INDEX IF NOT EXISTS doctors_facility_idx
  ON doctors (facility_id);

-- Doctor lists are always read with the account row for the display name, and
-- filtered on the account being active. A composite index lets that join be
-- satisfied from the index for the common case of browsing a facility.
CREATE INDEX IF NOT EXISTS doctors_facility_active_idx
  ON doctors (facility_id, is_accepting_new);

-- Facility lists are ordered by name and filtered by city. The existing
-- facilities_city_idx covers the filter; this covers the sort-then-slice that
-- a paginated facility list performs.
CREATE INDEX IF NOT EXISTS facilities_city_name_idx
  ON facilities (city, name);

-- The facility list matches the city case-insensitively (`lower(f.city) =
-- lower($1)`), because cities are user-entered and "bengaluru" and
-- "Bengaluru" must both find the same clinic. A plain index on `city` cannot
-- serve a `lower(city)` predicate, so that filter was a sequential scan on
-- every request. This expression index matches the query exactly.
CREATE INDEX IF NOT EXISTS facilities_city_lower_idx
  ON facilities (lower(city));