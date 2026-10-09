'use client'
import '@xterm/xterm/css/xterm.css'
import { ApiToBrowser } from '@brigade/contracts'
import { useEffect, useRef, useState } from 'react'
import { WS_URL } from '@/lib/config'

const COLS = 110
const ROWS = 28

/** A shell on the workspace computer, in the thread's directory, as the teammate's user. */
export function Terminal({ sessionId }: { sessionId: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | undefined
    let term: import('@xterm/xterm').Terminal | undefined
    const terminalId = crypto.randomUUID()

    void import('@xterm/xterm').then(({ Terminal: XTerm }) => {
      if (disposed || !host.current) return
      term = new XTerm({
        cols: COLS,
        rows: ROWS,
        convertEol: false,
        fontSize: 13,
        cursorBlink: true,
      })
      term.open(host.current)
      socket = new WebSocket(`${WS_URL}/api/ws`)
      socket.onopen = () =>
        socket!.send(
          JSON.stringify({ type: 'terminal.open', terminalId, sessionId, cols: COLS, rows: ROWS }),
        )
      socket.onmessage = (event) => {
        const parsed = ApiToBrowser.safeParse(JSON.parse(String(event.data)))
        if (!parsed.success) return
        const message = parsed.data
        if (message.type === 'terminal.output' && message.terminalId === terminalId) {
          setState('open')
          term!.write(message.data)
        } else if (message.type === 'terminal.exit' && message.terminalId === terminalId) {
          setState('closed')
          term!.write('\r\n[terminal closed]\r\n')
        }
      }
      socket.onclose = () => setState('closed')
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: 'terminal.input', terminalId, data }))
      })
    })

    return () => {
      disposed = true
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'terminal.close', terminalId }))
      socket?.close()
      term?.dispose()
    }
  }, [sessionId])

  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-sm text-muted-foreground">
        Terminal{' '}
        {state === 'connecting'
          ? '(starting the computer if needed…)'
          : state === 'closed'
            ? '(closed)'
            : ''}
      </div>
      {/* Black to match xterm's own default background. */}
      <div ref={host} className="overflow-x-auto rounded-lg bg-black p-1.5" />
    </div>
  )
}
