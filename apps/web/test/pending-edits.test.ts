import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addDesignEdit,
  designEditsOf,
  restoreDesignEdits,
  setDesignEdits,
  withUnsent,
  type DesignEdit,
} from '../lib/pending-edits'

const edit = (note: string) => ({
  folder: 'acme/pricing.design',
  board: null,
  rect: null,
  label: 'Pricing',
  where: 'Comment on the design @[acme/pricing.design](design:acme/pricing.design):',
  note,
})

test('a failed send gives its edits back, with one added while it was on its way', async () => {
  const thread = 'race'
  addDesignEdit(thread, edit('A1'))
  await new Promise((r) => setTimeout(r, 2))
  addDesignEdit(thread, edit('A2'))
  // The send takes them and clears the list.
  const sent = designEditsOf(thread)
  setDesignEdits(thread, [])
  // The member comments again before the send fails.
  await new Promise((r) => setTimeout(r, 2))
  addDesignEdit(thread, edit('B'))
  restoreDesignEdits(thread, sent)
  assert.deepEqual(
    designEditsOf(thread).map((e) => e.note),
    ['A1', 'A2', 'B'],
  )
  // Given back twice, nothing doubles.
  restoreDesignEdits(thread, sent)
  assert.equal(designEditsOf(thread).length, 3)
})

test('the preview’s elements merge the same way, by id and in the order they were picked', () => {
  const current = [{ id: 'c', at: 30 }]
  const unsent = [
    { id: 'a', at: 10 },
    { id: 'b', at: 20 },
  ]
  assert.deepEqual(
    withUnsent(current, unsent).map((e) => e.id),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(withUnsent<DesignEdit>([], []), [])
})
