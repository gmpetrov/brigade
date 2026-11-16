import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScheduleOperation, ThreadSpec } from '@brigade/contracts'
import { instructions } from '../src/instructions.js'
import { threadMemory } from '../src/memory-layers.js'
import { themeTools, type ScheduleCaller } from '../src/harness/tools.js'

// Themes on the runner (docs/themes.md): a thread whose starter has them is told when to restyle
// Brigade; each tool sends an operation the API reads, and an older API's refusal says why.

const options = { toolCallId: 'call-1', messages: [] } as never

const spec = (themes: boolean, origin: 'member' | 'trigger' = 'member') =>
  ThreadSpec.parse({
    themes,
    origin,
    sessionId: 's1',
    teammate: { id: 'riley', name: 'Riley', instructions: '', harness: 'claude_code', model: null },
    permissionMode: 'allow-all',
    account: { id: 'a1', provider: 'claude_code', source: 'machine' },
    fallbacks: [],
  })

const text = (s: ThreadSpec) =>
  instructions(
    s,
    threadMemory(s, { workspace: '', teammate: '', lines: {} }, '/t', new Date()),
    '/library',
    { ready: true },
  )

test('a person with themes is told when to restyle Brigade; nobody else is', () => {
  assert.match(text(spec(true)), /## Brigade themes\n\n.*`theme_set`/)
  assert.doesNotMatch(text(spec(false)), /## Brigade themes/)
  assert.doesNotMatch(text(spec(true, 'trigger')), /## Brigade themes/)
})

test('each tool sends an operation the API reads', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = themeTools(async (call) => {
    sent.push(call)
    return {}
  })
  assert.deepEqual(Object.keys(tools).sort(), [
    'theme_add_file',
    'theme_read',
    'theme_set',
    'theme_undo',
  ])
  await tools.theme_read!.execute!({}, options)
  await tools.theme_set!.execute!({ theme: { name: 'Paper', canvas: '#f4efe6' } }, options)
  await tools.theme_set!.execute!({ id: 'none' }, options)
  await tools.theme_add_file!.execute!({ id: 'paper', path: 'paper.png' }, options)
  await tools.theme_undo!.execute!({ steps: 2 }, options)
  assert.deepEqual(
    sent.map((c) => c.operation),
    [
      { name: 'theme_read' },
      { name: 'theme_set', theme: { name: 'Paper', canvas: '#f4efe6' } },
      { name: 'theme_set', id: 'none' },
      { name: 'theme_add_file', id: 'paper', path: 'paper.png' },
      { name: 'theme_undo', steps: 2 },
    ],
  )
  for (const call of sent) assert.ok(ScheduleOperation.safeParse(call.operation).success)
})

test('an API from before themes: the teammate reads why, not a parse error', async () => {
  const tools = themeTools(async () => {
    throw new Error('Brigade could not read this call (invalid input). Try again differently.')
  })
  await assert.rejects(
    Promise.resolve(tools.theme_read!.execute!({}, options)),
    /does not have themes yet/,
  )
})
