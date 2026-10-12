import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseDotenv, pastedEnv } from './dotenv.ts'

describe('parseDotenv', () => {
  test('reads NAME=value lines in order', () => {
    assert.deepEqual(parseDotenv('A=1\nB=two\nC='), [
      { name: 'A', value: '1' },
      { name: 'B', value: 'two' },
      { name: 'C', value: '' },
    ])
  })

  test('leaves out comments, blank lines and lines that are not variables', () => {
    const text = '# a comment\n\nA=1\n  # indented comment\nnot a variable\n1BAD=x\nB=2\n'
    assert.deepEqual(parseDotenv(text), [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
  })

  test('takes export, spaces around = and Windows line endings', () => {
    assert.deepEqual(parseDotenv('export A=1\r\n  B = 2 \r\nC=3\r'), [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
      { name: 'C', value: '3' },
    ])
  })

  test('a later variable replaces an earlier one of the same name, in its place', () => {
    assert.deepEqual(parseDotenv('A=1\nB=2\nA=3'), [
      { name: 'A', value: '3' },
      { name: 'B', value: '2' },
    ])
  })

  test('cuts an unquoted value at a comment after a space only', () => {
    assert.deepEqual(parseDotenv('A=value # comment\nB=url#anchor\nC=a=b'), [
      { name: 'A', value: 'value' },
      { name: 'B', value: 'url#anchor' },
      { name: 'C', value: 'a=b' },
    ])
  })

  test('keeps quoted values as written, with # and spaces', () => {
    assert.deepEqual(parseDotenv(`A="x # y "\nB='  z  ' # comment\nC=\`q\``), [
      { name: 'A', value: 'x # y ' },
      { name: 'B', value: '  z  ' },
      { name: 'C', value: 'q' },
    ])
  })

  test('unescapes \\n, \\r, \\t, \\" and \\\\ in double quotes only', () => {
    assert.deepEqual(
      parseDotenv(String.raw`A="a\nb\tc\rd\"e\\f\x"` + '\n' + String.raw`B='a\nb'`),
      [
        { name: 'A', value: 'a\nb\tc\rd"e\\f\\x' },
        { name: 'B', value: String.raw`a\nb` },
      ],
    )
  })

  test('reads a quoted value over several lines', () => {
    const text = 'KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1'
    assert.deepEqual(parseDotenv(text), [
      { name: 'KEY', value: '-----BEGIN-----\nabc\n-----END-----' },
      { name: 'NEXT', value: '1' },
    ])
  })

  test('takes the rest of the text when a quote is never closed', () => {
    assert.deepEqual(parseDotenv("A='open\nB=2"), [{ name: 'A', value: 'open\nB=2' }])
  })

  test('returns nothing for empty text', () => {
    assert.deepEqual(parseDotenv(''), [])
    assert.deepEqual(parseDotenv('\n# only a comment\n'), [])
  })
})

describe('pastedEnv', () => {
  test('is null when the text has no variables', () => {
    assert.equal(pastedEnv('just a value', { value: true, name: 'A' }), null)
    assert.equal(pastedEnv('just a name', { value: false }), null)
  })

  test('in a name field, one NAME=value line counts', () => {
    assert.deepEqual(pastedEnv('A=1', { value: false }), [{ name: 'A', value: '1' }])
  })

  test('in a value field, several lines count', () => {
    assert.deepEqual(pastedEnv('A=1\nB=2', { value: true, name: 'X' }), [
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ])
  })

  test("in a value field, one line counts only when it names the field's own variable", () => {
    assert.deepEqual(pastedEnv('A=1', { value: true, name: 'A' }), [{ name: 'A', value: '1' }])
    assert.equal(pastedEnv('B=1', { value: true, name: 'A' }), null)
    assert.equal(pastedEnv('base64==', { value: true }), null)
  })

  test('ignores blank lines around a single line', () => {
    assert.equal(pastedEnv('\nB=1\n', { value: true, name: 'A' }), null)
  })
})
