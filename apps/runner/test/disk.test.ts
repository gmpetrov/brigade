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
const { freeCaches, oldStores, reserveSize } = await import('../src/disk.js')

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
