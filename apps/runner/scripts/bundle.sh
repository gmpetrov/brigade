#!/usr/bin/env bash
# Build a self-contained runner bundle: dist + production node_modules.
# Output: apps/runner/bundle/brigade-runner.tgz, served by the API at /runner/bundle.tgz.
set -euo pipefail
cd "$(dirname "$0")/.."
# A clean environment: nested pnpm commands misbehave under `pnpm run`.
PNPM="env -i PATH=$PATH HOME=$HOME pnpm"
# A fixed folder, not mktemp's: pnpm writes it into the shims in node_modules/.bin.
OUT=/tmp/brigade-runner-bundle
rm -rf "$OUT" && mkdir -p "$OUT"
# Run quietly, but show the output of a step that fails.
quiet() {
  "$@" >"$OUT/log" 2>&1 || { cat "$OUT/log" >&2; rm -rf "$OUT"; exit 1; }
}
quiet $PNPM --filter @brigade/contracts build
quiet $PNPM --filter @brigade/runner build
quiet $PNPM --filter @brigade/runner --prod deploy "$OUT/runner"
# .modules.yaml is pnpm's record of the install, with its time and this machine's store path.
rm -rf "$OUT/runner/src" "$OUT/runner/tsconfig.json" "$OUT/runner/scripts" "$OUT/runner/node_modules/.modules.yaml"
mkdir -p bundle
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  # The same files give the same bundle, so runners update only when the runner changed
  # (each deploy of the API offers its bundle by SHA-256).
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$OUT" runner |
    gzip -n >bundle/brigade-runner.tgz
else
  COPYFILE_DISABLE=1 tar --no-xattrs -czf bundle/brigade-runner.tgz -C "$OUT" runner
fi
rm -rf "$OUT"
ls -la bundle/brigade-runner.tgz
