# Shared by setup.sh and start.sh: paths, Node, pnpm and the database.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HERE=$REPO/scripts/preview
# Downloads shared by every checkout on this machine (Node, PostgreSQL); data stays in the checkout.
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/brigade-preview
DATA=$REPO/.preview
NODE_VERSION=22.14.0
EMBEDDED_POSTGRES=17.10.0-beta.17
DB_PORT=5433

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# Node 22.13 or newer: the one on PATH, else one downloaded to the cache.
use_node() {
  if command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
    return
  fi
  local dir=$CACHE/node-v$NODE_VERSION
  if [ ! -x "$dir/bin/node" ]; then
    local os arch
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    case $(uname -m) in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) arch=$(uname -m) ;; esac
    say "Downloading Node $NODE_VERSION"
    mkdir -p "$dir"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$os-$arch.tar.gz" |
      tar -xz -C "$dir" --strip-components=1
  fi
  export PATH=$dir/bin:$PATH
}

# pnpm, through Corepack (the version package.json asks for) when it is not installed.
use_pnpm() {
  if command -v pnpm >/dev/null; then PNPM=(pnpm); else PNPM=(env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm); fi
}

# PostgreSQL from docker-compose.yml when Docker works here, else embedded (no Docker or root needed).
use_docker() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }

db_answers() { (echo >/dev/tcp/127.0.0.1/$DB_PORT) 2>/dev/null; }

wait_for_db() {
  for _ in $(seq 1 60); do db_answers && return; sleep 1; done
  echo "PostgreSQL did not start on port $DB_PORT" >&2
  return 1
}

# Starts PostgreSQL unless something already answers on its port. Embedded, it runs in the
# background until this script exits. Also embedded when Docker answers but cannot start the
# container (a rootless daemon whose overlay mounts fail, say).
start_db() {
  db_answers && return
  if use_docker && (cd "$REPO" && docker compose up -d postgres); then
    :
  else
    use_docker && say "Docker could not start PostgreSQL: using the embedded one"
    if [ ! -f "$CACHE/postgres/node_modules/embedded-postgres/package.json" ]; then
      say "Downloading PostgreSQL"
      npm install --silent --prefix "$CACHE/postgres" "embedded-postgres@$EMBEDDED_POSTGRES"
    fi
    PG_PACKAGE=$CACHE/postgres/node_modules/embedded-postgres PG_DATA=$DATA/postgres PG_PORT=$DB_PORT \
      node "$HERE/postgres.mjs" &
  fi
  wait_for_db
}
