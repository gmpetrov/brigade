#!/usr/bin/env bash
# Build a self-contained runner bundle: dist + production node_modules.
# Output: apps/runner/bundle/brigade-runner.tgz, served by the API at /runner/bundle.tgz.
set -euo pipefail
cd "$(dirname "$0")/.."
# A clean environment: nested pnpm commands misbehave under `pnpm run`.
PNPM="env -i PATH=$PATH HOME=$HOME pnpm"
$PNPM --filter @brigade/contracts build >/dev/null
$PNPM --filter @brigade/runner build >/dev/null
OUT=$(mktemp -d)
$PNPM --filter @brigade/runner --prod deploy "$OUT/runner" >/dev/null 2>&1
rm -rf "$OUT/runner/src" "$OUT/runner/tsconfig.json" "$OUT/runner/scripts"
mkdir -p bundle
COPYFILE_DISABLE=1 tar --no-xattrs -czf bundle/brigade-runner.tgz -C "$OUT" runner
rm -rf "$OUT"
ls -la bundle/brigade-runner.tgz
