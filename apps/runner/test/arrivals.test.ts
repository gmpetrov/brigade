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

test('a wait that starts before the model read the message ends at once', () => {
  const arrivals = new Arrivals()
  arrivals.arrived()
  const early = arrivals.watch()
  assert.equal(early.signal.aborted, true)
  assert.equal(early.cut, 'message')
  early.release()
  // A result went back, but the step's other calls may still run: the model reads the message
  // only with all their results (from the review of #772).
  arrivals.resulted()
  const sibling = arrivals.watch()
  assert.equal(sibling.cut, 'message')
  sibling.release()
  // The model writes again: its request had the message.
  arrivals.wrote()
  const later = arrivals.watch()
  assert.equal(later.signal.aborted, false)
  later.release()
  assert.equal(arrivals.listening, 0)
})

test('what the model writes before a result went back, or a call it wrote before, reads nothing', () => {
  const arrivals = new Arrivals()
  arrivals.wrote('call-1')
  // Came while the model wrote a step whose request did not carry it.
  arrivals.arrived()
  arrivals.wrote()
  arrivals.wrote('call-2')
  assert.equal(arrivals.watch().cut, 'message')
  arrivals.resulted()
  // An adapter showing a call again (around an approval) is no new writing.
  arrivals.wrote('call-2')
  assert.equal(arrivals.watch().cut, 'message')
  arrivals.wrote('call-3')
  assert.equal(arrivals.watch().cut, undefined)
})

test('a new turn reads what it is given now', () => {
  const arrivals = new Arrivals()
  arrivals.arrived()
  arrivals.started()
  assert.equal(arrivals.watch().cut, undefined)
})

test('a hand-over to the next runner ends the waits under way, and every one after it', () => {
  const arrivals = new Arrivals()
  const watch = arrivals.watch()
  arrivals.handOver()
  assert.equal(watch.signal.aborted, true)
  assert.equal(watch.cut, 'handover')
  watch.release()
  // What the turn got since changes nothing: this runner is leaving.
  arrivals.resulted()
  arrivals.wrote()
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
