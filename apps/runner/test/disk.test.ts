import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
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
const { freeCaches, installs, npxInUse, oldStores, reserveSize, tidyHome } = await import(
  '../src/disk.js'
)
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
    '.cargo/bin/cargo-watch',
    '.cargo/registry/index/index.crates.io-6f17d22bba15001f/config.json',
    'threads/cmthread1/app/node_modules/is-number/index.js',
  ]
  const gone = [
    '.local/share/pnpm/store/v3/files/00/abc',
    '.npm/_cacache/content-v2/sha512/ab',
    '.cache/yarn/v6/pkg',
    '.cache/pip/http/a',
    '.cache/go-build/00/a',
    '.bun/install/cache/0019245d1f12eeb3.npm/package.json',
    '.cargo/registry/cache/index.crates.io-6f17d22bba15001f/serde-1.0.0.crate',
    '.cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.0/lib.rs',
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
    'bun install',
    'bun add zod',
    '/home/bt-a/.cargo/bin/cargo build --release',
    'cargo t',
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
    'bun run dev',
    'cargo --version',
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

test("a teammate's old harness sessions and unused npx packages go, the rest stays", async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tidy-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const now = Date.now()
  const day = 24 * 60 * 60_000
  /** A file, its folders and itself last written (and read) that many days ago. */
  const file = async (path: string, daysAgo: number) => {
    const full = join(home, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, 'x')
    const when = new Date(now - daysAgo * day)
    let at = full
    while (at.length > home.length) {
      await utimes(at, when, when)
      at = join(at, '..')
    }
  }
  const runs = '.ai-sdk-harness/.agent-runs'
  await file(`${runs}/cmold/bridge/event-log.ndjson`, 4)
  await file(`${runs}/0b9a-uuid/bridge/start-config.json`, 5)
  // Written today, deep down: its folder's own time is old.
  await file(`${runs}/cmrecent/bridge/event-log.ndjson`, 4)
  await writeFile(join(home, runs, 'cmrecent/bridge/event-log.ndjson'), 'y')
  // Its thread is in use, and so is a side run of it.
  await file(`${runs}/cminuse/bridge/event-log.ndjson`, 9)
  await file(`${runs}/cminuse-title-1700000000000/bridge/event-log.ndjson`, 9)
  await file('.npm/_npx/aaaa/package.json', 20)
  await file('.npm/_npx/bbbb/package.json', 2)
  await file('.npm/_npx/cccc/package.json', 30)
  // Installed a month ago, run yesterday: running it read its manifest.
  await file('.npm/_npx/dddd/package.json', 30)
  await utimes(join(home, '.npm/_npx/dddd/package.json'), new Date(now - day), new Date(now - 30 * day))
  // Run from now, though not read for a month.
  const ps = `node ${home}/.npm/_npx/cccc/node_modules/.bin/mcp-server --stdio\nsh -c ls`
  await file('.npm/_cacache/index-v5/x', 40)

  const removed = await tidyHome(home, undefined, ['cminuse'], now, ps)
  assert.deepEqual(removed, { runs: 2, npx: 1 })
  const exists = (path: string) => existsSync(join(home, path))
  assert.ok(!exists(`${runs}/cmold`))
  assert.ok(!exists(`${runs}/0b9a-uuid`))
  assert.ok(exists(`${runs}/cmrecent`))
  assert.ok(exists(`${runs}/cminuse`))
  assert.ok(exists(`${runs}/cminuse-title-1700000000000`))
  assert.ok(!exists('.npm/_npx/aaaa'))
  assert.ok(exists('.npm/_npx/bbbb'))
  assert.ok(exists('.npm/_npx/cccc'))
  assert.ok(exists('.npm/_npx/dddd'))
  // Not its business: freeCaches clears it, when the disk fills.
  assert.ok(exists('.npm/_cacache/index-v5/x'))
})

test('the npx folders processes run from are read from their command lines', () => {
  assert.deepEqual(
    npxInUse(
      [
        'node /home/bt-ada/.npm/_npx/9f1c2a/node_modules/.bin/server',
        'npm exec @playwright/mcp',
        '/home/bt-bob/.npm/_npx/9f1c2a/node_modules/x/cli.js --port 3',
        'sh -c node /home/bt-bob/.npm/_npx/77/index.js',
      ].join('\n'),
    ),
    ['/.npm/_npx/9f1c2a', '/.npm/_npx/77'],
  )
})
