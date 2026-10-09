// The one-command runner install: `curl -fsSL <api>/runner/install.sh | sh`.
// Installs Node.js if needed (checksum-verified) and the runner into ~/.brigade. No root.
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { env } from '../config.js'

const NODE_VERSION = 'v24.18.1'

export const installScript = (apiUrl: string) => `#!/bin/sh
# Brigade runner installer. Installs into \${BRIGADE_INSTALL_DIR:-$HOME/.brigade}; needs curl and tar.
set -eu
API="${apiUrl}"
NODE_VERSION="${NODE_VERSION}"
DIR="\${BRIGADE_INSTALL_DIR:-\${BRIGADE_HOME:-$HOME/.brigade}}"
mkdir -p "$DIR/bin"

node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
if node_ok "$(command -v node || true)"; then
  NODE="$(command -v node)"
elif node_ok "$DIR/node/bin/node"; then
  NODE="$DIR/node/bin/node"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) P=linux-x64; EXT=tar.xz ;;
    Linux-aarch64) P=linux-arm64; EXT=tar.xz ;;
    Darwin-arm64) P=darwin-arm64; EXT=tar.gz ;;
    Darwin-x86_64) P=darwin-x64; EXT=tar.gz ;;
    *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  F="node-$NODE_VERSION-$P.$EXT"
  T=$(mktemp -d)
  echo "Installing Node.js $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$F" -o "$T/$F"
  EXPECTED=$(curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" | grep " $F\\$" | cut -d' ' -f1)
  ACTUAL=$( (sha256sum "$T/$F" 2>/dev/null || shasum -a 256 "$T/$F") | cut -d' ' -f1)
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || { echo "Node.js checksum mismatch" >&2; exit 1; }
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xf "$T/$F" -C "$DIR/node" --strip-components=1
  rm -rf "$T"
  NODE="$DIR/node/bin/node"
fi

echo "Installing the Brigade runner"
T=$(mktemp -d)
curl -fsSL "$API/runner/bundle.tgz" -o "$T/runner.tgz"
rm -rf "$DIR/runner.new" && mkdir -p "$DIR/runner.new"
tar -xzf "$T/runner.tgz" -C "$DIR/runner.new" --strip-components=1
rm -rf "$T" "$DIR/runner" "$DIR/bin/shims"
mv "$DIR/runner.new" "$DIR/runner"
cat > "$DIR/bin/brigade-runner" <<SH
#!/bin/sh
exec "$NODE" "$DIR/runner/dist/index.js" "\\$@"
SH
chmod +x "$DIR/bin/brigade-runner"
echo "Installed $DIR/bin/brigade-runner"
`

export const runnerInstall = new Hono()
  .get('/install.sh', (c) =>
    c.body(installScript(env.API_URL), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
    }),
  )
  .get('/bundle.tgz', (c) => {
    let size: number
    try {
      size = statSync(env.RUNNER_BUNDLE_PATH).size
    } catch {
      throw new HTTPException(503, {
        message: 'The runner bundle is not built. Run: pnpm --filter @brigade/runner bundle',
      })
    }
    const body = Readable.toWeb(createReadStream(env.RUNNER_BUNDLE_PATH)) as ReadableStream
    return c.body(body, 200, { 'content-type': 'application/gzip', 'content-length': String(size) })
  })
