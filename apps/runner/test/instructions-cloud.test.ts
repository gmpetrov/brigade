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
  assert.match(text(true), /## Heavy work\n\nThis thread has a machine of its own/)
  // A skill's own steps (a render it shows run here) go there too.
  assert.match(text(true), /even where a skill shows it run here: renders and\s+encodes/)
  // Code work stays on the shared computer: starting the machine takes longer than a typecheck.
  assert.match(text(true), /Code work stays here, whatever the repository/)
  assert.match(text(true), /run_on_machine/)
  assert.doesNotMatch(text(false), /Heavy work|run_on_machine/)
})

test('a teammate that may save to the library saves renders there from the machine; one that may not, brings them back', () => {
  const text = (library: 'read' | 'read_write') => {
    const spec = ThreadSpec.parse({
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
      machine: true,
      library,
    })
    const memory = threadMemory(spec, { workspace: '', teammate: '', lines: {} }, '/t', new Date())
    return instructions(spec, memory, '/library', { ready: true })
  }
  assert.match(
    text('read_write'),
    /Save what it makes for the library \(a render, a video\) straight from there with `library`/,
  )
  assert.match(text('read_write'), /never by bringing it back to save it/)
  assert.doesNotMatch(text('read'), /straight from there with `library`/)
  assert.match(text('read'), /Name in `outputs` the files you need back here \(a render/)
})
