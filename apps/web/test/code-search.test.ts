import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import { countMatches } from '../components/code-search'

const doc = 'durable_objects: { Durable: 1 }\n// durable again'
const at = (from: number, to: number) =>
  EditorState.create({ doc, selection: EditorSelection.single(from, to) })

test('the match the selection is on, out of how many', () => {
  const query = new SearchQuery({ search: 'durable' })
  assert.deepEqual(countMatches(at(0, 0), query), { index: 0, total: 3, more: false })
  const second = doc.indexOf('Durable')
  assert.deepEqual(countMatches(at(second, second + 7), query), {
    index: 2,
    total: 3,
    more: false,
  })
})

test('options narrow the count; an invalid expression counts nothing', () => {
  assert.equal(
    countMatches(at(0, 0), new SearchQuery({ search: 'durable', caseSensitive: true })).total,
    2,
  )
  assert.equal(
    countMatches(at(0, 0), new SearchQuery({ search: 'durable', wholeWord: true })).total,
    2,
  )
  assert.equal(countMatches(at(0, 0), new SearchQuery({ search: 'dur(', regexp: true })).total, 0)
})

test('a count stops at 1000', () => {
  const state = EditorState.create({ doc: 'a'.repeat(1500) })
  assert.deepEqual(countMatches(state, new SearchQuery({ search: 'a' })), {
    index: 0,
    total: 1000,
    more: true,
  })
})
