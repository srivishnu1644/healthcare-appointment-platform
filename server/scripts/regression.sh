#!/usr/bin/env bash
# Run every regression suite against the isolated multi-connection PostgreSQL.
#
#   ./scripts/regression.sh            # all suites
#   ./scripts/regression.sh slot-check.js
#
# Each suite gets a FRESHLY CREATED database, so no suite can pass or fail because
# of what a previous one left behind. The hosted Supabase project is never touched:
# the URL is asserted to be the local instance before anything runs.
set -uo pipefail
cd "$(dirname "$0")/.."

export PATH=/tmp/opencode/pgsql/usr/lib/postgresql/16/bin:$PATH
export LD_LIBRARY_PATH=/tmp/opencode/pgsql/usr/lib/x86_64-linux-gnu:/tmp/opencode/pgsql/usr/lib/postgresql/16/lib

PORT="${P6_PORT:-5440}"
ADMIN="postgresql://postgres@127.0.0.1:${PORT}/postgres"
SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(appointment-check.js directory-check.js slot-check.js auth-check.js security-check.js smoke.js)
fi

export DB_POOL_MAX="${P6_POOL_MAX:-10}"
export JWT_SECRET="${JWT_SECRET:-$(grep -E '^JWT_SECRET=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"

# Refuse to run against anything that is not this private instance.
case "$ADMIN" in
  *supabase*|*pooler*|*:5432/*)
    echo "REFUSING: $ADMIN does not look like the isolated instance" >&2
    exit 1
    ;;
esac

# The server must be up.
if ! pg_isready -h 127.0.0.1 -p "$PORT" -q; then
  echo "  isolated PostgreSQL is not running on port $PORT; start it first" >&2
  exit 1
fi

# Refuse to run if a suite port is already occupied.
#
# A suite that spawns its own API polls /health and cannot tell its own process
# from someone else's: if a stale server is already listening, the spawned one
# fails to bind, the health check is answered by the stale process, and the suite
# silently tests OLD CODE. That happened here and produced a convincing but false
# failure, so it is now cleared up front rather than left as a mystery.
for port in 5000 5091 5092 5093 5094 5095 5096 5097 5098 5099; do
  holder=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1)
  if [ -n "$holder" ]; then
    echo "  port ${port} was in use by pid ${holder}; stopping it" >&2
    kill -9 "$holder" 2>/dev/null
  fi
done
sleep 1

echo "  target : $(psql "$ADMIN" -Atc 'select version()' | cut -d' ' -f1-3)"
echo "  host   : 127.0.0.1:${PORT} (private instance, isolated data directory)"
echo

for suite in "${SUITES[@]}"; do
  db="t_$(echo "$suite" | tr -cd 'a-z0-9' | cut -c1-16)"
  psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db" >/dev/null 2>&1
  export DATABASE_URL="postgresql://postgres@127.0.0.1:${PORT}/${db}"

  node src/db/migrate.js >/dev/null 2>&1 || { echo "$suite: MIGRATE FAILED"; continue; }
  node src/db/seed.js    >/dev/null 2>&1 || { echo "$suite: SEED FAILED";    continue; }

  # Suites that own their own API lifecycle get SPAWN=1; the older ones expect a
  # server to already be running on the port they hardcode.
  if grep -q 'SPAWN' "scripts/$suite"; then
    result=$(SPAWN=1 node "scripts/$suite" 2>&1 | grep -E "passed,|^FAIL" | tail -5)
  else
    PORT=5000 NODE_ENV=development node index.js > /tmp/opencode/regress-api.log 2>&1 &
    api_pid=$!
    for _ in $(seq 1 60); do
      curl -sf http://localhost:5000/api/health >/dev/null 2>&1 && break
      sleep 0.5
    done
    result=$(API_URL=http://localhost:5000/api node "scripts/$suite" 2>&1 | grep -E "passed,|^FAIL" | tail -5)
    kill -9 "$api_pid" 2>/dev/null
    wait "$api_pid" 2>/dev/null
    sleep 1
  fi

  printf '  %-24s %s\n' "$suite" "$(echo "$result" | tr '\n' ' ')"
done
