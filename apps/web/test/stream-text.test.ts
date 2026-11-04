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
