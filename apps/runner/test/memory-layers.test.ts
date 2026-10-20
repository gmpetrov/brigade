import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLineKey } from '@brigade/contracts'
import {
  EARLIER_CORE,
  layerMemory,
  lineNote,
  memorySection,
  numberedMemory,
  threadMemory,
  threadTopicFiles,
} from '../src/memory-layers.js'

const now = new Date('2026-10-21T10:00:00Z')
const file = `# Brigade memory

- PRs are squash-merged.
- Esc never stops a run.

## Sidebar

What the sidebar shows and how it behaves.

- Control rows have no status dot.
- The ⋮ menu shows on hover.
`
const meta = {
  [memoryLineKey('PRs are squash-merged.')]: { at: '2026-10-15T09:00:00Z', legacy: true },
  [memoryLineKey('Esc never stops a run.')]: { at: '2026-10-19T09:00:00Z', by: 'Ada' },
  [memoryLineKey('The ⋮ menu shows on hover.')]: { at: '2025-12-02T09:00:00Z' },
}

test('each line ends with when it was learned or confirmed, and who wrote it when a person did', () => {
  assert.equal(lineNote({ at: '2026-10-19T09:00:00Z' }, now), ' (19 Oct)')
  assert.equal(lineNote({ at: '2025-12-02T09:00:00Z' }, now), ' (2 Dec 2025)')
  assert.equal(lineNote({ at: '2026-10-15T09:00:00Z', legacy: true }, now), ' (before 15 Oct)')
  assert.equal(lineNote({ at: '2026-10-19T09:00:00Z', by: 'Ada' }, now), ' (19 Oct, by Ada)')
  assert.equal(lineNote(undefined, now), '')
})

test('a thread loads the dated core, and its topics as files listed by name and size', () => {
  const layered = layerMemory(file, 'project', meta, now)
  assert.equal(
    memorySection(layered, '/work', 'project'),
    [
      '- PRs are squash-merged. (before 15 Oct)',
      '- Esc never stops a run. (19 Oct, by Ada)',
      '',
      'Topics, each in its own file: read one before work it bears on.',
      '- Sidebar: What the sidebar shows and how it behaves (2 lines, newest 2 Dec 2025): `/work/.brigade-memory/project/sidebar.md`',
    ].join('\n'),
  )
  const memory = threadMemory(
    {
      teammate: { id: 'riley', name: 'Riley' } as never,
      project: { id: 'p1', name: 'Brigade', memory: file } as never,
    },
    { workspace: '', teammate: '', lines: { 'projects/p1.md': meta } },
    '/work',
    now,
  )
  assert.deepEqual(
    threadTopicFiles(memory, {
      teammate: { name: 'Riley' },
      project: { name: 'Brigade' },
    } as never),
    [
      {
        path: 'project/sidebar.md',
        text: [
          '# Sidebar',
          '',
          'Memory of the project Brigade: What the sidebar shows and how it behaves.',
          '',
          '- Control rows have no status dot.',
          '- The ⋮ menu shows on hover. (2 Dec 2025)',
          '',
        ].join('\n'),
      },
    ],
  )
})

test('a core far past its budget keeps its newest lines and puts the others in a file', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `- Line ${i} ${'x'.repeat(80)}`)
  const flat = `# Brigade memory\n\n${lines.join('\n')}\n`
  // The first line was confirmed today: it is the newest, though first in the file.
  const dated = { [memoryLineKey(lines[0]!)]: { at: '2026-10-21T08:00:00Z' } }
  const layered = layerMemory(flat, 'project', dated, now)
  assert.ok(layered.coreChars <= 5_000 * 1.5)
  assert.equal(layered.core[0]!.text.startsWith('Line 0 '), true)
  assert.equal(layered.core.at(-1)!.text.startsWith('Line 119 '), true)
  const earlier = layered.topics[0]!
  assert.equal(earlier.name, EARLIER_CORE)
  assert.equal(earlier.lines[0]!.text.startsWith('Line 1 '), true)
  assert.equal(layered.core.length + earlier.lines.length, 120)
})

test('two topic names that make the same file name get different files', () => {
  const layered = layerMemory('## Apps & MCP\n- a\n## Apps MCP\n- b\n', 'project', {}, now)
  assert.deepEqual(
    layered.topics.map((t) => t.slug),
    ['apps-mcp', 'apps-mcp-2'],
  )
})

test('a run reads a file with every line numbered and dated, new lines dated today', () => {
  const numbered = numberedMemory(
    file,
    meta,
    now,
    new Set([memoryLineKey('Control rows have no status dot.')]),
  )
  assert.equal(
    numbered.text,
    [
      'Core:',
      '[1] PRs are squash-merged. (before 15 Oct)',
      '[2] Esc never stops a run. (19 Oct, by Ada)',
      '',
      'Topic "Sidebar": What the sidebar shows and how it behaves.',
      '[3] Control rows have no status dot. (21 Oct)',
      '[4] The ⋮ menu shows on hover. (2 Dec 2025)',
    ].join('\n'),
  )
  assert.deepEqual(numbered.lines, [
    'PRs are squash-merged.',
    'Esc never stops a run.',
    'Control rows have no status dot.',
    'The ⋮ menu shows on hover.',
  ])
})
