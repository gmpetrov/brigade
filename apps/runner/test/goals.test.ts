import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commandPrompt, GOAL_ASK, ScheduleOperation } from '@brigade/contracts'
import { measureGoal } from '../src/goal-measure.js'
import { THREAD_TOOLS } from '../src/harness/thread-tools.js'
import { goalTools, type ScheduleCaller } from '../src/harness/tools.js'

// Goals on the runner (docs/goals.md): `/goal` reaches the harness in words, never as a leading
// `/goal` (Claude Code's and Codex's own command); the teammate's goal tools, checked before they
// reach the API; and a goal's command measurement, run outside any turn.

const options = { toolCallId: 'call-1', messages: [] } as never
const nothing: ScheduleCaller = async () => ({})

const contract = {
  outcome: 'Tests green on the new API',
  recipe: { kind: 'command', command: 'pnpm test', read: 'exit_code' },
  budget: { tokens: 5_000_000, hours: 24 },
}

test('/goal reaches the harness as words, never as its own command', () => {
  const prompt = commandPrompt('/goal 10 demos booked by Friday')
  assert.ok(prompt.startsWith(GOAL_ASK))
  assert.match(prompt, /10 demos booked by Friday$/)
  assert.ok(!prompt.startsWith('/'))
})

test('a thread at the top proposes and reports; a sub-thread only reads where it stands', () => {
  assert.deepEqual(Object.keys(goalTools(nothing, { top: true })).sort(), [
    'goal_report',
    'goal_status',
    'propose_goal',
  ])
  assert.deepEqual(Object.keys(goalTools(nothing, { top: false })), ['goal_status'])
  // The contract and the summary are the thread's: its sub-agents do neither.
  assert.ok(THREAD_TOOLS.includes('propose_goal'))
  assert.ok(THREAD_TOOLS.includes('goal_report'))
  assert.ok(!THREAD_TOOLS.includes('goal_status'))
})

test('propose_goal sends a contract the API reads, and refuses an incomplete one here', async () => {
  const sent: Parameters<ScheduleCaller>[0][] = []
  const tools = goalTools(
    async (call) => {
      sent.push(call)
      return { goalId: 'g1' }
    },
    { top: true },
  )
  await tools.propose_goal!.execute!({ contract }, options)
  const op = ScheduleOperation.parse(sent[0]!.operation)
  assert.equal(op.name, 'propose_goal')
  assert.equal(op.name === 'propose_goal' && op.contract.stallTurns, 6)
  // An App's measure without a target: told what is missing, and nothing reaches the API.
  await assert.rejects(
    tools.propose_goal!.execute!(
      {
        contract: {
          ...contract,
          recipe: { kind: 'app', connectionId: 'c1', operation: 'stripe_mrr', input: {} },
        },
      },
      options,
    ),
    { message: /target: Give the target/ },
  )
  // A permission with a cap of 0 is no cap.
  await assert.rejects(
    tools.propose_goal!.execute!(
      {
        contract: {
          ...contract,
          permissions: [{ connectionId: 'c1', operation: 'gmail_send', label: 'Gmail', perDay: 0 }],
        },
      },
      options,
    ),
    { message: /permissions\.0\.perDay/ },
  )
  assert.equal(sent.length, 1)
})

test('an API from before goals says so', async () => {
  const old: ScheduleCaller = async () => {
    throw new Error(
      'Brigade could not read this call (operation.name: Invalid input). Try again differently.',
    )
  }
  await assert.rejects(
    goalTools(old, { top: true }).propose_goal!.execute!({ contract }, options),
    {
      message: /does not have goals yet/,
    },
  )
})

test('a command measurement: its exit code and the end of its output, stopped at its timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brigade-goal-'))
  try {
    const base = {
      type: 'goal.measure' as const,
      measureId: 'm1',
      sessionId: 's1',
      teammateId: 't1',
      timeoutSeconds: 10,
    }
    const failing = await measureGoal(
      { ...base, command: 'pwd; echo "3 failing" >&2; exit 2' },
      { dir, user: undefined },
    )
    assert.equal(failing.exitCode, 2)
    assert.match(failing.output, /3 failing/)
    assert.ok(failing.output.includes(dir), 'run in the thread’s working folder')
    const passing = await measureGoal({ ...base, command: 'true' }, { dir, user: undefined })
    assert.equal(passing.exitCode, 0)
    const started = Date.now()
    const slow = await measureGoal(
      { ...base, timeoutSeconds: 10, command: 'sleep 1; sleep 30 & wait' },
      { dir, user: undefined },
    ).catch((e: unknown) => e)
    assert.ok(Date.now() - started < 20_000)
    assert.equal((slow as { exitCode: number | null }).exitCode, null)
    assert.match((slow as { error?: string }).error ?? '', /past its 10 seconds/)
    const none = await measureGoal(
      { ...base, command: 'true' },
      { dir: join(dir, 'gone'), user: undefined },
    )
    assert.equal(none.exitCode, null)
    assert.match(none.error ?? '', /no working folder/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
