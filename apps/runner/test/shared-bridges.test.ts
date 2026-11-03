import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LINK_SCRIPT, staleCopies, UNLINK_SCRIPT } from '../src/shared-bridges.js'

// The scripts as the runner runs them as a teammate, here as this user.
const link = (folder: string, shared: string, convert = true) =>
  spawnSync('sh', ['-c', LINK_SCRIPT, 'sh', folder, shared, convert ? 'convert' : ''], {
    encoding: 'utf8',
  })

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'shared-bridges-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'home', '.ai-sdk-harness', '.harness-bootstrap', 'claude-code')
  const shared = join(root, 'bridges', 'claude-code-0123abcd', 'claude-code')
  await mkdir(shared, { recursive: true })
  return { root, folder, shared }
}

/** A teammate's own install, as the adapter leaves it. */
async function ownCopy(folder: string) {
  await mkdir(join(folder, 'node_modules'), { recursive: true })
  await writeFile(join(folder, 'bridge.mjs'), '')
}

test("a teammate without a bridge gets a link to the shared one", async (t) => {
  const { folder, shared } = await setup(t)
  assert.equal(link(folder, shared).status, 0)
  assert.equal(readlinkSync(folder), shared)
  // Again: nothing to do.
  assert.equal(link(folder, shared).status, 0)
  assert.equal(readlinkSync(folder), shared)
})

test('a link to an older shared bridge is pointed at the new one', async (t) => {
  const { root, folder, shared } = await setup(t)
  const older = join(root, 'bridges', 'claude-code-99999999', 'claude-code')
  await mkdir(older, { recursive: true })
  await mkdir(join(folder, '..'), { recursive: true })
  await symlink(older, folder)
  // Even without convert: a bridge started from the older one keeps it.
  assert.equal(link(folder, shared, false).status, 0)
  assert.equal(readlinkSync(folder), shared)
  assert.ok(existsSync(older))
})

test("a teammate's own bridge is replaced by the link, and its files go", async (t) => {
  const { root, folder, shared } = await setup(t)
  await ownCopy(folder)
  assert.equal(link(folder, shared).status, 0)
  assert.equal(readlinkSync(folder), shared)
  const left = spawnSync('sh', ['-c', 'ls -a "$1"', 'sh', join(folder, '..')], { encoding: 'utf8' })
  assert.deepEqual(left.stdout.split('\n').filter(Boolean).sort(), ['.', '..', 'claude-code'])
  assert.ok(existsSync(root))
})

test("a teammate's own bridge stays unless asked to convert", async (t) => {
  const { folder, shared } = await setup(t)
  await ownCopy(folder)
  assert.equal(link(folder, shared, false).status, 3)
  assert.ok(lstatSync(folder).isDirectory())
  assert.ok(existsSync(join(folder, 'bridge.mjs')))
})

for (const [what, args] of [
  ['one of its bridges runs from it', (folder: string) => [`${folder}/bridge.mjs`, '--workdir', '/x']],
  ['the adapter is installing', () => ['install', '--frozen-lockfile', '--store-dir', '.pnpm-store']],
] as const)
  test(`a teammate's own bridge stays while ${what}`, async (t) => {
    const { folder, shared } = await setup(t)
    await ownCopy(folder)
    // A process whose command line says so, as `ps` shows it.
    const running = spawn('sh', ['-c', 'sleep 30', ...args(folder)], { stdio: 'ignore' })
    t.after(() => void running.kill())
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(link(folder, shared).status, 3)
    assert.ok(existsSync(join(folder, 'bridge.mjs')))
    running.kill()
    await new Promise((resolve) => running.once('exit', resolve))
    // Once it is gone, the link replaces it.
    assert.equal(link(folder, shared).status, 0)
    assert.equal(readlinkSync(folder), shared)
  })

test("without a shared bridge, a link is taken away and a teammate's own folder stays", async (t) => {
  const { folder, shared } = await setup(t)
  await mkdir(join(folder, '..'), { recursive: true })
  await symlink(shared, folder)
  const unlink = () => spawnSync('sh', ['-c', UNLINK_SCRIPT, 'sh', folder])
  assert.equal(unlink().status, 0)
  assert.ok(!existsSync(folder))
  await ownCopy(folder)
  assert.equal(unlink().status, 0)
  assert.ok(existsSync(join(folder, 'bridge.mjs')))
})

test('shared copies no current recipe names are stale', () => {
  assert.deepEqual(
    staleCopies(
      ['claude-code-0123abcd', 'claude-code-99999999', 'codex-aaaabbbb', 'notes', 'claude-code-x'],
      new Set(['claude-code-0123abcd', 'codex-aaaabbbb']),
    ),
    ['claude-code-99999999'],
  )
})
