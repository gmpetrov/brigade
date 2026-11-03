import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// The runner's pnpm shim, which the harness's environment writes, somewhere of the test's own.
process.env.BRIGADE_SHIM_DIR = await mkdtemp(join(tmpdir(), 'shared-bridges-shims-'))
// As on a cloud computer, with shared copies under a folder of the test's own. Nothing here
// installs a real bridge: those tests that turn sharing on call the scripts themselves.
process.env.BRIGADE_CLOUD = '1'
process.env.BRIGADE_BRIDGES_DIR = await mkdtemp(join(tmpdir(), 'shared-bridges-root-'))
const { createHarnessSandboxTemplate } = await import('@ai-sdk/harness/agent')
const { harnessEnv } = await import('../src/harness/env.js')
const { createLocalSandboxSession } = await import('../src/harness/local-sandbox.js')
const {
  bridgeLink,
  installInto,
  LINK_SCRIPT,
  linkTeammate,
  removeSuperseded,
  staleCopies,
  UNLINK_SCRIPT,
  useSharedBridge,
} = await import('../src/shared-bridges.js')
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

/** The scripts as the runner runs them as a teammate (Exec), here as this user. */
const exec = (script: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile('sh', ['-c', script, 'sh', ...args], (error, stdout) =>
      error ? reject(Object.assign(error, { stdout })) : resolve(stdout),
    ),
  )

/** A process whose command line names a file in the folder, as a bridge started through it. */
async function bridgeFrom(folder: string, t: { after: (fn: () => void) => void }) {
  const child = spawn('sh', ['-c', 'sleep 60', `${folder}/bridge.mjs`], { stdio: 'ignore' })
  t.after(() => void child.kill())
  await new Promise((resolve) => setTimeout(resolve, 100))
  return {
    pid: child.pid!,
    stop: async () => {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

test('moving a link on says which of its bridges still run from the copy it left', async (t) => {
  const { root, folder, shared } = await setup(t)
  const older = join(root, 'bridges', 'claude-code-99999999', 'claude-code')
  await mkdir(older, { recursive: true })
  await mkdir(join(folder, '..'), { recursive: true })
  await symlink(older, folder)
  const bridge = await bridgeFrom(folder, t)
  const moved = link(folder, shared, false)
  assert.equal(moved.status, 0)
  assert.equal(moved.stdout.trim(), `held ${older} ${bridge.pid}`)
  assert.equal(readlinkSync(folder), shared)
})

test("an older shared copy stays while a bridge started through a teammate's link runs from it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-bridges-old-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const older = join(root, 'claude-code-99999999')
  const newer = join(root, 'claude-code-0123abcd')
  await mkdir(bridgeLink(older, 'claude-code'), { recursive: true })
  await mkdir(bridgeLink(newer, 'claude-code'), { recursive: true })
  const folder = bridgeLink(join(root, 'bt-ada'), 'claude-code')
  await mkdir(join(folder, '..'), { recursive: true })
  await symlink(bridgeLink(older, 'claude-code'), folder)
  // Started through the link: its command line names the link, never the copy.
  const bridge = await bridgeFrom(folder, t)
  // The next turn moves the link on to the newer copy.
  assert.equal(
    await linkTeammate(folder, bridgeLink(newer, 'claude-code'), true, exec, root),
    'linked',
  )
  // Superseded two days ago.
  await writeFile(join(older, '.superseded'), '')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  await utimes(join(older, '.superseded'), twoDaysAgo, twoDaysAgo)
  const tidy = (linked: string[], processes = '') =>
    removeSuperseded({
      root,
      current: new Set(['claude-code-0123abcd']),
      linked,
      processes,
      now: Date.now(),
    })
  await tidy([bridgeLink(newer, 'claude-code')])
  assert.ok(existsSync(older), 'kept while the bridge runs')
  await bridge.stop()
  // Another teammate's link to it, or a process naming it, keeps it too.
  await tidy([bridgeLink(older, 'claude-code')])
  assert.ok(existsSync(older))
  await tidy([], `/usr/bin/claude-x ${older}/.ai-sdk-harness/x`)
  assert.ok(existsSync(older))
  await tidy([bridgeLink(newer, 'claude-code')])
  assert.ok(!existsSync(older), 'gone once nothing holds it')
  assert.ok(existsSync(newer))
})

test("shared bridges turned off: a teammate's link is taken away, and its turn installs in its home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shared-bridges-off-'))
  t.after(async () => {
    delete process.env.BRIGADE_SHARED_BRIDGES
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true })
  })
  // Linked while they were on, to a copy that has no marker for this recipe, read-only.
  const copy = bridgeLink(join(root, 'bridges', 'claude-code-99999999'), 'claude-code')
  await mkdir(copy, { recursive: true })
  spawnSync('chmod', ['-R', 'a-w', join(root, 'bridges')])
  const home = join(root, 'bt-ada')
  assert.equal(link(bridgeLink(home, 'claude-code'), copy).status, 0)
  process.env.BRIGADE_SHARED_BRIDGES = '0'
  assert.equal(await useSharedBridge('bt-ada', 'claude-code', { home, exec }), 'own')
  assert.ok(!existsSync(bridgeLink(home, 'claude-code')))
  await prepareAs(home)
  assert.ok(lstatSync(bridgeLink(home, 'claude-code')).isDirectory())
})

