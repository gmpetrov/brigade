import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEMORY_MAX } from '@brigade/contracts'
import { applyMemoryEdit } from '../src/memory-edit.js'

const file = [
  '# Brigade memory',
  '',
  '- Esc never stops a run.',
  '- PRs are squash-merged.',
  '',
].join('\n')

test('a thread edit removes the lines it names and adds new ones at the end', () => {
  const result = applyMemoryEdit(file, {
    add: ['Brand colour is violet.'],
    remove: ['- esc never stops a run.'],
  })
  assert.equal(
    result.text,
    '# Brigade memory\n\n- PRs are squash-merged.\n- Brand colour is violet.\n',
  )
  assert.deepEqual(result.removedLines, ['- Esc never stops a run.'])
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.dropped, 0)
})

test('a full file takes no more lines, and says how many it left out', () => {
  const full = `# Memory\n\n- ${'x'.repeat(MEMORY_MAX - 20)}\n`
  const result = applyMemoryEdit(full, { add: ['one more line', 'and another'], remove: [] })
  assert.equal(result.text, full)
  assert.equal(result.added, 0)
  assert.equal(result.dropped, 2)
})

test('a line already there is not added twice', () => {
  const result = applyMemoryEdit(file, { add: ['PRs are squash-merged.'], remove: [] })
  assert.equal(result.added, 0)
  assert.equal(result.dropped, 0)
})
