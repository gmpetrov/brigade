// The one-command runner install: `curl -fsSL <api>/runner/install.sh | sh`.
// Installs Node.js if needed (checksum-verified) and the runner into ~/.brigade. No root.
// A runner updates itself by running this same script (see apps/runner/src/updater.ts).
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { env } from '../config.js'

const NODE_VERSION = 'v24.18.1'

/** Exit code of a runner that replaced itself: the wrapper starts the new one. */
export const UPDATED_EXIT_CODE = 75

let cached: { key: string; sha256: string } | undefined

/**
 * SHA-256 of the runner bundle this API serves, or null when it is not built.
 * Runners installed from another bundle update to it.
 */
export async function runnerBundle(): Promise<string | null> {
  let key: string
  try {
    const stat = statSync(env.RUNNER_BUNDLE_PATH)
    key = `${stat.size}:${stat.mtimeMs}`
  } catch {
    return null
  }
  if (cached?.key !== key) {
    const sha256 = createHash('sha256')
      .update(await readFile(env.RUNNER_BUNDLE_PATH))
      .digest('hex')
    cached = { key, sha256 }
  }
  return cached.sha256
}

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
curl -fsSL -D "$T/headers" "$API/runner/bundle.tgz" -o "$T/runner.tgz"
EXPECTED=$(sed -n 's/^[Xx]-[Bb]undle-[Ss]ha256: *\\([0-9a-f]*\\).*/\\1/p' "$T/headers" | tail -1)
ACTUAL=$( (sha256sum "$T/runner.tgz" 2>/dev/null || shasum -a 256 "$T/runner.tgz") | cut -d' ' -f1)
[ -z "$EXPECTED" ] || [ "$EXPECTED" = "$ACTUAL" ] || { echo "Runner bundle checksum mismatch" >&2; exit 1; }
rm -rf "$DIR/runner.new" && mkdir -p "$DIR/runner.new"
tar -xzf "$T/runner.tgz" -C "$DIR/runner.new" --strip-components=1
# The bundle a runner was installed from: it updates when the API serves another.
echo "$ACTUAL" > "$DIR/runner.new/.bundle-sha256"
rm -rf "$T" "$DIR/runner.old" "$DIR/bin/shims"
[ ! -d "$DIR/runner" ] || mv "$DIR/runner" "$DIR/runner.old"
mv "$DIR/runner.new" "$DIR/runner"
rm -rf "$DIR/runner.old"
# Exit code ${UPDATED_EXIT_CODE}: the runner updated itself; start the new one.
cat > "$DIR/bin/brigade-runner.new" <<SH
#!/bin/sh
export BRIGADE_SUPERVISED=1
while :; do
  "$NODE" "$DIR/runner/dist/index.js" "\\$@"
  CODE=\\$?
  [ "\\$CODE" -eq ${UPDATED_EXIT_CODE} ] || exit "\\$CODE"
done
SH
chmod +x "$DIR/bin/brigade-runner.new"
mv "$DIR/bin/brigade-runner.new" "$DIR/bin/brigade-runner"
echo "Installed $DIR/bin/brigade-runner"
`

export const runnerInstall = new Hono()
  .get('/install.sh', (c) =>
    c.body(installScript(env.API_URL), 200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
    }),
  )
  .get('/bundle.tgz', async (c) => {
    let size: number
    try {
      size = statSync(env.RUNNER_BUNDLE_PATH).size
    } catch {
      throw new HTTPException(503, {
        message: 'The runner bundle is not built. Run: pnpm --filter @brigade/runner bundle',
      })
    }
    const sha256 = await runnerBundle()
    const body = Readable.toWeb(createReadStream(env.RUNNER_BUNDLE_PATH)) as ReadableStream
    return c.body(body, 200, {
      'content-type': 'application/gzip',
      'content-length': String(size),
      ...(sha256 ? { 'x-bundle-sha256': sha256 } : {}),
    })
  })
