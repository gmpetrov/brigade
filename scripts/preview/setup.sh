#!/usr/bin/env bash
# One-off setup to run Brigade locally or as a preview: Node, dependencies, shared
# packages, apps/api/.env, the database with its migrations and the dev accounts.
# Safe to run again (after a pull, say): it only does what is missing or changed.
source "$(dirname "$0")/lib.sh"
use_node
use_pnpm
cd "$REPO"

if [ ! -f apps/api/.env ]; then
  say "Writing apps/api/.env"
  secret=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
  vault=$(node -p 'require("crypto").randomBytes(32).toString("base64")')
  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$secret|" -e "s|^VAULT_KEY=.*|VAULT_KEY=$vault|" \
    apps/api/.env.example >apps/api/.env
fi

# Notifications: a VAPID key pair, once (a new pair would unsubscribe every device).
if ! grep -q '^VAPID_PRIVATE_KEY=.' apps/api/.env; then
  say "Adding a VAPID key pair for notifications"
  sed -i.bak '/^VAPID_PUBLIC_KEY=/d; /^VAPID_PRIVATE_KEY=/d' apps/api/.env && rm -f apps/api/.env.bak
  node apps/api/scripts/vapid.mjs >>apps/api/.env
fi

say "Installing dependencies"
install_deps

say "Building shared packages"
"${PNPM[@]}" exec turbo run build --filter='@brigade/api^...' --filter='@brigade/web^...'
# The Prisma Client again only when its schema, Prisma or the client itself changed since.
CLIENT=(apps/api/prisma/schema.prisma apps/api/prisma.config.ts apps/api/node_modules/prisma/package.json
  apps/api/src/generated/prisma apps/api/src/generated/prisma-workers)
if unchanged client "$(fingerprint "${CLIENT[@]}")"; then
  say "The Prisma Client is up to date"
else
  "${PNPM[@]}" --filter @brigade/api exec prisma generate
  stamp client "$(fingerprint "${CLIENT[@]}")"
fi
node apps/api/scripts/playbooks.mjs

say "Starting PostgreSQL"
mkdir -p "$DATA"
trap 'kill $(jobs -p) 2>/dev/null || true; wait' EXIT
start_db

if node "$HERE/migrated.mjs"; then
  say "No migrations to apply"
else
  say "Applying migrations"
  "${PNPM[@]}" --filter @brigade/api exec prisma migrate deploy
fi

say "Adding the dev accounts and the sample workspace"
"${PNPM[@]}" --filter @brigade/api db:seed

say "Ready. Start it with scripts/preview/start.sh, then sign in as ada@example.com / correct-horse-battery"
