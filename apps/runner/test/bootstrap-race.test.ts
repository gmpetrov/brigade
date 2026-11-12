import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

// The runner's pnpm shim, which the harness's environment writes, somewhere of the test's own.
process.env.BRIGADE_SHIM_DIR = await mkdtemp(join(tmpdir(), 'bootstrap-race-shims-'))
const { createHarnessSandboxTemplate } = await import('@ai-sdk/harness/agent')
const { harnessEnv } = await import('../src/harness/env.js')
const { createLocalSandboxSession } = await import('../src/harness/local-sandbox.js')

type Adapter = Parameters<typeof createHarnessSandboxTemplate>[0]['harnesses'][number]

/**
 * A recipe whose install takes a while and notes when it starts and ends: two of them side by
 * side in one folder is what broke a new member's first turns (ERR_PNPM_ENOTEMPTY).
 */
const slowAdapter = {
  harnessId: 'claude-code',
  getBootstrap: async () => ({
    harnessId: 'claude-code',
    bootstrapDir: '.harness-bootstrap/claude-code',
    files: [{ path: '.harness-bootstrap/claude-code/bridge.mjs', content: 'export {}\n' }],
    commands: [{ command: 'echo start >> runs.txt; sleep 0.3; echo end >> runs.txt' }],
  }),
} as unknown as Adapter

async function prepare(
  home: string,
  abortSignal = AbortSignal.timeout(30_000),
  adapter: Adapter = slowAdapter,
) {
  const template = await createHarnessSandboxTemplate({ harnesses: [adapter] })
  const session = createLocalSandboxSession({
    id: 'test',
    workingDirectory: home,
    port: 0,
    env: harnessEnv({ HOME: home }),
  })
  await template!.prepare({ session, abortSignal })
}

const runsIn = (home: string) =>
  readFile(join(home, '.ai-sdk-harness', '.harness-bootstrap', 'claude-code', 'runs.txt'), 'utf8')

test('two turns starting together on one computer install the harness once', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  await Promise.all([prepare(home), prepare(home), prepare(home)])

  // One install, never two side by side: the others waited, then found its marker.
  assert.equal(await runsIn(home), 'start\nend\n')
})

test('turns in different homes do not wait on each other', async (t) => {
  const a = await mkdtemp(join(tmpdir(), 'bootstrap-race-a-'))
  const b = await mkdtemp(join(tmpdir(), 'bootstrap-race-b-'))
  const log = join(await mkdtemp(join(tmpdir(), 'bootstrap-race-log-')), 'runs.txt')
  t.after(() =>
    Promise.all([a, b, dirname(log)].map((dir) => rm(dir, { recursive: true, force: true }))),
  )
  // Both installs note into one file: side by side, both start before either ends.
  const adapter = {
    harnessId: 'claude-code',
    getBootstrap: async () => ({
      harnessId: 'claude-code',
      bootstrapDir: '.harness-bootstrap/claude-code',
      files: [],
      commands: [{ command: `echo start >> '${log}'; sleep 0.5; echo end >> '${log}'` }],
    }),
  } as unknown as Adapter

  await Promise.all([prepare(a, undefined, adapter), prepare(b, undefined, adapter)])
  assert.equal(await readFile(log, 'utf8'), 'start\nstart\nend\nend\n')
})

test('a turn stopped while it waits stops waiting, and the install it waited on goes on', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'bootstrap-race-abort-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const first = prepare(home)
  const stop = new AbortController()
  const second = prepare(home, stop.signal)
  setTimeout(() => stop.abort(new Error('stopped')), 50)

  await assert.rejects(second, /stopped/)
  await first
  assert.equal(await runsIn(home), 'start\nend\n')
  // A later turn finds the marker and installs nothing.
  await prepare(home)
  assert.equal(await runsIn(home), 'start\nend\n')
})
