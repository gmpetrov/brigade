import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadSpec } from '@brigade/contracts'
import { memoryPrompt, parseMemory, readOnce, TIDY_AT } from '../src/memory.js'

const riley = { id: 'riley', name: 'Riley' }
const spec = (project: string, isPrivate = false) =>
  ({
    sessionId: 's1',
    teammate: { ...riley, harness: 'claude_code' },
    teammates: [riley],
    private: isPrivate,
    project: { id: 'p1', name: 'Brigade', memory: project },
  }) as unknown as ThreadSpec
const lines = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `- ${word} line ${i} ${'x'.repeat(80)}`).join('\n')
const entries = [
  { by: null, name: 'Member', text: 'Use violet for status dots.' },
  { by: 'riley', name: 'Riley', text: 'Done.' },
]

test('the memory run reads each memory file whole, however long', () => {
  const project = `# Brigade memory\n\n${lines(400, 'project')}\n- the newest project line`
  const prompt = memoryPrompt({
    spec: spec(project),
    entries,
    summary: undefined,
    memory: () => ({ workspace: '# Workspace memory\n\n- a', teammate: '# Riley\n\n- b' }),
    speakers: [riley],
  })
  assert.ok(project.length > TIDY_AT)
  assert.match(prompt, /- the newest project line/)
  assert.match(prompt, /Memory of the project "Brigade" now \(long: [\d,]+ characters, tidy it\):/)
  assert.match(prompt, /A file marked long no longer fits/)
  // Short files are not marked, and a run with no long file is not told to tidy.
  assert.match(prompt, /Workspace memory now:/)
  const short = memoryPrompt({
    spec: spec('# Brigade memory\n\n- c'),
    entries,
    summary: undefined,
    memory: () => ({ workspace: '- a', teammate: '- b' }),
    speakers: [riley],
  })
  assert.doesNotMatch(short, /tidy/)
})

test('a long file may take merged lines; a short one keeps to three new lines', () => {
  const answer = JSON.stringify({
    summary: 'Asked for violet dots.',
    workspace: { add: ['1', '2', '3', '4', '5'], remove: [] },
    project: { add: ['1', '2', '3', '4', '5', '6', '7'], remove: ['- project line 3'] },
    teammates: { Riley: { add: ['1', '2', '3', '4'], remove: [] } },
  })
  const update = parseMemory(answer, spec(lines(400, 'project')), [riley], () => ({
    workspace: '- a',
    teammate: '- b',
  }))
  assert.ok(update)
  assert.equal(update.workspace.add.length, 3)
  assert.equal(update.project?.add.length, 6)
  assert.deepEqual(update.project?.remove, ['- project line 3'])
  assert.equal(update.teammates[0]?.edit.add.length, 3)
})

test('a private thread is not asked to tidy what it may not edit', () => {
  const prompt = memoryPrompt({
    spec: spec(lines(400, 'project'), true),
    entries,
    summary: undefined,
    memory: () => ({ workspace: lines(400, 'workspace'), teammate: '- b' }),
    speakers: [riley],
  })
  assert.doesNotMatch(prompt, /tidy/)
})

test('a long file loses at most 20 lines to one run', () => {
  const answer = JSON.stringify({
    summary: 'x',
    workspace: { add: [], remove: [] },
    project: { add: [], remove: Array.from({ length: 40 }, (_, i) => `- project line ${i}`) },
    teammates: {},
  })
  const update = parseMemory(answer, spec(lines(400, 'project')), [riley], () => ({
    workspace: '- a',
    teammate: '- b',
  }))
  assert.equal(update?.project?.remove.length, 20)
})

test('a run’s answer is read against the memory it was shown, even if it changed meanwhile', () => {
  let live = lines(400, 'lesson')
  const memory = readOnce(() => ({ workspace: '- a', teammate: live }))
  const seen = memory('riley').teammate
  // Another run tidies the file below the threshold while this one runs.
  live = '- short'
  assert.equal(memory('riley').teammate, seen)
  const answer = JSON.stringify({
    summary: 'x',
    teammates: { Riley: { add: ['1', '2', '3', '4', '5', '6'], remove: ['- lesson line 1'] } },
  })
  // The file was long when the run read it: its merged lines are kept with its removals.
  assert.equal(parseMemory(answer, spec('- c'), [riley], memory)?.teammates[0]?.edit.add.length, 6)
})
