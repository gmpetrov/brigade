import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryLineKey } from '@brigade/contracts'
import { inWords, needsTidy, tidyRun, type TidyFile } from '../src/memory-tidy.js'

const now = new Date('2026-10-21T10:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString()
const lines = (n: number, word = 'Line') =>
  Array.from({ length: n }, (_, i) => `- ${word} ${i} ${'x'.repeat(40)}`).join('\n')
const file = (text: string, extra: Partial<TidyFile> = {}): TidyFile => ({
  ref: { kind: 'project', projectId: 'p1' },
  scope: 'project',
  about: 'the memory of the project "Brigade"',
  text,
  meta: {},
  fresh: new Set(),
  lastTidied: null,
  ...extra,
})

test('a file is tidied when its core is past budget, when it was never sorted, or weekly when it changed', () => {
  // 120 lines of ~50 characters: a core past 5,000.
  assert.equal(needsTidy(file(`# M\n\n${lines(120)}\n`), now), true)
  // A short core with topics, never tidied but under 30 lines: left alone.
  assert.equal(needsTidy(file(`# M\n\n${lines(5)}\n\n## Topic\n\n${lines(10, 'T')}\n`), now), false)
  // Never tidied, 30 lines or more in topics: sorted once.
  assert.equal(needsTidy(file(`# M\n\n${lines(5)}\n\n## Topic\n\n${lines(30, 'T')}\n`), now), true)
  const sorted = `# M\n\n${lines(5)}\n\n## Topic\n\n${lines(30, 'T')}\n`
  // Tidied 2 days ago: not again, even with new lines.
  assert.equal(
    needsTidy(file(sorted, { lastTidied: hoursAgo(48), fresh: new Set(['x']) }), now),
    false,
  )
  // Tidied 8 days ago: again when a line changed since, not otherwise.
  assert.equal(
    needsTidy(file(sorted, { lastTidied: hoursAgo(8 * 24), fresh: new Set(['x']) }), now),
    true,
  )
  assert.equal(needsTidy(file(sorted, { lastTidied: hoursAgo(8 * 24) }), now), false)
  // Never twice within six hours, even past budget: a run that could not fix it waits.
  assert.equal(needsTidy(file(`# M\n\n${lines(120)}\n`, { lastTidied: hoursAgo(2) }), now), false)
})

const flat = `# Brigade memory

- PRs are squash-merged.
- Collapsed sections show a yellow count.
- Collapsed sections show no count; a badge next to Home shows the total.
- The ⋮ menu shows on hover.
- Stripe's MCP cannot delete webhooks.
- Stripe MCP can't delete webhooks.
`

test('a tidy run sees the file numbered and dated, with its budget, and its layout names lines by text', () => {
  const run = tidyRun(
    file(flat, {
      meta: {
        [memoryLineKey('PRs are squash-merged.')]: { at: '2026-10-15T09:00:00Z', by: 'Ada' },
      },
    }),
    now,
  )
  assert.match(
    run.prompt,
    /At most 5,000 characters in all, merged lines put in the core included \(the core has \d+ now\)/,
  )
  assert.match(run.prompt, /\[1\] PRs are squash-merged\. \(15 Oct, by Ada\)/)
  assert.match(run.prompt, /Today is 21 Oct 2026\./)
  const layout = run.parse(
    JSON.stringify({
      core: [1],
      topics: [{ name: 'Sidebar', description: 'Read when changing the sidebar.', lines: [3, 4] }],
      merge: [
        { lines: [5, 6], text: "Stripe's MCP server cannot delete webhooks.", topic: 'Apps' },
      ],
      archive: [{ line: 2, reason: 'A newer line replaced it.' }],
    }),
  )
  assert.deepEqual(layout, {
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
        topic: 'Apps',
      },
    ],
    archive: [
      { text: 'Collapsed sections show a yellow count.', reason: 'A newer line replaced it.' },
    ],
  })
})

test('a layout that would take most of the file away is not trusted', () => {
  const text = `# M\n\n${lines(40)}\n`
  const run = tidyRun(file(text), now)
  const all = Array.from({ length: 40 }, (_, i) => ({ line: i + 1, reason: 'old' }))
  assert.equal(run.parse(JSON.stringify({ archive: all })), null)
  assert.ok(run.parse(JSON.stringify({ archive: all.slice(0, 10) })))
  assert.equal(run.parse('no json here'), null)
})

test('reasons name the lines they point at by their text, not their number', () => {
  const lines = [
    'PRs are squash-merged.',
    'Collapsed sections show no count; a badge next to Home shows the total.',
  ]
  assert.equal(
    inWords('replaced by line 2', lines),
    'replaced by “Collapsed sections show no count; a badge next to Home shows the total.”',
  )
  assert.equal(
    inWords('repeats lines 1 and 2', lines),
    'repeats “PRs are squash-merged.” and “Collapsed sections show no count; a badge next to Home shows the total.”',
  )
  assert.equal(inWords('outdated since the rename', lines), 'outdated since the rename')
  assert.equal(inWords('replaced by line 9', lines), 'replaced by 9')
})
