import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPanelAddress, openInPlace, openedInPlace, subscribe } from '../lib/thread-address'

test("the threads panel's addresses open in place, others go to the router", () => {
  assert.equal(isPanelAddress('/app/threads'), true)
  assert.equal(isPanelAddress('/app/threads/'), true)
  assert.equal(isPanelAddress('/app/threads/abc123'), true)
  // A page of its own, with something in it.
  assert.equal(isPanelAddress('/app/threads/abc123/log'), false)
  // What the panel would not read (routeThread takes the path alone).
  assert.equal(isPanelAddress('/app/threads/abc123?tab=files'), false)
  assert.equal(isPanelAddress('/app/threads/abc123#end'), false)
  assert.equal(isPanelAddress('/app/projects/p1/threads'), false)
  assert.equal(isPanelAddress('/app'), false)
})

test('a thread opened in place is known at once, Back and Forward too, until Next catches up', () => {
  // A browser's history, enough for openInPlace.
  const listeners = new Map<string, () => void>()
  const location = { pathname: '/app/threads/a', search: '' }
  Object.assign(globalThis, {
    location,
    history: { pushState: (_: unknown, __: string, href: string) => (location.pathname = href) },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  })
  let heard = 0
  const stop = subscribe(() => heard++)

  assert.equal(openInPlace('/app/threads/b'), true)
  assert.equal(location.pathname, '/app/threads/b')
  assert.equal(openedInPlace(), '/app/threads/b')
  assert.equal(heard, 1)
  // The same address again: nothing to tell.
  openInPlace('/app/threads/b')
  assert.equal(heard, 1)
  // Not the panel's: left to the router, which the panel follows as before.
  assert.equal(openInPlace('/app/library'), false)
  assert.equal(openedInPlace(), '/app/threads/b')

  // Back to another thread: shown at once; to another page: the router's.
  location.pathname = '/app/threads/a'
  listeners.get('popstate')!()
  assert.equal(openedInPlace(), '/app/threads/a')
  location.pathname = '/app/library'
  listeners.get('popstate')!()
  assert.equal(openedInPlace(), null)

  stop()
  assert.equal(listeners.has('popstate'), false)
})
