import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onSignIn, tellSignIn, type SignInResult } from '../lib/sign-in-window'

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
