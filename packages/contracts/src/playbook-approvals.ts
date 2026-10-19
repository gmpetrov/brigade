// Grouped approvals: a playbook's runs ask a person before some of their writes, one ticket
// each (connector-calls.ts). With 50 mails a day that would be 50 items waiting, so wherever
// Brigade lists what waits on a person (Home, the Tickets page, the sidebar's count, the app
// icon badge, pushes), the open approvals of one playbook are one item: "Support and bugs ·
// 12 to approve". Opened, each is decided on its own, or all of one action at once. A decision
// made in bulk is marked on its ticket (decidedInBulk) and never counts toward the action's
// measured trust: approving without reading must not earn a playbook autonomy.
import { z } from 'zod'

/** The playbook approval a ticket is: its installation, its run, and its action when known. */
export type PlaybookApprovalRef = {
  installationId: string
  runId: string
  /** The manifest's action the call is; null for a write no action lists. */
  actionKey: string | null
}

/**
 * The playbook approval a ticket is, or null. Only approvals a run asked for group: a request
 * to activate a playbook or to let an action act on its own, a cap reached, or any other
 * ticket about one, stays an item of its own.
 */
export function playbookApprovalOf(ticket: {
  type: string
  payload: unknown
}): PlaybookApprovalRef | null {
  if (ticket.type !== 'approval') return null
  const p = (ticket.payload ?? {}) as Record<string, unknown>
  if (p.playbookActivation || p.playbookPromotion || p.skillAction || p.credentialAction)
    return null
  if (typeof p.playbookInstallationId !== 'string' || typeof p.playbookRunId !== 'string')
    return null
  return {
    installationId: p.playbookInstallationId,
    runId: p.playbookRunId,
    actionKey: typeof p.playbookActionKey === 'string' ? p.playbookActionKey : null,
  }
}

/** "12 to approve". */
export const toApprove = (count: number) => `${count} to approve`

/** Approve or deny several of a playbook's approvals at once ("Approve all 8"). */
export const DecidePlaybookApprovals = z.object({
  ticketIds: z.array(z.string().min(1)).min(1).max(200),
  approve: z.boolean(),
  reason: z.string().trim().max(2_000).optional(),
})
export type DecidePlaybookApprovals = z.infer<typeof DecidePlaybookApprovals>

/** What came of a bulk decision: those decided, and why the others were not. */
export type DecidedPlaybookApprovals = {
  decided: string[]
  failed: { ticketId: string; error: string }[]
}

/** One approval of the group, with what it will do. */
export type PlaybookApprovalItem = {
  ticketId: string
  title: string
  createdAt: string
  /** Its action, by the manifest's label; else the tool's name in words. */
  action: { key: string | null; label: string }
  /** A connector write: its tool, its account and what it acts on. */
  operation: string | null
  connection: string | null
  target: string | null
  /** A built-in tool the harness asked about, instead of a connector write. */
  toolName: string | null
  /** The call's arguments: the full draft of a mail, the amount, the pull request. */
  input: unknown
  reason: string | null
  /** The run it is part of, by its root thread's title; the thread it waits in. */
  run: { id: string; title: string }
  thread: { id: string; title: string }
  teammate: { id: string; name: string }
  /** Whether this member may decide it: the thread's starter, or an owner or admin. */
  canDecide: boolean
}

export type PlaybookApprovalsView = {
  installation: { id: string; name: string; teammate: { id: string; name: string } }
  /** Oldest first, as they were asked. */
  items: PlaybookApprovalItem[]
}
