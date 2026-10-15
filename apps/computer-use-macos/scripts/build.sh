#!/usr/bin/env bash
# Build "Brigade Computer Use.app" into build/, signed; --install also copies it
# to ~/Applications, where the runner looks for it.
#
# Signing: BRIGADE_SIGN_IDENTITY (e.g. "Developer ID Application: …"), else the
# first Developer ID Application identity in the keychain, else ad hoc. macOS
# ties Screen Recording and Accessibility to the signature: with an ad hoc
# signature every rebuild asks for them again; with a Developer ID it does not.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname)" != Darwin ]; then
  echo "Brigade Computer Use is macOS only; skipping." >&2
  exit 0
fi
NAME="Brigade Computer Use"
APP="build/$NAME.app"
swift build -c release --arch arm64 --arch x86_64 >&2
BIN="$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/BrigadeComputerUse"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp "$BIN" "$APP/Contents/MacOS/brigade-computer-use"
IDENTITY="${BRIGADE_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null |
  sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)}"
if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
else
  echo "No Developer ID identity: signing ad hoc (macOS will ask for permissions again after each rebuild)." >&2
  codesign --force --sign - "$APP"
fi
codesign --verify --strict "$APP"
if [ "${1:-}" = --install ]; then
  mkdir -p "$HOME/Applications"
  # Quit a running copy first, so the next request starts the new one.
  pkill -x brigade-computer-use 2>/dev/null || true
  rm -rf "$HOME/Applications/$NAME.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "$HOME/Applications/$NAME.app"
else
  echo "$PWD/$APP"
fi
