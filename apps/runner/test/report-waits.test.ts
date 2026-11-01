import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reportWaitsFor } from '../src/harness/background.js'

// A child's report is its whole result: made while its own sub-agents work, it is not sent.

test("a child's report waits for its own sub-agents", () => {
  const why = reportWaitsFor([
    { kind: 'agent', description: 'Research Linear and Copilot agents' },
    { kind: 'agent', description: 'Research Devin, Cursor, Codex' },
    { kind: 'command', description: 'npm run dev' },
  ])
  assert.equal(
    why,
    'Not sent: 2 sub-agents of yours are still at work (Research Linear and Copilot agents; ' +
      'Research Devin, Cursor, Codex). Their results wake you here when they finish: end your ' +
      'turn now, and call report once you have them all, with the whole result.',
  )
  assert.match(
    reportWaitsFor([{ kind: 'agent', description: 'Review' }])!,
    /^Not sent: a sub-agent of yours is still at work \(Review\)/,
  )
})

test('background commands do not hold a report, nor nothing at all', () => {
  assert.equal(reportWaitsFor([{ kind: 'command', description: 'npm run dev' }]), undefined)
  assert.equal(reportWaitsFor([]), undefined)
})
