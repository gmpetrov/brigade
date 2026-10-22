import { DEMO_API } from './flag'

const WS = DEMO_API.replace(/^http/, 'ws')
// What answers the demo's requests, loaded with its fixtures on the first one (lib/demo/server.ts).
const server = () => import('./server')

/**
 * Answers the API in the browser: fetch and WebSockets to DEMO_API go to the demo's
 * server, everything else (Next's own files, /version) goes out as usual. Runs once,
 * before the first request (lib/config.ts).
 */
export function installDemo() {
  const w = window as Window & { __brigadeDemo?: boolean }
  if (w.__brigadeDemo) return
  w.__brigadeDemo = true

  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(DEMO_API)) return realFetch(input, init)
    const request = new Request(input, init)
    return (await server()).handle(request)
  }

  const RealSocket = window.WebSocket
  class DemoSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readyState = 0
    readonly url: string
    readonly protocol = ''
    readonly extensions = ''
    binaryType: BinaryType = 'blob'
    readonly bufferedAmount = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    private detach?: () => void

    constructor(url: string | URL) {
      super()
      this.url = String(url)
      void server().then(({ connect }) => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.detach = connect((message) => this.deliver(message))
        this.fire(new Event('open'))
      })
    }
    send(data: string) {
      if (this.readyState !== 1) return
      void server().then(({ receive }) => receive(String(data), (m) => this.deliver(m)))
    }
    close() {
      if (this.readyState >= 2) return
      this.readyState = 3
      this.detach?.()
      setTimeout(() => this.fire(new CloseEvent('close', { code: 1000, wasClean: true })))
    }
    private deliver(message: unknown) {
      if (this.readyState !== 1) return
      this.fire(new MessageEvent('message', { data: JSON.stringify(message) }))
    }
    private fire(event: Event) {
      const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`]
      if (typeof handler === 'function') handler.call(this, event)
      this.dispatchEvent(event)
    }
  }
  window.WebSocket = new Proxy(RealSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      return String(args[0]).startsWith(WS)
        ? (new DemoSocket(args[0]) as unknown as WebSocket)
        : new target(...args)
    },
  })
}
