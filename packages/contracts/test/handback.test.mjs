import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handbackAnswer, handbackMessage, handbackNote } from '../dist/index.js'

test('a hand back message reads back as its note and files', () => {
  const both = {
    note: 'The login works now.\n\nCarry on with the tests.',
    files: ['web/login.ts', 'web/.env.local'],
  }
  assert.deepEqual(handbackNote(handbackMessage(both)), both)
  assert.deepEqual(handbackNote(handbackMessage({ note: 'Done', files: [] })), {
    note: 'Done',
    files: [],
  })
  assert.deepEqual(handbackNote(handbackMessage({ note: '  ', files: ['a.txt'] })), {
    note: '',
    files: ['a.txt'],
  })
})

test('a hand back message as runners wrote it before handbackMessage reads back', () => {
  const old =
    'A person took over this thread and has now handed it back to you.\n\n' +
    'Their note: fixed it\n\n' +
    'Files changed while they had control:\n- src/a.ts\n- src/b.ts'
  assert.deepEqual(handbackNote(old), { note: 'fixed it', files: ['src/a.ts', 'src/b.ts'] })
})

test('another message is no hand back', () => {
  assert.equal(handbackNote('Fix the login'), null)
  assert.equal(
    handbackNote('A person took over this thread and has now handed it back to you. Thanks'),
    null,
  )
})

test('handing back answers a ticket of browser actions, and only that', () => {
  const browser = { id: 'a1', type: 'action', title: 'Verify', browser: true }
  assert.deepEqual(handbackAnswer([browser], ' Passkey done '), {
    action: 'answered',
    replies: { a1: { type: 'action', done: true, note: 'Passkey done' } },
  })
  assert.deepEqual(handbackAnswer([browser], ''), {
    action: 'answered',
    replies: { a1: { type: 'action', done: true } },
  })
  assert.equal(handbackAnswer([{ ...browser, browser: undefined }], ''), undefined)
  assert.equal(handbackAnswer([browser, { id: 'a2', type: 'input', title: 'Code' }], ''), undefined)
  assert.equal(handbackAnswer([], ''), undefined)
})

test('handing back answers a ticket whose other asks the person answered already', () => {
  const account = { id: 'a1', type: 'decision', title: 'Which account?', options: [] }
  const browser = { id: 'a2', type: 'action', title: 'Sign in', browser: true }
  const chose = { type: 'decision', optionId: 'askli' }
  assert.deepEqual(handbackAnswer([account, browser], 'Signed in', { a1: chose }), {
    action: 'answered',
    replies: { a1: chose, a2: { type: 'action', done: true, note: 'Signed in' } },
  })
  // Not answered yet, or answered as another kind of ask: the ticket stays open.
  assert.equal(handbackAnswer([account, browser], ''), undefined)
  assert.equal(
    handbackAnswer([account, browser], '', { a1: { type: 'input', text: 'askli' } }),
    undefined,
  )
  // Every ask answered already: nothing left for the hand back to answer.
  assert.equal(handbackAnswer([account], '', { a1: chose }), undefined)
})
