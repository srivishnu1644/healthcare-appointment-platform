-- ============================================================
--  013_rls.sql — Row Level Security
--
--  Supabase exposes Postgres over HTTP. Without RLS, a leaked anon key
--  can read every table, including patients' blood groups and allergies.
--
--  The Express API connects with the service-role key (or a direct
--  connection string) and enforces authorization in the service layer,
--  so the application is not blocked by these policies. They are
--  defence in depth: a leaked anon key still reads zero rows.
--
--  Enabling RLS with no policies is deny-by-default. Tables the client
--  will legitimately read directly later (none in Phase 2) would get
--  explicit policies.
-- ============================================================

-- Patient health data and messages: never readable by anon/authenticated.
ALTER TABLE patient_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_allergies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries      ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_sessions   ENABLE ROW LEVEL SECURITY;

-- Reference data is public: the doctor directory is browsable before
-- sign-in, exactly as the existing API intends.
ALTER TABLE specialties        ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE services           ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctor_languages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots              ENABLE ROW LEVEL SECURITY;

-- No policies are created, so the anon and authenticated roles match zero
-- rows in all of the above. The `public` role (which owns the tables when
-- running locally as the superuser) is unaffected, which keeps local
-- development and the API's service-role connection working.
--
-- Verified so far: src/db/scripts/verify-schema.js asserts that
-- pg_class.relrowsecurity is set on 16 tables. That proves RLS is enabled,
-- but NOT that an anon Supabase key reads zero rows -- that check needs a real
-- Supabase project and has not been run. Do it before exposing the project.