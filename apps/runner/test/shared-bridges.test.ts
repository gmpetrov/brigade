import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The runner's pnpm shim, which the harness's environment writes, somewhere of the test's own.
process.env.BRIGADE_SHIM_DIR = await mkdtemp(join(tmpdir(), 'shared-bridges-shims-'))
const { createHarnessSandboxTemplate } = await import('@ai-sdk/harness/agent')
const { harnessEnv } = await import('../src/harness/env.js')
const { createLocalSandboxSession } = await import('../src/harness/local-sandbox.js')
const { bridgeLink, installInto, LINK_SCRIPT, staleCopies, UNLINK_SCRIPT } =
  await import('../src/shared-bridges.js')
type Adapter = import('../src/shared-bridges.js').Adapter

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

test('a teammate without a bridge gets a link to the shared one', async (t) => {
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
  [
    'one of its bridges runs from it',
    (folder: string) => [`${folder}/bridge.mjs`, '--workdir', '/x'],
  ],
  [
    'the adapter is installing',
    () => ['install', '--frozen-lockfile', '--store-dir', '.pnpm-store'],
  ],
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

/** An adapter whose recipe is small: a bridge file, and a command that says what it ran as. */
const fakeAdapter = {
  harnessId: 'claude-code',
  getBootstrap: async () => ({
    harnessId: 'claude-code',
    bootstrapDir: '.harness-bootstrap/claude-code',
    files: [{ path: '.harness-bootstrap/claude-code/bridge.mjs', content: 'export {}\n' }],
    commands: [{ command: 'cat /proc/self/oom_score_adj > installed.txt' }],
  }),
} as unknown as Adapter

/** A teammate's turn as the harness starts it: its bootstrap applied in its home. */
async function prepareAs(home: string) {
  await mkdir(home, { recursive: true })
  const template = await createHarnessSandboxTemplate({ harnesses: [fakeAdapter] })
  const session = createLocalSandboxSession({
    id: 'test',
    workingDirectory: home,
    port: 0,
    env: harnessEnv({ HOME: home }),
  })
  await template!.prepare({ session, abortSignal: AbortSignal.timeout(30_000) })
}

test("a teammate's turn finds the shared bridge through its link, and writes nothing there", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-bridges-install-'))
  t.after(async () => {
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true })
  })
  const shared = await installInto(join(root, 'bridges'), 'claude-code', fakeAdapter)
  assert.ok(shared)
  assert.match(
    shared.dir,
    /bridges\/claude-code-[0-9a-f]+\/\.ai-sdk-harness\/\.harness-bootstrap\/claude-code$/,
  )
  // The adapter's install ran there, first to go when memory runs out, and left its marker.
  assert.equal((await readFile(join(shared.dir, 'installed.txt'), 'utf8')).trim(), '1000')
  assert.ok((await readdir(shared.dir)).some((name) => /^\.bootstrap-[0-9a-f]+\.ok$/.test(name)))

  // Read-only, as it is for a teammate.
  spawnSync('chmod', ['-R', 'a-w', join(root, 'bridges')])
  const home = join(root, 'bt-ada')
  const folder = bridgeLink(home, 'claude-code')
  assert.equal(link(folder, shared.dir).status, 0)
  await prepareAs(home)
  assert.equal(readlinkSync(folder), shared.dir)

  // Control: a teammate with no link installs in its home, as before.
  const other = join(root, 'bt-bob')
  await prepareAs(other)
  assert.ok(lstatSync(bridgeLink(other, 'claude-code')).isDirectory())
  assert.ok(existsSync(join(bridgeLink(other, 'claude-code'), 'installed.txt')))
})

test("a link to a shared copy of another recipe would fail the turn: it is the identity's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-bridges-install-'))
  t.after(async () => {
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true })
  })
  // A copy without this recipe's marker, read-only: the harness would install into it.
  const stale = join(root, 'bridges', 'claude-code-99999999', 'claude-code')
  await mkdir(stale, { recursive: true })
  spawnSync('chmod', ['-R', 'a-w', join(root, 'bridges')])
  const home = join(root, 'bt-ada')
  assert.equal(link(bridgeLink(home, 'claude-code'), stale).status, 0)
  await assert.rejects(prepareAs(home))
})
