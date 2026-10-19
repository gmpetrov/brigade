import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectRefusal } from '../src/task-project.js'

test('a task of its own may take any project, or none', () => {
  assert.equal(projectRefusal('cmv9dwkkt001apsp77zztfyi1', null), null)
  assert.equal(projectRefusal(null, null), null)
})

test('no project asked: nothing to refuse, in a mission or not', () => {
  assert.equal(projectRefusal(undefined, null), null)
  assert.equal(projectRefusal(undefined, 'mission-1'), null)
})

test("a task in a mission keeps the mission's project", () => {
  assert.match(projectRefusal('cmv9dwkkt001apsp77zztfyi1', 'mission-1')!, /mission's project/)
  assert.match(projectRefusal(null, 'mission-1')!, /mission "none"/)
})
