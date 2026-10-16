import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpOutput, parsedText } from '../src/connectors/mcp-output.js'

const text = (t: string) => ({ content: [{ type: 'text', text: t }] })

test('JSON text comes back as the value it holds', () => {
  assert.deepEqual(mcpOutput(text('{"id":"u1","email":"a@b.c"}')).output, {
    id: 'u1',
    email: 'a@b.c',
  })
  assert.deepEqual(mcpOutput(text('[{"method":"GET"}]')).output, [{ method: 'GET' }])
})

test('JSON of a JSON string is unwrapped once more', () => {
  const inner = JSON.stringify([{ path: '/accounts' }], null, 2)
  assert.deepEqual(mcpOutput(text(JSON.stringify(inner))).output, [{ path: '/accounts' }])
})

test('plain text, and text that only looks like JSON, stay text', () => {
  assert.equal(mcpOutput(text('Deployed my-worker')).output, 'Deployed my-worker')
  assert.equal(parsedText('{not json'), '{not json')
  assert.equal(parsedText('42'), '42')
})

test('structured content wins, and several blocks stay text', () => {
  assert.deepEqual(
    mcpOutput({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } }).output,
    { ok: true },
  )
  assert.equal(
    mcpOutput({
      content: [{ type: 'text', text: '{"a":1}' }, { type: 'image' }],
    }).output,
    '{"a":1}\n[image]',
  )
})
