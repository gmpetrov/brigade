#!/usr/bin/env bash
# Runs on the server, in /opt/brigade, for .github/workflows/vps.yml: switches to the
# images of TAG, migrates the database and restarts what changed. ACTOR and a token
# that can read GitHub's registry (on stdin) pull the images.
#   TAG=<commit> ACTOR=<github user> ./deploy.sh <<<"$TOKEN"
set -euo pipefail
cd "$(dirname "$0")"
: "${TAG:?Set TAG to the image tag}" "${ACTOR:?Set ACTOR to the registry user}"
docker login ghcr.io --username "$ACTOR" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null' EXIT
echo "TAG=$TAG" >.env
docker compose pull --quiet
docker compose run --rm --no-deps api node_modules/.bin/prisma migrate deploy
docker compose up --detach --remove-orphans
# Brigade's older images stay a week, to go back to with a re-run of an earlier deploy.
# The server runs other things: only images labelled as this repository's are pruned.
docker image prune --all --force --filter until=168h \
  --filter label=org.opencontainers.image.source=https://github.com/gmpetrov/brigade >/dev/null
docker compose ps --format '{{.Service}}: {{.Status}}'
