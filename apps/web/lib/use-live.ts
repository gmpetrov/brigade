'use client'
import { ApiToBrowser, type BrowserToApi } from '@brigade/contracts'
import { useEffect, useRef } from 'react'
import { WS_URL } from './config'

/** Listen to the dashboard socket for workspace and member updates. */
export function useLive(onMessage: (message: ApiToBrowser) => void) {
  const handler = useRef(onMessage)
  handler.current = onMessage
  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    // Whether the member is looking at this dashboard: notifications wait meanwhile.
    const presence = () => {
      if (socket?.readyState !== WebSocket.OPEN) return
      const visible = document.visibilityState === 'visible' && document.hasFocus()
      socket.send(JSON.stringify({ type: 'presence', visible } satisfies BrowserToApi))
    }
    const connect = () => {
      socket = new WebSocket(`${WS_URL}/api/ws`)
      socket.onopen = presence
      socket.onmessage = (event) => {
        const parsed = ApiToBrowser.safeParse(JSON.parse(String(event.data)))
        if (parsed.success) handler.current(parsed.data)
      }
      socket.onclose = () => {
        if (!stopped) retry = setTimeout(connect, 2000)
      }
    }
    connect()
    document.addEventListener('visibilitychange', presence)
    window.addEventListener('focus', presence)
    window.addEventListener('blur', presence)
    return () => {
      document.removeEventListener('visibilitychange', presence)
      window.removeEventListener('focus', presence)
      window.removeEventListener('blur', presence)
      stopped = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [])
}
