import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LoggedResponse } from '@brigade/contracts'

// What turns spend, read from the harness's own logs (usage-scan.ts, usage-logs.ts).
const root = await mkdtemp(join(tmpdir(), 'usage-logs-'))
process.env.BRIGADE_HOME = join(root, 'brigade')
await mkdir(process.env.BRIGADE_HOME, { recursive: true })
const { projectFolder, scan } = await import('../src/usage-scan.js')
const { UsageLogs, localThread, cloudThread, loggedResponse, threadSource } =
  await import('../src/usage-logs.js')

const line = (value: unknown) => `${JSON.stringify(value)}\n`
/** A line of Claude Code's transcript for a block of a response. */
const block = (
  id: string,
  usage: Record<string, unknown>,
  { model = 'claude-opus-5-5', at = '2026-10-31T10:00:00.000Z' } = {},
) =>
  line({
    type: 'assistant',
    timestamp: at,
    requestId: `req_${id}`,
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage },
  })
const usage = (output: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: 2,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 50,
  output_tokens: output,
  ...extra,
})

test("each of a transcript's responses once, a subagent's included, read on from where it was", async () => {
  const config = join(root, 'claude')
  const thread = projectFolder('/home/bt-riley/threads/t1')
  const dir = join(config, 'projects', thread)
  await mkdir(join(dir, 's1', 'subagents'), { recursive: true })
  const log = join(dir, 's1.jsonl')
  const partial = block('msg_b', usage(9)).trimEnd()
  await writeFile(
    log,
    line({ type: 'user', timestamp: '2026-10-31T09:59:00.000Z', message: { content: 'go' } }) +
      // A response's blocks: the same input, the output growing to its final count.
      block('msg_a', usage(3)) +
      block('msg_a', usage(40, { output_tokens_details: { thinking_tokens: 7 } })) +
      // An error Claude Code wrote itself: no request behind it.
      block('msg_s', usage(0), { model: '<synthetic>' }) +
      // Still being written.
      partial.slice(0, 40),
  )
  await writeFile(
    join(dir, 's1', 'subagents', 'agent-1.jsonl'),
    block('msg_c', usage(5), { model: 'claude-haiku-5-5' }),
  )
  // A working directory that is no thread's.
  await mkdir(join(config, 'projects', '-Users-ada-code'), { recursive: true })
  await writeFile(join(config, 'projects', '-Users-ada-code', 'x.jsonl'), block('msg_z', usage(1)))
  const input = {
    configs: [{ dir: config, account: 'acc1' }],
    accountsDirs: [],
    prefixes: [projectFolder('/home/bt-riley/threads/')],
    max: 1000,
  }

  const first = await scan({ ...input, offsets: {} })
  assert.deepEqual(
    first.responses.map((r) => [r.id, r.model, r.input, r.cacheRead, r.cacheWrite, r.output]),
    [
      ['msg_a', 'claude-opus-5-5', 152, 100, 50, 40],
      ['msg_c', 'claude-haiku-5-5', 152, 100, 50, 5],
    ],
  )
  assert.equal(first.responses[0]!.reasoning, 7)
  assert.equal(first.responses[0]!.folder, thread)
  assert.equal(first.responses[0]!.account, 'acc1')
  assert.equal(first.more, false)
  // Up to its last whole line.
  const whole = (await readFile(log)).length - 40
  assert.equal(first.offsets[log]!.at, whole)

  // Read on: only what came since.
  await appendFile(log, `${partial.slice(40)}\n`)
  const next = await scan({ ...input, offsets: first.offsets })
  assert.deepEqual(
    next.responses.map((r) => [r.id, r.output]),
    [['msg_b', 9]],
  )
  assert.deepEqual(await scan({ ...input, offsets: { ...first.offsets, ...next.offsets } }), {
    responses: [],
    offsets: {},
    more: false,
  })

  // Written anew, shorter: read again from its start.
  await writeFile(log, block('msg_d', usage(2)))
  const anew = await scan({ ...input, offsets: { ...first.offsets, ...next.offsets } })
  assert.deepEqual(
    anew.responses.map((r) => r.id),
    ['msg_d'],
  )
})

