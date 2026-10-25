# Shared by setup.sh and start.sh: paths, Node, pnpm and the database.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HERE=$REPO/scripts/preview
# Downloads shared by every checkout on this machine (Node, PostgreSQL); data stays in the checkout.
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/brigade-preview
DATA=$REPO/.preview
NODE_VERSION=24.22.1
EMBEDDED_POSTGRES=17.10.0-beta.17
PG_CACHE=$CACHE/postgres-$EMBEDDED_POSTGRES
DB_PORT=5433

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# What files are now (paths and contents; missing ones count too), with cksum, which Linux
# and macOS both have. A step whose files are as its last run left them (its stamp) is skipped.
fingerprint() {
  (cd "$REPO" && { find "$@" -type f -exec cksum {} + 2>/dev/null || true; } | LC_ALL=C sort | cksum)
}
unchanged() { [ "$(cat "$DATA/stamps/$1" 2>/dev/null)" = "$2" ]; }
stamp() { mkdir -p "$DATA/stamps" && echo "$2" >"$DATA/stamps/$1"; }

# Node $NODE_VERSION or newer (older ones miss its security fixes): the one on PATH, else one
# downloaded to the cache.
use_node() {
  if command -v node >/dev/null && node -e '
    const [a, b] = [process.versions.node, process.argv[1]].map((v) => v.split(".").map(Number))
    process.exit((a.map((n, i) => n - b[i]).find((n) => n !== 0) ?? 0) >= 0 ? 0 : 1)' "$NODE_VERSION"; then
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

# pnpm, through Corepack (the version package.json asks for) when it is not installed or
# older than 10, which cannot read the lockfile. pnpm 10 itself runs package.json's version.
use_pnpm() {
  local major
  major=$(cd "$REPO" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm -v 2>/dev/null | cut -d. -f1) || true
  if [ "${major:-0}" -ge 10 ] 2>/dev/null; then PNPM=(pnpm); else PNPM=(env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm); fi
}

# The dependencies pnpm-lock.yaml asks for, with pnpm's quick check when it is enough: done in
# a moment rather than seconds. That check sees package.json files and missing folders, not a
# lockfile that alone changed (a dependency updated within its range) nor an install by hand
# since, which leave what pnpm installed (node_modules/.pnpm/lock.yaml) unlike the last stamp.
install_deps() {
  local files=(pnpm-lock.yaml node_modules/.pnpm/lock.yaml)
  if unchanged deps "$(fingerprint "${files[@]}")"; then
    (cd "$REPO" && "${PNPM[@]}" install --frozen-lockfile --config.optimistic-repeat-install=true)
  else
    (cd "$REPO" && "${PNPM[@]}" install --frozen-lockfile)
  fi
  stamp deps "$(fingerprint "${files[@]}")"
}

# PostgreSQL from docker-compose.yml when Docker works here, else embedded (no Docker or root needed).
use_docker() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }

db_answers() { (echo >/dev/tcp/127.0.0.1/$DB_PORT) 2>/dev/null; }

wait_for_db() {
  for _ in $(seq 1 60); do db_answers && return; sleep 1; done
  echo "PostgreSQL did not start on port $DB_PORT" >&2
  return 1
}

# Whether the thread's Docker holds the database already: its Compose volume is there.
docker_holds_db() {
  [ -n "${COMPOSE_PROJECT_NAME:-}" ] && use_docker &&
    [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
      --filter label=com.docker.compose.volume=postgres 2>/dev/null)" ]
}

# The embedded-postgres package, once per version, in the cache. With pnpm rather than npm: a
# cloud computer's own npm can be broken (one updated over another's files fails on every
# install). Installed beside the cache and moved in only once complete, so an install that
# failed or two previews installing at once never leave a half-installed package behind.
# Its platform package's install script links the libraries PostgreSQL loads: allowed here.
download_postgres() {
  [ -f "$PG_CACHE/node_modules/embedded-postgres/dist/index.js" ] && return
  say "Downloading PostgreSQL"
  local temp=$PG_CACHE.$$
  rm -rf "$temp" && mkdir -p "$temp" && echo '{"private":true}' >"$temp/package.json"
  if ! (cd "$temp" && "${PNPM[@]}" add --config.node-linker=hoisted \
    --config.dangerously-allow-all-builds=true "embedded-postgres@$EMBEDDED_POSTGRES"); then
    rm -rf "$temp"
    echo "Could not download PostgreSQL (embedded-postgres@$EMBEDDED_POSTGRES)" >&2
    return 1
  fi
  # Another preview may have put its own in place meanwhile.
  if [ -f "$PG_CACHE/node_modules/embedded-postgres/dist/index.js" ]; then
    rm -rf "$temp"
  else
    rm -rf "$PG_CACHE" && mv "$temp" "$PG_CACHE"
  fi
}

# Starts PostgreSQL unless something already answers on its port. Embedded, it runs in the
# background until this script exits. Docker's when Docker works here, except:
# - once the embedded one holds this checkout's data. Its data stays the same whether Docker
#   answers or not, and a daemon still starting (or failing to) does not hold each start for
#   as long as `docker info` waits on it, 13 seconds on a cloud computer;
# - in a preview, unless the thread's Docker holds the database already: the embedded one is
#   cached for every checkout on the computer, where each thread's Docker downloads
#   PostgreSQL's image into its own (646 MB, 13 seconds on a cloud computer).
# Also embedded when Docker answers but cannot start the container (a rootless daemon whose
# overlay mounts fail, say).
start_db() {
  db_answers && return
  local docker=
  if [ -f "$DATA/postgres/PG_VERSION" ]; then
    :
  elif [ -n "${BRIGADE_PREVIEW_URL:-}" ]; then
    if docker_holds_db; then docker=1; fi
  elif use_docker; then
    docker=1
  fi
  if [ -n "$docker" ] && (cd "$REPO" && docker compose up -d postgres); then
    :
  else
    [ -z "$docker" ] || say "Docker could not start PostgreSQL: using the embedded one"
    download_postgres || return 1
    PG_PACKAGE=$PG_CACHE/node_modules/embedded-postgres PG_DATA=$DATA/postgres PG_PORT=$DB_PORT \
      node "$HERE/postgres.mjs" &
  fi
  wait_for_db
}

# Returns when one of this shell's background jobs stops. Like `wait -n`, which
# macOS's bash 3.2 does not have.
wait_any() {
  local pids
  pids=$(jobs -p)
  while true; do
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null || return 0
    done
    sleep 2
  done
}
