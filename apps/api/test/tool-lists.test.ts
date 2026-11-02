import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolLists } from '../src/tool-lists.js'

// MCP servers' tool lists kept between App calls (src/tool-lists.ts), in a hub object's isolate,
// which every hub object of the isolate shares under its 128 MB: a list goes once its time is up,
// and the lists together stay under their size. Before, an account's list stayed for the life of
// the isolate, and its hubs were reset past their memory.

const clock = () => {
  let at = 1_000_000
  return { now: () => at, pass: (ms: number) => (at += ms) }
}

/** A list of about `chars` characters of JSON, as a server's tools are. */
const listOf = (chars: number) => [{ name: 'tool', description: 'x'.repeat(chars) }]

test('a list past its time is let go, even when its connection is never called again', () => {
  const time = clock()
  const lists = new ToolLists(1_000, 60_000, time.now)
  lists.set('posthog', listOf(100), 100)
  assert.ok(lists.get('posthog'))
  time.pass(60_000)
  // Another connection's list: the old one goes, though nobody asks for it again.
  lists.set('stripe', listOf(100), 100)
  assert.deepEqual(lists.size, { lists: 1, chars: 100 })
  assert.equal(lists.get('posthog'), undefined)
})

test('the lists together stay under their size, the least recently used going first', () => {
  const time = clock()
  const lists = new ToolLists(1_000, 60_000, time.now)
  lists.set('a', listOf(400), 400)
  lists.set('b', listOf(400), 400)
  // Used: kept over b.
  assert.ok(lists.get('a'))
  lists.set('c', listOf(400), 400)
  assert.deepEqual(lists.size, { lists: 2, chars: 800 })
  assert.ok(lists.get('a'))
  assert.equal(lists.get('b'), undefined)
  assert.ok(lists.get('c'))
  // Listed again: counted once.
  lists.set('c', listOf(500), 500)
  assert.deepEqual(lists.size, { lists: 2, chars: 900 })
  // Larger than the whole budget: not kept, and keeps nothing else out.
  lists.set('huge', listOf(2_000), 2_000)
  assert.equal(lists.get('huge'), undefined)
  assert.deepEqual(lists.size, { lists: 2, chars: 900 })
  assert.ok(lists.delete('a'))
  assert.deepEqual(lists.size, { lists: 1, chars: 500 })
})

test('many accounts listed over hours keep at most the budget', () => {
  const time = clock()
  const lists = new ToolLists(4_000_000, 5 * 60_000, time.now)
  for (let i = 0; i < 500; i++) {
    lists.set(`connection-${i % 60}`, listOf(0), 300_000 + (i % 7) * 100_000)
    time.pass(30_000)
    assert.ok(lists.size.chars <= 4_000_000)
  }
})

test(
  'the memory of a list let go is released',
  { skip: !global.gc && 'needs --expose-gc' },
  async () => {
    const time = clock()
    const lists = new ToolLists<object>(4_000_000, 60_000, time.now)
    let refs: WeakRef<object>[] = []
    ;(() => {
      // Ten lists of about 1 MB each, as an App's tools are.
      for (let i = 0; i < 10; i++) {
        const list = listOf(1_000_000)
        refs.push(new WeakRef(list))
        lists.set(`connection-${i}`, list, 1_000_000)
      }
    })()
    // Four fit: the six oldest are already let go.
    await new Promise((resolve) => setImmediate(resolve))
    global.gc!()
    assert.equal(refs.filter((r) => r.deref()).length, 4)
    // Past their time, the others go with the next list kept.
    time.pass(60_000)
    lists.set('small', listOf(10), 10)
    await new Promise((resolve) => setImmediate(resolve))
    global.gc!()
    assert.equal(refs.filter((r) => r.deref()).length, 0)
    refs = []
  },
)
