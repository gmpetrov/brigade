'use client'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { useApi, type RunLog, type RunLogEntry, type Thread } from '@/lib/api'
import { cn } from '@/lib/utils'

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
  request: 'ticket',
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
    return (
      <p className={cn('text-sm', log.error ? 'text-destructive-text' : 'text-muted-foreground')}>
        {log.error?.message ?? 'Loading…'}
      </p>
    )
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
            <code className="font-mono text-xs">{String(d.operation)}</code> on{' '}
            {String(d.connection)}: {String(d.target)}{' '}
            <StatusBadge
              status={e.type}
              tone={e.type === 'ok' ? 'success' : e.type === 'denied' ? 'warning' : 'destructive'}
            />
            {Boolean(d.write) && <StatusBadge status="write" tone="warning" className="ml-1" />}
            {typeof d.error === 'string' && (
              <span className="text-muted-foreground"> {d.error}</span>
            )}
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
          : /^(trigger|webhook):/.test(String(d.actorId))
            ? 'Trigger'
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
          actor: who(d.memberId) ?? (t.origin === 'trigger' ? 'Trigger' : 'Brigade'),
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
                Visited{' '}
                <code className="font-mono text-xs">
                  {clip((d.input as { url: string }).url, 200)}
                </code>
              </>
            ),
            detail: d.input,
          }
        return {
          actor: teammate,
          what: (
            <>
              Called <code className="font-mono text-xs">{String(d.toolName)}</code>
            </>
          ),
          detail: d.input,
        }
      case 'tool.finished':
        return {
          actor: teammate,
          what: (
            <>
              <code className="font-mono text-xs">{String(d.toolName)}</code>{' '}
              {d.isError ? 'failed' : 'finished'}
            </>
          ),
          detail: d.output,
        }
      case 'approval.requested':
        return {
          actor: teammate,
          what: (
            <>
              Asked to run <code className="font-mono text-xs">{String(d.toolName)}</code>
              {typeof d.reason === 'string' && (
                <span className="text-muted-foreground"> · {d.reason}</span>
              )}
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
              Changed <code className="font-mono text-xs">{String(d.path)}</code>
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
              Ran <code className="font-mono text-xs">{clip(d.command, 200)}</code>
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
      case 'ticket.opened':
        return {
          actor: teammate,
          what: `Opened a ticket: ${clip(d.title)}`,
          detail: d.asks,
        }
      case 'ticket.answered':
        return {
          actor: who(d.memberId) ?? 'a member',
          what:
            (d.answer as { action: string }).action === 'declined'
              ? 'Declined the ticket'
              : 'Answered the ticket',
          detail: d.answer,
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
        return {
          actor: teammate,
          what: <span className="text-destructive-text">{String(d.message)}</span>,
        }
      case 'raw':
        return d.source === 'reasoning'
          ? {
              actor: teammate,
              what: <span className="text-muted-foreground">Thinking</span>,
              detail: d.value,
            }
          : { actor: 'Runner', what: clip(d.value), detail: d.value }
      default:
        return { actor: 'Runner', what: e.type, detail: d }
    }
  }

  const entries = log.data.entries.filter(
    (e) => sources.has(e.source) && (usage || e.type !== 'usage.updated'),
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Link
          href={`/app/threads/${id}`}
          className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4 flex-none" aria-hidden />
          <span className="truncate">{t.title}</span>
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight">Run log</h1>
        <p className="text-sm text-muted-foreground">
          Everything that happened in this thread, in order: messages, tool calls, approvals and who
          gave them, connector calls and files changed.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {SOURCES.map((s) => (
          <Label key={s.value} className="font-normal text-muted-foreground">
            <Checkbox
              checked={sources.has(s.value)}
              onCheckedChange={(checked) => {
                const next = new Set(sources)
                if (checked === true) next.add(s.value)
                else next.delete(s.value)
                setSources(next)
              }}
            />
            {s.label}
          </Label>
        ))}
        <Label className="font-normal text-muted-foreground">
          <Checkbox checked={usage} onCheckedChange={(checked) => setUsage(checked === true)} />
          Usage updates
        </Label>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <Table>
            <TableBody>
              {entries.map((e, i) => {
                const { actor, what, detail } = describe(e)
                return (
                  <TableRow key={`${e.source}${e.seq ?? ''}${i}`} className="hover:bg-transparent">
                    <TableCell
                      className="w-0 py-2.5 pl-4 align-top font-mono text-xs text-muted-foreground"
                      title={new Date(e.at).toLocaleString()}
                    >
                      {new Date(e.at).toLocaleTimeString()}
                    </TableCell>
                    <TableCell className="w-0 py-2.5 align-top text-muted-foreground">
                      {actor}
                    </TableCell>
                    <TableCell className="min-w-64 py-2.5 pr-4 align-top whitespace-normal wrap-anywhere">
                      {detail === undefined ? (
                        what
                      ) : (
                        <Collapsible>
                          <CollapsibleTrigger className="group flex items-start gap-1 text-left">
                            <ChevronRight
                              className="mt-0.5 size-4 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                              aria-hidden
                            />
                            <span className="min-w-0">{what}</span>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">
                              {typeof detail === 'string'
                                ? detail
                                : JSON.stringify(detail, null, 2)}
                            </pre>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
