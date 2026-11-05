import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

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
const {
  freeCaches,
  homeEntries,
  installs,
  largest,
  largestInHomes,
  LARGEST_MIN,
  npxInUse,
  oldStores,
  reserveSize,
  restoring,
  RESTORE_MAX_MS,
  runsMintlify,
  tidyHome,
} = await import('../src/disk.js')
const { diskReport } = await import('../src/folders.js')

test('the reserve is 2 GiB, or 3% of a small disk', () => {
  assert.equal(reserveSize(69 * 1024 ** 3), 2 * 1024 ** 3)
  assert.equal(reserveSize(20 * 1024 ** 3), Math.floor(20 * 1024 ** 3 * 0.03))
})

test('stores other than the one pnpm uses now are old', () => {
  assert.deepEqual(oldStores(['v3', 'v10', 'tmp', ''], 'v10'), ['v3'])
  assert.deepEqual(oldStores(['v10'], 'v10'), [])
})

/** A home with these files in it, removed after the test. */
async function homeWith(t: TestContext, paths: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'disk-home-'))
  t.after(async () => {
    // A folder left read-only (Go's, when a test fails) would stop the removal.
    await chmodTree(home)
    await rm(home, { recursive: true, force: true })
  })
  for (const path of paths) {
    await mkdir(join(home, path, '..'), { recursive: true })
    await writeFile(join(home, path), 'x')
  }
  return home
}

/** Make every folder under `dir` writable again. */
async function chmodTree(dir: string) {
  await chmod(dir, 0o755).catch(() => {})
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory()) await chmodTree(join(dir, entry.name))
}

/** As Go leaves its modules: files and folders read-only, from `dir` down. */
async function readOnly(dir: string) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await readOnly(path)
    else await chmod(path, 0o444)
  }
  await chmod(dir, 0o555)
}

const GO_MODULE = 'go/pkg/mod/golang.org/x/text@v0.42.0/LICENSE'
const GO_TOOLCHAIN = 'go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.linux-amd64/bin/go'
const MINTLIFY_SITE = '.mintlify/previews/3333/mint/mint-version.txt'

test("a teammate's caches go, its threads and the tools it runs stay", async (t) => {
  const kept = [
    '.local/share/pnpm/store/v10/files/00/abc',
    '.npm/_npx/1234/package.json',
    '.cache/ms-playwright/chromium-1200/chrome',
    '.cargo/bin/cargo-watch',
    '.cargo/registry/index/index.crates.io-6f17d22bba15001f/config.json',
    'threads/cmthread1/app/node_modules/is-number/index.js',
    // What go install made, beside its modules.
    'go/bin/gopls',
    '.mintlify/preview-locks/.keep',
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
    GO_MODULE,
    GO_TOOLCHAIN,
    MINTLIFY_SITE,
    '.mintlify/previews/shared/mint/mint-version.txt',
  ]
  const home = await homeWith(t, [...kept, ...gone])
  await readOnly(join(home, 'go/pkg/mod'))

  await freeCaches(home, undefined, async () => ['node /usr/bin/next dev --port 3000', 'sh -c ls'])

  for (const path of kept) assert.ok(existsSync(join(home, path)), `${path} stays`)
  for (const path of gone) assert.ok(!existsSync(join(home, path)), `${path} goes`)
  assert.ok(!existsSync(join(home, 'go/pkg/mod')), "Go's modules go, folder and all")
  assert.match(await readFile(join(home, 'pnpm.log'), 'utf8'), /^store prune$/m)
})

test("Mintlify's site stays while a mint command runs", async (t) => {
  for (const processes of [
    ['sh -c pnpm dlx mint@4.2.1167 dev --port 3333'],
    ['node /home/bt-ada/.cache/pnpm/dlx/e331/1a1a-d25/node_modules/.bin/../mint/index.js dev'],
  ]) {
    const home = await homeWith(t, [MINTLIFY_SITE, GO_MODULE])
    await freeCaches(home, undefined, async () => processes)
    assert.ok(existsSync(join(home, MINTLIFY_SITE)), `kept with ${processes[0]}`)
    assert.ok(!existsSync(join(home, GO_MODULE)), 'the other caches go')
  }
})

test('a mint command started while the store was pruned keeps its site; one unknown too', async (t) => {
  // It starts once pnpm was asked to prune: the processes read before then had none.
  const home = await homeWith(t, [MINTLIFY_SITE])
  const pruned = async () =>
    (await readFile(join(home, 'pnpm.log'), 'utf8').catch(() => '')).includes('store prune')
  await freeCaches(home, undefined, async () =>
    (await pruned()) ? ['node /tmp/mint/index.js dev --port 3333'] : [],
  )
  assert.ok(existsSync(join(home, MINTLIFY_SITE)), 'its site stays')

  const unknown = await homeWith(t, [MINTLIFY_SITE])
  await freeCaches(unknown, undefined, async () => null)
  assert.ok(existsSync(join(unknown, MINTLIFY_SITE)), 'kept while the processes cannot be read')
})

