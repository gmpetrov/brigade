import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runningAsides, type AsidesNode } from '../lib/aside-layout'

type Plain = { type: 'item'; i: number }
const item = (i: number): Plain => ({ type: 'item', i })
const card = (...is: number[]): AsidesNode => ({ type: 'asides', is, live: false })

// The running turn (from item 0) wrote between two asides: one card at its end, by the
// composer, rather than one card per question.
test("the running turn's asides read as one card at its end, its messages above", () => {
  const kinds = ['start', 'user', 'assistant', 'user', 'assistant'].map((kind) => ({ kind }))
  const nodes = runningAsides<Plain>([item(0), card(1), item(2), card(3), item(4)], kinds, 0)
  assert.deepEqual(nodes, [
    item(0),
    item(2),
    item(4),
    { type: 'asides', is: [1, 3], live: true, quiet: true },
  ])
})

test('an aside after the turn last wrote keeps its card open', () => {
  const kinds = ['start', 'assistant', 'user'].map((kind) => ({ kind }))
  const nodes = runningAsides<Plain>([item(0), item(1), card(2)], kinds, 0)
  assert.deepEqual(nodes.at(-1), { type: 'asides', is: [2], live: true, quiet: false })
})

test("an earlier turn's asides stay where they are", () => {
  const kinds = ['user', 'turn', 'start', 'assistant'].map((kind) => ({ kind }))
  const nodes = [card(0), item(1), item(2), item(3)]
  assert.deepEqual(runningAsides<Plain>(nodes, kinds, 2), nodes)
})

// The thread lays out its running turn by replacing what it had with this list: given back
// as the same array, emptying it to refill it lost every message while the teammate worked.
test('a running turn without asides comes back as a new list, its nodes all there', () => {
  const kinds = ['user', 'turn', 'start', 'assistant'].map((kind) => ({ kind }))
  const nodes = [item(0), item(1), item(2), item(3)]
  const laid = runningAsides<Plain>(nodes, kinds, 2)
  assert.notEqual(laid, nodes)
  nodes.length = 0
  assert.deepEqual(laid, [item(0), item(1), item(2), item(3)])
})

test('an aside folded with the work before a steered message still joins the card', () => {
  type Worked = { type: 'worked'; inner: (Plain | AsidesNode)[] }
  const kinds = ['start', 'user', 'assistant', 'user', 'assistant'].map((kind) => ({ kind }))
  const worked: Worked = { type: 'worked', inner: [item(0), card(1), item(2)] }
  const nodes = runningAsides<Plain | Worked>([worked, item(3), item(4)], kinds, 0)
  assert.deepEqual(nodes, [
    { type: 'worked', inner: [item(0), item(2)] },
    item(3),
    item(4),
    { type: 'asides', is: [1], live: true, quiet: true },
  ])
})
