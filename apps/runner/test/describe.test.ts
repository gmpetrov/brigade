import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describePrompt, parseAnswer } from '../src/describe.js'

test('the answer gives the name, the brief and the logo, numbered from 1 in the prompt', () => {
  const answer = parseAnswer(
    'Here: {"name": "Lovarank", "brief": "Lovarank automatise le SEO pour les équipes de contenu.", "logo": 2}',
    3,
  )
  assert.deepEqual(answer, {
    name: 'Lovarank',
    brief: 'Lovarank automatise le SEO pour les équipes de contenu.',
    logo: 1,
  })
})

test('a logo out of range or null is left out', () => {
  assert.equal(
    parseAnswer('{"name": "A", "brief": "A brief long enough to keep.", "logo": 9}', 3).logo,
    undefined,
  )
  assert.equal(
    parseAnswer('{"name": "A", "brief": "A brief long enough to keep.", "logo": null}', 3).logo,
    undefined,
  )
})

test('an answer that is not JSON is taken as the brief', () => {
  assert.deepEqual(parseAnswer('Brief: A plain answer about the product.', 2), {
    brief: 'A plain answer about the product.',
  })
})

test('the prompt numbers the logos and asks for JSON', () => {
  const prompt = describePrompt('https://acme.com', 'Acme sells desks.', [
    'favicon',
    '<img> alt "Acme logo"',
  ])
  assert.match(prompt, /1\. favicon\n2\. <img> alt "Acme logo"/)
  assert.match(prompt, /"logo": 1/)
  assert.doesNotMatch(describePrompt('https://acme.com', 'x'), /Images:/)
})
