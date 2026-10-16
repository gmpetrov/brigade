import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replyCard, withoutCard } from '../dist/cards.js'

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
