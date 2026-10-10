-- ============================================================
--  006_doctor_links.sql — many-to-many doctor relations
--
--  Split out from 004 so the foreign keys have a `doctors` table to
--  reference.
-- ============================================================

-- Replaces the doctors.serviceIds[] array, which was unindexable and
-- therefore unfilterable.
CREATE TABLE doctor_services (
  doctor_id  text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  service_id text NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  PRIMARY KEY (doctor_id, service_id)
);

CREATE INDEX doctor_services_service_idx ON doctor_services (service_id);

-- Replaces the doctors.languages[] array, so `?language=Hindi` becomes an
-- indexed lookup instead of a JavaScript array scan.
CREATE TABLE doctor_languages (
  doctor_id text NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  language  text NOT NULL,
  PRIMARY KEY (doctor_id, language)
);

CREATE INDEX doctor_languages_lang_idx ON doctor_languages (lower(language));