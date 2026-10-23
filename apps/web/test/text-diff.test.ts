import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textChange } from '../lib/text-diff'

const apply = (before: string, c: ReturnType<typeof textChange>) =>
  before.slice(0, c.from) + c.insert + before.slice(c.to)

test('the change between two texts is what lies between their common ends', () => {
  assert.deepEqual(textChange('a model per teammate', 'a different model per teammate'), {
    from: 2,
    to: 2,
    insert: 'different ',
  })
  assert.deepEqual(textChange('abc', 'abc'), { from: 3, to: 3, insert: '' })
  assert.deepEqual(textChange('abcd', 'ad'), { from: 1, to: 3, insert: '' })
  for (const [a, b] of [
    ['', 'x'],
    ['x', ''],
    ['aaa', 'aa'],
    ['aa', 'aaaa'],
    ['hello world', 'help wordl'],
    ['line 1\nline 2\n', 'line 0\nline 1\nline 2\n'],
  ] as const)
    assert.equal(apply(a, textChange(a, b)), b, `${a} → ${b}`)
})
