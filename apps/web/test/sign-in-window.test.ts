import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  desktopSignedInLink,
  onSignIn,
  openSignIn,
  tellSignIn,
  type SignInResult,
} from '../lib/sign-in-window'

const next = () =>
  new Promise<SignInResult>((resolve) => {
    const stop = onSignIn((result) => {
      stop()
      resolve(result)
    })
  })

test('the sign-in tab tells the waiting page which account signed in', async () => {
  const heard = next()
  tellSignIn({ connected: 'conn_1' })
  assert.deepEqual(await heard, { connected: 'conn_1' })
})

test('the sign-in tab tells the waiting page why it did not', async () => {
  const heard = next()
  tellSignIn({ error: 'declined' })
  assert.deepEqual(await heard, { error: 'declined' })
})

/** Brigade.app's bridge, as its preload gives it: a one-time value, and results it hears. */
function inDesktopApp() {
  const handlers = new Set<(result: SignInResult) => void>()
  const opened: string[] = []
  // The tab the dashboard opens; it sets the tab's address once the API gave it.
  const tab = {
    get location() {
      return {
        set href(url: string) {
          opened.push(url)
        },
      } as { href: string }
    },
    close() {},
  }
  Object.assign(globalThis, {
    window: {
      open: () => tab,
      brigadeDesktop: {
        providerSignIn: {
          start: async () => 'once-1',
          onResult: (handle: (result: SignInResult) => void) => {
            handlers.add(handle)
            return () => handlers.delete(handle)
          },
        },
      },
    },
  })
  return { handlers, opened, done: () => delete (globalThis as { window?: unknown }).window }
}

test('in Brigade.app, the sign-in comes back to the app with a one-time value', async () => {
  const app = inDesktopApp()
  try {
    const returns: (string | undefined)[] = []
    const inWindow = await openSignIn(async (returnTo) => {
      returns.push(returnTo)
      return 'https://accounts.example/consent'
    })
    assert.equal(inWindow, true)
    assert.deepEqual(returns, ['/app/connections?popup=1&desktop=once-1'])
    assert.deepEqual(app.opened, ['https://accounts.example/consent'])
    // The return page, in the browser, hands the result to the app.
    assert.equal(
      desktopSignedInLink('once-1', { connected: 'conn_1' }),
      'brigade://signed-in?nonce=once-1&connected=conn_1',
    )
  } finally {
    app.done()
  }
})

test('in Brigade.app, the waiting page hears the result the app brings back', async () => {
  const app = inDesktopApp()
  try {
    const heard = next()
    assert.equal(app.handlers.size, 1)
    for (const handle of app.handlers) handle({ connected: 'conn_2' })
    assert.deepEqual(await heard, { connected: 'conn_2' })
    // Heard once: the listener is gone with its cleanup.
    assert.equal(app.handlers.size, 0)
  } finally {
    app.done()
  }
})
