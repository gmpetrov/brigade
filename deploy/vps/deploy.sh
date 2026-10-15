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
# What runs now, not .env: a deploy that failed has already written its TAG there.
previous=$(docker compose ps --quiet api 2>/dev/null | xargs -r docker inspect --format '{{.Config.Image}}' | sed 's/.*://' || true)
echo "TAG=$TAG" >.env
docker compose pull --quiet
docker compose run --rm --no-deps api node_modules/.bin/prisma migrate deploy
docker compose up --detach --remove-orphans
# Only the images of this deploy and the one it replaced stay, to go back to with a re-run
# of that deploy: each deploy pulls ~1.8 GB and main deploys many times a day, so a week
# of them filled the disk. The server runs other things: only Brigade's images go.
for image in api web collab; do
  docker image ls "ghcr.io/gmpetrov/brigade-$image" --format '{{.Tag}}' |
    grep -vxF -e "$TAG" -e "${previous:-$TAG}" |
    sed "s#^#ghcr.io/gmpetrov/brigade-$image:#" |
    xargs -r docker image rm >/dev/null || true
done
docker image prune --force \
  --filter label=org.opencontainers.image.source=https://github.com/gmpetrov/brigade >/dev/null
docker compose ps --format '{{.Service}}: {{.Status}}'