/** Shared copies under a root of the test's own: an older one, superseded two days ago, and the current one. */
async function copies(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'shared-bridges-moves-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'bridges')
  const older = join(root, 'claude-code-99999999')
  const newer = bridgeLink(join(root, 'claude-code-0123abcd'), 'claude-code')
  await mkdir(bridgeLink(older, 'claude-code'), { recursive: true })
  await mkdir(newer, { recursive: true })
  await writeFile(join(older, '.superseded'), '')
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
  await utimes(join(older, '.superseded'), twoDaysAgo, twoDaysAgo)
  /** A teammate's folder linked to the older copy. */
  const teammate = async (name: string) => {
    const folder = bridgeLink(join(base, name), 'claude-code')
    await mkdir(join(folder, '..'), { recursive: true })
    await symlink(bridgeLink(older, 'claude-code'), folder)
    return folder
  }
  /** The tidy as the runner does it: where the folders point now, and what runs now. */
  const tidy = async (folders: string[]) =>
    removeSuperseded({
      root,
      current: new Set(['claude-code-0123abcd']),
      linked: folders.map((folder) => readlinkSync(folder)),
      processes: spawnSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).stdout,
      now: Date.now(),
    })
  return { root, older, newer, teammate, tidy }
}

test('teammates leaving the same copy at once are all noted as holding it', async (t) => {
  const { root, older, newer, teammate, tidy } = await copies(t)
  const folders = await Promise.all(['bt-ada', 'bt-bob', 'bt-cyd'].map(teammate))
  const bridges = await Promise.all(folders.map((folder) => bridgeFrom(folder, t)))
  // Each script returns only once all have run: their notes are then written together.
  const gates = new Map<string, { count: number; open: () => void; opened: Promise<void> }>()
  const together: typeof exec = async (script, args) => {
    const out = await exec(script, args)
    let gate = gates.get(script)
    if (!gate) {
      let open = () => {}
      const opened = new Promise<void>((resolve) => (open = resolve))
      gate = { count: 0, open, opened }
      gates.set(script, gate)
    }
    if (++gate.count === folders.length) gate.open()
    await gate.opened
    return out
  }
  await Promise.all(folders.map((folder) => linkTeammate(folder, newer, true, together, root)))
  const held = JSON.parse(await readFile(join(older, '.holders'), 'utf8')) as { pid: number }[]
  assert.deepEqual(held.map((h) => h.pid).sort(), bridges.map((b) => b.pid).sort())
  // Any one of them still running keeps it.
  await bridges[0]!.stop()
  await bridges[1]!.stop()
  await tidy(folders)
  assert.ok(existsSync(older))
  await bridges[2]!.stop()
  await tidy(folders)
  assert.ok(!existsSync(older))
})

test('a tidy right after a link moved on keeps the copy its bridge still runs from', async (t) => {
  const { root, older, newer, teammate, tidy } = await copies(t)
  const folder = await teammate('bt-ada')
  const bridge = await bridgeFrom(folder, t)
  // The tidy runs once the link has moved, before what the script printed is noted.
  const thenTidy: typeof exec = async (script, args) => {
    const out = await exec(script, args)
    if (script === LINK_SCRIPT) await tidy([folder])
    return out
  }
  await linkTeammate(folder, newer, true, thenTidy, root)
  assert.equal(readlinkSync(folder), newer)
  assert.ok(existsSync(older), 'kept: noted before the link moved')
  await bridge.stop()
  await tidy([folder])
  assert.ok(!existsSync(older))
})

test('a link stays where it is when what runs through it cannot be noted', async (t) => {
  const { root, older, newer, teammate, tidy } = await copies(t)
  const folder = await teammate('bt-ada')
  await bridgeFrom(folder, t)
  // Its note cannot be written there, as on a full disk.
  spawnSync('chmod', ['a-w', older])
  t.after(() => void spawnSync('chmod', ['u+w', older]))
  await assert.rejects(linkTeammate(folder, newer, true, exec, root), /could not note/)
  assert.equal(readlinkSync(folder), bridgeLink(older, 'claude-code'))
  // So a tidy finds the link still pointing there.
  spawnSync('chmod', ['u+w', older])
  await tidy([folder])
  assert.ok(existsSync(older))
})

test('a copy whose note of what runs from it cannot be read stays', async (t) => {
  const { older, tidy } = await copies(t)
  await writeFile(join(older, '.holders'), '[{"pid": 1, "sta')
  await tidy([])
  assert.ok(existsSync(older))
  await writeFile(join(older, '.holders'), '[]')
  await tidy([])
  assert.ok(!existsSync(older))
})

test('a link stays where it is when the note it would add to cannot be read', async (t) => {
  const { root, older, newer, teammate } = await copies(t)
  const folder = await teammate('bt-ada')
  await bridgeFrom(folder, t)
  await writeFile(join(older, '.holders'), 'not JSON')
  await assert.rejects(linkTeammate(folder, newer, true, exec, root), /cannot be read/)
  assert.equal(readlinkSync(folder), bridgeLink(older, 'claude-code'))
})
