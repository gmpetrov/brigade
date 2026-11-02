#!/usr/bin/env bash
# Checks Run's sweep as it works in Brigade Computer Use: in an app opened with `open`, its own
# responsible process, a daemon a command detached (setsid, double fork, reparented to launchd,
# deaf to SIGTERM) is gone when `run` replies. `swift test` can't: its process belongs to the
# terminal's app. Asks for no permission and shows nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(mktemp -d /tmp/brigade-sweep-test.XXXXXX)"
trap 'rm -rf "$DIR"' EXIT
APP="$DIR/Sweep Test.app"
mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.brigade.computer-use.sweep-test</string>
<key>CFBundleExecutable</key><string>sweep-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
swiftc -O -o "$APP/Contents/MacOS/sweep-test" \
  Sources/BrigadeComputerUse/Run.swift Sources/BrigadeComputerUse/Server.swift Tests/sweep/main.swift
codesign --force --sign - "$APP" 2>/dev/null
open -g -W "$APP" --args "$DIR"
RESULT="$(cat "$DIR/result" 2>/dev/null || echo "no result")"
if [ "$RESULT" = ok ]; then echo "sweep: ok"; else echo "sweep failed: $RESULT" >&2; exit 1; fi
