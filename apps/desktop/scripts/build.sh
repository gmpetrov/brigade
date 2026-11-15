#!/usr/bin/env bash
# Builds Brigade.app for this platform into release/out (electron-builder.config.cjs):
#   macOS: Brigade.dmg and the update .zip, universal, with Brigade Computer Use.app inside;
#   Windows: Brigade-Setup.exe; Linux: Brigade-x86_64.AppImage and a .deb.
# Signing and notarization on macOS come from electron-builder's variables when set: CSC_LINK
# and CSC_KEY_PASSWORD (the Developer ID certificate), APPLE_API_KEY (a .p8 file),
# APPLE_API_KEY_ID and APPLE_API_ISSUER. Without them, a Developer ID in the keychain signs it,
# else nothing does (CSC_IDENTITY_AUTO_DISCOVERY=false skips the keychain).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" = Darwin ]; then
  # The computer-use helper goes inside Brigade.app, signed with the release's identity.
  BRIGADE_SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:-${BRIGADE_SIGN_IDENTITY:-}}" ../computer-use-macos/scripts/build.sh >&2
fi
node scripts/bundle.mjs
case "$(uname)" in
  Darwin) TARGET=--mac ;;
  Linux) TARGET=--linux ;;
  *) TARGET=--win ;;
esac
pnpm exec electron-builder "$TARGET" --config electron-builder.config.cjs --publish never "$@"
