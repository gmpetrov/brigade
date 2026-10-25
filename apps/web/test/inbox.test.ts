// The Inbox page's decisions (lib/inbox): when its list is asked again, what a draft shows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftFacts, reloadsInboxList } from '../lib/inbox'

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