test("Mintlify's CLI is told from its command lines", () => {
  for (const args of [
    'mint dev',
    'pnpm dlx mint@4.2.1167 dev --port 3333',
    'npx mintlify dev',
    'node /home/bt-ada/.npm/_npx/9f1c/node_modules/.bin/mint dev',
    'node /home/bt-ada/.cache/pnpm/dlx/e331/pkg/node_modules/mint/index.js broken-links',
  ])
    assert.ok(runsMintlify(args), args)
  for (const args of [
    'node /usr/bin/next dev',
    'pnpm dlx peppermint',
    'node mintlify-scraper.js',
    'cat docs/mint.json',
  ])
    assert.ok(!runsMintlify(args), args)
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

test('the disk is said full from 80% until it is back under 75%, and said again every 10 minutes', () => {
  const at = 1_000_000
  // Under 75%: not full; said once, then only every 10 minutes.
  const first = diskReport(undefined, 0.73, at)
  assert.deepEqual(first, { full: false, at })
  assert.equal(diskReport(first!, 0.78, at + 60_000), null)
  assert.deepEqual(diskReport(first!, 0.78, at + 10 * 60_000), {
    full: false,
    at: at + 10 * 60_000,
  })
  // From 80%: full at once, well before boat stops resuming the computer (90%).
  const full = diskReport(first!, 0.81, at + 60_000)
  assert.deepEqual(full, { full: true, at: at + 60_000 })
  // Still full down to 75%, then not.
  assert.equal(diskReport(full!, 0.76, at + 120_000), null)
  assert.deepEqual(diskReport(full!, 0.74, at + 120_000), { full: false, at: at + 120_000 })
  // A runner just started between the two says nothing: a full disk stays full.
  assert.equal(diskReport(undefined, 0.77, at), null)
  assert.deepEqual(diskReport(undefined, 0.74, at), { full: false, at })
})

test("a full disk names the largest entries of teammates' homes, hidden ones and thread folders too", async (t) => {
  const homes = await mkdtemp(join(tmpdir(), 'homes-'))
  t.after(() => rm(homes, { recursive: true, force: true }))
  const fill = async (path: string, bytes: number) => {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, Buffer.alloc(bytes, 1))
  }
  const MB = 1024 ** 2
  await fill(join(homes, 'a', 'threads', 't1', 'frames.yuv'), 6 * MB)
  await fill(join(homes, 'a', 'work', 'frames.yuv'), 4 * MB)
  await fill(join(homes, 'a', '.browser', 'profile'), 2 * MB)
  await fill(join(homes, 'a', 'note.txt'), 10)
  await fill(join(homes, 'b', 'clone', 'big'), 5 * MB)
  // A home that is not there adds nothing. Run as the runner itself here (no user).
  const found = await largestInHomes([undefined, undefined, undefined], {
    homeOf: (() => {
      const queue = ['a', 'b', 'gone']
      return () => join(homes, queue.shift()!)
    })(),
    count: 3,
    min: MB,
  })
  assert.deepEqual(
    found.map((e) => e.path.slice(homes.length + 1)),
    ['a/threads', 'b/clone', 'a/work'],
  )
  assert.ok(found[0]!.bytes >= 6 * MB)
  // Hidden entries count too; note.txt is under the minimum.
  const more = await largestInHomes([undefined], { homeOf: () => join(homes, 'a'), count: 9, min: MB })
  assert.deepEqual(
    more.map((e) => e.path.slice(homes.length + 1)),
    ['a/threads', 'a/work', 'a/.browser'],
  )
  assert.equal(LARGEST_MIN, 256 * MB)
})

test('du lines become paths under the home, largest first, at most some, none too small', () => {
  const entries = homeEntries(
    '4096\t./work\n12000000000\t./threads\nnot a line\n2700000000\t./with space\n',
    '/home/bt-1',
  )
  assert.deepEqual(entries, [
    { path: '/home/bt-1/work', bytes: 4096 },
    { path: '/home/bt-1/threads', bytes: 12e9 },
    { path: '/home/bt-1/with space', bytes: 2.7e9 },
  ])
  assert.deepEqual(
    largest(entries, 1).map((e) => e.path),
    ['/home/bt-1/threads'],
  )
  assert.deepEqual(
    largest(entries).map((e) => e.path),
    ['/home/bt-1/threads', '/home/bt-1/with space'],
  )
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
  await utimes(
    join(home, '.npm/_npx/dddd/package.json'),
    new Date(now - day),
    new Date(now - 30 * day),
  )
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

test("the disk is being restored from boat's mount at this boot until its hydration is done", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'disk-restore-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const at = (path: string, ms: number) => utimes(join(dir, path), ms / 1000, ms / 1000)
  const boot = Date.parse('2026-11-05T05:03:00Z')
  // Not boat: neither file.
  assert.equal(await restoring(dir, boot + 60_000, boot), false)
  // Mounted at this boot, the snapshot still copying in (Nov 5, 16 minutes after the resume).
  await writeFile(join(dir, 'mounted'), '')
  await at('mounted', boot + 20_000)
  assert.equal(await restoring(dir, boot + 16 * 60_000, boot), true)
  // A hydration-done left from an earlier boot does not end this one's restore.
  await writeFile(join(dir, 'hydration-done'), '')
  await at('hydration-done', boot - 3 * 60 * 60_000)
  assert.equal(await restoring(dir, boot + 16 * 60_000, boot), true)
  // Done (05:34:53).
  await at('hydration-done', boot + 31 * 60_000)
  assert.equal(await restoring(dir, boot + 32 * 60_000, boot), false)
  // A mount from an earlier boot, its hydration never done: not this boot's restore.
  await rm(join(dir, 'hydration-done'))
  assert.equal(await restoring(dir, boot + 8 * 60 * 60_000, boot + 7 * 60 * 60_000), false)
  // A restore said to run for longer than RESTORE_MAX_MS: taken as over, nothing held forever.
  assert.equal(await restoring(dir, boot + 20_000 + RESTORE_MAX_MS, boot), false)
})
