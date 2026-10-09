'use client'
import Link from 'next/link'
import { isAdmin, timeAgo } from '@/components/dashboard'
import type { Me, Ticket } from '@/lib/api'

const typeLabel: Record<Ticket['type'], string> = {
  approval: 'approval',
  cap: 'reached cap',
  sign_in: 'expired login',
  usage_limit: 'out of usage',
  question: 'question',
}

/** One ticket, with the actions its kind allows this member. */
export function TicketRow({
  ticket: t,
  me,
  onResolve,
}: {
  ticket: Ticket
  me: Me
  onResolve: (id: string, approved: boolean) => Promise<void>
}) {
  const admin = isAdmin(me)
  const starter = t.session?.startedByMemberId === me.memberId
  const open = t.status === 'open'
  const concerns = t.payload.memberId ? t.payload.memberId === me.memberId : starter

  let actions: React.ReactNode = null
  if (open && t.type === 'approval' && (admin || starter)) {
    actions = (
      <>
        <button className="primary" onClick={() => void onResolve(t.id, true)}>
          Approve
        </button>
        <button onClick={() => void onResolve(t.id, false)}>Deny</button>
      </>
    )
  } else if (open && t.type === 'cap') {
    actions = admin ? (
      <>
        <button className="primary" onClick={() => void onResolve(t.id, true)}>
          Allow once
        </button>
        <button onClick={() => void onResolve(t.id, false)}>Deny</button>
      </>
    ) : (
      <span className="hint">Waiting for an admin</span>
    )
  } else if (open && t.type === 'question' && t.payload.source === 'harness') {
    actions =
      admin || starter ? (
        <>
          {t.session && (
            <Link className="button primary" href={`/app/threads/${t.session.id}`}>
              Answer in the thread
            </Link>
          )}
          <button onClick={() => void onResolve(t.id, false)}>Decline</button>
        </>
      ) : (
        <span className="hint">For the member who started the thread</span>
      )
  } else if (open && (admin || concerns)) {
    actions = (
      <>
        {t.type === 'sign_in' && (
          <Link className="button primary" href="/app/accounts">
            Sign in
          </Link>
        )}
        <button onClick={() => void onResolve(t.id, true)}>Dismiss</button>
      </>
    )
  }

  return (
    <li style={{ display: 'block' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div>{t.title}</div>
          <div className="hint">
            {typeLabel[t.type]} · {timeAgo(t.createdAt)}
            {t.session && (
              <>
                {' · '}
                <Link href={`/app/threads/${t.session.id}`}>{t.session.title}</Link>
                {t.session.origin === 'webhook' && ' (webhook)'}
              </>
            )}
            {t.type === 'usage_limit' && t.payload.resetsAt && (
              <> · resets {new Date(t.payload.resetsAt).toLocaleString()}</>
            )}
          </div>
        </div>
        {actions ?? (
          <span
            className={`badge ${t.status === 'approved' ? 'ok' : t.status === 'denied' ? 'danger' : t.status === 'open' ? 'warn' : ''}`}
          >
            {t.status}
          </span>
        )}
      </div>
      {t.payload.reason && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          {t.payload.reason}
        </p>
      )}
      {t.type === 'cap' && t.payload.pending && (
        <details className="tool" style={{ marginTop: 8 }}>
          <summary className="hint">The message waiting to run</summary>
          <pre>{t.payload.pending.text}</pre>
        </details>
      )}
      {t.type === 'cap' && admin && t.session && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          Used {t.payload.used} of {t.payload.limit}.{' '}
          <Link href={`/app/teammates/${t.session.teammate.id}`}>Change the caps</Link>
        </p>
      )}
      {t.payload.input !== undefined && (
        <details className="tool" style={{ marginTop: 8 }}>
          <summary className="hint">
            {t.payload.source === 'harness'
              ? `${t.payload.toolName} (built-in tool)`
              : `${t.payload.operation} on ${t.payload.connection}: ${t.payload.target}`}
          </summary>
          <pre>
            {typeof t.payload.input === 'string'
              ? t.payload.input
              : JSON.stringify(t.payload.input, null, 2)}
          </pre>
        </details>
      )}
    </li>
  )
}
