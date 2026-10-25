#!/usr/bin/env bash
# TEMPLATE — copy this file to startdevserver.sh, fill in your own values,
# then run ./startdevserver.sh:
#
#   cp startdevserver.example.sh startdevserver.sh
#   $EDITOR startdevserver.sh
#   ./startdevserver.sh
#
# startdevserver.sh is gitignored on purpose: this repo ships no
# infrastructure names, and your credentials should never be committed.
#
# Requirements: PostgreSQL 15+ with the schema from db/schema.sql applied
# (search_path is fixed to the `explanet` schema by the server). The password
# is taken from PGPASSWORD or ~/.pgpass — leave PGPASSWORD commented out and
# prefer ~/.pgpass (a line like  myhost:5432:*:myuser:mypass  with chmod 600).
set -euo pipefail

# --- world database ---------------------------------------------------------
export PGHOST="your-pg-host"        # e.g. pgsql01
export PGPORT=5432
export PGDATABASE="your-database"   # e.g. explanet
export PGUSER="your-db-user"        # e.g. postgres
# Password is resolved from ~/.pgpass (server/db.mjs reads it). To hardcode
# it instead, uncomment:
#   export PGPASSWORD=***

if [[ "$PGHOST" == "your-pg-host" ]]; then
  echo "startdevserver.sh: edit PGHOST/PGDATABASE/PGUSER with your real values first" >&2
  exit 1
fi

# --- dev server -------------------------------------------------------------
# Binds all interfaces so the app is reachable from other machines on the
# LAN (drop the flag to keep it localhost-only); extra args are forwarded to
# vite and override this if repeated.
cd "$(dirname "$0")"
exec npm run dev -- --host 0.0.0.0 "$@"
