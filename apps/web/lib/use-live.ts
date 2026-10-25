'use client'
import { ApiToBrowser, type BrowserToApi } from '@brigade/contracts'
import { useEffect, useRef } from 'react'
import { WS_URL } from './config'

type Listener = (message: ApiToBrowser) => void

// One dashboard socket for every listener on the page: each list that stays live adds a
// listener, not a connection.
const listeners = new Set<Listener>()
// Called when the socket is back after it dropped: what it would have said meanwhile is lost,
// so lists fetch again.
const reconnects = new Set<() => void>()
let stop: (() => void) | undefined
let closing: ReturnType<typeof setTimeout> | undefined

function open() {
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let dropped = false
  // Whether the member is looking at this dashboard: notifications wait meanwhile. Each
  // message holds for a little over a minute, so it is repeated while in view.
  const presence = () => {
    if (socket?.readyState !== WebSocket.OPEN) return
    const visible = document.visibilityState === 'visible' && document.hasFocus()
    socket.send(JSON.stringify({ type: 'presence', visible } satisfies BrowserToApi))
  }
  const connect = () => {
    socket = new WebSocket(`${WS_URL}/api/ws`)
    socket.onopen = () => {
      presence()
      if (!dropped) return
      dropped = false
      for (const reconnected of [...reconnects]) reconnected()
    }
    socket.onmessage = (event) => {
      const parsed = ApiToBrowser.safeParse(JSON.parse(String(event.data)))
      if (parsed.success) for (const listener of [...listeners]) listener(parsed.data)
    }
    socket.onclose = () => {
      dropped = true
      if (!stopped) retry = setTimeout(connect, 2000)
    }
  }
  connect()
  const repeat = setInterval(presence, 30_000)
  document.addEventListener('visibilitychange', presence)
  window.addEventListener('focus', presence)
  window.addEventListener('blur', presence)
  return () => {
    clearInterval(repeat)
    document.removeEventListener('visibilitychange', presence)
    window.removeEventListener('focus', presence)
    window.removeEventListener('blur', presence)
    stopped = true
    clearTimeout(retry)
    socket?.close()
  }
}

/**
 * Hear every message of the dashboard socket until the returned function is called, and
 * `onReconnect` each time it is back after dropping (messages may have been missed).
 */
export function listen(listener: Listener, onReconnect?: () => void) {
  listeners.add(listener)
  if (onReconnect) reconnects.add(onReconnect)
  clearTimeout(closing)
  stop ??= open()
  return () => {
    listeners.delete(listener)
    if (onReconnect) reconnects.delete(onReconnect)
    if (listeners.size) return
    // Kept a moment: a page that changes takes its listeners off before the next one's are on.
    closing = setTimeout(() => {
      if (listeners.size) return
      stop?.()
      stop = undefined
    }, 1000)
  }
}

/**
 * Listen to the dashboard socket for workspace and member updates, and `onReconnect` once it
 * is back after dropping.
 */
export function useLive(onMessage: Listener, onReconnect?: () => void) {
  const handler = useRef(onMessage)
  handler.current = onMessage
  const reconnected = useRef(onReconnect)
  reconnected.current = onReconnect
  useEffect(
    () =>
      listen(
        (message) => handler.current(message),
        () => reconnected.current?.(),
      ),
    [],
  )
}
