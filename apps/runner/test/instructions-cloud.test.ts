import assert from 'node:assert/strict'
import { test } from 'node:test'

// On a cloud computer (CLOUD is read once, as config.js loads): the instructions keep a
// teammate's files in its thread's folder, which Brigade trims and archives, where nothing
// frees what lies elsewhere in its home.
process.env.BRIGADE_CLOUD = '1'
const { ThreadSpec } = await import('@brigade/contracts')
const { instructions } = await import('../src/instructions.js')
const { threadMemory } = await import('../src/memory-layers.js')

test("on a cloud computer, a teammate keeps what it makes in its thread's folder", () => {
  const spec = ThreadSpec.parse({
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    teammates: [{ id: 'riley', name: 'Riley' }],
  })
  const memory = threadMemory(
    spec,
    { workspace: '', teammate: '', lines: {} },
    '/threads/s1',
    new Date('2026-11-05T12:00:00Z'),
  )
  const text = instructions(spec, memory, '/library', { ready: true })
  assert.match(
    text,
    /## Your files\n\nKeep everything you make for this thread in this thread's folder, your working directory: downloads, renders, clones/,
  )
  assert.match(text, /what lies outside them stays on the disk for good/)
  assert.match(text, /Delete large temporary files/)
})

test('a thread with a machine of its own says to run heavy work there; one without says nothing of it', () => {
  const spec = (machine: boolean) =>
    ThreadSpec.parse({
      sessionId: 's1',
      teammate: {
        id: 'riley',
        name: 'Riley',
        instructions: '',
        harness: 'claude_code',
        model: null,
      },
      permissionMode: 'allow-all',
      account: { id: 'a1', provider: 'claude_code', source: 'machine' },
      fallbacks: [],
      machine,
    })
  const text = (machine: boolean) =>
    instructions(
      spec(machine),
      threadMemory(
        spec(machine),
        { workspace: '', teammate: '', lines: {} },
        '/threads/s1',
        new Date(),
      ),
      '/library',
      { ready: true },
    )
  assert.match(text(true), /## Heavy work\n\nBesides this computer/)
  assert.match(text(true), /run_on_machine/)
  assert.doesNotMatch(text(false), /Heavy work|run_on_machine/)
})
