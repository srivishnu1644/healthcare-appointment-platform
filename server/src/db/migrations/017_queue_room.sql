-- ============================================================
--  017_queue_room.sql — one waiting room per doctor per clinic day
--
--  WHY THIS EXISTS
--  A queue entry belonged to a SLOT, and a slot holds exactly one active
--  appointment (appointments_one_active_per_slot, migration 008). Position was
--  therefore allocated and enforced per slot:
--
--      join():  COALESCE(max(position),0)+1
--               WHERE slot_id = $1 AND state = 'waiting'
--      index:   UNIQUE (slot_id, position) WHERE state = 'waiting'
--
--  One appointment per slot means one entry per slot, so max(position) over a
--  set of at most one row is always that row's 1, and the unique index makes a
--  second position impossible. Every position in the system was 1. That is a
--  scoping bug, not an arithmetic one, and it was reproduced with three patients
--  waiting in one doctor-day, all reported at position 1.
--
--  The waiting room is really ONE ROOM PER DOCTOR PER CLINIC DAY. Patients hold
--  separate appointment slots, but they all wait for the same person, so their
--  order must come from when they ARRIVED, not from which slot they hold.
--
--  WHAT CHANGES HERE
--  `clinic_date` names the room an entry belongs to, so the room is a real,
--  indexable key rather than something recomputed per query.
--
--  WHAT DELIBERATELY DOES NOT CHANGE
--  * `queue_entries.position` is KEPT. It is now legacy: written for the old
--    per-slot readers, never used to rank the room. Dropping it is a separate,
--    later migration, once every reader has moved to the computed position.
--  * `queue_unique_position` is KEPT, for the same reason. It still guarantees
--    the legacy column stays sane for anything still reading it.
--  * Every appointment constraint is untouched: one active appointment per slot,
--    no overlapping slots for a doctor, no overlapping appointments for a
--    patient. A waiting room is about presence in the room, not slot ownership,
--    so none of them needed to move.
--  * Row-level security is untouched (queue_entries was already enabled in 013).
--
--  ROLLBACK
--  This project applies migrations forward only; there is no `down`, and
--  `--reset` is a destructive DROP SCHEMA CASCADE. This file is therefore NOT
--  reversible in place. Recovery is the pre-migration backup described in the
--  README: restore the dump taken before applying, then redeploy the previous
--  code. The additive steps below are safe to leave in place on their own,
--  because nothing reads `clinic_date` until the code that accompanies it ships.
-- ============================================================

-- ------------------------------------------------------------
--  1. Name the room each entry belongs to
-- ------------------------------------------------------------
--  Nullable first, so the backfill below can be verified before anything
--  becomes mandatory.
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS clinic_date date;

--  Asia/Kolkata is APP_TIMEZONE's default and the zone the repositories label
--  slots with (repositories/base.js DATE_EXPR). A migration is a static file and
--  cannot read the environment, so the verified value is named here and
--  verify-schema.js asserts that stored clinic_date still agrees with the
--  repository expression — so a deployment that changes APP_TIMEZONE fails a
--  check rather than silently mis-dating rooms.
UPDATE queue_entries q
   SET clinic_date = to_char(sl.starts_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')::date
  FROM slots sl
 WHERE sl.id = q.slot_id
   AND q.clinic_date IS NULL;

--  Refuse to continue rather than leave a partially dated table. Every entry
--  references a slot with ON DELETE CASCADE, so this should be impossible; the
--  check turns "impossible" into a failed migration instead of a silent NULL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM queue_entries WHERE clinic_date IS NULL) THEN
    RAISE EXCEPTION
      'queue_entries rows could not be assigned a clinic_date; the table is unchanged';
  END IF;
END $$;

ALTER TABLE queue_entries ALTER COLUMN clinic_date SET NOT NULL;

-- ------------------------------------------------------------
--  2. At most one consultation at a time, per doctor-day
-- ------------------------------------------------------------
--  This is the database backstop for a double "call next". Application logic
--  promotes a patient inside a transaction under the room's advisory lock; this
--  index makes it structurally impossible for two rows to be in consultation in
--  the same room, whoever writes them.
--
--  Validated before creation rather than discovered by a failed CREATE INDEX.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(DISTINCT q.doctor_id || ' @ ' || q.clinic_date::text, ', ')
    INTO offenders
    FROM queue_entries q
   WHERE q.state = 'in-consultation'
   GROUP BY q.doctor_id, q.clinic_date
  HAVING count(*) > 1
  LIMIT 1;

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'cannot add the single-consultation rule; these doctor-days already have more than one: %',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS queue_one_active_consultation
  ON queue_entries (doctor_id, clinic_date)
  WHERE state = 'in-consultation';

-- ------------------------------------------------------------
--  3. Ordering for the room
-- ------------------------------------------------------------
--  `joined_at ASC, id ASC` is the arrival order, and `id` makes it total: two
--  patients checked in in the same millisecond still have a defined order. This
--  deliberately is NOT slot start time — a patient who arrived early for a later
--  slot waits behind an on-time patient for an earlier one, which is what a
--  waiting room actually is.
CREATE INDEX IF NOT EXISTS queue_room_order
  ON queue_entries (doctor_id, clinic_date, joined_at, id);

--  The consultation lookup is on its own predicate and is the hot path for
--  "call next", which reads it before deciding whether to promote anyone.
CREATE INDEX IF NOT EXISTS queue_room_active_consultation
  ON queue_entries (doctor_id, clinic_date, joined_at, id)
  WHERE state = 'in-consultation';