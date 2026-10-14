#!/usr/bin/env bash
# Build or deploy one of Brigade's Workers:
#   scripts/deploy/workers.sh build|deploy api|web|collab
# Each Worker's Workers Build runs it on a push to main (the cf:* scripts in the root
# package.json), after installing dependencies. Deploying the API migrates the database
# first, with DATABASE_URL from the environment (a build secret on Cloudflare). A deploy
# keeps the secrets a Worker has; change one with `wrangler secret put` (see
# docs/deployment-plan.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
API_URL=https://api.brigade.lol

case "${1:-}:${2:-}" in
build:api)
  pnpm --filter "@brigade/api^..." build
  # prisma.config.ts needs a URL, which generating never connects to.
  DATABASE_URL=${DATABASE_URL:-postgresql://localhost/unused} pnpm --filter @brigade/api exec prisma generate
  pnpm --filter @brigade/runner bundle
  ;;
deploy:api)
  : "${DATABASE_URL:?Set DATABASE_URL to migrate the database}"
  # Another deploy can hold Prisma's migration lock for a while: wait for it, then go on.
  # Any other failure stops the deploy.
  for attempt in 1 2 3 4; do
    if out=$(pnpm --filter @brigade/api exec prisma migrate deploy 2>&1); then
      echo "$out"
      break
    fi
    echo "$out"
    case "$out" in
    *P1002*advisory*) [ "$attempt" -lt 4 ] || exit 1 ;;
    *) exit 1 ;;
    esac
    echo "Another deploy is migrating; trying again in 15 seconds"
    sleep 15
  done
  SHA=$(node apps/api/scripts/prepare-worker.mjs)
  pnpm --filter @brigade/api exec wrangler deploy --var "RUNNER_BUNDLE_SHA256:$SHA"
  ;;
build:web)
  pnpm --filter "@brigade/web^..." build
  NEXT_PUBLIC_API_URL=$API_URL pnpm --filter @brigade/web exec opennextjs-cloudflare build
  ;;
deploy:web)
  pnpm --filter @brigade/web exec opennextjs-cloudflare deploy
  ;;
build:collab)
  # Nothing: wrangler bundles it when deploying.
  ;;
deploy:collab)
  pnpm --filter @brigade/collab exec wrangler deploy --var "API_URL:$API_URL"
  ;;
*)
  echo "Usage: $0 build|deploy api|web|collab" >&2
  exit 1
  ;;
esac
