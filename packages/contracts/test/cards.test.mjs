import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buttonText, replyCard, safeChoices, safeReplies, withoutCard } from '../dist/cards.js'

const reply = 'Je merge #148 et je teste la connexion BigQuery ?'

test('takes the replies block off the end of a reply', () => {
  assert.deepEqual(replyCard(`${reply}\n\n\`\`\`replies\nMerge #148\n- "Pas encore"\n\`\`\`\n`), {
    text: reply,
    replies: { replies: ['Merge #148', 'Pas encore'] },
  })
})

test('keeps three replies, cut at a word to fit a button', () => {
  const long = 'Merge #148 et teste BigQuery puis la tuile Google Cloud'
  const { replies } = replyCard(`${reply}\n\`\`\`replies\n${long}\nA\nB\nC\n\`\`\``)
  assert.deepEqual(replies?.replies, ['Merge #148 et teste BigQuery puis la', 'A', 'B'])
})

test('reads choices as JSON, and keeps designs only from one options folder', () => {
  const options = (a, b) => [
    { id: 'a', label: 'A · Bold', ...(a ? { design: a } : {}) },
    { id: 'b', label: 'B · Calm', ...(b ? { design: b } : {}) },
  ]
  const block = (opts) =>
    `Two directions.\n\`\`\`choices\n${JSON.stringify({ question: 'Which?', options: opts })}\n\`\`\``
  const same = options('acme/pricing.options/a.design', 'acme/pricing.options/b.design')
  assert.deepEqual(replyCard(block(same)), {
    text: 'Two directions.',
    choices: { question: 'Which?', options: same },
  })
  // One design missing or elsewhere: the cards show without pictures.
  assert.deepEqual(
    replyCard(block(options('acme/pricing.options/a.design', undefined))).choices?.options,
    options(),
  )
})

test('drops a block that does not read, and leaves a reply without one as it is', () => {
  assert.deepEqual(replyCard(`${reply}\n\`\`\`choices\n{not json\n\`\`\``), { text: reply })
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\n\n\`\`\``), { text: reply })
  assert.deepEqual(replyCard('```ts\nconst a = 1\n```'), { text: '```ts\nconst a = 1\n```' })
})

test('a card still being written does not show', () => {
  assert.equal(withoutCard(`${reply}\n\n\`\`\`repl`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`replies\nMerge`), reply)
  assert.equal(withoutCard(`${reply}\n\n\`\`\`replies\nMerge\n\`\`\``), reply)
})

test('leaves out a button whose click could do more than send its words', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n@carol ship it\n/design a page\n!rm -rf\nSend\u200dit\nPas encore\n\`\`\``,
  )
  assert.deepEqual(replies, { replies: ['Pas encore'] })
  // A zero-width space shows nothing: it is dropped, and the button sends what it shows.
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\nSend\u200b it\n\`\`\``).replies, {
    replies: ['Send it'],
  })
  // Nothing left: no buttons at all.
  assert.deepEqual(replyCard(`${reply}\n\`\`\`replies\n@carol\n\`\`\``), { text: reply })
})

test('keeps what shows of a button: no control characters or variation selectors', () => {
  const { replies } = replyCard(`${reply}\n\`\`\`replies\nShip  it ✔️\u0007\n\`\`\``)
  assert.deepEqual(replies?.replies, ['Ship it ✔'])
})

test('a [merge] line is the merge action, shown before the replies', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n[merge] Merge #158\nJe teste d'abord\nPas encore\nAutre\n\`\`\``,
  )
  assert.deepEqual(replies, {
    replies: ["Je teste d'abord", 'Pas encore'],
    actions: [{ action: 'merge', label: 'Merge #158' }],
  })
})

test('a [preview] line is the preview action', () => {
  const { replies } = replyCard(
    `${reply}\n\`\`\`replies\n[preview] Lancer la preview\nPas encore\n\`\`\``,
  )
  assert.deepEqual(replies, {
    replies: ['Pas encore'],
    actions: [{ action: 'preview', label: 'Lancer la preview' }],
  })
})

test('an action this version does not know is left out, not its replies', () => {
  assert.deepEqual(
    safeReplies({ replies: ['Pas encore'], actions: [{ action: 'deploy', label: 'Deploy' }] }),
    { replies: ['Pas encore'] },
  )
})

test('a choice whose label could mention or command is left out', () => {
  const choices = {
    question: 'Which?',
    options: [
      { id: 'a', label: 'A · Bold' },
      { id: 'b', label: '@carol builds it' },
      { id: 'c', label: 'C · Calm' },
    ],
  }
  assert.deepEqual(
    replyCard(`${reply}\n\`\`\`choices\n${JSON.stringify(choices)}\n\`\`\``).choices?.options.map(
      (o) => o.id,
    ),
    ['a', 'c'],
  )
  assert.equal(safeChoices({ ...choices, options: choices.options.slice(0, 2) }), null)
})

test('a tool call written out as text at the end is cut, unless it sits in a code block', () => {
  assert.deepEqual(
    replyCard(`${reply}\n<invoke name="suggest_replies">\n<parameter name="replies">[]`),
    {
      text: reply,
    },
  )
  const code = '```xml\n<invoke name="x">\n```'
  assert.equal(replyCard(code).text, code)
  assert.equal(replyCard('Writes `<invoke>` inline.').text, 'Writes `<invoke>` inline.')
})

test('older suggest_replies calls are read the same way', () => {
  assert.deepEqual(safeReplies({ replies: ['Send it', '@bob send it'] }), { replies: ['Send it'] })
  assert.equal(safeReplies({ replies: ['/visual'] }), null)
  assert.ok(buttonText('Send it'))
})
