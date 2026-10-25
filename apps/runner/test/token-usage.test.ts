import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, RunnerToApi } from '@brigade/contracts'
import { EventMapper, tokenCounts } from '../src/harness/events.js'
import { reportRunUsage, sendUsageRunsTo } from '../src/usage.js'

function mapped(...parts: { type: string; [key: string]: unknown }[]) {
  const events: AgentEvent[] = []
  const mapper = new EventMapper((event) => events.push(event))
  for (const part of parts) mapper.map(part)
  return events.map(({ at: _, ...event }) => event)
}

// The AI SDK's LanguageModelUsage, as both harnesses total a turn: input counts the cache.
const usage = {
  inputTokens: 120_000,
  inputTokenDetails: { noCacheTokens: 2_000, cacheReadTokens: 110_000, cacheWriteTokens: 8_000 },
  outputTokens: 3_000,
  outputTokenDetails: { textTokens: 2_500, reasoningTokens: 500 },
  totalTokens: 123_000,
}

test("a turn's usage keeps the cache's share and the model the harness ran", () => {
  const events = mapped(
    { type: 'finish-step', response: { modelId: 'claude-opus-5-5' }, usage },
    { type: 'finish', finishReason: 'stop', totalUsage: usage },
  )
  assert.deepEqual(events, [
    {
      type: 'usage.updated',
      inputTokens: 120_000,
      outputTokens: 3_000,
      cacheReadTokens: 110_000,
      cacheWriteTokens: 8_000,
      reasoningTokens: 500,
      model: 'claude-opus-5-5',
    },
  ])
})

test('a stream that counted nothing says nothing, and odd numbers are left out', () => {
  assert.deepEqual(mapped({ type: 'finish', finishReason: 'stop', totalUsage: {} }), [])
  assert.deepEqual(
    tokenCounts({ inputTokens: 10, outputTokens: -1, inputTokenDetails: { cacheReadTokens: NaN } }),
    { inputTokens: 10 },
  )
})

test('a background run reports what it spent, and a limits-only event is not spending', () => {
  const sent: RunnerToApi[] = []
  sendUsageRunsTo((message) => sent.push(message))
  const at = '2026-10-25T10:00:00.000Z'
  const run = { kind: 'memory' as const, accountId: 'acc', sessionId: 's1', teammateId: 't1' }
  reportRunUsage({ at, type: 'usage.updated', status: 'allowed', limits: [] }, run)
  reportRunUsage(
    { at, type: 'usage.updated', inputTokens: 900, outputTokens: 40, model: 'claude-haiku' },
    run,
  )
  assert.deepEqual(sent, [
    {
      type: 'usage.run',
      at,
      kind: 'memory',
      accountId: 'acc',
      sessionId: 's1',
      teammateId: 't1',
      inputTokens: 900,
      outputTokens: 40,
      model: 'claude-haiku',
    },
  ])
})
