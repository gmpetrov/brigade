#!/usr/bin/env bash
# Puts the preview's data back as setup.sh first made it, in seconds, to try a flow again
# (sign-up, onboarding, billing, a first thread): the database and the local library bucket.
#   scripts/preview/reset.sh           the dev accounts and the sample workspace (seed)
#   scripts/preview/reset.sh --empty   no account at all: as production on its first day
# Also from the preview itself: /__preview/reset (proxy.mjs).
#
# The first reset after a migration or seed change makes a snapshot of that state (a template
# database, brigade_<mode>_<fingerprint>), which takes as long as migrating and seeding; later
# ones copy it. While it runs, start.sh's API is held, then started again: it keeps state in
# memory (workspace hubs, caches) that must not outlive its database.
source "$(dirname "$0")/lib.sh"
use_node
use_pnpm
cd "$REPO"

mode=seed
case ${1:-} in
  '') ;;
  --empty) mode=empty ;;
  *)
    echo "Usage: $0 [--empty]" >&2
    exit 2
    ;;
esac
[ -f apps/api/.env ] || {
  echo "No apps/api/.env: run scripts/preview/setup.sh first" >&2
  exit 1
}

db() { node "$HERE/database.mjs" "$@"; }

# Its own database server when the preview is not running.
trap 'rm -f "$DATA/api.hold"; kill $(jobs -p) 2>/dev/null || true; wait' EXIT
mkdir -p "$DATA"
start_db

# What the snapshot holds: the migrations, and what seeds it.
SOURCES=(apps/api/prisma/migrations apps/api/prisma/schema.prisma)
[ $mode = seed ] && SOURCES+=(apps/api/prisma/seed.ts apps/api/prisma/seed-*.ts)
PREFIX=brigade_${mode}_
TEMPLATE=$PREFIX$(fingerprint "${SOURCES[@]}" | cut -d' ' -f1)

if db exists "$TEMPLATE"; then
  say "Using the snapshot $TEMPLATE"
else
  say "Making the snapshot $TEMPLATE (once after each migration or seed change)"
  building=${PREFIX}new
  db create "$building"
  url=$(db url "$building")
  DATABASE_URL=$url "${PNPM[@]}" --filter @brigade/api exec prisma migrate deploy
  [ $mode = seed ] && DATABASE_URL=$url "${PNPM[@]}" --filter @brigade/api db:seed
  db drop-prefix "$PREFIX" "$building"
  db rename "$building" "$TEMPLATE"
fi

# Hold start.sh's API: stopped, and not started again until the database is back.
api=$(cat "$DATA/api.pid" 2>/dev/null || true)
if [ -n "$api" ] && kill -0 "$api" 2>/dev/null; then
  say "Stopping the API"
  touch "$DATA/api.hold"
  stop_tree "$api"
else
  api=
fi

say "Resetting the database"
db restore "$TEMPLATE"
# Library files: of workspaces gone with the database (the seed puts none there).
rm -rf apps/api/.bucket

if [ -n "$api" ]; then
  rm -f "$DATA/api.hold"
  say "Starting the API again"
  for _ in $(seq 1 60); do
    curl -fs -o /dev/null "http://127.0.0.1:${API_PORT:-3001}/api/auth/ok" && break
    sleep 1
  done
else
  say "Restart the API if it runs: it keeps state of the old database in memory"
fi
if [ $mode = seed ]; then
  say "Reset: sign in as ada@example.com, or dana@example.com to try onboarding (password correct-horse-battery)"
else
  say "Reset: no accounts, sign up to start"
fi
