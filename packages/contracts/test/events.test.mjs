import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentEvent } from '../dist/events.js'

const at = '2026-10-13T08:00:00.000Z'

test('reads the repositories a teammate has checked out in a thread', () => {
  const event = {
    at,
    type: 'repositories.changed',
    teammateId: 'cody',
    repositories: ['acme/api', 'acme/web'],
  }
  assert.deepEqual(AgentEvent.parse(event), event)
  assert.deepEqual(AgentEvent.parse({ at, type: 'repositories.changed', repositories: [] }), {
    at,
    type: 'repositories.changed',
    repositories: [],
  })
})

test('refuses a repositories report without its list, or with too many', () => {
  assert.equal(AgentEvent.safeParse({ at, type: 'repositories.changed' }).success, false)
  const many = Array.from({ length: 51 }, (_, i) => `acme/repo-${i}`)
  assert.equal(
    AgentEvent.safeParse({ at, type: 'repositories.changed', repositories: many }).success,
    false,
  )
})
