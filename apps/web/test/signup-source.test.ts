import assert from 'node:assert/strict'
import { test } from 'node:test'
import { carried, externalReferrer, sourceOf, withSource } from '../lib/signup-source'

// Where a visit came from, carried in the address from the site's first page to sign-up
// (lib/signup-source.ts).
const at = (url: string) => {
  const u = new URL(url)
  return { search: u.search, pathname: u.pathname, hostname: u.hostname }
}

test('the first page reads utm, the external referrer, its path and a paid click', () => {
  assert.deepEqual(
    sourceOf(
      at('https://www.brigade.lol/how-it-works?utm_source=hn&utm_medium=social&gclid=x&q=1'),
      'https://news.ycombinator.com/item?id=1',
    ),
    {
      utm_source: 'hn',
      utm_medium: 'social',
      ref: 'news.ycombinator.com',
      lp: '/how-it-works',
      paid: '1',
    },
  )
  assert.deepEqual(sourceOf(at('https://www.brigade.lol/'), ''), { lp: '/' })
})

test("Brigade's own pages are no referrer", () => {
  assert.equal(externalReferrer('https://www.brigade.lol/privacy', 'www.brigade.lol'), undefined)
  assert.equal(externalReferrer('https://demo.brigade.lol/app', 'www.brigade.lol'), undefined)
  assert.equal(externalReferrer('not a url', 'www.brigade.lol'), undefined)
  assert.equal(externalReferrer('https://t.co/abc', 'www.brigade.lol'), 't.co')
})

test("a page a link of the site brought keeps the first page's source", () => {
  const first = at('https://www.brigade.lol/privacy?ref=x.com&lp=%2F')
  assert.deepEqual(sourceOf(first, 'https://www.brigade.lol/'), { ref: 'x.com', lp: '/' })
})

test('links carry it in their query, and only the known keys are read back', () => {
  const href = withSource('/sign-up', { utm_source: 'hn', ref: 'news.ycombinator.com', lp: '/' })
  assert.equal(href, '/sign-up?utm_source=hn&ref=news.ycombinator.com&lp=%2F')
  assert.equal(withSource('/sign-in', {}), '/sign-in')
  assert.deepEqual(carried('?utm_source=hn&next=%2Fapp&email=a%40b.c'), { utm_source: 'hn' })
})
