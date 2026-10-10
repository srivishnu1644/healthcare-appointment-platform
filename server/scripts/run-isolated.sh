#!/usr/bin/env bash
# Provision an ISOLATED, multi-connection PostgreSQL and run the Phase 6 suite.
#
#   ./scripts/run-isolated.sh              # provision, then run the suite
#   ./scripts/run-isolated.sh --keep       # reuse the existing database
#
# Why this exists
# ---------------
# The Phase 6 acceptance criterion is a twenty-way booking race, which needs a
# database that can hold twenty concurrent connections. The bundled
# scripts/local-postgres.js is a single PGlite instance behind a socket server and
# serves one client at a time, so it cannot demonstrate a race at all.
#
# The hosted Supabase project can hold many connections, but it is the project's
# real database: running a suite that books, cancels and queues against it would
# write to it. So this provisions a private PostgreSQL of its own:
#
#   * real PostgreSQL binaries (extracted from the distribution .deb into a
#     user-writable prefix - no root, no system package changes)
#   * its own data directory, its own socket directory, its own port
#   * its own database, named medicare_test
#   * dropped and recreated on every run, so results never depend on leftovers
#
# Nothing here touches the hosted project, the project tree, or any system
# package database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${P6_PREFIX:-/tmp/opencode/pgsql}"
DATADIR="${P6_DATADIR:-/tmp/opencode/pgdata}"
SOCKDIR="${P6_SOCKDIR:-/tmp/opencode/pgsock}"
LOGFILE="${P6_LOG:-/tmp/opencode/pg16.log}"
PORT="${P6_PORT:-5440}"
DBNAME="${P6_DBNAME:-medicare_test}"
# 25 so twenty simultaneous bookings can each hold a connection.
POOL="${P6_POOL_MAX:-25}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

export LD_LIBRARY_PATH="$PREFIX/usr/lib/x86_64-linux-gnu:$PREFIX/usr/lib/postgresql/16/lib"
export PATH="$PREFIX/usr/lib/postgresql/16/bin:$PATH"

URL="postgresql://postgres@127.0.0.1:${PORT}/${DBNAME}"

# ---------------------------------------------------------------- server up?
server_up() { pg_isready -h 127.0.0.1 -p "$PORT" -q 2>/dev/null; }

stop_server() {
  if [ -d "$DATADIR" ]; then
    pg_ctl -D "$DATADIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
}

if [ "$KEEP" -eq 0 ]; then
  stop_server
  # A fresh data directory guarantees no state from any previous run.
  rm -rf "$DATADIR" "$SOCKDIR"
  mkdir -p "$SOCKDIR"
  initdb -D "$DATADIR" -U postgres --auth=trust --no-sync -E UTF8 >/dev/null
  pg_ctl -D "$DATADIR" -l "$LOGFILE" \
    -o "-p ${PORT} -k ${SOCKDIR} -c listen_addresses=127.0.0.1 -c max_connections=100" \
    -w start >/dev/null
elif ! server_up; then
  pg_ctl -D "$DATADIR" -l "$LOGFILE" \
    -o "-p ${PORT} -k ${SOCKDIR} -c listen_addresses=127.0.0.1 -c max_connections=100" \
    -w start >/dev/null
fi

createdb -h 127.0.0.1 -p "$PORT" -U postgres "$DBNAME" 2>/dev/null || true

# ------------------------------------------------------- identity, verified
echo "----------------------------------------------------------------"
echo "  Isolated test database"
echo "----------------------------------------------------------------"
psql "$URL" -Atc "select '  server   : ' || split_part(version(), ',', 1)" | sed 's/PostgreSQL //'
psql "$URL" -Atc "select '  database : ' || current_database()"
psql "$URL" -Atc "select '  port     : ' || inet_server_port()"
psql "$URL" -Atc "select '  datadir  : ' || current_setting('data_directory')"
psql "$URL" -Atc "select '  tables   : ' || count(*) from information_schema.tables where table_schema='public'"

# Refuse to run against anything that is not this private instance. The hosted
# project is on port 5432 of a *.supabase.com host and shares this project; a
# mistaken DATABASE_URL must fail here rather than write to it.
case "$URL" in
  *supabase*|*pooler*|*"@localhost:5432"*|*"@127.0.0.1:5432"*)
    echo "  REFUSING: $URL does not look like the isolated instance" >&2
    exit 1
    ;;
esac
echo "  guard    : URL is the isolated instance (not Supabase, not the default port)"

# ---------------------------------------------------- migrate, seed, verify
cd "$ROOT"
export DATABASE_URL="$URL"
export DB_POOL_MAX="$POOL"
export JWT_SECRET="${JWT_SECRET:-$(grep -E '^JWT_SECRET=' .env 2>/dev/null | tail -1 | cut -d= -f2-)}"

node src/db/migrate.js >/dev/null
node src/db/seed.js >/dev/null
echo "  migrated + seeded"
echo "----------------------------------------------------------------"

SPAWN=1 node scripts/appointment-check.js
