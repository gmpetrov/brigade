#!/usr/bin/env bash
# Deploy Brigade to Cloudflare from a laptop: the database's migrations, the library
# bucket, the API (apps/api/wrangler.jsonc), live document sync (apps/collab/wrangler.jsonc)
# and the dashboard (apps/web/wrangler.jsonc), with the secrets in apps/api/.env.prod.
# A push to main deploys the same way (scripts/deploy/workers.sh), keeping the secrets
# the Workers have: run this for a first deploy, or after changing .env.prod.
# Needs wrangler signed in to the account (npx wrangler login).
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=apps/api/.env.prod
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
value() { grep "^$1=" "$ENV_FILE" | cut -d= -f2-; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
WORKERS=scripts/deploy/workers.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

step "Build"
$WORKERS build api
$WORKERS build web

step "Library bucket"
API="pnpm --filter @brigade/api exec"
BUCKET="$(value R2_BUCKET)"
$API wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1 ||
  $API wrangler r2 bucket create "$BUCKET" --location weur
yes | $API wrangler r2 bucket cors set "$BUCKET" --file "$PWD/scripts/deploy/r2-cors.json"

step "Database migrations and API"
grep -E '^[A-Z0-9_]+=' "$ENV_FILE" | grep -vE '^PORT=' >"$TMP/api"
DATABASE_URL="$(value DATABASE_URL)" API_SECRETS="$TMP/api" $WORKERS deploy api

step "Collab"
grep -E '^COLLAB_SECRET=' "$ENV_FILE" >"$TMP/collab"
COLLAB_SECRETS="$TMP/collab" $WORKERS deploy collab

step "Dashboard"
$WORKERS deploy web

step "Check"
curl -fsS "$(value API_URL)/health" && echo
curl -fsS -o /dev/null -w "dashboard %{http_code}\n" "$(value WEB_URL)/sign-in"
