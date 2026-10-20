import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_MAX, MemoryEdit, MemoryLayout, memoryLineKey } from '@brigade/contracts'
import {
  applyMemoryEdit,
  applyMemoryLayout,
  planLineSync,
  rowKey,
  type LineContext,
  type LineRow,
} from '../src/memory-edit.js'

const file = [
  '# Brigade memory',
  '',
  '- Esc never stops a run.',
  '- PRs are squash-merged.',
  '',
  '## Sidebar',
  '',
  '- The ⋮ menu shows on hover.',
  '',
].join('\n')
const edit = (e: Partial<MemoryEdit>) => MemoryEdit.parse(e)

test('an old runner’s edit adds to the core and removes lines', () => {
  const result = applyMemoryEdit(
    file,
    edit({ add: ['Brand colour is violet.'], remove: ['- esc never stops a run.'] }),
  )
  assert.match(result.text, /- PRs are squash-merged\.\n- Brand colour is violet\.\n\n## Sidebar/)
  assert.deepEqual(result.removed, [{ text: 'Esc never stops a run.', topic: null }])
  assert.equal(result.added.length, 1)
})

test('a layered edit files new lines by topic, corrects in place and says why lines go', () => {
  const result = applyMemoryEdit(
    file,
    edit({
      lines: [{ text: 'Sections collapse by their title.', topic: 'Sidebar' }],
      replace: [
        { from: 'The ⋮ menu shows on hover.', to: 'The ⋮ menu shows on hover, always on phones.' },
      ],
      archive: [{ text: 'Esc never stops a run.', reason: 'The member reversed it on 20 Oct.' }],
      confirm: ['PRs are squash-merged.'],
    }),
  )
  assert.equal(
    result.text,
    [
      '# Brigade memory',
      '',
      '- PRs are squash-merged.',
      '',
      '## Sidebar',
      '',
      '- The ⋮ menu shows on hover, always on phones.',
      '- Sections collapse by their title.',
      '',
    ].join('\n'),
  )
  assert.equal(
    result.reasons.get(memoryLineKey('Esc never stops a run.')),
    'The member reversed it on 20 Oct.',
  )
  assert.equal(
    result.reasons.get(memoryLineKey('The ⋮ menu shows on hover.')),
    'Replaced by: The ⋮ menu shows on hover, always on phones.',
  )
  assert.ok(result.confirm.has(memoryLineKey('PRs are squash-merged.')))
})

test('a full file drops new lines and counts them', () => {
  const full = `# Memory\n\n- ${'x'.repeat(MEMORY_MAX - 20)}\n`
  const result = applyMemoryEdit(full, edit({ add: ['one more line', 'and another'] }))
  assert.equal(result.text, full)
  assert.equal(result.dropped, 2)
})

const now = new Date('2026-10-21T10:00:00Z')
const day = (d: number) => new Date(now.getTime() - d * 86_400_000)
const row = (text: string, extra: Partial<LineRow> = {}): LineRow => ({
  id: `row-${memoryLineKey(text)}`,
  key: rowKey(memoryLineKey(text)),
  text,
  topic: null,
  legacy: false,
  createdByType: 'teammate',
  createdById: 'riley',
  createdAt: day(5),
  confirmedAt: null,
  archivedAt: null,
  ...extra,
})
const context = (c: Partial<LineContext> = {}): LineContext => ({
  actor: { type: 'teammate', id: 'riley' },
  sessionId: 's1',
  reasons: new Map(),
  confirm: new Set(),
  sources: new Map(),
  now,
  ...c,
})

test('rows follow a thread’s edit: new lines dated now, gone lines archived with why', () => {
  const result = applyMemoryEdit(
    file,
    edit({
      lines: [{ text: 'Sections collapse by their title.', topic: 'Sidebar' }],
      archive: [{ text: 'Esc never stops a run.', reason: 'Reversed.' }],
      confirm: ['PRs are squash-merged.'],
    }),
  )
  const rows = [
    row('Esc never stops a run.'),
    row('PRs are squash-merged.'),
    row('The ⋮ menu shows on hover.', { topic: 'Sidebar' }),
  ]
  const plan = planLineSync(
    file,
    result.text,
    rows,
    context({ reasons: result.reasons, confirm: result.confirm }),
  )
  assert.deepEqual(
    plan.create.map((c) => [c.text, c.topic, c.createdById, c.sessionId, c.createdAt, c.legacy]),
    [['Sections collapse by their title.', 'Sidebar', 'riley', 's1', now, false]],
  )
  assert.deepEqual(
    plan.update.map((u) => [u.id, u.data.archivedReason ?? null, u.data.confirmedAt ?? null]),
    [
      ['row-prs are squash-merged.', null, now],
      ['row-esc never stops a run.', 'Reversed.', null],
    ],
  )
  assert.deepEqual(plan.delete, [])
})

test('lines that were there before dates were kept get legacy rows', () => {
  const plan = planLineSync(file, file, [], context())
  assert.equal(plan.create.length, 3)
  assert.ok(plan.create.every((c) => c.legacy && c.createdByType === null && !c.archivedAt))
})

test('a person taking out their own line moments after writing it leaves no archive', () => {
  const draft = row('Typo lin', {
    createdByType: 'member',
    createdById: 'm1',
    createdAt: new Date(now.getTime() - 60_000),
  })
  const old = row('PRs are squash-merged.')
  const before = '# Memory\n\n- Typo lin\n- PRs are squash-merged.\n'
  const after = '# Memory\n\n- Typo line\n'
  const plan = planLineSync(
    before,
    after,
    [draft, old],
    context({ actor: { type: 'member', id: 'm1' }, sessionId: null }),
  )
  assert.deepEqual(plan.delete, [draft.id])
  assert.deepEqual(
    plan.update.map((u) => [u.id, u.data.archivedReason, u.data.archivedByType]),
    [[old.id, 'Removed', 'member']],
  )
  assert.deepEqual(
    plan.create.map((c) => [c.text, c.createdByType, c.createdById]),
    [['Typo line', 'member', 'm1']],
  )
})

test('a line put back leaves the archive, and a merged line keeps the newest date of its sources', () => {
  const archived = row('Esc never stops a run.', { archivedAt: day(1) })
  const putBack = planLineSync('# M\n', '# M\n\n- Esc never stops a run.\n', [archived], context())
  assert.deepEqual(putBack.update, [
    {
      id: archived.id,
      data: {
        text: 'Esc never stops a run.',
        topic: null,
        archivedAt: null,
        archivedReason: null,
        archivedByType: null,
        archivedById: null,
        archivedSessionId: null,
        confirmedAt: now,
      },
    },
  ])

  const before =
    "# M\n\n- Stripe's MCP cannot delete webhooks.\n- Stripe MCP can't delete webhooks.\n"
  const layout = MemoryLayout.parse({
    merge: [
      {
        from: ["Stripe's MCP cannot delete webhooks.", "Stripe MCP can't delete webhooks."],
        text: "Stripe's MCP server cannot delete webhooks.",
        topic: 'Apps',
      },
    ],
  })
  const laid = applyMemoryLayout(before, layout)
  const rows = [
    row("Stripe's MCP cannot delete webhooks.", { createdAt: day(9) }),
    row("Stripe MCP can't delete webhooks.", { createdAt: day(3), confirmedAt: day(2) }),
  ]
  const plan = planLineSync(
    before,
    laid.text,
    rows,
    context({ reasons: laid.reasons, sources: laid.sources }),
  )
  assert.deepEqual(
    plan.create.map((c) => [c.text, c.topic, c.createdAt]),
    [["Stripe's MCP server cannot delete webhooks.", 'Apps', day(2)]],
  )
  assert.deepEqual(
    plan.update.map((u) => u.data.archivedReason),
    [
      "Merged into: Stripe's MCP server cannot delete webhooks.",
      "Merged into: Stripe's MCP server cannot delete webhooks.",
    ],
  )
})

test('a line of any length gets a row whose key fits the index', () => {
  const long = `A line pasted long: ${'x'.repeat(8000)}`
  const plan = planLineSync('# M\n', `# M\n\n- ${long}\n`, [], context())
  assert.equal(plan.create[0]?.key.length, 64)
  assert.equal(plan.create[0]?.text, long)
})

test('a line merged from lines older than dates in memory is still dated "before"', () => {
  const before =
    "# M\n\n- Stripe's MCP cannot delete webhooks.\n- Stripe MCP can't delete webhooks.\n"
  const laid = applyMemoryLayout(
    before,
    MemoryLayout.parse({
      merge: [
        {
          from: ["Stripe's MCP cannot delete webhooks.", "Stripe MCP can't delete webhooks."],
          text: "Stripe's MCP server cannot delete webhooks.",
          topic: null,
        },
      ],
    }),
  )
  const rows = [
    row("Stripe's MCP cannot delete webhooks.", {
      legacy: true,
      createdAt: day(1),
      createdByType: null,
    }),
    row("Stripe MCP can't delete webhooks.", {
      legacy: true,
      createdAt: day(1),
      createdByType: null,
    }),
  ]
  const plan = planLineSync(
    before,
    laid.text,
    rows,
    context({ reasons: laid.reasons, sources: laid.sources }),
  )
  assert.deepEqual(
    plan.create.map((c) => [c.legacy, c.createdAt]),
    [[true, day(1)]],
  )
})
