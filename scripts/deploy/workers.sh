#!/usr/bin/env bash
# Build or deploy one of Brigade's Workers:
#   scripts/deploy/workers.sh build|deploy api|api-front|web|collab
# Each Worker's Workers Build runs it on a push to main (the cf:* scripts in the root
# package.json), after installing dependencies. Deploying the API migrates the database
# first, with DATABASE_URL from the environment (a build secret on Cloudflare). A deploy
# keeps the secrets a Worker has; change one with `wrangler secret put` (see
# docs/deployment-plan.md).
#
# The API's and the dashboard's builds run side by side, and the dashboard's is done
# first: deploying it waits until the API runs this commit's API code, so a page never
# asks the API for something it does not have yet (#94's wake-ups broke every thread
# page for minutes). The API says which commit it runs at /health.
set -euo pipefail
cd "$(dirname "$0")/../.."
API_URL=https://api.brigade.lol
# The commit being deployed (Workers Builds sets it; git otherwise).
COMMIT=${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD)}
# What the API is built from: the dashboard waits for a change in these.
API_PATHS=(apps/api apps/runner packages patches package.json pnpm-lock.yaml)

# Waits until the API runs code no older than this commit's, up to 12 minutes (a Workers Build stops at 20):
# the commit it runs has the same API_PATHS, or comes after this one.
wait_for_api() {
  local deadline=$((SECONDS + 720)) build
  while :; do
    build=$(curl -fsS --max-time 10 "$API_URL/health" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).build??"")}catch{}})' || true)
    if [ -n "$build" ]; then
      [ "$build" = "$COMMIT" ] && return 0
      # A shallow clone has neither the API's commit nor the history between them.
      git cat-file -e "$build^{commit}" 2>/dev/null || git fetch -q origin "$build" 2>/dev/null || true
      if git cat-file -e "$build^{commit}" 2>/dev/null; then
        [ "$(git rev-parse --is-shallow-repository)" = true ] && git fetch -q --unshallow origin 2>/dev/null || true
        git diff --quiet "$build" "$COMMIT" -- "${API_PATHS[@]}" && return 0
        git merge-base --is-ancestor "$COMMIT" "$build" 2>/dev/null && return 0
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "The API still runs ${build:-an unknown commit}, not $COMMIT's API code: not deploying the dashboard" >&2
      return 1
    fi
    echo "Waiting for the API to run $COMMIT's API code (it runs ${build:-an unknown commit})"
    sleep 20
  done
}

case "${1:-}:${2:-}" in
build:api)
  pnpm --filter "@brigade/api^..." build
  # prisma.config.ts needs a URL, which generating never connects to.
  DATABASE_URL=${DATABASE_URL:-postgresql://localhost/unused} pnpm --filter @brigade/api exec prisma generate
  # The playbook templates (loops/) go inside the Worker's code.
  pnpm --filter @brigade/api loops
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
  pnpm --filter @brigade/api exec wrangler deploy --var "RUNNER_BUNDLE_SHA256:$SHA" \
    --var "BRIGADE_BUILD_ID:$COMMIT"
  ;;
build:api-front)
  # Nothing: wrangler bundles it when deploying.
  ;;
deploy:api-front)
  # The small Worker in front of the API's Durable Object (src/front.ts).
  pnpm --filter @brigade/api exec wrangler deploy -c wrangler.front.jsonc
  ;;
build:web)
  pnpm --filter "@brigade/web^..." build
  NEXT_PUBLIC_API_URL=$API_URL pnpm --filter @brigade/web exec opennextjs-cloudflare build
  ;;
deploy:web)
  wait_for_api
  pnpm --filter @brigade/web exec opennextjs-cloudflare deploy
  ;;
build:collab)
  # Nothing: wrangler bundles it when deploying.
  ;;
deploy:collab)
  pnpm --filter @brigade/collab exec wrangler deploy --var "API_URL:$API_URL"
  ;;
*)
  echo "Usage: $0 build|deploy api|api-front|web|collab" >&2
  exit 1
  ;;
esac
