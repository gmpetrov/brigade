import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublicPage } from '../lib/public-pages'

test('only the public pages may send analytics', () => {
  for (const page of ['/', '/how-it-works', '/privacy', '/terms/', '/dpa', '/subprocessors'])
    assert.equal(isPublicPage(page), true, page)
  for (const page of [
    '/sign-in',
    '/sign-up',
    '/app',
    '/app/threads/x',
    '/onboarding',
    '/privacy/x',
  ])
    assert.equal(isPublicPage(page), false, page)
})
