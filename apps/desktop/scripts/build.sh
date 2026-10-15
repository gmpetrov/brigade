#!/usr/bin/env bash
# Build Brigade.app and its .dmg (src-tauri/target/<target>/release/bundle).
#   TARGET: a Rust target (default: this Mac's); CI builds universal-apple-darwin.
# Signing and notarization use Tauri's variables when set: APPLE_SIGNING_IDENTITY,
# APPLE_API_ISSUER, APPLE_API_KEY, APPLE_API_KEY_PATH; update artifacts need
# TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD).
set -euo pipefail
cd "$(dirname "$0")/.."
# The computer-use helper goes inside Brigade.app, signed with the same identity.
BRIGADE_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-${BRIGADE_SIGN_IDENTITY:-}}" ../computer-use-macos/scripts/build.sh >&2
ARGS=()
[ -z "${TARGET:-}" ] || ARGS+=(--target "$TARGET")
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
pnpm tauri build "${ARGS[@]}"
