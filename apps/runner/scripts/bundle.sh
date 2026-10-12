#!/usr/bin/env bash
# Build a self-contained runner bundle: dist + production node_modules.
# Output: apps/runner/bundle/brigade-runner.tgz, served by the API at /runner/bundle.tgz.
set -euo pipefail
cd "$(dirname "$0")/.."
# A clean environment: nested pnpm commands misbehave under `pnpm run`.
PNPM="env -i PATH=$PATH HOME=$HOME pnpm"
OUT=$(mktemp -d)
# Run quietly, but show the output of a step that fails.
quiet() {
  "$@" >"$OUT/log" 2>&1 || { cat "$OUT/log" >&2; rm -rf "$OUT"; exit 1; }
}
quiet $PNPM --filter @brigade/contracts build
quiet $PNPM --filter @brigade/runner build
quiet $PNPM --filter @brigade/runner --prod deploy "$OUT/runner"
rm -rf "$OUT/runner/src" "$OUT/runner/tsconfig.json" "$OUT/runner/scripts"
mkdir -p bundle
COPYFILE_DISABLE=1 tar --no-xattrs -czf bundle/brigade-runner.tgz -C "$OUT" runner
rm -rf "$OUT"
ls -la bundle/brigade-runner.tgz
