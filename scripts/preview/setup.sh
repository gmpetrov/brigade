#!/usr/bin/env bash
# One-off setup to run Brigade locally or as a preview: Node, dependencies, shared
# packages, apps/api/.env, the database with its migrations and the dev accounts.
# Safe to run again (after a pull, say): it only does what is missing or changed.
source "$(dirname "$0")/lib.sh"
use_node
use_pnpm
cd "$REPO"

say "Installing dependencies"
"${PNPM[@]}" install --frozen-lockfile

say "Building shared packages"
"${PNPM[@]}" exec turbo run build --filter='@brigade/api^...' --filter='@brigade/web^...'
"${PNPM[@]}" --filter @brigade/api exec prisma generate

if [ ! -f apps/api/.env ]; then
  say "Writing apps/api/.env"
  secret=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
  vault=$(node -p 'require("crypto").randomBytes(32).toString("base64")')
  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$secret|" -e "s|^VAULT_KEY=.*|VAULT_KEY=$vault|" \
    apps/api/.env.example >apps/api/.env
fi

say "Starting PostgreSQL"
mkdir -p "$DATA"
trap 'kill $(jobs -p) 2>/dev/null; wait' EXIT
start_db

say "Applying migrations"
"${PNPM[@]}" --filter @brigade/api exec prisma migrate deploy

say "Adding the dev accounts"
"${PNPM[@]}" --filter @brigade/api db:seed

say "Ready. Start it with scripts/preview/start.sh, then sign in as ada@example.com / correct-horse-battery"
