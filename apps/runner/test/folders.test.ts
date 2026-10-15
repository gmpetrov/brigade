import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { madeByOldPnpm, oldPnpmModules } from '../src/folders.js'

const wants = (packageManager?: string) => JSON.stringify({ name: 'app', packageManager })

// What each pnpm writes, cut down.
const PNPM_8_MODULES = `hoistPattern:
  - '*'
hoistedDependencies:
  /@esbuild/linux-x64/0.19.12:
    '@esbuild/linux-x64': private
layoutVersion: 5
nodeLinker: isolated
packageManager: pnpm@8.7.5
skipped:
  - /@esbuild/darwin-arm64/0.19.12
storeDir: /home/bt-ada/.local/share/pnpm/store/v3
virtualStoreDir: .pnpm
`
const PNPM_8_LOCK = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
`
const PNPM_10_MODULES = JSON.stringify(
  {
    hoistedDependencies: { 'is-number@6.0.0': { 'is-number': 'private' } },
    layoutVersion: 5,
    nodeLinker: 'isolated',
    packageManager: 'pnpm@10.34.6',
    skipped: ['@esbuild/darwin-arm64@0.19.12'],
    storeDir: '/home/bt-ada/.local/share/pnpm/store/v10',
    virtualStoreDir: '.pnpm',
  },
  null,
  2,
)
const PNPM_10_LOCK = `lockfileVersion: '9.0'
`
// pnpm 10 installed over pnpm 8's node_modules: its own metadata, pnpm 8's paths left in it.
const PNPM_10_OVER_8_MODULES = JSON.stringify(
  {
    hoistedDependencies: {
      '/@esbuild/linux-x64/0.19.12': { '@esbuild/linux-x64': 'private' },
      'is-number@6.0.0': { 'is-number': 'private' },
    },
    packageManager: 'pnpm@10.34.6',
    skipped: ['/@esbuild/darwin-arm64/0.19.12'],
    storeDir: '/home/bt-ada/.local/share/pnpm/store/v10',
  },
  null,
  2,
)

test('a node_modules pnpm 8 made, in a project asking for pnpm 10, is old', () => {
  assert.equal(
    madeByOldPnpm({
      packageJson: wants('pnpm@10.34.6'),
      modules: PNPM_8_MODULES,
      lock: PNPM_8_LOCK,
    }),
    true,
  )
  assert.equal(
    madeByOldPnpm({ packageJson: wants('pnpm@11.0.0+sha512.abc'), modules: PNPM_8_MODULES }),
    true,
  )
})

test('a pnpm 6.0 lockfile alone says pnpm 8 made it', () => {
  assert.equal(
    madeByOldPnpm({
      packageJson: wants('pnpm@10.34.6'),
      modules: 'virtualStoreDir: .pnpm\n',
      lock: PNPM_8_LOCK,
    }),
    true,
  )
})

test('pnpm 10 installed over pnpm 8 leaves it old', () => {
  assert.equal(
    madeByOldPnpm({
      packageJson: wants('pnpm@10.34.6'),
      modules: PNPM_10_OVER_8_MODULES,
      lock: PNPM_10_LOCK,
    }),
    true,
  )
})

test('a node_modules pnpm 10 made is kept', () => {
  assert.equal(
    madeByOldPnpm({
      packageJson: wants('pnpm@10.34.6'),
      modules: PNPM_10_MODULES,
      lock: PNPM_10_LOCK,
    }),
    false,
  )
})

test('a project still on pnpm 8, or saying nothing, keeps what pnpm 8 made', () => {
  for (const packageJson of [wants('pnpm@8.7.5'), wants(), wants('yarn@4.1.0'), '{', 'null'])
    assert.equal(madeByOldPnpm({ packageJson, modules: PNPM_8_MODULES, lock: PNPM_8_LOCK }), false)
})

async function folder(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-folders-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const gitInit = (dir: string) => execFileSync('git', ['init', '-q', dir])

test("a checkout's old node_modules go, its workspace packages' too; the rest stays", async (t) => {
  const workDir = await folder({
    // On pnpm 10 now, installed by pnpm 8.
    'brigade/package.json': wants('pnpm@10.34.6'),
    'brigade/.gitignore': 'node_modules\n.next\n',
    'brigade/node_modules/.modules.yaml': PNPM_8_MODULES,
    'brigade/node_modules/.pnpm/lock.yaml': PNPM_8_LOCK,
    'brigade/apps/web/package.json': '{"name":"web"}',
    'brigade/apps/web/node_modules/next/package.json': '{}',
    'brigade/apps/web/.next/cache/x': '',
    // Installed by pnpm 10.
    'fresh/package.json': wants('pnpm@10.34.6'),
    'fresh/.gitignore': 'node_modules\n',
    'fresh/node_modules/.modules.yaml': PNPM_10_MODULES,
    'fresh/node_modules/.pnpm/lock.yaml': PNPM_10_LOCK,
    // Still on pnpm 8.
    'legacy/package.json': wants('pnpm@8.7.5'),
    'legacy/.gitignore': 'node_modules\n',
    'legacy/node_modules/.modules.yaml': PNPM_8_MODULES,
  })
  t.after(() => rm(workDir, { recursive: true, force: true }))
  for (const repo of ['brigade', 'fresh', 'legacy']) gitInit(join(workDir, repo))

  assert.deepEqual((await oldPnpmModules(workDir)).sort(), [
    join(workDir, 'brigade/apps/web/node_modules'),
    join(workDir, 'brigade/node_modules'),
  ])
})

test('a folder without old node_modules has nothing to remove', async (t) => {
  const workDir = await folder({ 'notes.md': 'hello' })
  t.after(() => rm(workDir, { recursive: true, force: true }))
  assert.deepEqual(await oldPnpmModules(workDir), [])
})
