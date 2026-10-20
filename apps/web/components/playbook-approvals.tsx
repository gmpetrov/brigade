'use client'
// A playbook's approvals, opened from the one item they are wherever something waits on a
// person (Home's Waiting on you, the Tickets page, a push). Each shows what it will do (the
// whole mail, the amount, the pull request) and is approved or denied on its own, through the
// same route as anywhere; or all of one action at once, once confirmed. Those approved
// together do not count when Brigade measures whether an action may run on its own.
import {
  toApprove,
  type DecidedPlaybookApprovals,
  type PlaybookApprovalItem,
  type PlaybookApprovalsView,
} from '@brigade/contracts'
import Link from 'next/link'
import { useState } from 'react'
import { timeAgo } from '@/components/dashboard'
import { EmailDraftView, emailDraft, ToolArguments } from '@/components/email-cards'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api, pullHref, useApi, type Ticket } from '@/lib/api'
import { useLive } from '@/lib/use-live'

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** What an approval will do, read before deciding: the whole mail, the pull request, else its arguments. */
function ActionPreview({ item }: { item: PlaybookApprovalItem }) {
  const input = record(item.input)
  // A mail (gmail_send, gmail_create_draft): who it goes to, its subject and its whole body.
  const draft = emailDraft(item.input)
  if (draft) return <EmailDraftView draft={draft} account={item.connection ?? undefined} />
  // A pull request to merge: which one, to open before deciding.
  if (
    item.operation?.includes('merge') &&
    typeof input.repository === 'string' &&
    typeof input.number === 'number'
  )
    return (
      <div className="flex flex-col gap-1 rounded-lg border bg-background px-3 py-2.5 text-sm">
        <p>
          Merge{' '}
          <Link
            href={pullHref(input.repository, input.number)}
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            {input.repository}#{input.number}
          </Link>
          {typeof input.method === 'string' && ` (${input.method})`}
        </p>
      </div>
    )
  // Anything else: its arguments, an amount first.
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {(item.target || item.toolName) && (
        <p className="text-sm font-medium wrap-anywhere">
          {item.toolName ? `${item.toolName} (built-in tool)` : item.target}
        </p>
      )}
      <ToolArguments input={item.input} />
    </div>
  )
}

/** The approvals of one action, in the order they were asked. */
type ActionGroup = { key: string; label: string; items: PlaybookApprovalItem[] }

function byAction(items: PlaybookApprovalItem[]) {
  const groups: ActionGroup[] = []
  for (const item of items) {
    const key = item.action.key ?? `tool:${item.action.label}`
    const group = groups.find((g) => g.key === key)
    if (group) group.items.push(item)
    else groups.push({ key, label: item.action.label, items: [item] })
  }
  return groups
}

export function PlaybookApprovals({
  installationId,
  onDecided,
  onEmptied,
}: {
  installationId: string
  /** After each decision: the lists that count what waits catch up. */
  onDecided?: () => Promise<void>
  /** This member decided the last one: what to say it did. */
  onEmptied?: (label: string) => Promise<void>
}) {
  const view = useApi<PlaybookApprovalsView>(`/playbooks/${installationId}/approvals`)
  const reload = view.reload
  useLive((message) => {
    if (message.type === 'tickets.updated') void reload()
  })
  const [error, setError] = useState<string>()
  // Decisions on their way: the buttons wait, without a spinner.
  const [busy, setBusy] = useState(false)
  // The action whose "Approve all" waits for a confirmation.
  const [confirming, setConfirming] = useState<string>()

  if (view.error) return <p className="text-sm text-destructive-text">{view.error.message}</p>
  const v = view.data
  if (!v) return <Skeleton className="h-40 w-full" />
  if (!v.items.length)
    return <p className="px-1 text-sm text-muted-foreground">Nothing left to approve.</p>

  async function after(left: number, label: string) {
    // The last one: what holds the group says it is done (and catches up), before it goes.
    if (!left && onEmptied) return onEmptied(label)
    await Promise.all([reload(), onDecided?.()])
  }

  async function decide(item: PlaybookApprovalItem, approved: boolean) {
    setError(undefined)
    setBusy(true)
    try {
      await api(`/tickets/${item.ticketId}/resolve`, { body: { approved } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
      await reload()
      return
    }
    setBusy(false)
    await after(v!.items.length - 1, approved ? 'Approved' : 'Denied')
  }

  async function approveAll(group: ActionGroup) {
    const ticketIds = group.items.filter((i) => i.canDecide).map((i) => i.ticketId)
    setError(undefined)
    setBusy(true)
    let result: DecidedPlaybookApprovals
    try {
      result = await api<DecidedPlaybookApprovals>(
        `/playbooks/${installationId}/approvals/decide`,
        { body: { ticketIds, approve: true } },
      )
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
      await reload()
      return
    }
    setBusy(false)
    setConfirming(undefined)
    if (result.failed.length)
      setError(
        `${result.failed.length} of ${ticketIds.length} could not be approved: ${result.failed[0]!.error}`,
      )
    await after(v!.items.length - result.decided.length, `${result.decided.length} approved`)
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="px-1 text-sm text-destructive-text">{error}</p>}
      {byAction(v.items).map((group) => {
        const decidable = group.items.filter((i) => i.canDecide).length
        return (
          <section key={group.key} aria-label={group.label} className="flex flex-col gap-2">
            <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-1">
              <h3 className="text-sm font-semibold">{group.label}</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {toApprove(group.items.length)}
              </span>
              {decidable > 1 && confirming !== group.key && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => setConfirming(group.key)}
                >
                  Approve all {decidable}
                </Button>
              )}
            </div>
            {confirming === group.key && (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
                <p>
                  Approve all {decidable} at once? Each one goes ahead as if approved on its own.
                  Approvals given together don&apos;t count when Brigade measures whether this
                  action can run without asking.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void approveAll(group)}>
                    Approve all {decidable}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirming(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <Card className="gap-0 overflow-hidden py-0">
              <ul className="divide-y">
                {group.items.map((item) => (
                  <li key={item.ticketId} className="flex min-w-0 flex-col gap-2 px-4 py-3">
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span aria-hidden className="size-1.5 flex-none rounded-full bg-warning" />
                      <Link
                        href={`/app/threads/${item.thread.id}`}
                        className="truncate font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {item.run.title}
                      </Link>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">{timeAgo(item.createdAt)}</span>
                    </p>
                    <ActionPreview item={item} />
                    {item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
                    {item.canDecide ? (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy} onClick={() => void decide(item, true)}>
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void decide(item, false)}
                        >
                          Deny
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        For the member who started the thread, or an admin
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )
      })}
    </div>
  )
}

/** A playbook's open approvals as one row of the Tickets page, opened in place. */
export function PlaybookApprovalsRow({
  installationId,
  tickets,
  onDecided,
}: {
  installationId: string
  /** Its open approvals as listed, latest first: /tickets lists one, with their count (playbook). */
  tickets: Ticket[]
  onDecided: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const latest = tickets[0]!
  const name = latest.playbook?.name ?? 'Playbook'
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">
            {name} · {toApprove(latest.playbook?.count ?? tickets.length)}
          </div>
          <div className="text-sm text-muted-foreground">
            approvals · {timeAgo(latest.createdAt)}
            {latest.session && ` · ${latest.session.teammate.name}`}
          </div>
        </div>
        <Button size="sm" variant={open ? 'ghost' : 'default'} onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Review'}
        </Button>
      </div>
      {open && (
        <div className="mt-3">
          <PlaybookApprovals installationId={installationId} onDecided={onDecided} />
        </div>
      )}
    </li>
  )
}
