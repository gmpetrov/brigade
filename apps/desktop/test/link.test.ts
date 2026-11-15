import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLink } from '../src/link.js'

test('reads a connect link', () => {
  assert.deepEqual(
    parseLink(
      'brigade://link?code=ABC&api=https%3A%2F%2Fapi.brigade.lol%2F&dashboard=https%3A%2F%2Fwww.brigade.lol%2Fapp&workspace=ws_1',
    ),
    {
      kind: 'connect',
      code: 'ABC',
      api: 'https://api.brigade.lol',
      dashboard: 'https://www.brigade.lol/app',
      workspace: 'ws_1',
    },
  )
})

test('reads a sign-in link', () => {
  assert.deepEqual(parseLink('brigade://sign-in?code=xyz'), { kind: 'signIn', code: 'xyz' })
  assert.equal(parseLink('brigade://sign-in'), undefined)
})

test('turns away what it should not follow', () => {
  // An API without TLS, unless it is a local one.
  assert.equal(parseLink('brigade://link?code=A&api=http%3A%2F%2Fevil.test'), undefined)
  assert.equal(
    parseLink('brigade://link?code=A&api=http%3A%2F%2Flocalhost%3A3001')?.kind,
    'connect',
  )
  assert.equal(parseLink('brigade://link?api=https%3A%2F%2Fapi.test'), undefined)
  assert.equal(parseLink('https://link?code=A&api=https%3A%2F%2Fapi.test'), undefined)
  assert.equal(parseLink('brigade://other?code=A'), undefined)
  assert.equal(parseLink('not a url'), undefined)
  // A dashboard it should not send windows to is dropped, the link kept.
  const link = parseLink(
    'brigade://link?code=A&api=https%3A%2F%2Fapi.test&dashboard=javascript%3Aalert(1)',
  )
  assert.ok(link?.kind === 'connect' && link.dashboard === undefined)
})
