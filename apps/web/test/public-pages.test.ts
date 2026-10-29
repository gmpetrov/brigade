import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublicPage } from '../lib/public-pages'

test('only the public pages may send analytics', () => {
  for (const page of [
    '/',
    '/how-it-works',
    '/privacy',
    '/terms/',
    '/dpa',
    '/subprocessors',
    '/changelog',
    '/changelog/2026-10-29',
  ])
    assert.equal(isPublicPage(page), true, page)
  for (const page of [
    '/sign-in',
    '/sign-up',
    '/app',
    '/app/threads/x',
    '/onboarding',
    '/privacy/x',
    '/changelog/rss.xml',
  ])
    assert.equal(isPublicPage(page), false, page)
})
