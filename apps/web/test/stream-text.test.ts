import assert from 'node:assert/strict'
import { test } from 'node:test'
import { closeOpenMarkdown, revealStep, wordCut } from '../lib/stream-text'

test('a cut ends with a word, never inside one', () => {
  const text = 'Je te conseille une adresse'
  assert.equal(text.slice(0, wordCut(text, 5)), 'Je te ')
  assert.equal(text.slice(0, wordCut(text, 6)), 'Je te ')
  assert.equal(text.slice(0, wordCut(text, 1)), '')
  assert.equal(wordCut(text, 99), text.length)
})

test('text without spaces still shows as it grows', () => {
  const text = '我建议使用一个地址作为苹果账号并且邀请到两个服务里面'
  assert.equal(wordCut(text, 10), 10)
  assert.equal(wordCut('apple@brigade.lol/abcdefghijklmnop', 30), 30)
  // A word within reach still shows whole, later.
  assert.equal(wordCut('Je te conseille', 8), 6)
  // Not between an emoji's halves.
  assert.equal(wordCut('🙂'.repeat(12), 19), 18)
})

test('a reply without spaces reveals while it is still coming', () => {
  // As useSmoothText does at 60 frames a second, 35 characters coming every 200 ms.
  let text = ''
  let at = 0
  let shown = 0
  for (let frame = 0; frame < 120; frame++) {
    if (frame % 12 === 0) text += '我建议使用一个地址作为苹果账号'.repeat(3).slice(0, 35)
    at = Math.min(text.length, at + revealStep(text.length - at, 1 / 60, false))
    shown = wordCut(text, Math.floor(at))
  }
  assert.ok(shown > text.length / 2, `${shown} of ${text.length}`)
})

test('what waits is caught up in about a third of a second, done in less', () => {
  assert.equal(revealStep(0, 1, false), 60)
  assert.ok(Math.abs(revealStep(70, 0.35, false) - 70) < 1e-9)
  assert.ok(revealStep(70, 0.1, true) > revealStep(70, 0.1, false))
})

test('open bold, code and strike close at the end of what came', () => {
  assert.equal(closeOpenMarkdown('Voici **Ce qui'), 'Voici **Ce qui**')
  assert.equal(closeOpenMarkdown('Voici **Ce qui '), 'Voici **Ce qui** ')
  assert.equal(closeOpenMarkdown('une `apple@bri'), 'une `apple@bri`')
  assert.equal(closeOpenMarkdown('un ~~vieux'), 'un ~~vieux~~')
  assert.equal(closeOpenMarkdown('**gras `code'), '**gras `code`**')
})

test('a marker with nothing after it yet does not show', () => {
  assert.equal(closeOpenMarkdown('Voici **'), 'Voici ')
  assert.equal(closeOpenMarkdown('une `'), 'une ')
})

test('a link shows as its words while its address comes', () => {
  assert.equal(closeOpenMarkdown('voir [la doc'), 'voir la doc')
  assert.equal(closeOpenMarkdown('voir [la doc](https://exa'), 'voir la doc')
  assert.equal(
    closeOpenMarkdown('voir [la doc](https://x.y) puis'),
    'voir [la doc](https://x.y) puis',
  )
})

test('closed Markdown, earlier paragraphs and fenced code stay as they are', () => {
  assert.equal(closeOpenMarkdown('**a** et `b`'), '**a** et `b`')
  assert.equal(closeOpenMarkdown('**a\n\nb'), '**a\n\nb')
  assert.equal(closeOpenMarkdown('```ts\nconst a = `x'), '```ts\nconst a = `x')
  assert.equal(closeOpenMarkdown('```ts\nx\n```\nun **b'), '```ts\nx\n```\nun **b**')
})
