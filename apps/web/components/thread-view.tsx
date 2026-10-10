'use client'
import {
  formatMention,
  mentionsToText,
  type AgentEvent,
  type Ask,
  type AskReply,
  type MessageAttachment,
  type Question,
  type QuestionAnswer,
  type SequencedEvent,
  type TicketAnswer,
} from '@brigade/contracts'
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleHelp,
  ClipboardList,
  GitPullRequest,
  ListChecks,
  Plus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { MessageAttachments } from '@/components/attachments'
import { CredentialForm } from '@/components/credential-form'
import { TeammateAvatar } from '@/components/dashboard'
import { FileLinksProvider, useFileLinks } from '@/components/file-links'
import { Markdown, MessageWithCode } from '@/components/markdown'
import { credentialHint } from '@/components/mention'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { pullHref, threadImageUrl, useApi, type Credential, type Teammate } from '@/lib/api'
import { cn } from '@/lib/utils'

type Item =
  | { kind: 'user'; key: string; text: string; attachments: MessageAttachment[] }
  | { kind: 'assistant'; key: string; text: string; done: boolean; teammateId?: string }
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
      reason?: string
      resolved?: { approved: boolean }
    }
  | {
      kind: 'question'
      key: string
      questionId: string
      questions: Question[]
      answer?: QuestionAnswer
    }
  | {
      kind: 'ticket'
      key: string
      requestId: string
      title: string
      asks: Ask[]
      teammateId?: string
      answer?: TicketAnswer
    }
  | { kind: 'plan'; key: string; items: Extract<AgentEvent, { type: 'plan.updated' }>['items'] }
  | { kind: 'file'; key: string; path: string }
  | { kind: 'image'; key: string; path: string; teammateId?: string; prompt?: string }
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
          add({ kind: 'user', key: `u${seq}`, text: e.text, attachments: e.attachments ?? [] })
          break
        // Ids come from each teammate's own harness: keyed by teammate too.
        case 'message.delta': {
          const key = `m${e.teammateId ?? ''}:${e.id}`
          const item = byKey.get(key)
          if (item?.kind === 'assistant') item.text += e.text
          else add({ kind: 'assistant', key, text: e.text, done: false, teammateId: e.teammateId })
          break
        }
        case 'message.done': {
          const key = `m${e.teammateId ?? ''}:${e.id}`
          const item = byKey.get(key)
          if (item?.kind === 'assistant') Object.assign(item, { text: e.text, done: true })
          else add({ kind: 'assistant', key, text: e.text, done: true, teammateId: e.teammateId })
          break
        }
        case 'tool.started':
          add({
            kind: 'tool',
            key: `t${e.teammateId ?? ''}:${e.toolCallId}`,
            toolName: e.toolName,
            input: e.input,
            finished: false,
          })
          break
        case 'tool.finished': {
          const item = byKey.get(`t${e.teammateId ?? ''}:${e.toolCallId}`)
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
            ...(e.reason ? { reason: e.reason } : {}),
          })
          break
        case 'approval.resolved': {
          const item = byKey.get(`a${e.approvalId}`)
          if (item?.kind === 'approval') item.resolved = { approved: e.approved }
          break
        }
        case 'question.asked':
          add({
            kind: 'question',
            key: `q${e.questionId}`,
            questionId: e.questionId,
            questions: e.questions,
          })
          break
        case 'question.answered': {
          const item = byKey.get(`q${e.questionId}`)
          if (item?.kind === 'question') item.answer = e.answer
          break
        }
        case 'ticket.opened':
          add({
            kind: 'ticket',
            key: `k${e.requestId}`,
            requestId: e.requestId,
            title: e.title,
            asks: e.asks,
            ...(e.teammateId ? { teammateId: e.teammateId } : {}),
          })
          break
        case 'ticket.answered': {
          const item = byKey.get(`k${e.requestId}`)
          if (item?.kind === 'ticket') item.answer = e.answer
          break
        }
        case 'plan.updated':
          add({ kind: 'plan', key: `p${seq}`, items: e.items })
          break
        case 'file.changed':
          add({ kind: 'file', key: `f${seq}`, path: e.path })
          break
        case 'image.generated':
          add({
            kind: 'image',
            key: `i${seq}`,
            path: e.path,
            ...(e.teammateId ? { teammateId: e.teammateId } : {}),
            ...(e.prompt ? { prompt: e.prompt } : {}),
          })
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

