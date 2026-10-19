import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HTTPException } from 'hono/http-exception'
import { accountReaching } from '../src/repository-grant.js'

const gmpetrov = { id: 'c1', label: 'GitHub', externalAccount: 'gmpetrov (selected repositories)' }
const acme = { id: 'c2', label: 'GitHub', externalAccount: 'acme (all repositories)' }
const refused = (status: number, text: RegExp) => (e: unknown) =>
  e instanceof HTTPException && e.status === status && text.test(e.message)

test('gives the account that reaches the repository, picked or the only one', () => {
  const reaching = new Set(['c2'])
  assert.equal(accountReaching('acme/web', [gmpetrov, acme], reaching, 'c2'), acme)
  assert.equal(accountReaching('acme/web', [gmpetrov, acme], reaching, undefined), acme)
})

test('refuses a picked account whose installation does not reach the repository', () => {
  assert.throws(
    () => accountReaching('thewrappingcompany/lovadesk', [gmpetrov], new Set(), 'c1'),
    refused(
      409,
      /gmpetrov \(selected repositories\) does not reach thewrappingcompany\/lovadesk.*install the GitHub app on thewrappingcompany/,
    ),
  )
})

test('refuses when no account the person may give reaches the repository', () => {
  assert.throws(
    () => accountReaching('thewrappingcompany/lovadesk', [gmpetrov], new Set(), undefined),
    refused(409, /No GitHub account you can give reaches thewrappingcompany\/lovadesk/),
  )
  // Reached only through an account this person may not give.
  assert.throws(
    () => accountReaching('acme/web', [gmpetrov], new Set(['c3']), undefined),
    refused(409, /No GitHub account/),
  )
})

test('asks which account when several reach the repository', () => {
  assert.throws(
    () => accountReaching('acme/web', [gmpetrov, acme], new Set(['c1', 'c2']), undefined),
    refused(400, /Pick the GitHub account/),
  )
})
