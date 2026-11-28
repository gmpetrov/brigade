import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessOf, frameAllow, frameEngine } from '../lib/local-preview'

test('a preview on this computer is framed in Chromium, never in WebKit', () => {
  const mac = 'Macintosh; Intel Mac OS X 10_15_7'
  assert.equal(
    frameEngine(
      `Mozilla/5.0 (${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36`,
    ),
    'chromium',
  )
  assert.equal(
    frameEngine(
      `Mozilla/5.0 (${mac}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0`,
    ),
    'chromium',
  )
  // Safari: its frame blocks http://<thread>.localhost under the dashboard's HTTPS page.
  assert.equal(
    frameEngine(
      `Mozilla/5.0 (${mac}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15`,
    ),
    'webkit',
  )
  assert.equal(
    frameEngine(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/158.0 Mobile/15E148 Safari/604.1',
    ),
    'webkit',
  )
  assert.equal(frameEngine(`Mozilla/5.0 (${mac}; rv:146.0) Gecko/20100101 Firefox/146.0`), 'other')
})

test("Chrome's permission decides whether the frame shows it", () => {
  assert.equal(accessOf('granted'), 'frame')
  assert.equal(accessOf('prompt'), 'ask')
  assert.equal(accessOf('denied'), 'denied')
})

test('only a frame of this computer asks to reach it', () => {
  assert.equal(frameAllow(false), 'clipboard-read; clipboard-write; fullscreen')
  assert.match(frameAllow(true), /loopback-network; local-network; local-network-access$/)
})
