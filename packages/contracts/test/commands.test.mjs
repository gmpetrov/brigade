import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandPrompt, messageCommand } from '../dist/commands.js'

test('reads the command a message starts with', () => {
  assert.deepEqual(messageCommand('/design a pricing page'), {
    command: 'design',
    rest: 'a pricing page',
  })
  assert.deepEqual(messageCommand('/visual\ncompare the flows'), {
    command: 'visual',
    rest: 'compare the flows',
  })
  assert.deepEqual(messageCommand('/design'), { command: 'design', rest: '' })
})

test('leaves other slashes alone', () => {
  for (const text of ['/designs are nice', 'make a /design', '/usr/bin is a path', '/compact', ''])
    assert.equal(messageCommand(text), null, text)
})

test('the teammate reads the command in words, never a leading slash', () => {
  const prompt = commandPrompt('/design a pricing page for @[acme](repository:acme/web)')
  assert.match(prompt, /^The person asked for a design \(\/design\)/)
  assert.ok(prompt.endsWith('\n\na pricing page for @[acme](repository:acme/web)'))
  assert.equal(commandPrompt('no command here'), 'no command here')
})
