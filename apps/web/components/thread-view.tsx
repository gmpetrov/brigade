'use client'
import type { AgentEvent, SequencedEvent } from '@brigade/contracts'
import { useMemo } from 'react'

type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; done: boolean }
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      toolName: string
      input: unknown
      output?: unknown
      isError?: boolean
      finished: boolean
    }
  | {
      kind: 'approval'
      key: string
      approvalId: string
      toolName: string
      input: unknown
      resolved?: { approved: boolean }
    }
  | { kind: 'plan'; key: string; items: Extract<AgentEvent, { type: 'plan.updated' }>['items'] }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'turn'; key: string; finishReason: string }
  | { kind: 'error'; key: string; message: string }
  | { kind: 'note'; key: string; text: string }

export type Limits = NonNullable<Extract<AgentEvent, { type: 'usage.updated' }>['limits']>

/** Fold the event log into what a person reads: messages, tool calls, approvals. */
export function useThreadItems(events: SequencedEvent[]) {
  return useMemo(() => {
    const items: Item[] = []
    const byKey = new Map<string, Item>()
    let limits: Limits | undefined
    const add = (item: Item) => {
      items.push(item)
      byKey.set(item.key, item)
    }
    for (const { seq, event: e } of events) {
      switch (e.type) {
        case 'message.user':
          add({ kind: 'user', key: `u${seq}`, text: e.text })
          break
        case 'message.delta': {
          const item = byKey.get(`m${e.id}`)
          if (item?.kind === 'assistant') item.text += e.text
          else add({ kind: 'assistant', key: `m${e.id}`, text: e.text, done: false })
          break
        }
        case 'message.done': {
          const item = byKey.get(`m${e.id}`)
          if (item?.kind === 'assistant') Object.assign(item, { text: e.text, done: true })
          else add({ kind: 'assistant', key: `m${e.id}`, text: e.text, done: true })
          break
        }
        case 'tool.started':
          add({
            kind: 'tool',
            key: `t${e.toolCallId}`,
            toolName: e.toolName,
            input: e.input,
            finished: false,
          })
          break
        case 'tool.finished': {
          const item = byKey.get(`t${e.toolCallId}`)
          if (item?.kind === 'tool')
            Object.assign(item, { output: e.output, isError: e.isError, finished: true })
          break
        }
        case 'approval.requested':
          add({
            kind: 'approval',
            key: `a${e.approvalId}`,
            approvalId: e.approvalId,
            toolName: e.toolName,
            input: e.input,
          })
          break
        case 'approval.resolved': {
          const item = byKey.get(`a${e.approvalId}`)
          if (item?.kind === 'approval') item.resolved = { approved: e.approved }
          break
        }
        case 'plan.updated':
          add({ kind: 'plan', key: `p${seq}`, items: e.items })
          break
        case 'file.changed':
          add({ kind: 'file', key: `f${seq}`, path: e.path })
          break
        case 'usage.updated':
          if (e.limits?.length) limits = e.limits
          break
        case 'turn.completed':
          add({ kind: 'turn', key: `c${seq}`, finishReason: e.finishReason })
          break
        case 'error':
          add({ kind: 'error', key: `e${seq}`, message: e.message })
          break
        case 'raw':
          if (e.source === 'reasoning' && typeof e.value === 'string')
            add({ kind: 'thinking', key: `r${seq}`, text: e.value })
          else if (e.source === 'runner' && typeof e.value === 'string')
            add({ kind: 'note', key: `n${seq}`, text: e.value })
          break
        case 'account.switched':
          add({
            kind: 'note',
            key: `n${seq}`,
            text: e.toAccountId
              ? e.reason === 'usage_limit'
                ? 'The account ran out of usage. Continuing on your next account with a summary of this thread.'
                : 'Continuing on another of your accounts with a summary of this thread.'
              : `Paused: all your accounts for this agent are out of usage${e.resetsAt ? ` until ${new Date(e.resetsAt).toLocaleString()}` : ''}. Add an account or send a message after the reset.`,
          })
          break
        case 'terminal.command':
          add({ kind: 'note', key: `n${seq}`, text: `$ ${e.command}` })
          break
        case 'control.changed':
          add({
            kind: 'note',
            key: `n${seq}`,
            text: e.controller === 'human' ? 'A human took over' : 'Control handed back',
          })
          break
      }
    }
    return { items, limits }
  }, [events])
}

const json = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

function toolSummary(toolName: string, input: unknown) {
  const i = (input ?? {}) as Record<string, unknown>
  const value = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description
  return typeof value === 'string' ? value : ''
}

export function ThreadItems({
  items,
  onApproval,
  canApprove,
}: {
  items: Item[]
  onApproval: (approvalId: string, approved: boolean) => void
  canApprove: boolean
}) {
  return (
    <div className="thread">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.key} className="bubble user">
                {item.text}
              </div>
            )
          case 'assistant':
            return (
              <div key={item.key} className="bubble assistant">
                {item.text}
              </div>
            )
          case 'thinking':
            return (
              <details key={item.key} className="tool">
                <summary className="hint">Thinking</summary>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{item.text}</pre>
              </details>
            )
          case 'tool':
            return (
              <details key={item.key} className="tool">
                <summary>
                  <code>{item.toolName}</code>
                  <span
                    className="hint"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {toolSummary(item.toolName, item.input)}
                  </span>
                  {!item.finished ? (
                    <span className="badge">running</span>
                  ) : item.isError ? (
                    <span className="badge danger">failed</span>
                  ) : null}
                </summary>
                <pre>{json(item.input)}</pre>
                {item.output !== undefined && <pre>{json(item.output)}</pre>}
              </details>
            )
          case 'approval':
            return (
              <div key={item.key} className="approval">
                <div className="meta">Approval needed</div>
                <div style={{ marginBottom: 8 }}>
                  Allow <code>{item.toolName}</code> {toolSummary(item.toolName, item.input)}?
                </div>
                <pre
                  className="card"
                  style={{ background: 'var(--sunken)', overflowX: 'auto', maxHeight: 240 }}
                >
                  {json(item.input)}
                </pre>
                {item.resolved ? (
                  <span className={`badge ${item.resolved.approved ? 'ok' : 'danger'}`}>
                    {item.resolved.approved ? 'Approved' : 'Denied'}
                  </span>
                ) : canApprove ? (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="primary" onClick={() => onApproval(item.approvalId, true)}>
                      Approve
                    </button>
                    <button onClick={() => onApproval(item.approvalId, false)}>Deny</button>
                  </div>
                ) : (
                  <p className="hint">Only the member who started this thread can answer.</p>
                )}
              </div>
            )
          case 'plan':
            return (
              <div key={item.key} className="card">
                <div className="meta">Plan</div>
                {item.items.map((p, i) => (
                  <div key={i}>
                    {p.status === 'completed' ? '☑' : p.status === 'in_progress' ? '◐' : '☐'}{' '}
                    {p.content}
                  </div>
                ))}
              </div>
            )
          case 'file':
            return (
              <div key={item.key} className="hint">
                Changed <code>{item.path}</code>
              </div>
            )
          case 'turn':
            return item.finishReason === 'interrupted' ? (
              <div key={item.key} className="hint">
                Interrupted
              </div>
            ) : null
          case 'error':
            return (
              <div
                key={item.key}
                className="bubble error"
                style={{ border: '1px solid var(--danger)' }}
              >
                {item.message}
              </div>
            )
          case 'note':
            return (
              <div key={item.key} className="hint">
                {item.text}
              </div>
            )
        }
      })}
    </div>
  )
}
