import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPanelAddress } from '../lib/thread-address'

test("the threads panel's addresses open in place, others go to the router", () => {
  assert.equal(isPanelAddress('/app/threads'), true)
  assert.equal(isPanelAddress('/app/threads/'), true)
  assert.equal(isPanelAddress('/app/threads/abc123'), true)
  // A page of its own, with something in it.
  assert.equal(isPanelAddress('/app/threads/abc123/log'), false)
  // What the panel would not read (routeThread takes the path alone).
  assert.equal(isPanelAddress('/app/threads/abc123?tab=files'), false)
  assert.equal(isPanelAddress('/app/threads/abc123#end'), false)
  assert.equal(isPanelAddress('/app/projects/p1/threads'), false)
  assert.equal(isPanelAddress('/app'), false)
})
