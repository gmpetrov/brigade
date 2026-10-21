#!/usr/bin/env bash
# Runs Brigade at one address (PORT, 3000): PostgreSQL, the API on API_PORT, Next
# on WEB_PORT and proxy.mjs in front. Run setup.sh first. Its public address is
# BRIGADE_PREVIEW_URL in a Brigade preview, else http://localhost:$PORT.
source "$(dirname "$0")/lib.sh"
use_node
use_pnpm

export PORT=${PORT:-3000} API_PORT=${API_PORT:-3001} WEB_PORT=${WEB_PORT:-3002}
URL=${BRIGADE_PREVIEW_URL:-http://localhost:$PORT}
URL=${URL%/}
# The thread shows a preview in a frame on another site: over HTTPS, its session cookie must allow that.
CROSS_SITE_COOKIES=false
[[ $URL == https://* ]] && CROSS_SITE_COOKIES=true

trap 'exit' INT TERM
trap 'kill 0' EXIT
start_db

# Billing with a test account's key (a preview variable): its product, price and portal, once.
if [[ ${STRIPE_SECRET_KEY:-} == sk_test_* || ${STRIPE_SECRET_KEY:-} == rk_test_* ]]; then
  (cd "$REPO/apps/api" && WEB_URL=$URL node scripts/stripe-setup.mjs) || echo "Stripe setup failed: billing may not work"
fi

(cd "$REPO/apps/api" && PORT=$API_PORT API_URL=$URL WEB_URL=$URL CROSS_SITE_COOKIES=$CROSS_SITE_COOKIES \
  "${PNPM[@]}" dev) &

# Turbopack sometimes panics and exits: start Next again when it does.
(cd "$REPO/apps/web" && while true; do
  NEXT_PUBLIC_API_URL=$URL DEV_ORIGINS=${URL#*://} "${PNPM[@]}" exec next dev --port "$WEB_PORT" || true
  echo "Next exited, starting it again"
  sleep 2
done) &

# The first page a browser opens is signed in as Ada; PREVIEW_SIGN_IN= turns it off.
PREVIEW_URL=$URL PREVIEW_SIGN_IN=${PREVIEW_SIGN_IN-ada@example.com} node "$HERE/proxy.mjs" &

# The proxy or the embedded database stopping ends the preview.
wait_any
