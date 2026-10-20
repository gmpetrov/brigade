import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ThreadSpec } from '@brigade/contracts'
import { instructions, MEMORY_CHARS } from '../src/instructions.js'

const lines = (n: number, word: string) =>
  Array.from({ length: n }, (_, i) => `- ${word} line ${i} ${'x'.repeat(80)}`).join('\n')

const testSpec = (project: string) =>
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
    teammates: [{ id: 'riley', name: 'Riley' }],
    project: {
      id: 'p1',
      name: 'Brigade',
      brief: '',
      memory: project,
      folder: null,
      repositories: [],
      connections: [],
    },
  })

test('a long memory shows its newest lines, and says older ones were left out', () => {
  const project = `# Brigade memory\n\n${lines(300, 'project')}\n- the newest project line`
  assert.ok(project.length > MEMORY_CHARS)
  const text = instructions(
    testSpec(project),
    { workspace: '# Workspace memory\n\n- a workspace line', teammate: '' },
    '/library',
    { ready: true },
  )
  const section = text.slice(text.indexOf('## Project memory: Brigade'), text.indexOf('## Memory'))
  assert.match(section, /^## Project memory: Brigade\n\n… \(\d+ older lines not shown/)
  assert.match(section, /- the newest project line\n/)
  assert.doesNotMatch(section, /- project line 0 /)
  assert.ok(section.length < MEMORY_CHARS + 300)
  // A short memory is shown as it is.
  assert.match(text, /## Workspace memory\n\n- a workspace line\n/)
})
