import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  changeMemoryFile,
  coreLength,
  layOutMemoryFile,
  memoryLineKey,
  MemoryLayout,
  parseMemoryFile,
  tidyTakesTooMuch,
  topicSlug,
} from '../dist/memory.js'

// As the dashboard's editor writes it: star bullets, blank lines around headings.
const file = `# Brigade memory

* PRs are squash-merged.
* Esc never stops a run.

## Sidebar

What the sidebar shows and how it behaves.

* Control rows have no status dot.
* The ⋮ menu shows on hover.

## Apps and MCP

* Stripe's MCP cannot delete webhooks.
`

test('a memory file reads as its core and its topics', () => {
  const layers = parseMemoryFile(file)
  assert.equal(layers.title, 'Brigade memory')
  assert.deepEqual(
    layers.core.map((l) => l.text),
    ['PRs are squash-merged.', 'Esc never stops a run.'],
  )
  assert.deepEqual(
    layers.topics.map((t) => [t.name, t.description, t.lines.length]),
    [
      ['Sidebar', 'What the sidebar shows and how it behaves.', 2],
      ['Apps and MCP', '', 1],
    ],
  )
  assert.equal(
    coreLength(layers),
    'PRs are squash-merged.'.length + 'Esc never stops a run.'.length + 6,
  )
})

test('a file with no topics is all core, and topics of one name read as one', () => {
  const flat = parseMemoryFile('# Workspace memory\n\n- One.\n- Two.\n')
  assert.deepEqual(
    flat.core.map((l) => l.text),
    ['One.', 'Two.'],
  )
  assert.deepEqual(flat.topics, [])
  const twice = parseMemoryFile('## Sidebar\n- One.\n## Other\n- Two.\n## sidebar\n- Three.\n')
  assert.deepEqual(
    twice.topics.map((t) => [t.name, t.lines.map((l) => l.text)]),
    [
      ['Sidebar', ['One.', 'Three.']],
      ['Other', ['Two.']],
    ],
  )
})

test('a line is known by its text, whatever its bullet, case or spacing', () => {
  assert.equal(
    memoryLineKey('* PRs are  squash-merged.'),
    memoryLineKey('- prs are squash-merged.'),
  )
  assert.equal(memoryLineKey('  + Two'), 'two')
  assert.equal(topicSlug('Apps & MCP: Google'), 'apps-mcp-google')
  assert.equal(topicSlug('Éditeur'), 'editeur')
})

test('a new line goes at the end of its topic, or of the core', () => {
  const { text, added } = changeMemoryFile(
    file,
    {
      add: [
        { text: 'Sections collapse by their title.', topic: 'sidebar' },
        { text: 'Reply in the member’s language.', topic: null },
      ],
    },
    50_000,
  )
  assert.equal(
    text,
    `# Brigade memory

* PRs are squash-merged.
* Esc never stops a run.
* Reply in the member’s language.

## Sidebar

What the sidebar shows and how it behaves.

* Control rows have no status dot.
* The ⋮ menu shows on hover.
* Sections collapse by their title.

## Apps and MCP

* Stripe's MCP cannot delete webhooks.
`,
  )
  assert.deepEqual(added, [
    { text: 'Sections collapse by their title.', topic: 'Sidebar' },
    { text: 'Reply in the member’s language.', topic: null },
  ])
})

test('a line for a new topic starts that topic at the end of the file', () => {
  const { text } = changeMemoryFile(file, { add: [{ text: 'Use R2.', topic: 'Storage' }] }, 50_000)
  assert.ok(text.endsWith("* Stripe's MCP cannot delete webhooks.\n\n## Storage\n\n* Use R2.\n"))
})

