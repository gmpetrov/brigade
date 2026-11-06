// A message given to a running turn, or the turn's hand-over to the next runner, ends the waits
// of the tools that wait on work going on without them (src/harness/arrivals.ts).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Arrivals } from '../src/harness/arrivals.js'

test('a wait under way ends when a message comes in, and says so', () => {
  const arrivals = new Arrivals()
  const watch = arrivals.watch()
  assert.equal(watch.signal.aborted, false)
  arrivals.arrived()
  assert.equal(watch.signal.aborted, true)
  assert.equal(watch.cut, 'message')
  watch.release()
  assert.equal(arrivals.listening, 0)
})

test('a wait that starts before the turn read the message ends at once; after a result, it waits', () => {
  const arrivals = new Arrivals()
  arrivals.arrived()
  const early = arrivals.watch()
  assert.equal(early.signal.aborted, true)
  assert.equal(early.cut, 'message')
  early.release()
  // The turn got a tool's result: the message went in with it.
  arrivals.read()
  const later = arrivals.watch()
  assert.equal(later.signal.aborted, false)
  later.release()
  assert.equal(arrivals.listening, 0)
})

test('a hand-over to the next runner ends the waits under way, and every one after it', () => {
  const arrivals = new Arrivals()
  const watch = arrivals.watch()
  arrivals.handOver()
  assert.equal(watch.signal.aborted, true)
  assert.equal(watch.cut, 'handover')
  watch.release()
  // A result the turn got since changes nothing: this runner is leaving.
  arrivals.read()
  const after = arrivals.watch()
  assert.equal(after.signal.aborted, true)
  assert.equal(after.cut, 'handover')
  after.release()
  assert.equal(arrivals.listening, 0)
})

test("the call's own abort ends the wait too, as neither", () => {
  const arrivals = new Arrivals()
  const call = new AbortController()
  const watch = arrivals.watch(call.signal)
  call.abort()
  assert.equal(watch.signal.aborted, true)
  assert.equal(watch.cut, undefined)
  watch.release()
  // A call aborted already: at once.
  const gone = arrivals.watch(AbortSignal.abort())
  assert.equal(gone.signal.aborted, true)
  assert.equal(gone.cut, undefined)
  gone.release()
  assert.equal(arrivals.listening, 0)
})

test('a released wait hears no more, and holds nothing', () => {
  const arrivals = new Arrivals()
  const call = new AbortController()
  const watch = arrivals.watch(call.signal)
  watch.release()
  arrivals.arrived()
  call.abort()
  assert.equal(watch.signal.aborted, false)
  assert.equal(arrivals.listening, 0)
})
