'use client'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useApi, type RunLog, type RunLogEntry, type Thread } from '@/lib/api'

const SOURCES: { value: RunLogEntry['source']; label: string }[] = [
  { value: 'event', label: 'Thread' },
  { value: 'call', label: 'Connector calls' },
  { value: 'ticket', label: 'Tickets' },
  { value: 'audit', label: 'Actions' },
]

const ticketKind: Record<string, string> = {
  approval: 'approval',
  cap: 'reached-cap',
  sign_in: 'expired-login',
  usage_limit: 'out-of-usage',
  question: 'question',
}

const clip = (text: unknown, max = 280) => {
  const s = typeof text === 'string' ? text : JSON.stringify(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Every thread replayed end to end, from the event, call and audit logs. */
export default function RunLogPage() {
  const { id } = useParams<{ id: string }>()
  const thread = useApi<Thread>(`/threads/${id}`)
  const log = useApi<RunLog>(`/threads/${id}/log`)
  const [sources, setSources] = useState(new Set(SOURCES.map((s) => s.value)))
  const [usage, setUsage] = useState(false)

  if (!log.data || !thread.data)
    return <p className={log.error ? 'error' : 'hint'}>{log.error?.message ?? 'Loading…'}</p>
  const t = thread.data
  const members = log.data.members
  const who = (memberId: unknown) =>
    typeof memberId === 'string' ? (members[memberId] ?? 'a former member') : null

  function describe(e: RunLogEntry): { actor: string; what: React.ReactNode; detail?: unknown } {
    const d = e.data
    const teammate = t.teammate.name
    if (e.source === 'call') {
      return {
        actor: teammate,
        what: (
          <>
            <code>{String(d.operation)}</code> on {String(d.connection)}: {String(d.target)}{' '}
            <span
              className={`badge ${e.type === 'ok' ? 'ok' : e.type === 'denied' ? 'warn' : 'danger'}`}
            >
              {e.type}
            </span>
            {Boolean(d.write) && <span className="badge warn"> write</span>}
            {typeof d.error === 'string' && <span className="hint"> {d.error}</span>}
          </>
        ),
      }
    }
    if (e.source === 'ticket') {
      const [kind, state] = e.type.split('.')
      return state === 'opened'
        ? {
            actor: 'Brigade',
            what: (
              <>
                Opened {kind === 'approval' ? 'an' : 'a'} {ticketKind[kind ?? ''] ?? kind} ticket:{' '}
                {String(d.title)}
              </>
            ),
          }
        : {
            actor: who(d.memberId) ?? 'Brigade',
            what: (
              <>
                {state === 'resolved' ? 'Resolved' : state === 'approved' ? 'Approved' : 'Denied'}{' '}
                ticket: {String(d.title)}
              </>
            ),
          }
    }
    if (e.source === 'audit') {
      const actor =
        d.actorType === 'member'
          ? (who(d.actorId) ?? 'a member')
          : String(d.actorId).startsWith('webhook:')
            ? 'Webhook'
            : d.actorType === 'system'
              ? 'Brigade'
              : String(d.actorType)
      const { actorType: _t, actorId: _a, ...rest } = d
      return {
        actor,
        what: e.type.replace(/[._]/g, ' '),
        ...(Object.keys(rest).length ? { detail: rest } : {}),
      }
    }
    switch (e.type) {
      case 'message.user':
        return {
          actor: who(d.memberId) ?? (t.origin === 'webhook' ? 'Webhook' : 'Brigade'),
          what: clip(d.text),
          detail: d.text,
        }
      case 'message.done':
        return { actor: teammate, what: clip(d.text), detail: d.text }
      case 'tool.started':
        // Pages visited in the teammate's browser.
        if (
          /browser_navigate$/.test(String(d.toolName)) &&
          typeof (d.input as { url?: unknown })?.url === 'string'
        )
          return {
            actor: teammate,
            what: (
              <>
                Visited <code>{clip((d.input as { url: string }).url, 200)}</code>
              </>
            ),
            detail: d.input,
          }
        return {
          actor: teammate,
          what: (
            <>
              Called <code>{String(d.toolName)}</code>
            </>
          ),
          detail: d.input,
        }
      case 'tool.finished':
        return {
          actor: teammate,
          what: (
            <>
              <code>{String(d.toolName)}</code> {d.isError ? 'failed' : 'finished'}
            </>
          ),
          detail: d.output,
        }
      case 'approval.requested':
        return {
          actor: teammate,
          what: (
            <>
              Asked to run <code>{String(d.toolName)}</code>
              {typeof d.reason === 'string' && <span className="hint"> · {d.reason}</span>}
            </>
          ),
          detail: d.input,
        }
      case 'approval.resolved':
        return {
          actor: who(d.memberId) ?? 'a member',
          what: `${d.approved ? 'Approved' : 'Denied'}${d.reason ? `: ${String(d.reason)}` : ''}`,
        }
      case 'file.changed':
        return {
          actor: teammate,
          what: (
            <>
              Changed <code>{String(d.path)}</code>
            </>
          ),
        }
      case 'plan.updated':
        return { actor: teammate, what: 'Updated its plan', detail: d.items }
      case 'control.changed':
        return {
          actor: who(d.memberId) ?? 'a member',
          what: d.controller === 'human' ? 'Took over' : 'Handed back',
        }
      case 'terminal.command':
        return {
          actor: who(d.memberId) ?? 'a member',
          what: (
            <>
              Ran <code>{clip(d.command, 200)}</code>
            </>
          ),
        }
      case 'account.switched':
        return {
          actor: 'Brigade',
          what: d.toAccountId
            ? 'Switched to another account with usage left'
            : 'Paused: every account is out of usage',
        }
      case 'question.asked':
        return {
          actor: teammate,
          what: `Asked: ${clip((d.questions as { question: string }[]).map((q) => q.question).join(' / '))}`,
          detail: d.questions,
        }
      case 'question.answered':
        return {
          actor: who(d.memberId) ?? 'a member',
          what:
            (d.answer as { action: string }).action === 'declined'
              ? 'Declined the question'
              : 'Answered',
          detail: d.answer,
        }
      case 'turn.completed':
        return { actor: teammate, what: `Turn finished (${String(d.finishReason)})` }
      case 'usage.updated':
        return { actor: teammate, what: 'Usage updated', detail: d }
      case 'error':
        return { actor: teammate, what: <span className="error">{String(d.message)}</span> }
      case 'raw':
        return d.source === 'reasoning'
          ? { actor: teammate, what: <span className="hint">Thinking</span>, detail: d.value }
          : { actor: 'Runner', what: clip(d.value), detail: d.value }
      default:
        return { actor: 'Runner', what: e.type, detail: d }
    }
  }

  const entries = log.data.entries.filter(
    (e) => sources.has(e.source) && (usage || e.type !== 'usage.updated'),
  )

  return (
    <div className="stack">
      <div>
        <Link href={`/app/threads/${id}`} className="hint">
          ← {t.title}
        </Link>
        <h1 style={{ margin: '4px 0 0' }}>Run log</h1>
        <p className="hint">
          Everything that happened in this thread, in order: messages, tool calls, approvals and who
          gave them, connector calls and files changed.
        </p>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {SOURCES.map((s) => (
          <label key={s.value} className="row hint" style={{ fontWeight: 400 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={sources.has(s.value)}
              onChange={(e) => {
                const next = new Set(sources)
                if (e.target.checked) next.add(s.value)
                else next.delete(s.value)
                setSources(next)
              }}
            />
            {s.label}
          </label>
        ))}
        <label className="row hint" style={{ fontWeight: 400 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={usage}
            onChange={(e) => setUsage(e.target.checked)}
          />
          Usage updates
        </label>
      </div>
      {entries.length === 0 ? (
        <p className="hint">Nothing yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="log">
            <tbody>
              {entries.map((e, i) => {
                const { actor, what, detail } = describe(e)
                return (
                  <tr key={`${e.source}${e.seq ?? ''}${i}`}>
                    <td className="hint" title={new Date(e.at).toLocaleString()}>
                      {new Date(e.at).toLocaleTimeString()}
                    </td>
                    <td>{actor}</td>
                    <td>
                      {detail === undefined ? (
                        what
                      ) : (
                        <details className="tool">
                          <summary>{what}</summary>
                          <pre>
                            {typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
