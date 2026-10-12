import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatMention, mentionedIds, mentionsToText, parseMentions } from './mentions.ts'

describe('formatMention', () => {
  it('writes the composer syntax', () => {
    assert.equal(
      formatMention({ kind: 'repository', id: 'acme/web', label: 'acme/web' }),
      '@[acme/web](repository:acme/web)',
    )
  })

  it('keeps closing brackets and newlines out of the label', () => {
    const text = formatMention({ kind: 'teammate', id: 't1', label: ' Riley [bot]\n' })
    assert.equal(text, '@[Riley [bot](teammate:t1)')
    assert.deepEqual(parseMentions(text), [{ label: 'Riley [bot', kind: 'teammate', id: 't1' }])
  })
})

describe('parseMentions', () => {
  it('splits text and mentions in order', () => {
    assert.deepEqual(
      parseMentions('Hi @[Riley](teammate:t1), see @[faq/support.md](document:d9).'),
      [
        'Hi ',
        { label: 'Riley', kind: 'teammate', id: 't1' },
        ', see ',
        { label: 'faq/support.md', kind: 'document', id: 'd9' },
        '.',
      ],
    )
  })

  it('returns plain text as is', () => {
    assert.deepEqual(parseMentions('no mentions here'), ['no mentions here'])
    assert.deepEqual(parseMentions(''), [])
  })

  it('reads design-system apart from design', () => {
    assert.deepEqual(parseMentions('@[Acme](design-system:design-systems/acme)'), [
      { label: 'Acme', kind: 'design-system', id: 'design-systems/acme' },
    ])
    assert.deepEqual(parseMentions('@[acme/pricing.design](design:acme/pricing.design)'), [
      { label: 'acme/pricing.design', kind: 'design', id: 'acme/pricing.design' },
    ])
  })

  it('leaves unknown kinds and malformed mentions as text', () => {
    assert.deepEqual(parseMentions('@[x](unknown:1) @[y](teammate:)'), [
      '@[x](unknown:1) @[y](teammate:)',
    ])
  })

  it('reads back what formatMention wrote', () => {
    const mention = { kind: 'credential', id: 'c42', label: 'Stripe key' } as const
    assert.deepEqual(parseMentions(formatMention(mention)), [mention])
  })
})

describe('mentionsToText', () => {
  it('keeps the label, with @ for teammates', () => {
    assert.equal(
      mentionsToText('Ask @[Riley](teammate:t1) about @[acme/web](repository:acme/web)'),
      'Ask @Riley about acme/web',
    )
  })
})

describe('mentionedIds', () => {
  it('lists the ids of one kind', () => {
    const text = '@[A](credential:c1) @[Riley](teammate:t1) @[B](credential:c2)'
    assert.deepEqual(mentionedIds(text, 'credential'), ['c1', 'c2'])
    assert.deepEqual(mentionedIds(text, 'thread'), [])
  })
})
