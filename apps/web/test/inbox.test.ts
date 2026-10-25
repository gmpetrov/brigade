// The Inbox page's decisions (lib/inbox): when its list is asked again, what a draft shows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftFacts, filtersToRestore, keptFilters, reloadsInboxList } from '../lib/inbox'

test('the list follows tickets too: a reply to approve moves a conversation into To do', () => {
  assert.equal(reloadsInboxList('tickets.updated'), true)
  assert.equal(reloadsInboxList('mail.updated'), true)
  assert.equal(reloadsInboxList('connections.updated'), true)
  assert.equal(reloadsInboxList('thread.updated'), false)
})

test('a draft to approve shows its Cc, subject and files, not only whom it goes to', () => {
  const facts = new Map(
    draftFacts({
      to: ['priya@umbrella.test'],
      cc: ['boss@other.test'],
      subject: 'Your export',
      replying: true,
      files: ['customers.csv'],
    }),
  )
  assert.equal(facts.get('To'), 'priya@umbrella.test')
  assert.equal(facts.get('Cc'), 'boss@other.test')
  assert.equal(facts.get('Subject'), 'Your export')
  assert.equal(facts.get('Files'), 'customers.csv')
  // A plain reply: its subject is the conversation's, and no empty Cc or Files line.
  const reply = new Map(
    draftFacts({ to: ['a@b.test'], cc: [], subject: '', replying: true, files: [] }),
  )
  assert.equal(reply.get('Subject'), 'Re: the conversation’s subject')
  assert.equal(reply.has('Cc'), false)
  assert.equal(reply.has('Files'), false)
})

test('filters are kept without the words or the open email, and put back only on a bare address', () => {
  const kept = keptFilters(
    new URLSearchParams('status=handled&source=email:a&teammate=t1&q=refund&item=mail:x'),
  )
  assert.deepEqual(kept, { status: 'handled', source: 'email:a', teammate: 't1' })
  const saved = JSON.stringify(kept)
  assert.deepEqual(filtersToRestore(new URLSearchParams(''), saved), kept)
  // A link to a view, an email or a search wins over what was kept.
  assert.equal(filtersToRestore(new URLSearchParams('item=mail:y'), saved), null)
  assert.equal(filtersToRestore(new URLSearchParams('status=done'), saved), null)
  assert.equal(filtersToRestore(new URLSearchParams('q=hello'), saved), null)
  // Nothing kept, or something else than filters: nothing put back.
  assert.equal(filtersToRestore(new URLSearchParams(''), null), null)
  assert.equal(filtersToRestore(new URLSearchParams(''), '{not json'), null)
  assert.equal(filtersToRestore(new URLSearchParams(''), '{}'), null)
  assert.deepEqual(
    filtersToRestore(
      new URLSearchParams(''),
      JSON.stringify({ project: 'p1', other: 'x', source: 3 }),
    ),
    { project: 'p1' },
  )
})
