import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beyondShown, pickLines, recalledBlock, SESSION_CHARS } from '../src/recall.js'

test('only lines past what the instructions file shows are candidates', () => {
  assert.deepEqual(beyondShown('short memory', 100), [])
  const text = ['- first line', '- second line', '- third line'].join('\n')
  // The file shows 15 characters: the second line is cut, so it is a candidate too.
  assert.deepEqual(beyondShown(text, 15), ['- second line', '- third line'])
})

test('picks the lines that bear on the message, best first, once per session', () => {
  const lines = [
    '- Deploys to Cloudflare run on every push to main',
    '- The BigQuery export runs nightly at 2am',
    '- Ada prefers short commit messages',
    '- Invoices are sent on the first of the month',
  ]
  const already = new Set<string>()
  assert.deepEqual(pickLines(lines, 'Why did the BigQuery export fail last night?', already), [
    '- The BigQuery export runs nightly at 2am',
  ])
  // Not twice in the same session.
  assert.deepEqual(pickLines(lines, 'BigQuery export again', already), [])
  assert.deepEqual(pickLines(lines, 'hello there', new Set()), [])
})

test('accents and case do not matter', () => {
  assert.deepEqual(
    pickLines(['- Le déploiement passe par Cloudflare'], 'DEPLOIEMENT ?', new Set()),
    ['- Le déploiement passe par Cloudflare'],
  )
})

test('a session is not brought more than its share of memory', () => {
  const already = new Set(['x'.repeat(SESSION_CHARS)])
  assert.deepEqual(pickLines(['- cloudflare deploys'], 'cloudflare', already), [])
})

test('the block says what the lines are, and nothing when there are none', () => {
  assert.equal(recalledBlock([]), '')
  assert.match(
    recalledBlock(['- a line']),
    /^<recalled-memory>\n.*\n- a line\n<\/recalled-memory>$/s,
  )
})
