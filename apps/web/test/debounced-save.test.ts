// The demo editor's save a moment after the last change (lib/debounced-save.ts): leaving the
// page within that moment must not lose the change.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { debouncedSave } from '../lib/debounced-save'

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('saves the last text once nothing changed for a moment', async () => {
  const saved: string[] = []
  const autosave = debouncedSave((t) => saved.push(t), 30)
  autosave.schedule('a')
  autosave.schedule('ab')
  assert.deepEqual(saved, [])
  await pause(60)
  assert.deepEqual(saved, ['ab'])
  assert.equal(autosave.pending, false)
})

test('closing within the moment saves what waits, at once and once', async () => {
  const saved: string[] = []
  const autosave = debouncedSave((t) => saved.push(t), 600)
  autosave.schedule('ticked')
  autosave.close()
  assert.deepEqual(saved, ['ticked'])
  await pause(20)
  assert.deepEqual(saved, ['ticked'])
})

test('a change that arrives once closed is saved at once', () => {
  const saved: string[] = []
  const autosave = debouncedSave((t) => saved.push(t), 600)
  autosave.close()
  assert.deepEqual(saved, [])
  autosave.schedule('last word')
  assert.deepEqual(saved, ['last word'])
})
