import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MEDIA_FRESH_MS,
  RENEW_RETRY_MS,
  onMediaError,
  renewedSrc,
  staleOnRead,
} from '../lib/renewing-media'

test('a renewed address asks the API again, keeping its query and its #fragment', () => {
  const api = 'https://api.example.com/api/library/f1/content'
  assert.equal(renewedSrc(api, 0), api)
  assert.equal(renewedSrc(api, 1), `${api}?renew=1`)
  assert.equal(renewedSrc(`${api}#t=0.1`, 2), `${api}?renew=2#t=0.1`)
  assert.equal(renewedSrc(`${api}?x=1#t=0.1`, 3), `${api}?x=1&renew=3#t=0.1`)
})

test("this browser's own copies are never renewed", () => {
  assert.equal(
    renewedSrc('blob:https://app.example.com/1234', 1),
    'blob:https://app.example.com/1234',
  )
  assert.equal(
    onMediaError({ loaded: true, renewedAt: 0, now: 1e9, src: 'blob:https://app/1' }),
    'fail',
  )
})

test('a player renews before reading more once its signed address may have expired', () => {
  const loadedAt = 1_000_000
  assert.equal(staleOnRead(loadedAt, loadedAt + 60_000), false)
  assert.equal(staleOnRead(loadedAt, loadedAt + MEDIA_FRESH_MS + 1), true)
  // Not loaded yet: its first load asks the API anyway.
  assert.equal(staleOnRead(0, loadedAt), false)
  // Renewed before the 5 minutes the signed URL works.
  assert.ok(MEDIA_FRESH_MS < 5 * 60 * 1000)
})

test('a failure renews a file that played, and gives up on one that never loaded or keeps failing', () => {
  const src = 'https://api.example.com/api/library/f1/content'
  const now = 10_000_000
  assert.equal(onMediaError({ loaded: true, renewedAt: 0, now, src }), 'renew')
  assert.equal(onMediaError({ loaded: false, renewedAt: 0, now, src }), 'fail')
  assert.equal(
    onMediaError({ loaded: true, renewedAt: now - RENEW_RETRY_MS + 1, now, src }),
    'fail',
  )
  assert.equal(
    onMediaError({ loaded: true, renewedAt: now - RENEW_RETRY_MS - 1, now, src }),
    'renew',
  )
})
