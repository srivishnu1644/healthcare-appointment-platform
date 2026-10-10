-- ============================================================
--  002_enums.sql — domain enumerations
--
--  Replaces the free-form status strings that were previously only
--  validated in some Express routes and unvalidated in others.
--  An invalid status is now impossible to store rather than merely
--  discouraged by application code.
-- ============================================================

-- user_role replaces the 'patient' | 'doctor' | 'admin' free text,
-- and eliminates the 'provider' alias that registration previously
-- mapped onto the privileged 'doctor' role.
CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');

CREATE TYPE consult_mode AS ENUM ('in-person', 'video');

CREATE TYPE slot_status AS ENUM ('available', 'booked', 'blocked');

CREATE TYPE appt_status AS ENUM (
  'scheduled',
  'confirmed',
  'in-progress',
  'completed',
  'cancelled',
  'no-show'
);

CREATE TYPE queue_state AS ENUM ('waiting', 'in-consultation', 'completed', 'left');

CREATE TYPE notify_channel AS ENUM ('in-app', 'sms', 'email');

CREATE TYPE delivery_status AS ENUM ('queued', 'sent', 'delivered', 'failed', 'simulated');

-- Which side cancelled. Was previously a bare role string
-- ('provider' | 'admin' | 'patient') stored on the appointment.
CREATE TYPE cancelled_by_role AS ENUM ('patient', 'provider', 'admin', 'system');