test('a removed line goes, a replaced one changes in place, a repeat is not added', () => {
  const { text, removed, replaced, added } = changeMemoryFile(
    file,
    {
      remove: ['- esc never stops a run.'],
      replace: [{ from: 'The ⋮ menu shows on hover.', to: 'The ⋮ menu shows on hover or focus.' }],
      add: [{ text: 'PRs are squash-merged.', topic: 'Sidebar' }],
    },
    50_000,
  )
  assert.match(text, /\* PRs are squash-merged\.\n\n## Sidebar/)
  assert.match(text, /\* The ⋮ menu shows on hover or focus\.\n/)
  assert.doesNotMatch(text, /Esc never stops/)
  assert.deepEqual(removed, [{ text: 'Esc never stops a run.', topic: null }])
  assert.deepEqual(replaced, [
    {
      from: 'The ⋮ menu shows on hover.',
      to: 'The ⋮ menu shows on hover or focus.',
      topic: 'Sidebar',
    },
  ])
  assert.deepEqual(added, [])
})

test('a line replaced by one already in the file just goes', () => {
  const { text, removed, replaced } = changeMemoryFile(
    file,
    { replace: [{ from: 'Esc never stops a run.', to: 'PRs are squash-merged.' }] },
    50_000,
  )
  assert.doesNotMatch(text, /Esc never stops/)
  assert.equal((text.match(/squash-merged/g) ?? []).length, 1)
  assert.deepEqual(replaced, [])
  assert.deepEqual(removed, [{ text: 'Esc never stops a run.', topic: null }])
})

test('the first line of an empty memory goes under its title', () => {
  const { text } = changeMemoryFile(
    '# Workspace memory\n',
    { add: [{ text: 'One.', topic: null }] },
    50_000,
  )
  assert.equal(text, '# Workspace memory\n\n- One.\n')
  const topicsOnly = changeMemoryFile(
    '## Sidebar\n\n- A.\n',
    { add: [{ text: 'Core.', topic: null }] },
    50_000,
  )
  assert.equal(topicsOnly.text, '- Core.\n\n## Sidebar\n\n- A.\n')
})

test('a full file drops new lines and counts them', () => {
  const { text, dropped, added } = changeMemoryFile(
    file,
    { add: [{ text: 'One more line.', topic: null }] },
    file.length + 5,
  )
  assert.equal(text, file)
  assert.equal(dropped, 1)
  assert.deepEqual(added, [])
})

test('a tidy layout files lines into topics, merges repeats and archives what is outdated', () => {
  const flat = `# Brigade memory

- PRs are squash-merged.
- Collapsed sections show a yellow count.
- Collapsed sections show no count; a badge next to Home shows the total.
- Playbooks are called loops in code.
- The ⋮ menu shows on hover.
- Stripe's MCP cannot delete webhooks.
- Stripe MCP can't delete webhooks.
- A line the layout forgot.
`
  const layout = MemoryLayout.parse({
    core: ['PRs are squash-merged.'],
    topics: [
      {
        name: 'Sidebar',
        description: 'Read when changing the sidebar.',
        lines: [
          'Collapsed sections show no count; a badge next to Home shows the total.',
          'The ⋮ menu shows on hover.',
        ],
      },
    ],
    merge: [
      {
        from: ["Stripe's MCP cannot delete webhooks.", "Stripe MCP can't delete webhooks."],
        text: "Stripe's MCP server cannot delete webhooks.",
        topic: 'Apps and MCP',
      },
    ],
    archive: [
      {
        text: 'Collapsed sections show a yellow count.',
        reason: 'replaced by the badge next to Home',
      },
      { text: 'Playbooks are called loops in code.', reason: 'contradicts a newer line' },
    ],
  })
  const result = layOutMemoryFile(flat, layout)
  assert.equal(
    result.text,
    `# Brigade memory

- PRs are squash-merged.
- A line the layout forgot.

## Sidebar

Read when changing the sidebar.

- Collapsed sections show no count; a badge next to Home shows the total.
- The ⋮ menu shows on hover.

## Apps and MCP

- Stripe's MCP server cannot delete webhooks.
`,
  )
  assert.deepEqual(
    result.archived.map((a) => a.reason),
    ['replaced by the badge next to Home', 'contradicts a newer line'],
  )
  assert.equal(result.merged[0].from.length, 2)
  assert.deepEqual(
    result.moved.map((m) => m.topic),
    ['Sidebar', 'Sidebar'],
  )
  // Laid out again, a tidy file stays as it is.
  assert.equal(layOutMemoryFile(result.text, MemoryLayout.parse({})).text, result.text)
})

test('a topic whose last line goes, goes with it', () => {
  const { text } = changeMemoryFile(
    file,
    { remove: ["Stripe's MCP cannot delete webhooks."] },
    50_000,
  )
  assert.ok(text.endsWith('* The ⋮ menu shows on hover.\n'))
  assert.doesNotMatch(text, /Apps and MCP/)
  // Unless the same change puts a line in it.
  const kept = changeMemoryFile(
    file,
    {
      remove: ["Stripe's MCP cannot delete webhooks."],
      add: [{ text: 'Linear cannot delete issues.', topic: 'Apps and MCP' }],
    },
    50_000,
  )
  assert.ok(kept.text.endsWith('## Apps and MCP\n\n* Linear cannot delete issues.\n'))
})

test('a tidy layout can say one line again in today’s words', () => {
  const result = layOutMemoryFile(
    '# M\n\n- Playbooks show in the Automations page.\n',
    MemoryLayout.parse({
      merge: [
        {
          from: ['Playbooks show in the Automations page.'],
          text: 'Playbooks show in the Routines page.',
          topic: null,
        },
      ],
    }),
  )
  assert.equal(result.text, '# M\n\n- Playbooks show in the Routines page.\n')
  assert.equal(result.merged[0].from.length, 1)
})

test('a merge whose lines are not all still there is left out', () => {
  const text = '# M\n\n- One.\n- Two.\n'
  const result = layOutMemoryFile(
    text,
    MemoryLayout.parse({
      merge: [{ from: ['One.', 'Gone since.'], text: 'One and gone.', topic: null }],
    }),
  )
  assert.equal(result.text, text)
  assert.deepEqual(result.merged, [])
})

test('lines that go make room, and a correction that would overfill the file is not made', () => {
  const big = `# M\n\n- ${'a'.repeat(60)}\n- ${'b'.repeat(60)}\n`
  // Removing a line makes room for a new one of the same size.
  const swap = changeMemoryFile(
    big,
    { remove: ['a'.repeat(60)], add: [{ text: 'c'.repeat(60), topic: null }] },
    big.length,
  )
  assert.equal(swap.dropped, 0)
  assert.equal(swap.added.length, 1)
  // Growing a line past the limit is dropped, and the old line stays.
  const grow = changeMemoryFile(
    big,
    { replace: [{ from: 'b'.repeat(60), to: 'b'.repeat(90) }] },
    big.length,
  )
  assert.equal(grow.dropped, 1)
  assert.equal(grow.text, big)
})

test('a line said twice is removed or corrected everywhere it is', () => {
  const text = '# M\n\n- Old rule.\n\n## Topic\n\n- Old rule.\n- Other.\n'
  const removed = changeMemoryFile(text, { remove: ['Old rule.'] }, 50_000)
  assert.equal(removed.text, '# M\n\n## Topic\n\n- Other.\n')
  const corrected = changeMemoryFile(
    text,
    { replace: [{ from: 'Old rule.', to: 'Corrected rule.' }] },
    50_000,
  )
  assert.equal(corrected.text, '# M\n\n- Corrected rule.\n\n## Topic\n\n- Other.\n')
})

test('a tidy may not empty a small file either', () => {
  const eight = `# M\n\n${Array.from({ length: 8 }, (_, i) => `- Fact ${i}.`).join('\n')}\n`
  assert.equal(tidyTakesTooMuch(eight, '# M\n'), true)
  assert.equal(tidyTakesTooMuch(eight, eight.replace('- Fact 0.\n', '')), false)
})

test('the limit is checked on the file as written, separators and emptied topics included', () => {
  // The emptied topic's heading goes too: the new line fits in 17 characters.
  const room = changeMemoryFile(
    '# M\n\n## Old\n\n- a\n',
    { remove: ['a'], add: [{ text: 'new rule', topic: null }] },
    17,
  )
  assert.equal(room.dropped, 0)
  assert.equal(room.text, '# M\n\n- new rule\n')
  // The blank line under the title counts: 9 characters do not fit in 8.
  const tight = changeMemoryFile('# M\n', { add: [{ text: 'x', topic: null }] }, 8)
  assert.equal(tight.dropped, 1)
  assert.equal(tight.text, '# M\n')
})

test('the days memory shows after a line come off its text, and nothing else does', async () => {
  const { withoutShownDay } = await import('../dist/memory.js')
  assert.equal(
    withoutShownDay('Stripe connects live accounts. (30 Oct)'),
    'Stripe connects live accounts.',
  )
  // Copied twice, a past year, before a day, by a person.
  assert.equal(withoutShownDay('A line. (30 Oct) (29 Oct)'), 'A line.')
  assert.equal(withoutShownDay('A line. (2 Dec 2025)'), 'A line.')
  assert.equal(withoutShownDay('A line. (before 20 Oct, by Ada)'), 'A line.')
  // Brackets that are not a day stay, and so does a day inside the line.
  assert.equal(withoutShownDay('Runs 8 turns at once (not 4)'), 'Runs 8 turns at once (not 4)')
  assert.equal(withoutShownDay('Asked by Ada (by mail)'), 'Asked by Ada (by mail)')
  assert.equal(
    withoutShownDay('Since (30 Oct) PRs are squash-merged.'),
    'Since (30 Oct) PRs are squash-merged.',
  )
  assert.equal(withoutShownDay('Talks at 10 Oct.'), 'Talks at 10 Oct.')
})
