#!/usr/bin/env bash
# Records the demo's fixtures (apps/web/lib/demo/fixtures.json) from a fresh sample
# workspace: a database of its own, seeded as a preview is (apps/api/prisma/seed-workspace.ts),
# the API and the dashboard on ports of their own, then apps/web/scripts/demo-record.mjs
# walks every page in a browser as Ada. Nothing of a running preview is touched (its
# database, its ports, its Next build folder). See docs/demo.md.
#
#   scripts/demo/record.sh     (RECORD_PORT=3300 by default; the API and Next take the next two)
source "$(dirname "$0")/../preview/lib.sh"
use_node
use_pnpm
cd "$REPO"

PORT=${RECORD_PORT:-3300}
API_PORT=$((PORT + 1))
WEB_PORT=$((PORT + 2))
DB_PORT=${RECORD_DB_PORT:-5499}
URL=http://localhost:$PORT
WORK=$(mktemp -d)
export DATABASE_URL=postgresql://brigade:brigade@localhost:$DB_PORT/brigade BUCKET_DIR=$WORK/bucket

# Stops what it started, children first (pnpm does not pass the signal on); not `kill 0`,
# which would stop a deploy that runs this too.
stop() {
  local pid
  for pid in "$@"; do
    stop $(pgrep -P "$pid")
    kill "$pid" 2>/dev/null || true
  done
}
trap 'exit' INT TERM
trap 'stop $(jobs -p); rm -rf "$WORK"' EXIT

say "Dependencies, shared packages and the API's .env (scripts/preview/setup.sh's first steps)"
install_deps
"${PNPM[@]}" exec turbo run build --filter='@brigade/api^...' --filter='@brigade/web^...'
"${PNPM[@]}" --filter @brigade/api exec prisma generate >/dev/null
[ -f apps/api/.env ] || {
  secret=$(node -p 'require("crypto").randomBytes(32).toString("hex")')
  vault=$(node -p 'require("crypto").randomBytes(32).toString("base64")')
  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$secret|" -e "s|^VAULT_KEY=.*|VAULT_KEY=$vault|" \
    apps/api/.env.example >apps/api/.env
}

say "A fresh database on port $DB_PORT"
if [ ! -f "$CACHE/postgres/node_modules/embedded-postgres/package.json" ]; then
  npm install --silent --prefix "$CACHE/postgres" "embedded-postgres@$EMBEDDED_POSTGRES"
fi
PG_PACKAGE=$CACHE/postgres/node_modules/embedded-postgres PG_DATA=$WORK/postgres PG_PORT=$DB_PORT \
  node "$HERE/postgres.mjs" &
for _ in $(seq 1 60); do (echo >/dev/tcp/127.0.0.1/$DB_PORT) 2>/dev/null && break; sleep 1; done
"${PNPM[@]}" --filter @brigade/api exec prisma migrate deploy >/dev/null
"${PNPM[@]}" --filter @brigade/api db:seed

say "The API, the dashboard and the sign-in proxy at $URL"
node apps/api/scripts/playbooks.mjs
(cd apps/api && PORT=$API_PORT API_URL=$URL WEB_URL=$URL \
  "${PNPM[@]}" exec tsx --env-file-if-exists=.env src/index.ts) >"$WORK/api.log" 2>&1 &
# Its own build folder: a dev server already running in apps/web holds .next.
(cd apps/web && NEXT_DIST_DIR=.next-demo-record NEXT_PUBLIC_API_URL=$URL \
  "${PNPM[@]}" exec next dev --port "$WEB_PORT") >"$WORK/web.log" 2>&1 &
PORT=$PORT API_PORT=$API_PORT WEB_PORT=$WEB_PORT PREVIEW_URL=$URL PREVIEW_SIGN_IN=ada@example.com \
  node "$HERE/proxy.mjs" >"$WORK/proxy.log" 2>&1 &
for _ in $(seq 1 120); do
  curl -fs -o /dev/null "http://localhost:$API_PORT/health" && curl -fs -o /dev/null "http://localhost:$WEB_PORT/app" && break
  sleep 1
done

say "A browser for the recorder"
(cd apps/web && "${PNPM[@]}" exec playwright-core install chromium >/dev/null)

say "Recording"
(cd apps/web && node scripts/demo-record.mjs --url "$URL") || {
  echo "Recording failed. The API's log:" >&2
  tail -40 "$WORK/api.log" >&2
  exit 1
}
