// The dashboard socket (lib/use-live): one connection for every listener on the page.
import assert from 'node:assert/strict'
import { test } from 'node:test'

class FakeSocket {
  static OPEN = 1
  static opened: FakeSocket[] = []
  readyState = 0
  closed = false
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  constructor(readonly url: string) {
    FakeSocket.opened.push(this)
  }
  send() {}
  close() {
    this.closed = true
  }
  say(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}
const target = { addEventListener() {}, removeEventListener() {} }
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  window: target,
  document: { ...target, visibilityState: 'visible', hasFocus: () => true },
})
const { listen } = await import('../lib/use-live')
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('listeners share one socket, and each hears every message', async () => {
  const heard: string[] = []
  const stopA = listen((m) => heard.push(`a:${m.type}`))
  const stopB = listen((m) => heard.push(`b:${m.type}`))
  assert.equal(FakeSocket.opened.length, 1)
  FakeSocket.opened[0]!.say({ type: 'mail.updated' })
  FakeSocket.opened[0]!.say({ type: 'not.a.message' })
  assert.deepEqual(heard, ['a:mail.updated', 'b:mail.updated'])
  stopA()
  stopB()
  await settle(1100)
  assert.equal(FakeSocket.opened[0]!.closed, true)
})

test('a listener that comes back within a moment keeps the socket', async () => {
  const before = FakeSocket.opened.length
  const stop = listen(() => {})
  stop()
  const again = listen(() => {})
  await settle(1100)
  assert.equal(FakeSocket.opened.length, before + 1)
  assert.equal(FakeSocket.opened.at(-1)!.closed, false)
  again()
  await settle(1100)
  assert.equal(FakeSocket.opened.at(-1)!.closed, true)
})