/**
 * The pull request a github_create_pull_request call opened. Its output reaches the
 * thread in each harness's own wrapping, so the pull request's URL is what is looked for.
 */
function openedPull(item: { toolName: string; input: unknown; output?: unknown }) {
  if (!/github_create_pull_request/.test(item.toolName)) return null
  const found = json(item.output ?? '').match(
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/,
  )
  if (!found) return null
  const title = (item.input as { title?: unknown } | null)?.title
  return {
    repository: found[1]!.toLowerCase(),
    number: Number(found[2]),
    title: typeof title === 'string' ? title : null,
  }
}

/** Raw JSON or text under a tool call, an approval or a thought. */
const preClass =
  'max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere'

/** A small uppercase label heading a card in the thread. */
function CardLabel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 text-xs font-bold tracking-wider uppercase [&>svg]:size-3.5',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A picture a teammate made, under its messages. Opens beside the thread. */
function ThreadImage({
  threadId,
  item,
}: {
  threadId: string
  item: Extract<Item, { kind: 'image' }>
}) {
  const links = useFileLinks()
  const [failed, setFailed] = useState(false)
  const name = item.path.split('/').pop()
  if (failed)
    return (
      <div className="pl-11 text-sm text-muted-foreground">
        Made <code className="font-mono text-xs text-foreground">{item.path}</code>, which can't be
        shown while the computer is offline.
      </div>
    )
  return (
    <div className="pl-11">
      <button
        type="button"
        className="block overflow-hidden rounded-lg border bg-muted"
        title={item.prompt ?? name}
        onClick={() => links?.open({ path: item.path, teammateId: item.teammateId })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={threadImageUrl(threadId, item.path, item.teammateId)}
          alt={item.prompt ?? name ?? 'A generated image'}
          className="max-h-96 max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      </button>
    </div>
  )
}

export function ThreadItems({
  threadId,
  items,
  onApproval,
  onAnswer,
  onTicket,
  canApprove,
  teammate,
  teammates = [],
}: {
  threadId: string
  items: Item[]
  onApproval: (approvalId: string, approved: boolean) => void
  onAnswer: (questionId: string, answer: QuestionAnswer) => Promise<void>
  onTicket: (requestId: string, answer: TicketAnswer) => Promise<void>
  canApprove: boolean
  /** Who answers when a message does not say: shown beside its messages. */
  teammate?: { name: string; harness: string }
  /** Everyone in the thread. With several, each message shows who wrote it. */
  teammates?: { id: string; name: string; harness: string }[]
}) {
  // A teammate carries its harness as a plain string; the avatar only tells codex apart.
  const avatarOf = (t: { name: string; harness: string } | undefined) =>
    t && { name: t.name, harness: t.harness as Teammate['harness'] }
  const byId = new Map(teammates.map((t) => [t.id, t]))
  const several = teammates.length > 1
  return (
    <div className="flex flex-col gap-4">
      {items.map((item, i) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={item.key} className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
                {item.text && (
                  <div className="rounded-2xl rounded-br-md bg-primary px-4 py-2.5 leading-relaxed wrap-anywhere whitespace-pre-wrap text-primary-foreground">
                    <MessageWithCode text={item.text} />
                  </div>
                )}
                {item.attachments.length > 0 && (
                  <MessageAttachments attachments={item.attachments} className="justify-end" />
                )}
              </div>
            )
          case 'assistant': {
            const author = (item.teammateId && byId.get(item.teammateId)) || teammate
            const avatar = avatarOf(author)
            // With several teammates, name the author where the speaker changes.
            const previous = items
              .slice(0, i)
              .findLast((it): it is Extract<Item, { kind: 'assistant' }> => it.kind === 'assistant')
            const named =
              several &&
              author &&
              (!previous ||
                previous.teammateId !== item.teammateId ||
                items.slice(items.indexOf(previous), i).some((it) => it.kind === 'user'))
            return (
              <div key={item.key} className="flex items-start gap-3">
                {avatar && <TeammateAvatar teammate={avatar} className="mt-0.5 size-8" />}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
                  {named && <span className="text-sm font-semibold">{author.name}</span>}
                  {/* A file it names opens from its own working folder first. */}
                  <FileLinksProvider value={{ teammateId: item.teammateId }}>
                    <Markdown text={item.text} />
                  </FileLinksProvider>
                </div>
              </div>
            )
          }
          case 'thinking':
            return (
              <Collapsible key={item.key} className="self-start">
                <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-sm text-muted-foreground hover:border-solid hover:text-foreground">
                  <ChevronRight
                    className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
                    aria-hidden
                  />
                  Thinking
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Markdown
                    text={item.text}
                    className="mt-2 max-h-80 overflow-auto rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
                  />
                </CollapsibleContent>
              </Collapsible>
            )
          case 'tool': {
            const opened = item.finished && !item.isError ? openedPull(item) : null
            if (opened)
              return (
                <Link
                  key={item.key}
                  href={pullHref(opened.repository, opened.number)}
                  className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm hover:bg-secondary/50"
                >
                  <GitPullRequest className="size-5 flex-none text-success" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">
                      Opened pull request #{opened.number}
                      {opened.title && `: ${opened.title}`}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {opened.repository}
                    </span>
                  </span>
                  <span className="flex-none font-medium text-primary">See the changes</span>
                </Link>
              )
            return (
              <Collapsible key={item.key} className="rounded-lg border border-dashed text-sm">
                <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left">
                  <ChevronRight
                    className="size-3.5 flex-none text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                    aria-hidden
                  />
                  <code className="flex-none font-mono text-xs font-medium">{item.toolName}</code>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {toolSummary(item.toolName, item.input)}
                  </span>
                  {!item.finished ? (
                    <StatusBadge status="running" />
                  ) : item.isError ? (
                    <StatusBadge status="failed" />
                  ) : null}
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-2 border-t border-dashed p-2">
                  <pre className={preClass}>{json(item.input)}</pre>
                  {item.output !== undefined && <pre className={preClass}>{json(item.output)}</pre>}
                </CollapsibleContent>
              </Collapsible>
            )
          }
          case 'approval':
            return (
              <Card key={item.key} className="gap-3 border-warning/50 px-5 py-4">
                <CardLabel className="text-warning">
                  <ShieldAlert aria-hidden />
                  Approval needed
                </CardLabel>
                <div className="font-medium">
                  Allow <code className="font-mono text-sm">{item.toolName}</code>{' '}
                  {toolSummary(item.toolName, item.input)}?
                </div>
                {item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
                <pre className={cn(preClass, 'max-h-60')}>{json(item.input)}</pre>
                {item.resolved ? (
                  <StatusBadge
                    status={item.resolved.approved ? 'approved' : 'denied'}
                    label={item.resolved.approved ? 'Approved' : 'Denied'}
                  />
                ) : canApprove ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => onApproval(item.approvalId, true)}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onApproval(item.approvalId, false)}
                    >
                      Deny
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Only the member who started this thread can answer.
                  </p>
                )}
              </Card>
            )
          case 'question':
            return (
              <QuestionCard
                key={item.key}
                item={item}
                canAnswer={canApprove}
                onAnswer={(answer) => onAnswer(item.questionId, answer)}
              />
            )
          case 'ticket':
            return (
              <TicketCard
                key={item.key}
                item={item}
                canAnswer={canApprove}
                teammates={teammates}
                askerId={item.teammateId}
                askerName={
                  (item.teammateId && byId.get(item.teammateId)?.name) ||
                  teammate?.name ||
                  'the teammate'
                }
                onAnswer={(answer) => onTicket(item.requestId, answer)}
              />
            )
          case 'plan':
            return (
              <Card key={item.key} className="gap-2 px-5 py-4">
                <CardLabel className="text-muted-foreground">
                  <ListChecks aria-hidden />
                  Plan
                </CardLabel>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {item.items.map((p, i) => (
                    <li key={i} className="flex items-start gap-2">
                      {p.status === 'completed' ? (
                        <CircleCheck
                          className="mt-0.5 size-4 flex-none text-success"
                          aria-label="Done"
                        />
                      ) : p.status === 'in_progress' ? (
                        <CircleDot
                          className="mt-0.5 size-4 flex-none text-primary"
                          aria-label="In progress"
                        />
                      ) : (
                        <Circle
                          className="mt-0.5 size-4 flex-none text-muted-foreground"
                          aria-label="To do"
                        />
                      )}
                      <span className={cn(p.status === 'completed' && 'text-muted-foreground')}>
                        {p.content}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )
          case 'file':
            return (
              <div key={item.key} className="text-sm text-muted-foreground">
                Changed <code className="font-mono text-xs text-foreground">{item.path}</code>
              </div>
            )
          case 'image':
            return <ThreadImage key={item.key} threadId={threadId} item={item} />
          case 'turn':
            return item.finishReason === 'interrupted' ? (
              <div key={item.key} className="text-sm text-muted-foreground">
                Interrupted
              </div>
            ) : null
          case 'error':
            return (
              <div
                key={item.key}
                role="alert"
                className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm wrap-anywhere whitespace-pre-wrap text-destructive-text"
              >
                {item.message}
              </div>
            )
          case 'note':
            return (
              <div key={item.key} className="text-sm text-muted-foreground">
                {item.text}
              </div>
            )
        }
      })}
    </div>
  )
}

