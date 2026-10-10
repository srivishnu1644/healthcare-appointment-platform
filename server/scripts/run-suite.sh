#!/usr/bin/env bash
# Run one check suite against a freshly created local PostgreSQL.
#
#   ./scripts/run-suite.sh slot-check.js
#
# The bundled local PostgreSQL serves exactly one client at a time. A suite that
# starts and SIGKILLs an API leaves the server holding a half-dead connection,
# and the next suite then fails with "Connection terminated unexpectedly" for
# reasons that have nothing to do with the code. Restarting the database between
# suites removes that whole class of confusing failure.
#
# Suites that support SPAWN=1 start and stop the API themselves. The older ones
# (security, smoke) only know how to talk to an already-running server, so for
# those this script starts one on port 5000 and shuts it down afterwards.
set -u
cd "$(dirname "$0")/.."

SUITE="$1"
shift || true

if [ ! -f "scripts/$SUITE" ]; then
  echo "no such suite: scripts/$SUITE"
  exit 1
fi

export DATABASE_URL=postgresql://postgres@localhost:5433/postgres
export DB_POOL_MAX=1

# A suite that signs its own tokens (auth-check mints an expired one on purpose)
# needs the same JWT_SECRET the API child process loads from .env, or every
# hand-made token fails verification. Read it without echoing it. dotenv never
# overrides a real environment variable, so this value also wins inside the API.
if [ -f .env ]; then
  JWT_SECRET=$(grep -E '^JWT_SECRET=' .env | tail -1 | cut -d= -f2-)
  if [ -n "$JWT_SECRET" ]; then
    export JWT_SECRET
  else
    echo "  warning: .env has no JWT_SECRET; a suite that signs tokens will fail"
  fi
fi

# Stop anything still holding a port we are about to reuse.
for p in $(ss -ltnp 2>/dev/null | grep -E ':(5433|5000|5095|5096|5097|5098|5099)' | grep -oP 'pid=\K[0-9]+' | sort -u); do
  kill -9 "$p" 2>/dev/null
done
sleep 2
rm -rf /tmp/medicare-pg
(setsid node scripts/local-postgres.js > /tmp/opencode/pg.log 2>&1 < /dev/null &)

for _ in $(seq 1 40); do
  grep -q "local PostgreSQL ready" /tmp/opencode/pg.log 2>/dev/null && break
  sleep 1
done
sleep 2

node src/db/migrate.js > /tmp/opencode/migrate.log 2>&1 || {
  echo "MIGRATE FAILED"; tail -20 /tmp/opencode/migrate.log; exit 1; }
node src/db/seed.js > /tmp/opencode/seed.log 2>&1 || {
  echo "SEED FAILED"; tail -20 /tmp/opencode/seed.log; exit 1; }

echo "----------------------------------------------------------------"
echo "  $SUITE"
echo "----------------------------------------------------------------"

EXTERNAL_API=""
if grep -q 'SPAWN' "scripts/$SUITE"; then
  SPAWN=1 node "scripts/$SUITE" "$@" 2>&1 | tail -25
  STATUS=${PIPESTATUS[0]}
else
  # No SPAWN support: run the API for the duration of the suite.
  PORT=5000 NODE_ENV=development setsid node index.js > /tmp/opencode/api.log 2>&1 < /dev/null &
  EXTERNAL_API=$!
  for _ in $(seq 1 60); do
    if curl -sf http://localhost:5000/api/health > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
  API_URL=http://localhost:5000/api node "scripts/$SUITE" "$@" 2>&1 | tail -25
  STATUS=${PIPESTATUS[0]}
  kill -9 "$EXTERNAL_API" 2>/dev/null
  sleep 1
fi

exit "$STATUS"
