import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandPrompt, messageCommand, skillCommand } from '../dist/commands.js'

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

test('a workspace skill is a command, by its name', () => {
  const skills = ['release-notes', 'triage']
  assert.deepEqual(skillCommand('/release-notes for 2.4', skills), {
    skill: 'release-notes',
    rest: 'for 2.4',
  })
  assert.deepEqual(skillCommand('/triage', skills), { skill: 'triage', rest: '' })
  for (const text of ['/release-notes-old', '/unknown do it', 'use /triage', '/design a page'])
    assert.equal(skillCommand(text, skills), null, text)
  const prompt = commandPrompt('/release-notes for 2.4', skills)
  assert.match(prompt, /^The person asked for the skill release-notes \(\/release-notes\)/)
  assert.ok(prompt.endsWith('\n\nfor 2.4'))
  assert.equal(commandPrompt('/release-notes for 2.4'), '/release-notes for 2.4')
})

test('/image asks for the image tool', () => {
  const prompt = commandPrompt('/image a violet robot waving')
  assert.match(prompt, /^The person asked for an image \(\/image\).*generate_image/)
  assert.ok(prompt.endsWith('\n\na violet robot waving'))
})
