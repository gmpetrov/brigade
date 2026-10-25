'use client'
import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { isAdmin, timeAgo } from '@/components/dashboard'
import {
  EditableEmailPreview,
  isEmailSend,
  ToolInputPreview,
  type EditedEmail,
} from '@/components/email-cards'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { credentialManagersOnly, pullHref, type Me, type Ticket } from '@/lib/api'

const typeLabel: Record<Ticket['type'], string> = {
  approval: 'approval',
  cap: 'reached cap',
  sign_in: 'expired login',
  usage_limit: 'out of usage',
  disk_full: 'disk full',
  question: 'question',
  request: 'ticket',
}

const statusTone = (status: string): StatusTone =>
  status === 'approved'
    ? 'success'
    : status === 'denied'
      ? 'destructive'
      : status === 'open'
        ? 'warning'
        : 'neutral'

/** A collapsed block of raw detail (the pending message or a tool call's input). */
function Detail({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="size-4 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-80 overflow-auto rounded-md border bg-secondary p-3 font-mono text-xs whitespace-pre-wrap">
          {children}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One ticket, with the actions its kind allows this member. */
export function TicketRow({
  ticket: t,
  me,
  onResolve,
}: {
  ticket: Ticket
  me: Me
  /** edited: an email's draft as the person changed it before approving it. */
  onResolve: (
    id: string,
    approved: boolean,
    always?: boolean,
    edited?: EditedEmail,
  ) => Promise<void>
}) {
  const admin = isAdmin(me)
  const starter = t.session?.startedByMemberId === me.memberId
  const open = t.status === 'open'
  const concerns = t.payload.memberId ? t.payload.memberId === me.memberId : starter

  const owner = t.payload.credentialOwnerId === me.memberId
  let actions: React.ReactNode = null
  if (open && t.type === 'approval' && t.payload.playbookActivation) {
    // A playbook a member installed: once active it runs on its own, so an owner or admin decides.
    actions = admin ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Activate
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Decline
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">Waiting for an owner or admin</span>
    )
  } else if (open && t.type === 'approval' && t.payload.playbookPromotion) {
    // Brigade proposes a playbook's action act on its own: it runs on its owner's accounts, so
    // they decide, or an owner or admin.
    const promotion = t.payload.playbookPromotion
    actions =
      admin || promotion.ownerMemberId === me.memberId ? (
        <>
          <Button size="sm" onClick={() => void onResolve(t.id, true)}>
            Let it act on its own
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
            Keep asking first
          </Button>
          <Link
            href={`/app/routines/playbooks/${promotion.installationId}`}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Open the playbook
          </Link>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">
          Waiting for the playbook&apos;s owner or an admin
        </span>
      )
  } else if (open && t.type === 'approval' && t.payload.skillAction) {
    // A teammate's skill: it shapes what every teammate does, so an admin decides.
    actions = admin ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          {t.payload.skillAction === 'update' ? 'Apply the change' : 'Add the skill'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Decline
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">Waiting for an admin</span>
    )
  } else if (open && t.type === 'approval' && t.payload.triggerAction) {
    // A teammate's trigger: outside events start work on someone's accounts, an admin's call.
    actions = admin ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Add the trigger
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Decline
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">Waiting for an owner or admin</span>
    )
  } else if (open && t.type === 'approval' && t.payload.credentialAction) {
    // A credential's ticket: sharing or changing it is for its creator or an admin.
    const managersOnly = credentialManagersOnly(t)
    const mayDecide = managersOnly ? admin || owner : admin || starter
    // Allowing it for good changes who may use it: the creator's or an admin's call.
    const mayAlways =
      t.payload.always && (t.payload.credentialAction === 'create' ? mayDecide : admin || owner)
    actions = mayDecide ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          {t.payload.credentialAction === 'create'
            ? 'Save'
            : t.payload.credentialAction === 'update'
              ? 'Allow the change'
              : 'Allow in this thread'}
        </Button>
        {mayAlways && (
          <Button
            size="sm"
            variant="outline"
            title="Let this teammate use it from now on, in any thread, without asking"
            onClick={() => void onResolve(t.id, true, true)}
          >
            {t.payload.credentialAction === 'create' ? 'Save, use without asking' : 'Always allow'}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Deny
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">
        {managersOnly
          ? 'Waiting for the secret’s creator or an admin'
          : 'For the member who started the thread'}
      </span>
    )
  } else if (open && t.type === 'approval' && (admin || starter)) {
    actions = (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Allow
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Deny
        </Button>
      </>
    )
  } else if (open && t.type === 'cap') {
    actions = admin ? (
      <>
        <Button size="sm" onClick={() => void onResolve(t.id, true)}>
          Allow once
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
          Deny
        </Button>
      </>
    ) : (
      <span className="text-sm text-muted-foreground">Waiting for an admin</span>
    )
  } else if (
    open &&
    (t.type === 'question' || t.type === 'request') &&
    t.payload.source === 'harness'
  ) {
    actions =
      admin || starter ? (
        <>
          {t.session && (
            <Button asChild size="sm">
              <Link href={`/app/threads/${t.session.id}`}>Answer in the thread</Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, false)}>
            Decline
          </Button>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">For the member who started the thread</span>
      )
  } else if (open && (admin || concerns)) {
    actions = (
      <>
        {t.type === 'sign_in' && (
          <Button asChild size="sm">
            <Link href="/app/accounts">Sign in</Link>
          </Button>
        )}
        {t.payload.pullRequest && (
          <Button asChild size="sm">
            <Link href={pullHref(t.payload.pullRequest.repository, t.payload.pullRequest.number)}>
              Open the pull request
            </Link>
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void onResolve(t.id, true)}>
          Dismiss
        </Button>
      </>
    )
  }

  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t.title}</div>
          <div className="text-sm text-muted-foreground">
            {typeLabel[t.type]} · {timeAgo(t.createdAt)}
            {t.session && (
              <>
                {' · '}
                <Link
                  href={`/app/threads/${t.session.id}`}
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  {t.session.title}
                </Link>
                {t.session.origin === 'trigger' && ' (trigger)'}
                {t.session.origin === 'schedule' && ' (schedule)'}
              </>
            )}
            {t.type === 'usage_limit' && t.payload.resetsAt && (
              <> · resets {new Date(t.payload.resetsAt).toLocaleString()}</>
            )}
          </div>
        </div>
        {/* Answered: its status at the top, as on the cards in a thread. */}
        {!actions && <StatusBadge status={t.status} tone={statusTone(t.status)} />}
      </div>
      {t.payload.reason && (
        <p className="mt-1.5 text-sm text-muted-foreground">{t.payload.reason}</p>
      )}
      {t.payload.credentialAction === 'create' && t.payload.details && (
        <Detail summary={`What ${t.payload.credential} would hold (never its value)`}>
          {JSON.stringify({ kind: t.payload.kind, ...t.payload.details }, null, 2)}
        </Detail>
      )}
      {t.payload.credentialAction === 'update' && t.payload.changes && (
        <Detail summary="The change (never the value)">
          {JSON.stringify(
            {
              ...t.payload.changes,
              ...(t.payload.secretReplaced ? { secret: 'replaced; the old value is kept' } : {}),
            },
            null,
            2,
          )}
        </Detail>
      )}
      {t.payload.skillAction && t.payload.skill && <SkillProposalDetail ticket={t} />}
      {t.payload.triggerAction && t.payload.instructions !== undefined && (
        <TriggerProposalDetail ticket={t} />
      )}
      {t.type === 'cap' && t.payload.pending && (
        <Detail summary="The message waiting to run">{t.payload.pending.text}</Detail>
      )}
      {t.type === 'cap' && admin && t.session && (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Used {t.payload.used} of {t.payload.limit}.{' '}
          <Link
            href={`/app/teammates/${t.session.teammate.id}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Change the caps
          </Link>
        </p>
      )}
      {t.payload.input !== undefined && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground wrap-anywhere">
            {t.payload.source === 'harness'
              ? `${t.payload.toolName} (built-in tool)`
              : `${t.payload.operation} on ${t.payload.connection}: ${t.payload.target}`}
          </p>
          {/* An email as it would go, which its approver may change; any other call's arguments one per line. */}
          {open &&
          t.type === 'approval' &&
          isEmailSend(t.payload.operation ?? '') &&
          (admin || starter) ? (
            <EditableEmailPreview
              input={t.payload.input}
              onAllow={(edited) => void onResolve(t.id, true, false, edited)}
            />
          ) : (
            <ToolInputPreview input={t.payload.input} />
          )}
        </div>
      )}
      {/* Last, once all there is to read before deciding has been shown. */}
      {actions && <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  )
}

/** What a teammate proposes a skill should say, and what it said before. */
function SkillProposalDetail({ ticket: t }: { ticket: Ticket }) {
  const skill = t.payload.skill!
  const previous = t.payload.previous
  const files = skill.files.map((f) => f.path)
  return (
    <>
      <p className="mt-1.5 text-sm">
        <span className="font-mono font-semibold">/{skill.name}</span>: {skill.description}
      </p>
      {t.payload.teammateOnly && (
        <p className="mt-1 text-sm text-muted-foreground">
          For {t.session?.teammate.name ?? 'this teammate'}&apos;s threads only. Change where it
          applies in Skills.
        </p>
      )}
      <Detail summary={previous ? 'The skill as proposed' : 'The skill'}>
        {skill.instructions}
        {files.length > 0 && `\n\nWith ${files.join(', ')}`}
      </Detail>
      {previous && (
        <Detail summary="The skill as it is now">
          {previous.instructions}
          {previous.files.length > 0 && `\n\nWith ${previous.files.join(', ')}`}
        </Detail>
      )}
    </>
  )
}

/** What a teammate's trigger listens to, and what it would do with each event. */
function TriggerProposalDetail({ ticket: t }: { ticket: Ticket }) {
  const p = t.payload
  const options = Object.entries(p.options ?? {})
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-sm">
      <p className="text-muted-foreground wrap-anywhere">
        {p.eventLabel} on {p.app}
        {options.map(([name, value]) => ` · ${name} ${value}`).join('')}
        {p.verification === 'none' && ' · unsigned: anyone with its URL can start a thread'}
      </p>
      <Detail summary="Its instructions for each event">{p.instructions}</Detail>
    </div>
  )
}
