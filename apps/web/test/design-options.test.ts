import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stepOption } from '../lib/design-options'

const set = ['x.options/a.design', 'x.options/b.design', 'x.options/c.design']

test('the arrows go to the next and previous option, wrapping around', () => {
  assert.equal(stepOption(set, set[0]!, 1), set[1])
  assert.equal(stepOption(set, set[2]!, 1), set[0])
  assert.equal(stepOption(set, set[0]!, -1), set[2])
  assert.equal(stepOption(set, set[1]!, -1), set[0])
})

test('from all of them side by side, the first or the last', () => {
  assert.equal(stepOption(set, null, 1), set[0])
  assert.equal(stepOption(set, null, -1), set[2])
})

test('an option no longer in the set goes as from all of them; an empty set nowhere', () => {
  assert.equal(stepOption(set, 'x.options/gone.design', 1), set[0])
  assert.equal(stepOption(set, 'x.options/gone.design', -1), set[2])
  assert.equal(stepOption([], null, 1), undefined)
})
