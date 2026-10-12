import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMention, mentionedIds, mentionsToText, parseMentions } from '../dist/mentions.js'

test('parses mixed text and mentions in their original order', () => {
  assert.deepEqual(
    parseMentions('Ask @[Cody](teammate:cody) about @[acme/web](repository:acme/web).'),
    [
      'Ask ',
      { label: 'Cody', kind: 'teammate', id: 'cody' },
      ' about ',
      { label: 'acme/web', kind: 'repository', id: 'acme/web' },
      '.',
    ],
  )
})

test('handles empty input and text without mentions', () => {
  assert.deepEqual(parseMentions(''), [])
  assert.deepEqual(parseMentions('Hello @Cody'), ['Hello @Cody'])
})

test('parses adjacent mentions without inserting empty text', () => {
  assert.deepEqual(parseMentions('@[Cody](teammate:cody)@[Chief](teammate:chief)'), [
    { label: 'Cody', kind: 'teammate', id: 'cody' },
    { label: 'Chief', kind: 'teammate', id: 'chief' },
  ])
})

test('preserves malformed and unsupported mentions as text', () => {
  for (const text of [
    '@[Cody](unknown:cody)',
    '@[](teammate:cody)',
    '@[Cody](teammate:)',
    '@[Cody](teammate:two words)',
    '@[Co\ndy](teammate:cody)',
    '@[Cody](teammate:cody',
  ]) {
    assert.deepEqual(parseMentions(text), [text], text)
    assert.equal(mentionsToText(text), text)
  }
})

test('distinguishes design systems from designs and supports legacy projects', () => {
  assert.deepEqual(
    parseMentions(
      '@[Brigade](design-system:design-systems/brigade) @[Page](design:acme/page.design) @[Web](project:legacy)',
    ),
    [
      { label: 'Brigade', kind: 'design-system', id: 'design-systems/brigade' },
      ' ',
      { label: 'Page', kind: 'design', id: 'acme/page.design' },
      ' ',
      { label: 'Web', kind: 'project', id: 'legacy' },
    ],
  )
})

test('formats a mention that the parser can read back', () => {
  const mention = { label: 'acme/web', kind: 'repository', id: 'acme/web' }
  assert.equal(formatMention(mention), '@[acme/web](repository:acme/web)')
  assert.deepEqual(parseMentions(formatMention(mention)), [mention])
})

test('sanitizes closing brackets and newlines in mention labels', () => {
  const mention = { label: '  Co]dy\nTeam  ', kind: 'teammate', id: 'cody' }
  assert.equal(formatMention(mention), '@[Co dy Team](teammate:cody)')
  assert.deepEqual(parseMentions(formatMention(mention)), [
    { label: 'Co dy Team', kind: 'teammate', id: 'cody' },
  ])
})

test('reduces mentions to labels while keeping the teammate @ prefix', () => {
  assert.equal(
    mentionsToText('Ask @[Cody](teammate:cody) about @[Web](repository:acme/web).'),
    'Ask @Cody about Web.',
  )
})

test('selects only the requested mention kind, preserving order and repeated ids', () => {
  const text =
    '@[Cody](teammate:cody) @[Key](credential:key) @[Chief](teammate:chief) @[Cody](teammate:cody)'
  assert.deepEqual(mentionedIds(text, 'teammate'), ['cody', 'chief', 'cody'])
  assert.deepEqual(mentionedIds(text, 'credential'), ['key'])
  assert.deepEqual(mentionedIds(text, 'repository'), [])
  assert.deepEqual(mentionedIds('', 'teammate'), [])
})