test('a Codex rollout: each request once with its turn’s model, never a member’s own', async () => {
  const home = join(root, 'codex')
  const day = join(home, 'sessions', '2026', '10', '31')
  await mkdir(day, { recursive: true })
  const fixture = await readFile(new URL('./fixtures/codex-rollout.jsonl', import.meta.url), 'utf8')
  // Its two first turns on a model, then a compaction, then a third turn on another.
  await writeFile(
    join(day, 'rollout-a.jsonl'),
    fixture.replaceAll('/work/thread', '/home/bt-sam/threads/t2'),
  )
  const own = join(day, 'rollout-b.jsonl')
  await writeFile(own, fixture.replaceAll('/work/thread', '/Users/ada/code'))
  const input = {
    configs: [{ dir: home, account: 'acc2' }],
    accountsDirs: [],
    prefixes: [projectFolder('/home/bt-sam/threads/')],
    offsets: {},
    max: 1000,
  }
  const all = await scan(input)
  const thread = '01a192c9-9353-7b50-ad0b-1c16e767e3d8'
  assert.deepEqual(
    all.responses.map((r) => [
      r.provider,
      r.id,
      r.model,
      r.input,
      r.cacheRead,
      r.output,
      r.reasoning,
    ]),
    [
      ['codex', `${thread}:resp_fake_22`, 'fake-model-1', 23_000, 22_000, 230, 23],
      ['codex', `${thread}:resp_fake_23`, 'fake-model-1', 24_000, 23_000, 240, 24],
      ['codex', `${thread}:resp_fake_24`, 'fake-model-2', 25_000, 24_000, 250, 25],
    ],
  )
  assert.equal(all.responses[0]!.folder, projectFolder('/home/bt-sam/threads/t2'))
  // A rollout of no thread's is skipped to its end, without reading past its first line.
  assert.equal(all.offsets[own]!.at, (await readFile(own)).length)
  assert.equal(all.offsets[own]!.cwd, '/Users/ada/code')

  // One by one: the same, each turn's model kept from where the last read stopped.
  let offsets = {}
  const read: string[] = []
  for (let calls = 0; calls < 10; calls++) {
    const piece = await scan({ ...input, offsets, max: 1 })
    read.push(...piece.responses.map((r) => `${r.id.split(':')[1]} ${r.model}`))
    offsets = { ...offsets, ...piece.offsets }
    if (!piece.more) break
  }
  assert.deepEqual(read, [
    'resp_fake_22 fake-model-1',
    'resp_fake_23 fake-model-1',
    'resp_fake_24 fake-model-2',
  ])
})

test("a project folder is its thread's and teammate's", () => {
  const home = process.env.BRIGADE_HOME!
  assert.deepEqual(localThread(projectFolder(`${home}/teammates/cmteam1/threads/cmthread1`)), {
    teammateId: 'cmteam1',
    sessionId: 'cmthread1',
  })
  assert.equal(localThread(projectFolder('/Users/ada/code/brigade')), undefined)
  assert.deepEqual(cloudThread(projectFolder('/home/bt-cmteam1/threads/cmthread1')), {
    teammateId: 'cmteam1',
    sessionId: 'cmthread1',
  })
  assert.equal(cloudThread(projectFolder('/home/bt-cmteam1/.memory-runs/cmthread1')), undefined)
  // After a turn: just its thread's folder.
  const source = threadSource('cmteam1', 'cmthread1', `${home}/teammates/cmteam1/threads/cmthread1`)
  assert.deepEqual(source.input.folders, [
    projectFolder(`${home}/teammates/cmteam1/threads/cmthread1`),
  ])
})

test('a response as the API takes it: input with the cache, no thread no response', () => {
  const scanned = {
    provider: 'claude_code' as const,
    account: null,
    folder: 'f',
    id: 'msg_1',
    model: 'claude-opus-5-5',
    at: '2026-10-31T10:00:00.000Z',
    input: 152,
    cacheRead: 100,
    cacheWrite: 50,
    output: 40,
    reasoning: 7,
  }
  assert.deepEqual(loggedResponse(scanned, { sessionId: 's', teammateId: 't' }), {
    id: 'msg_1',
    sessionId: 's',
    teammateId: 't',
    provider: 'claude_code',
    model: 'claude-opus-5-5',
    at: '2026-10-31T10:00:00.000Z',
    inputTokens: 152,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    outputTokens: 40,
    reasoningTokens: 7,
  })
  assert.equal(loggedResponse(scanned, undefined), undefined)
  assert.equal(
    loggedResponse({ ...scanned, id: 'x'.repeat(300) }, { sessionId: 's', teammateId: 't' }),
    undefined,
  )
})

test('a log is moved past only once the API kept what it read', async () => {
  const config = join(root, 'claude-sent')
  const folder = projectFolder('/home/bt-riley/threads/t3')
  await mkdir(join(config, 'projects', folder), { recursive: true })
  await writeFile(
    join(config, 'projects', folder, 's.jsonl'),
    block('msg_1', usage(4)) + block('msg_2', usage(6)),
  )
  const stateFile = join(root, 'state', 'usage-logs.json')
  const sent: LoggedResponse[][] = []
  let fail = true
  const logs = new UsageLogs({
    stateFile,
    // As the runner runs it: its own process.
    sources: async () => [
      {
        input: {
          configs: [{ dir: config, account: 'acc1' }],
          accountsDirs: [],
          prefixes: [projectFolder('/home/bt-riley/threads/')],
        },
        threadOf: (f: string) =>
          f === folder ? { sessionId: 't3', teammateId: 'riley' } : undefined,
      },
    ],
    send: async (responses) => {
      sent.push(responses)
      if (fail) throw new Error('Not connected to Brigade; try again shortly')
    },
  })
  await logs.sweep()
  assert.equal(existsSync(stateFile), false)
  fail = false
  await logs.sweep()
  // Sent again whole: the API counts each once.
  assert.deepEqual(
    sent.map((batch) => batch.map((r) => [r.id, r.sessionId, r.teammateId, r.accountId])),
    [
      [
        ['msg_1', 't3', 'riley', 'acc1'],
        ['msg_2', 't3', 'riley', 'acc1'],
      ],
      [
        ['msg_1', 't3', 'riley', 'acc1'],
        ['msg_2', 't3', 'riley', 'acc1'],
      ],
    ],
  )
  await logs.sweep()
  assert.equal(sent.length, 2)
  const saved = JSON.parse(await readFile(stateFile, 'utf8')) as {
    offsets: Record<string, unknown>
  }
  assert.deepEqual(Object.keys(saved.offsets), [join(config, 'projects', folder, 's.jsonl')])
})
