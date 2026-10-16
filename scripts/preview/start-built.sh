#!/usr/bin/env bash
# Like start.sh, but built for production: the API compiled, Next's own server on a
# build made for this address. Several times lighter than the dev servers, without
# hot reload: for a preview people try rather than one a teammate edits. Builds
# again only when the address or the checkout changed. Run setup.sh first.
source "$(dirname "$0")/lib.sh"
use_node
use_pnpm

export PORT=${PORT:-3000} API_PORT=${API_PORT:-3001} WEB_PORT=${WEB_PORT:-3002}
URL=${BRIGADE_PREVIEW_URL:-http://localhost:$PORT}
URL=${URL%/}
CROSS_SITE_COOKIES=false
[[ $URL == https://* ]] && CROSS_SITE_COOKIES=true

trap 'exit' INT TERM
trap 'kill 0' EXIT
start_db

# The address is baked into the dashboard's build (NEXT_PUBLIC_API_URL).
STAMP="$URL $(cd "$REPO" && { git rev-parse HEAD; git status --porcelain=v1 -uno; git diff; } 2>/dev/null | cksum)"
if [ "$(cat "$DATA/built" 2>/dev/null)" != "$STAMP" ]; then
  say "Building the API and the dashboard for $URL"
  (cd "$REPO" && "${PNPM[@]}" --filter @brigade/api build)
  (cd "$REPO/apps/web" && NEXT_PUBLIC_API_URL=$URL "${PNPM[@]}" exec next build)
  mkdir -p "$DATA" && echo "$STAMP" >"$DATA/built"
fi

# Node itself, not through pnpm: each pnpm in between is another resident Node.
(cd "$REPO/apps/api" && PORT=$API_PORT API_URL=$URL WEB_URL=$URL CROSS_SITE_COOKIES=$CROSS_SITE_COOKIES \
  exec node --env-file-if-exists=.env dist/index.js) &
(cd "$REPO/apps/web" && NEXT_PUBLIC_API_URL=$URL exec node node_modules/next/dist/bin/next start --port "$WEB_PORT") &

PREVIEW_URL=$URL PREVIEW_SIGN_IN=${PREVIEW_SIGN_IN-ada@example.com} node "$HERE/proxy.mjs" &

# Any of them stopping ends the preview, which the runner starts again.
wait -n
