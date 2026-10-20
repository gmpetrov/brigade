import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLineKey, ThreadSpec } from '@brigade/contracts'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'

const now = new Date('2026-10-21T10:00:00Z')
const testSpec = (project: string, isPrivate = false) =>
  ThreadSpec.parse({
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
    teammates: [{ id: 'riley', name: 'Riley' }],
    private: isPrivate,
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

const project = `# Brigade memory

- PRs are squash-merged.

## Sidebar

What the sidebar shows and how it behaves.

- The ⋮ menu shows on hover.
`

test('a thread loads each memory’s dated core, and its topics by name, size and file', () => {
  const spec = testSpec(project)
  const memory = threadMemory(
    spec,
    {
      workspace: '# Workspace memory\n\n- Brand colour is violet.\n',
      teammate: '',
      lines: {
        'projects/p1.md': {
          [memoryLineKey('PRs are squash-merged.')]: { at: '2026-10-19T09:00:00Z' },
        },
      },
    },
    '/threads/s1',
    now,
  )
  const text = instructions(spec, memory, '/library', { ready: true })
  assert.match(text, /## Workspace memory\n\n- Brand colour is violet\.\n/)
  assert.match(
    text,
    /## Project memory: Brigade\n\n- PRs are squash-merged\. \(19 Oct\)\n\nTopics, each in its own file: read one before work it bears on\.\n- Sidebar: What the sidebar shows and how it behaves \(1 line\): `\/threads\/s1\/\.brigade-memory\/project\/sidebar\.md`\n/,
  )
  // Nothing learned yet: no section.
  assert.doesNotMatch(text, /## What you have learned/)
  assert.match(
    text,
    /## Memory\n\nEach memory line ends with the day it was learned or last confirmed/,
  )
  assert.match(text, /the newer one wins/)
  assert.doesNotMatch(text, /this thread is private/)
})

test('a private thread is told it writes only to its own memory', () => {
  const spec = testSpec(project, true)
  const memory = threadMemory(spec, { workspace: '', teammate: '' }, '/threads/s1', now)
  assert.match(
    instructions(spec, memory, '/library', { ready: true }),
    /\(this thread is private: only into your own memory\)/,
  )
})
