#!/usr/bin/env bash
# Deploy the load test copy of the API (README.md): brigade-api-loadtest and its front.
#   SECRETS=<.env file> scripts/load/deploy.sh [api|front] [STATELESS_ROUTES]
# SECRETS holds CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, DATABASE_URL and the Worker's
# secrets (BETTER_AUTH_SECRET, VAULT_KEY, OPS_TOKEN, R2_*, API_URL), never committed.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${SECRETS:?Set SECRETS to the .env file of the load test copy}"
set -a
# shellcheck disable=SC1090
. "$SECRETS"
set +a
what=${1:-api}
case "$what" in
api)
  # Built as production's is (scripts/deploy/workers.sh build api) beforehand.
  (cd apps/api && pnpm exec prisma migrate deploy)
  SHA=$(node apps/api/scripts/prepare-worker.mjs)
  # Only the Worker's own secrets: never the Cloudflare token.
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  grep -E '^(DATABASE_URL|BETTER_AUTH_SECRET|VAULT_KEY|OPS_TOKEN|R2_[A-Z_]+|API_URL|WEB_URL)=' "$SECRETS" >"$tmp"
  (cd apps/api && pnpm exec wrangler deploy -c ../../scripts/load/wrangler.api.jsonc \
    --secrets-file "$tmp" --var "RUNNER_BUNDLE_SHA256:$SHA" --var "BRIGADE_BUILD_ID:$(git rev-parse HEAD)")
  ;;
front)
  (cd apps/api && pnpm exec wrangler deploy -c ../../scripts/load/wrangler.front.jsonc \
    --var "STATELESS_ROUTES:${2:-}")
  ;;
*)
  echo "Usage: $0 api|front [STATELESS_ROUTES]" >&2
  exit 1
  ;;
esac
