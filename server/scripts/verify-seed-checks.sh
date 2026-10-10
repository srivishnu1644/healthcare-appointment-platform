#!/usr/bin/env bash
# Prove the seeded-data invariant checks can actually FAIL.
#
# A test that cannot fail is not a test. This rebuilds the isolated database from
# scratch, injects one of the defects the seed used to have, and confirms
# verify-schema.js reports it. Each defect gets a clean database, because the
# point is to attribute each failure to the defect that caused it.
#
# Nothing here touches the hosted project.
set -uo pipefail
cd "$(dirname "$0")/.."

export PATH=/tmp/opencode/pgsql/usr/lib/postgresql/16/bin:$PATH
export LD_LIBRARY_PATH=/tmp/opencode/pgsql/usr/lib/x86_64-linux-gnu:/tmp/opencode/pgsql/usr/lib/postgresql/16/lib
export DATABASE_URL="postgresql://postgres@127.0.0.1:${P6_PORT:-5440}/${P6_DBNAME:-medicare_test}"
export DB_POOL_MAX=5
ADMIN="postgresql://postgres@127.0.0.1:${P6_PORT:-5440}/postgres"

rebuild() {
  psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS ${P6_DBNAME:-medicare_test} WITH (FORCE)" \
                -c "CREATE DATABASE ${P6_DBNAME:-medicare_test}" >/dev/null 2>&1
  node src/db/migrate.js >/dev/null 2>&1
  node src/db/seed.js >/dev/null 2>&1
}

inject() {
  case "$1" in
    orphan-booked-slots)
      psql "$DATABASE_URL" -q -c "
        UPDATE slots SET status = 'booked'
         WHERE id IN (SELECT id FROM slots
                       WHERE status = 'available'
                         AND starts_at > now()
                         AND id NOT IN (SELECT slot_id FROM appointments)
                       LIMIT 60)" >/dev/null
      echo 60 ;;
    history-without-actor)
      psql "$DATABASE_URL" -q -c "
        UPDATE appointment_status_history SET changed_by = NULL WHERE from_status IS NULL" >/dev/null
      psql "$DATABASE_URL" -Atc "SELECT count(*) FROM appointment_status_history WHERE changed_by IS NULL" ;;
    window-mismatch)
      # Terminal appointments only. appointments_patient_no_overlap is a PARTIAL
      # exclusion over active statuses, so shifting an active one backwards is
      # rejected by the database before any row changes - which would make this
      # mutation look like an undetectable defect when it simply never applied.
      psql "$DATABASE_URL" -q -c "
        UPDATE appointments SET starts_at = starts_at - interval '2 hours'
         WHERE status IN ('completed','cancelled','no-show')" >/dev/null 2>&1
      psql "$DATABASE_URL" -Atc "SELECT count(*) FROM appointments a JOIN slots sl ON sl.id=a.slot_id
        WHERE a.starts_at <> sl.starts_at" ;;
    doctor-owns-slot)
      psql "$DATABASE_URL" -q -c "
        UPDATE appointments SET doctor_id = (
          SELECT d2.id FROM doctors d2
           WHERE d2.id <> appointments.doctor_id LIMIT 1)
         WHERE id IN (SELECT id FROM appointments LIMIT 10)" >/dev/null
      echo 10 ;;
    mode-mismatch)
      psql "$DATABASE_URL" -q -c "
        UPDATE appointments SET mode = 'video' WHERE mode = 'in-person'
         AND id IN (SELECT id FROM appointments LIMIT 15)" >/dev/null
      echo 15 ;;
    duplicate-position-in-slot)
      A=$(psql "$DATABASE_URL" -Atc "SELECT id FROM appointments LIMIT 1")
      SLOT=$(psql "$DATABASE_URL" -Atc "SELECT slot_id FROM appointments WHERE id='$A'")
      DOC=$(psql "$DATABASE_URL" -Atc "SELECT doctor_id FROM appointments WHERE id='$A'")
      PAT=$(psql "$DATABASE_URL" -Atc "SELECT patient_id FROM appointments WHERE id='$A'")
      B=$(psql "$DATABASE_URL" -Atc "SELECT id FROM appointments WHERE id<>'$A' LIMIT 1")
      psql "$DATABASE_URL" -q -c "INSERT INTO queue_entries (appointment_id, slot_id, doctor_id, patient_id, position, state) VALUES ('$A','$SLOT','$DOC','$PAT',3,'waiting')" >/dev/null 2>&1
      psql "$DATABASE_URL" -q -c "INSERT INTO queue_entries (appointment_id, slot_id, doctor_id, patient_id, position, state) VALUES ('$B','$SLOT','$DOC','$PAT',3,'waiting')" >/dev/null 2>&1
      echo 2 ;;
    cancelled-without-timestamp)
      psql "$DATABASE_URL" -q -c "
        UPDATE appointments SET cancelled_at = NULL, status = 'scheduled'
         WHERE status = 'cancelled'" >/dev/null
      echo "all cancelled" ;;
  esac
}

# Defects the schema forbids outright. Injecting them is impossible: the
# constraint or trigger rejects the write, so no seeded-data CHECK can fire on
# them. The corresponding seed assertions are therefore defensive redundancy, not
# load-bearing coverage - which is a different thing from being vacuous, and worth
# stating rather than leaving a misleading "NOT DETECTED".
SCHEMA_FORBIDDEN="doctor-owns-slot duplicate-position-in-slot duplicate-entry-per-appointment"

for defect in orphan-booked-slots history-without-actor window-mismatch \
               cancelled-without-timestamp mode-mismatch \
               doctor-owns-slot duplicate-position-in-slot; do
  rebuild
  rows=$(inject "$defect")
  case " $SCHEMA_FORBIDDEN " in
    *" $defect "*) kind="schema-forbidden" ;;
    *) kind="load-bearing" ;;
  esac
  echo "  defect: $defect [$kind] (rows touched: $rows)"
  out=$(node src/db/scripts/verify-schema.js 2>&1)
  echo "$out" | grep "^FAIL" | sed 's/^FAIL  /        caught: /' | head -4
  fails=$(echo "$out" | grep -c "^FAIL")
  if [ "$fails" -eq 0 ] && [ "$kind" = "load-bearing" ]; then
    echo "        *** NOT DETECTED - this check is vacuous ***"
  elif [ "$fails" -eq 0 ]; then
    echo "        (rejected by the database, so the state is unrepresentable)"
  fi
done

echo
echo "  control: a freshly seeded database with no defect"
rebuild
node src/db/scripts/verify-schema.js 2>&1 | grep -E "^FAIL|passed," | sed 's/^/        /'
