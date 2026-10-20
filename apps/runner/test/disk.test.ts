import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// A pnpm of our own where the runner looks for its shim: it says where its store is and logs
// what it is asked.
const shims = await mkdtemp(join(tmpdir(), 'disk-shims-'))
process.env.BRIGADE_SHIM_DIR = shims
await writeFile(
  join(shims, 'pnpm'),
  `#!/bin/sh
echo "$*" >>"$HOME/pnpm.log"
[ "$1 $2" = "store path" ] && echo "$HOME/.local/share/pnpm/store/v10"
exit 0
`,
  { mode: 0o755 },
)
const { freeCaches, installs, oldStores, reserveSize } = await import('../src/disk.js')
const { diskReport } = await import('../src/folders.js')

test('the reserve is 2 GiB, or 3% of a small disk', () => {
  assert.equal(reserveSize(69 * 1024 ** 3), 2 * 1024 ** 3)
  assert.equal(reserveSize(20 * 1024 ** 3), Math.floor(20 * 1024 ** 3 * 0.03))
})

test('stores other than the one pnpm uses now are old', () => {
  assert.deepEqual(oldStores(['v3', 'v10', 'tmp', ''], 'v10'), ['v3'])
  assert.deepEqual(oldStores(['v10'], 'v10'), [])
})

test("a teammate's caches go, its threads and the tools it runs stay", async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'disk-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = async (path: string) => {
    await mkdir(join(home, path, '..'), { recursive: true })
    await writeFile(join(home, path), 'x')
  }
  const kept = [
    '.local/share/pnpm/store/v10/files/00/abc',
    '.npm/_npx/1234/package.json',
    '.cache/ms-playwright/chromium-1200/chrome',
    'threads/cmthread1/app/node_modules/is-number/index.js',
  ]
  const gone = [
    '.local/share/pnpm/store/v3/files/00/abc',
    '.npm/_cacache/content-v2/sha512/ab',
    '.cache/yarn/v6/pkg',
    '.cache/pip/http/a',
    '.cache/go-build/00/a',
  ]
  for (const path of [...kept, ...gone]) await file(path)

  await freeCaches(home)

  for (const path of kept) assert.ok(existsSync(join(home, path)), `${path} stays`)
  for (const path of gone) assert.ok(!existsSync(join(home, path)), `${path} goes`)
  assert.match(await readFile(join(home, 'pnpm.log'), 'utf8'), /^store prune$/m)
})

test('a package manager installing is told from one running something', () => {
  for (const args of [
    'node /usr/local/bin/pnpm install',
    '/opt/brigade/bin/shims/pnpm',
    'node /home/bt-a/.local/share/pnpm/.tools/pnpm/10.34.6/bin/pnpm.cjs --filter web add zod',
    'pnpm i --frozen-lockfile',
    'npm ci',
    'node /usr/lib/node_modules/npm/bin/npm-cli.js install',
    'sh -c pnpm install',
    'pnpm dlx create-next-app',
    'uv pip install requests',
    'yarn',
    'pnpm --dir test install',
    'pnpm -C build install',
    'python3 -m pip3.12 install requests',
    'go build ./...',
    'go mod download',
  ])
    assert.equal(installs(args), true, args)
  for (const args of [
    'node /usr/local/bin/pnpm exec next dev --port 3005',
    'pnpm run build',
    'pnpm --filter web dev',
    'npm exec @modelcontextprotocol/server-github',
    'npx -y @playwright/mcp',
    'node /opt/brigade/runner/dist/index.js start',
    'npm',
    'pnpm exec prettier --write install.md',
    'pnpm --filter web dev',
    'go version',
  ])
    assert.equal(installs(args), false, args)
})

test('the disk is said full from 85% until it is back under 80%, and said again every 10 minutes', () => {
  const at = 1_000_000
  // Under 80%: not full; said once, then only every 10 minutes.
  const first = diskReport(undefined, 0.78, at)
  assert.deepEqual(first, { full: false, at })
  assert.equal(diskReport(first!, 0.83, at + 60_000), null)
  assert.deepEqual(diskReport(first!, 0.83, at + 10 * 60_000), {
    full: false,
    at: at + 10 * 60_000,
  })
  // From 85%: full at once.
  const full = diskReport(first!, 0.86, at + 60_000)
  assert.deepEqual(full, { full: true, at: at + 60_000 })
  // Still full down to 80%, then not.
  assert.equal(diskReport(full!, 0.81, at + 120_000), null)
  assert.deepEqual(diskReport(full!, 0.79, at + 120_000), { full: false, at: at + 120_000 })
  // A runner just started between the two says nothing: an open ticket stays open.
  assert.equal(diskReport(undefined, 0.82, at), null)
  assert.deepEqual(diskReport(undefined, 0.79, at), { full: false, at })
})
