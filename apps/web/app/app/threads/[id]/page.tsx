'use client'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { StatusBadge, useDashboard } from '@/components/dashboard'
import { Takeover } from '@/components/takeover'
import { TicketRow } from '@/components/ticket-row'
import { ThreadItems, useThreadItems } from '@/components/thread-view'
import { api, harnessLabel, useApi, type Thread } from '@/lib/api'
import { useThreadEvents } from '@/lib/use-thread-events'

export default function ThreadPage() {
  const { id } = useParams<{ id: string }>()
  const { me } = useDashboard()
  const thread = useApi<Thread>(`/threads/${id}`)
  const [status, setStatus] = useState<string>()
  const { events, connected } = useThreadEvents(id, setStatus)
  const { items, limits } = useThreadItems(events)
  const [error, setError] = useState<string>()
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', inline: 'nearest' })
  }, [items.length])
  useEffect(() => {
    if (thread.data) setStatus(thread.data.status)
  }, [thread.data])
  // Status changes can open or close tickets (a cap, an empty account): refetch them.
  const reload = thread.reload
  useEffect(() => {
    if (status) void reload()
  }, [status, reload])

  if (!thread.data)
    return <p className={thread.error ? 'error' : 'hint'}>{thread.error?.message ?? 'Loading…'}</p>
  const t = thread.data
  const current = status ?? t.status
  const busy = current === 'running' || current === 'starting'
  // Approvals, questions and caps on a connector call show in the thread itself; other open tickets above it.
  const notices = t.tickets.filter(
    (ticket) =>
      ticket.type !== 'approval' &&
      !(ticket.type === 'question' && ticket.payload.source === 'harness') &&
      !(ticket.type === 'cap' && ticket.payload.connectionId),
  )

  async function call(path: string, body?: unknown) {
    setError(undefined)
    try {
      await api(`/threads/${id}${path}`, { method: 'POST', body: body ?? {} })
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    await call('/messages', { text })
    setText('')
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t.title}
          </h1>
          <div className="hint">
            {t.teammate.name} · {harnessLabel(t.teammate.harness)} on{' '}
            {t.computer.kind === 'cloud' ? 'the workspace computer' : t.computer.name} ·{' '}
            {t.origin === 'webhook'
              ? `started by webhook "${t.webhook?.label ?? 'deleted'}" on ${t.startedBy.user.name}'s accounts`
              : `started by ${t.startedBy.user.name}`}
            {limits?.map(
              (l) => ` · ${l.window.replace('_', ' ')} ${Math.round(l.utilization * 100)}% used`,
            )}
          </div>
        </div>
        <Link href={`/app/threads/${id}/log`} className="button">
          Run log
        </Link>
        <span
          className={`dot ${connected ? 'on' : ''}`}
          title={connected ? 'Live' : 'Reconnecting'}
        />
        <StatusBadge status={current} />
      </div>

      {notices.length > 0 && (
        <ul className="list" style={{ marginBottom: 16 }}>
          {notices.map((ticket) => (
            <TicketRow
              key={ticket.id}
              me={me}
              ticket={{
                ...ticket,
                status: 'open',
                resolvedAt: null,
                session: {
                  id: t.id,
                  title: t.title,
                  origin: t.origin,
                  startedByMemberId: t.startedByMemberId,
                  teammate: t.teammate,
                },
              }}
              onResolve={async (ticketId, approved) => {
                setError(undefined)
                try {
                  await api(`/tickets/${ticketId}/resolve`, { body: { approved } })
                } catch (e) {
                  setError((e as Error).message)
                }
                await thread.reload()
              }}
            />
          ))}
        </ul>
      )}

      <div style={{ marginBottom: 16 }}>
        <Takeover thread={t} memberId={me.memberId ?? ''} onChange={() => void thread.reload()} />
      </div>

      <ThreadItems
        items={items}
        canApprove={t.mayPrompt}
        onApproval={(approvalId, approved) =>
          void call('/approvals', { approvalId, approved }).catch(() => undefined)
        }
        onAnswer={(questionId, answer) =>
          api(`/threads/${id}/answers`, { body: { questionId, answer } }).then(() => undefined)
        }
      />
      <div ref={bottom} />

      {t.controlledByMemberId ? null : t.mayPrompt ? (
        <div className="composer">
          <form onSubmit={(e) => void send(e).catch(() => undefined)} className="card stack">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                busy ? `${t.teammate.name} is working. Your message will run next.` : 'Reply'
              }
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                  void send(e).catch(() => undefined)
              }}
            />
            <div className="row">
              {error && <span className="error">{error}</span>}
              <div className="spacer" />
              {busy && (
                <button
                  type="button"
                  onClick={() => void call('/interrupt').catch(() => undefined)}
                >
                  Interrupt
                </button>
              )}
              <button className="primary" disabled={!text.trim() || current === 'waiting'}>
                Send
              </button>
            </div>
          </form>
        </div>
      ) : (
        <p className="hint">
          This thread runs on {t.startedBy.user.name}&apos;s subscription. You can watch it live.
        </p>
      )}
    </div>
  )
}