const isSecret = (q: Question) => typeof q.allowFreeForm === 'object' && q.allowFreeForm.secret

/**
 * The answer to a question asking for a secret: a credential from the vault,
 * or a new one saved there from here. The teammate gets its mention, which
 * lets it use the credential in this thread; the secret itself never goes
 * into the answer.
 */
function CredentialPicker({
  value,
  onChange,
  disabled,
  intro = 'This asks for a secret. Pick one from the vault, or add it there: your teammate can then use it in this thread without ever seeing it.',
  onNew,
}: {
  value: string
  onChange: (mention: string) => void
  disabled: boolean
  intro?: string
  /** Adding a new one happens elsewhere, instead of in a form here. */
  onNew?: () => void
}) {
  const credentials = useApi<Credential[]>('/credentials')
  const [adding, setAdding] = useState(false)
  const list = credentials.data ?? []
  if (adding)
    return (
      <CredentialForm
        inline
        onCancel={() => setAdding(false)}
        onSaved={async (saved) => {
          await credentials.reload()
          onChange(formatMention(mentionOf(saved)))
          setAdding(false)
        }}
      />
    )
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{intro}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          disabled={disabled || list.length === 0}
          value={value}
          onValueChange={(next) => {
            const c = list.find((c) => formatMention(mentionOf(c)) === next)
            onChange(c ? formatMention(mentionOf(c)) : '')
          }}
        >
          <SelectTrigger aria-label="Credential" className="min-w-0 flex-[1_1_14rem]">
            <SelectValue
              placeholder={list.length ? 'Choose a credential…' : 'The vault is empty'}
            />
          </SelectTrigger>
          <SelectContent>
            {list.map((c) => (
              <SelectItem key={c.id} value={formatMention(mentionOf(c))}>
                {c.name} · {credentialHint(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => (onNew ? onNew() : setAdding(true))}
        >
          <Plus aria-hidden />
          New credential
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => void credentials.reload()}
        >
          <RefreshCw aria-hidden />
          Refresh
        </Button>
      </div>
    </div>
  )
}

const mentionOf = (c: Credential) => ({ kind: 'credential' as const, id: c.id, label: c.name })

/**
 * A teammate lacks a credential: save it to the vault right here, filled in
 * with what the teammate knows, or grant one already there. Either way the
 * teammate gets its mention and carries on with it in this thread.
 */
function CredentialAccess({
  ask,
  askerName,
  onReply,
}: {
  ask: Extract<Ask, { type: 'access' }>
  askerName: string
  onReply: (reply: AskReply) => void
}) {
  const [fromVault, setFromVault] = useState(false)
  const [picked, setPicked] = useState('')
  const grant = (mention: string) => onReply({ type: 'access', granted: true, credential: mention })
  const refuse = (
    <Button size="sm" variant="ghost" onClick={() => onReply({ type: 'access', granted: false })}>
      Can&apos;t grant
    </Button>
  )
  if (fromVault)
    return (
      <div className="flex flex-col gap-2">
        <CredentialPicker
          value={picked}
          onChange={setPicked}
          disabled={false}
          intro={`Pick one from the vault: ${askerName} can then use it in this thread without ever seeing it.`}
          onNew={() => setFromVault(false)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!picked} onClick={() => grant(picked)}>
            Grant
          </Button>
          {refuse}
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Save it to the vault here and {askerName} uses it in this thread right away. The secret is
        encrypted the moment you save it; {askerName} never sees it.
      </p>
      <CredentialForm
        inline
        draft={ask.credential}
        submitLabel="Save and grant"
        onSaved={(saved) => grant(formatMention(mentionOf(saved)))}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="link" onClick={() => setFromVault(true)}>
          It&apos;s already in the vault
        </Button>
        {refuse}
      </div>
    </div>
  )
}

/** The harness asks a person something: options, a free answer, or a decline. */
function QuestionCard({
  item,
  canAnswer,
  onAnswer,
}: {
  item: Extract<Item, { kind: 'question' }>
  canAnswer: boolean
  onAnswer: (answer: QuestionAnswer) => Promise<void>
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [text, setText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function send(answer: QuestionAnswer) {
    setBusy(true)
    setError(undefined)
    try {
      await onAnswer(answer)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const answers = Object.fromEntries(
    item.questions.map((q) => [
      q.id,
      {
        optionIds: picked[q.id] ?? [],
        ...(text[q.id]?.trim() ? { freeform: text[q.id]!.trim() } : {}),
      },
    ]),
  )
  const complete = item.questions.every(
    (q) => (picked[q.id]?.length ?? 0) > 0 || Boolean(text[q.id]?.trim()),
  )
  const disabled = !canAnswer || busy

  return (
    <Card className="gap-4 border-primary/40 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <CardLabel className="text-primary">
          <CircleHelp aria-hidden />
          Question
        </CardLabel>
        {item.answer && (
          <StatusBadge
            status={item.answer.action}
            tone={item.answer.action === 'declined' ? 'warning' : 'success'}
            label={item.answer.action === 'declined' ? 'Declined' : 'Answered'}
          />
        )}
      </div>
      {item.questions.map((q) => {
        const optionId = (o: { id: string }) => `${item.questionId}-${q.id}-${o.id}`
        return (
          <div key={q.id} className="flex flex-col gap-3">
            <div className="font-semibold">
              {q.header && <span className="text-muted-foreground">{q.header}: </span>}
              {/* The first paragraph stays on the header's line. */}
              <Markdown text={q.question} className="inline [&>p:first-child]:inline" />
            </div>
            {item.answer ? null : (
              <>
                {q.options?.length ? (
                  q.allowMultiple ? (
                    <div className="flex flex-col gap-2.5">
                      {q.options.map((o) => (
                        <div key={o.id} className="flex items-start gap-2.5">
                          <Checkbox
                            id={optionId(o)}
                            className="mt-0.5"
                            disabled={disabled}
                            checked={picked[q.id]?.includes(o.id) ?? false}
                            onCheckedChange={(checked) =>
                              setPicked((p) => ({
                                ...p,
                                [q.id]:
                                  checked === true
                                    ? [...(p[q.id] ?? []), o.id]
                                    : (p[q.id] ?? []).filter((x) => x !== o.id),
                              }))
                            }
                          />
                          <OptionLabel htmlFor={optionId(o)} option={o} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <RadioGroup
                      name={`${item.questionId}-${q.id}`}
                      disabled={disabled}
                      value={picked[q.id]?.[0] ?? ''}
                      onValueChange={(id) => setPicked((p) => ({ ...p, [q.id]: [id] }))}
                      className="gap-2.5"
                    >
                      {q.options.map((o) => (
                        <div key={o.id} className="flex items-start gap-2.5">
                          <RadioGroupItem id={optionId(o)} value={o.id} className="mt-0.5" />
                          <OptionLabel htmlFor={optionId(o)} option={o} />
                        </div>
                      ))}
                    </RadioGroup>
                  )
                ) : null}
                {isSecret(q) ? (
                  <CredentialPicker
                    disabled={disabled}
                    value={text[q.id] ?? ''}
                    onChange={(mention) => setText((t) => ({ ...t, [q.id]: mention }))}
                  />
                ) : (
                  (q.allowFreeForm || !q.options?.length) && (
                    <Textarea
                      rows={2}
                      placeholder="Your answer"
                      aria-label="Your answer"
                      disabled={disabled}
                      value={text[q.id] ?? ''}
                      onChange={(e) => setText((t) => ({ ...t, [q.id]: e.target.value }))}
                    />
                  )
                )}
              </>
            )}
          </div>
        )
      })}
      {item.answer ? null : canAnswer ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !complete}
            onClick={() => void send({ action: 'answered', answers })}
          >
            Answer
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void send({ action: 'declined' })}
          >
            Decline
          </Button>
          {error && <span className="text-sm text-destructive-text">{error}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the member who started this thread can answer.
        </p>
      )}
    </Card>
  )
}

function OptionLabel({
  htmlFor,
  option,
}: {
  htmlFor: string
  option: { label: string; description?: string }
}) {
  return (
    <Label htmlFor={htmlFor} className="block leading-snug font-normal">
      {option.label}
      {option.description && <span className="text-muted-foreground"> · {option.description}</span>}
    </Label>
  )
}

/**
 * A ticket the teammate opened: one or more asks, each answered with its own
 * buttons. The teammate waits; the answers go to it once every ask has one.
 */
function TicketCard({
  item,
  canAnswer,
  teammates,
  askerId,
  askerName,
  onAnswer,
}: {
  item: Extract<Item, { kind: 'ticket' }>
  canAnswer: boolean
  teammates: { id: string; name: string }[]
  askerId: string | undefined
  askerName: string
  onAnswer: (answer: TicketAnswer) => Promise<void>
}) {
  const [replies, setReplies] = useState<Record<string, AskReply>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function send(answer: TicketAnswer) {
    setBusy(true)
    setError(undefined)
    try {
      await onAnswer(answer)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  // The last reply sends the whole ticket.
  function reply(askId: string, value: AskReply) {
    const next = { ...replies, [askId]: value }
    setReplies(next)
    if (item.asks.every((a) => next[a.id])) void send({ action: 'answered', replies: next })
  }
  const undo = (askId: string) => setReplies(({ [askId]: _, ...rest }) => rest)

  const answered = item.answer?.action === 'answered' ? item.answer.replies : undefined
  const done = Boolean(item.answer)
  const disabled = !canAnswer || busy || done

  return (
    <Card className="gap-4 border-primary/40 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <CardLabel className="text-primary">
          <ClipboardList aria-hidden />
          Ticket
        </CardLabel>
        {item.answer && (
          <StatusBadge
            status={item.answer.action}
            tone={item.answer.action === 'declined' ? 'warning' : 'success'}
            label={item.answer.action === 'declined' ? 'Declined' : 'Answered'}
          />
        )}
      </div>
      <div className="font-semibold">{item.title}</div>
      {item.asks.map((ask) => (
        <div key={ask.id} className="flex flex-col gap-2.5 border-t pt-3">
          <AskView
            ask={ask}
            reply={answered?.[ask.id] ?? replies[ask.id]}
            disabled={disabled}
            teammates={teammates}
            askerId={askerId}
            askerName={askerName}
            onReply={(value) => reply(ask.id, value)}
            onUndo={done || busy ? undefined : () => undo(ask.id)}
          />
        </div>
      ))}
      {done ? null : canAnswer ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {item.asks.length > 1 && (
            <span className="text-sm text-muted-foreground">
              {Object.keys(replies).length} of {item.asks.length} answered
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void send({ action: 'declined' })}
          >
            Decline ticket
          </Button>
          {error && <span className="text-sm text-destructive-text">{error}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the member who started this thread can answer.
        </p>
      )}
    </Card>
  )
}

/** What a person answered, shown in place of the buttons. */
function replyLabel(ask: Ask, reply: AskReply, teammates: { id: string; name: string }[]) {
  switch (reply.type) {
    case 'approval':
      if (reply.approved) return 'Approved'
      return `Changes requested${reply.sendTo ? `, sent to ${teammates.find((t) => t.id === reply.sendTo)?.name ?? 'a teammate'}` : ''}`
    case 'decision':
      return ask.type === 'decision' && ask.options
        ? `Chose ${ask.options.find((o) => o.id === reply.optionId)?.label ?? reply.optionId}`
        : reply.optionId === 'approve'
          ? 'Approved'
          : 'Declined'
    case 'access':
      if (!reply.granted) return 'Not granted'
      return reply.credential ? `Granted ${mentionsToText(reply.credential)}` : 'Granted'
    case 'action':
      return reply.done ? 'Done' : 'Not done'
    case 'input':
      return 'Answered'
  }
}

function AskView({
  ask,
  reply,
  disabled,
  teammates,
  askerId,
  askerName,
  onReply,
  onUndo,
}: {
  ask: Ask
  reply: AskReply | undefined
  disabled: boolean
  teammates: { id: string; name: string }[]
  askerId: string | undefined
  askerName: string
  onReply: (reply: AskReply) => void
  onUndo: (() => void) | undefined
}) {
  const [showDraft, setShowDraft] = useState(true)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sendTo, setSendTo] = useState(askerId ?? '')

  const heading =
    ask.type === 'approval' || ask.type === 'action'
      ? ask.title
      : ask.type === 'access'
        ? `Access to ${ask.what}`
        : ask.question
  const kind = {
    approval: 'Approval',
    decision: 'Decision',
    access: 'Access',
    action: 'Action',
    input: 'Input',
  }[ask.type]

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {kind}
        </span>
        <Markdown text={heading} className="font-medium" />
        {ask.type === 'access' && ask.reason && (
          <p className="text-sm text-muted-foreground">{ask.reason}</p>
        )}
      </div>

      {ask.type === 'approval' && (
        <>
          {showDraft && (
            <Markdown
              text={ask.draft}
              className="max-h-96 overflow-auto rounded-md bg-muted px-4 py-3 text-sm"
            />
          )}
          <Button
            variant="link"
            size="sm"
            className="h-auto self-start p-0"
            onClick={() => setShowDraft((s) => !s)}
          >
            {showDraft ? 'Hide draft' : 'Show draft'}
          </Button>
        </>
      )}

      {ask.type === 'action' && ask.steps?.length ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium text-primary">
            <ChevronRight
              className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
              aria-hidden
            />
            View steps
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-2 flex flex-col gap-2 text-sm">
              {ask.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <Checkbox id={`${ask.id}-step-${i}`} className="mt-0.5" />
                  <Label htmlFor={`${ask.id}-step-${i}`} className="block leading-snug font-normal">
                    {step}
                  </Label>
                </li>
              ))}
            </ol>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {reply ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={reply.type}
            tone={
              (reply.type === 'approval' && !reply.approved) ||
              (reply.type === 'decision' &&
                !('options' in ask && ask.options) &&
                reply.optionId === 'decline') ||
              (reply.type === 'access' && !reply.granted) ||
              (reply.type === 'action' && !reply.done)
                ? 'warning'
                : 'success'
            }
            label={replyLabel(ask, reply, teammates)}
          />
          {onUndo && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onUndo}>
              Change
            </Button>
          )}
        </div>
      ) : disabled ? null : ask.type === 'approval' ? (
        open ? (
          <div className="flex flex-col gap-2">
            <Textarea
              rows={3}
              autoFocus
              placeholder="What should change?"
              aria-label="What should change"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Send back to</span>
              <Select value={sendTo || askerId || ''} onValueChange={setSendTo}>
                <SelectTrigger size="sm" aria-label="Send back to">
                  <SelectValue placeholder={askerName} />
                </SelectTrigger>
                <SelectContent>
                  {(teammates.length
                    ? teammates
                    : askerId
                      ? [{ id: askerId, name: askerName }]
                      : []
                  ).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!text.trim()}
                onClick={() =>
                  onReply({
                    type: 'approval',
                    approved: false,
                    changes: text.trim(),
                    ...(sendTo && sendTo !== askerId ? { sendTo } : {}),
                  })
                }
              >
                Send
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onReply({ type: 'approval', approved: true })}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Request changes
            </Button>
          </div>
        )
      ) : ask.type === 'decision' ? (
        <div className="flex flex-wrap gap-2">
          {ask.options?.length ? (
            ask.options.map((o) => (
              <Button
                key={o.id}
                size="sm"
                variant="outline"
                title={o.description}
                onClick={() => onReply({ type: 'decision', optionId: o.id })}
              >
                {o.label}
              </Button>
            ))
          ) : (
            <>
              <Button size="sm" onClick={() => onReply({ type: 'decision', optionId: 'approve' })}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onReply({ type: 'decision', optionId: 'decline' })}
              >
                Decline
              </Button>
            </>
          )}
        </div>
      ) : ask.type === 'access' && ask.kind === 'credential' ? (
        <CredentialAccess ask={ask} askerName={askerName} onReply={onReply} />
      ) : ask.type === 'access' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <a href="/app/connections" target="_blank" rel="noreferrer">
              Open Connections →
            </a>
          </Button>
          <Button size="sm" onClick={() => onReply({ type: 'access', granted: true })}>
            Mark granted
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onReply({ type: 'access', granted: false })}
          >
            Can&apos;t grant
          </Button>
        </div>
      ) : ask.type === 'action' ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onReply({ type: 'action', done: true })}>
            I&apos;ve done this
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onReply({ type: 'action', done: false })}
          >
            Can&apos;t do it
          </Button>
        </div>
      ) : ask.secret ? (
        <div className="flex flex-col gap-2">
          <CredentialPicker value={text} onChange={setText} disabled={false} />
          <Button
            size="sm"
            className="self-start"
            disabled={!text}
            onClick={() => onReply({ type: 'input', text })}
          >
            Submit
          </Button>
        </div>
      ) : open ? (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={3}
            autoFocus
            placeholder="Your answer"
            aria-label="Your answer"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!text.trim()}
              onClick={() => onReply({ type: 'input', text: text.trim() })}
            >
              Submit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
          Provide details
        </Button>
      )}
    </>
  )
}
