'use client'
import {
  ASIDE_TOOLS,
  Choices,
  choiceMessage,
  DESIGN_THUMBNAIL,
  designOptionsOf,
  pickedChoice,
  pickedDesignPath,
  bareToolName,
  asksParallel,
  childNote,
  fromParent,
  forPeople,
  formatMention,
  handbackNote,
  mentionsToText,
  OFFER_CHOICES_TOOL,
  PREVIEW_REPLACED,
  PROPOSE_TEAM_TOOL,
  resolveConflictsNote,
  SHOW_WIDGET_TOOL,
  splitPreviewElements,
  STORED_FILE,
  STORED_FILE_NAME,
  SUGGEST_REPLIES_TOOL,
  THREAD_NOTE_SOURCE,
  TURN_WAITING_SOURCE,
  type TurnWaiting,
  hasVisibleText,
  SuggestedReplies,
  safeChoices,
  safeReplies,
  TeamProposal,
  turnAnswer,
  visibleChars,
  Widget,
  withoutCard,
  type LibraryFile,
  type AgentEvent,
  type Ask,
  type AskReply,
  type CredentialKind,
  type Handback,
  type MessageAttachment,
  type Question,
  type QuestionAnswer,
  type ReplyTo,
  type SequencedEvent,
  type TicketAnswer,
  handedEmail,
  triggerEmail,
  triggerEvent,
  type TriggerEmail,
  type TriggerEventMessage,
} from '@brigade/contracts'
import {
  Globe,
  ChevronDown,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  CircleDot,
  CircleHelp,
  ClipboardList,
  EllipsisVertical,
  Copy,
  FileText,
  Hand,
  LayoutTemplate,
  ListChecks,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Reply,
  ShieldAlert,
} from 'lucide-react'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MediaPreview, MessageAttachments } from '@/components/attachments'
import { PdfPreview } from '@/components/file-preview'
import { APP_NAMES, AppAccessAsk } from '@/components/app-access-ask'
import { CredentialForm } from '@/components/credential-form'
import {
  BrigadeNoteLine,
  brigadeNote,
  handOffNote,
  type BrigadeNote,
} from '@/components/brigade-notes'
import {
  EditableEmailPreview,
  isEmailSend,
  ReceivedEmailCard,
  ToolInputPreview,
  type EditedEmail,
} from '@/components/email-cards'
import { TeammateAvatar, useDashboard } from '@/components/dashboard'
import { FileLinksProvider, useFileLinks } from '@/components/file-links'
import { contentUrl } from '@/components/library-browser'
import { CommandChip, startingCommand, useSkillCommands } from '@/components/composer'
import { CodeSnippet, CopyableCode, Markdown, MessageWithCode } from '@/components/markdown'
import { credentialHint } from '@/components/mention'
import { PreviewElementChips } from '@/components/preview-elements'
import { endedText } from '@/components/preview-panel'
import { VariablesAsk } from '@/components/preview-variables'
import { PullMergeButton } from '@/components/pull-action'
import { PullCard } from '@/components/pull-card'
import { StatusBadge } from '@/components/status-badge'
import {
  ActivationCard,
  DryRunProgress,
  DryRunReport,
  PlaybookCard,
} from '@/components/playbook-cards'
import { TeamProposalCard } from '@/components/team-proposal'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Hint } from '@/components/ui/tooltip'
import { WidgetFrame } from '@/components/widget-frame'
import { ReportedThread, reportNote, StartedChild } from '@/components/thread-children'
import {
  attachmentUrl,
  storedFileUrl,
  threadImageUrl,
  useApi,
  type Credential,
  type ThreadChild,
} from '@/lib/api'
import { useTicketReplies } from '@/lib/ticket-replies'
import { slotWait } from '@/lib/slot-wait'
import { inGap, type EventGap } from '@/lib/use-thread-events'
import { messageRuns, type RunEntry } from '@/lib/message-runs'
import { pauseLabel, pauses } from '@/lib/thread-times'
import { useMemberNames } from '@/lib/member-names'
import { cn } from '@/lib/utils'

export type Item =
  | {
      kind: 'user'
      key: string
      /** Where it is in the thread: a reply names it by this. */
      seq: number
      text: string
      /** The member who wrote it; null for Brigade's own words. */
      memberId: string | null
      attachments: MessageAttachment[]
      /** The earlier message it replies to. */
      replyTo?: ReplyTo
      /** Given to this teammate during its running turn. */
      steeredTo?: string
      /** When it was shown, or given to the running turn. */
      at: number
      /** Written by Brigade about child threads, not by a person: a child's work, or reports for its parent. */
      brigade?: NonNullable<ReturnType<typeof childNote>>
      /** An email a trigger received, shown as a mail rather than as the teammate's prompt. */
      email?: { event: TriggerEventMessage; email: TriggerEmail }
      /** An email the person handed over from the Inbox: their note as their message, the mail as a card below it. */
      handed?: {
        note: string
        event: TriggerEventMessage
        email: TriggerEmail
        item: string | null
      }
      /** Anything else Brigade wrote (a wake-up, a schedule's run…): a line rather than a person's bubble. */
      note?: BrigadeNote
      /** A person handed the thread back: their note and what they did, as a card rather than the teammate's prompt. */
      handback?: Handback & { commands: string[] }
    }
  | {
      kind: 'assistant'
      key: string
      seq: number
      text: string
      done: boolean
      teammateId?: string
      /** The images it shows, kept with the thread (message.images): by path, as it writes it. */
      images?: Record<string, string>
    }
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
      /** A credential: may also be allowed for good. */
      always?: boolean
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
  /** Where a teammate's turn begins: what it did until its turn ends folds under one line. */
  | { kind: 'start'; key: string; at: number; teammateId?: string }
  /**
   * The turn only waited on work it left in the background, and a report from that work
   * set the teammate going again, no message steered in: what came before answered.
   */
  | { kind: 'woke'; key: string; at: number }
  /** A turn waits for a free slot on its computer, all of them taken by other turns. */
  | { kind: 'slot'; key: string; at: number; teammateId: string; running: number }
  | { kind: 'turn'; key: string; finishReason: string; startedAt?: number; at: number }
  /** Events not loaded here, after the timeline jumped past them: they load as it comes near. */
  | { kind: 'gap'; key: string; gap: EventGap }
  | { kind: 'error'; key: string; message: string }
  /** settles: something happened that the buttons asked before it no longer fit (thread.note). */
  | { kind: 'note'; key: string; text: string; settles?: true }
  /**
   * A person at the computer: taking over, handing back, a command in the shell. Handing
   * back holds the commands run since taking over, for its card.
   */
  | {
      kind: 'control'
      key: string
      change: 'took' | 'handed' | 'command'
      command?: string
      commands?: string[]
    }
  | {
      kind: 'preview'
      key: string
      previewId: string
      /** ready: its pages passed their check; attention: some failed; running: not checked (older runners). */
      status: 'ready' | 'attention' | 'running' | 'failed' | 'stopped'
      repository?: string
      failed?: string[]
      reason?: string
    }

export type Limits = NonNullable<Extract<AgentEvent, { type: 'usage.updated' }>['limits']>

/**
 * Work a teammate started in the background, while it runs: an agent (Claude Code's
 * Agent tool, a workflow) or a command (a shell, a Monitor watching one).
 */
export type BackgroundTask = {
  id: string
  kind: 'agent' | 'command'
  description: string
  steps: number
}

/** Claude Code's task types that are agents at work. */
const AGENT_TASKS = new Set(['local_agent', 'remote_agent', 'local_workflow'])
/** And those that are commands: its turn waits for them too. */
const COMMAND_TASKS = new Set(['local_bash', 'monitor_mcp'])

/** A message waiting to be read, shown above the composer rather than in the thread. */
export type QueuedMessage = {
  messageId: string
  text: string
  /** Who wrote it: none for Brigade's own, such as a child's report. */
  memberId: string | null
  attachments: MessageAttachment[]
  waitingFor: 'turn' | 'person'
  note?: string
}

/** Asks that wait on a person: shown even from before the page loaded, while open. */
const ASKS = new Set<Item['kind']>(['approval', 'question', 'ticket'])

/**
 * Fold the event log into what a person reads: messages, tool calls, approvals.
 * Events before `firstSeq` (the context of a thread opened by its latest page)
 * count for its state but do not show, but for asks still open; so do those in `gaps`,
 * each of which shows as a line where it is.
 */
export function useThreadItems(events: SequencedEvent[], firstSeq = 1, gaps: EventGap[] = NO_GAPS) {
  return useMemo(() => {
    const items: Item[] = []
    const byKey = new Map<string, Item>()
    let limits: Limits | undefined
    // Messages still queued, and every message id the thread has seen (queued, read or cancelled).
    const queued = new Map<string, QueuedMessage>()
    const seen = new Set<string>()
    let turnTeammate: string | undefined
    let turnStartedAt: number | undefined
    let lastPreview: { previewId: string; status: string } | undefined
    // The running turn's background work, by task id: Claude Code sends every one still running at each change.
    let background = new Map<string, BackgroundTask>()
    // The running turn only waits on that work: 'steered' once a message went in.
    let idle: 'waiting' | 'steered' | undefined
    let shown = true
    // Since a person took over: the commands they ran, then their hand back, until its message comes.
    let commands: Extract<Item, { kind: 'control' }>[] = []
    let handed: Extract<Item, { kind: 'control' }> | undefined
    const add = (item: Item) => {
      if (shown || ASKS.has(item.kind)) items.push(item)
      byKey.set(item.key, item)
    }
    let nextGap = 0
    for (const { seq, event: e } of events) {
      // Past a gap: its line, and what was open before it closes, as unknown.
      while (nextGap < gaps.length && gaps[nextGap]!.to <= seq) {
        const gap = gaps[nextGap++]!
        items.push({ kind: 'gap', key: `g${gap.from}`, gap })
        turnStartedAt = undefined
        idle = undefined
        commands = []
        handed = undefined
      }
      shown = seq >= firstSeq && !inGap(gaps, seq)
      switch (e.type) {
        case 'message.user':
          if (e.messageId) {
            seen.add(e.messageId)
            queued.delete(e.messageId)
          }
          // Not steered into a turn: one still open never ended.
          if (!e.steered) turnStartedAt = undefined
          else if (idle) idle = 'steered'
          // Brigade wrote it, even when sent in the name of the person who asked (resolving a
          // pull request's conflicts did, before it was sent as Brigade's).
          const fromBrigade = e.memberId === null || resolveConflictsNote(e.text) !== null
          const handback = e.memberId !== null ? handbackNote(e.text) : null
          const handedOver = e.memberId !== null ? handedEmail(e.text) : null
          // Its card takes the place of the hand back's line, and of what that line held.
          if (handback && handed && items.includes(handed)) items.splice(items.indexOf(handed), 1)
          add({
            kind: 'user',
            key: `u${seq}`,
            seq,
            text: e.text,
            memberId: fromBrigade ? null : e.memberId,
            attachments: e.attachments ?? [],
            at: Date.parse(e.at),
            ...(e.replyTo ? { replyTo: e.replyTo } : {}),
            ...(e.steered && turnTeammate ? { steeredTo: turnTeammate } : {}),
            ...(e.memberId === null && childNote(e.text) ? { brigade: childNote(e.text)! } : {}),
            ...(e.memberId === null ? receivedEmail(e.text) : {}),
            ...userNote(e.text, fromBrigade),
            ...(e.memberId !== null && handOffNote(e.text) ? { note: handOffNote(e.text)! } : {}),
            ...(handback ? { handback: { ...handback, commands: handed?.commands ?? [] } } : {}),
            ...(handedOver ? { handed: handedOver } : {}),
          })
          handed = undefined
          break
        case 'message.queued':
          seen.add(e.messageId)
          queued.set(e.messageId, {
            messageId: e.messageId,
            text: e.text,
            memberId: e.memberId,
            attachments: e.attachments ?? [],
            waitingFor: e.waitingFor,
            ...(e.note ? { note: e.note } : {}),
          })
          break
        case 'message.cancelled': {
          seen.add(e.messageId)
          const message = queued.get(e.messageId)
          queued.delete(e.messageId)
          // Cancelled by its sender: it just goes. Otherwise say it was not sent, and why.
          if (e.reason)
            add({
              kind: 'note',
              key: `n${seq}`,
              text: `A queued message was not sent. ${e.reason}${message?.text ? ` “${clipText(mentionsToText(message.text), 200)}”` : ''}`,
            })
          break
        }
        case 'turn.started':
          turnTeammate = e.teammateId
          // A turn resumed (after a restart, say) starts again before it ends: still the same turn.
          turnStartedAt ??= Date.parse(e.at)
          idle = undefined
          add({ kind: 'start', key: `s${seq}`, at: turnStartedAt, teammateId: e.teammateId })
          break
        // Ids come from each teammate's own harness: keyed by teammate too.
        case 'message.delta': {
          const key = `m${e.teammateId ?? ''}:${e.id}`
          const item = byKey.get(key)
          if (item?.kind === 'assistant') item.text += e.text
          else
            add({
              kind: 'assistant',
              key,
              seq,
              text: e.text,
              done: false,
              teammateId: e.teammateId,
            })
          break
        }
        case 'message.done': {
          const key = `m${e.teammateId ?? ''}:${e.id}`
          const item = byKey.get(key)
          if (item?.kind === 'assistant') Object.assign(item, { text: e.text, done: true })
          else
            add({
              kind: 'assistant',
              key,
              seq,
              text: e.text,
              done: true,
              teammateId: e.teammateId,
            })
          break
        }
        case 'message.images': {
          const item = byKey.get(`m${e.teammateId ?? ''}:${e.id}`)
          if (item?.kind === 'assistant') item.images = { ...item.images, ...e.images }
          break
        }
        case 'tool.started':
          // The same call started twice (repeated by the harness): one card.
          if (byKey.has(`t${e.teammateId ?? ''}:${e.toolCallId}`)) break
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
            ...(e.always ? { always: true } : {}),
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
          add({
            kind: 'turn',
            key: `c${seq}`,
            finishReason: e.finishReason,
            ...(turnStartedAt !== undefined ? { startedAt: turnStartedAt } : {}),
            at: Date.parse(e.at),
          })
          turnStartedAt = undefined
          background = new Map()
          idle = undefined
          break
        case 'error':
          add({ kind: 'error', key: `e${seq}`, message: e.message })
          break
        case 'raw':
          if (e.source === 'reasoning' && typeof e.value === 'string')
            add({ kind: 'thinking', key: `r${seq}`, text: e.value })
          else if (e.source === 'runner' && typeof e.value === 'string')
            add({ kind: 'note', key: `n${seq}`, text: e.value })
          else if (e.source === THREAD_NOTE_SOURCE && typeof e.value === 'string')
            add({ kind: 'note', key: `n${seq}`, text: e.value, settles: true })
          else if (e.source === TURN_WAITING_SOURCE) {
            const { teammateId, running } = e.value as TurnWaiting
            add({ kind: 'slot', key: `q${seq}`, at: Date.parse(e.at), teammateId, running })
          } else if (e.source === 'harness') {
            background = backgroundTasks(background, e.value)
            const waiting = backgroundWait(e.value)
            if (waiting === false && idle === 'waiting')
              add({ kind: 'woke', key: `b${seq}`, at: Date.parse(e.at) })
            if (waiting !== undefined) idle = waiting ? 'waiting' : undefined
          }
          break
        case 'account.switched':
          add({
            kind: 'note',
            key: `n${seq}`,
            text: e.toAccountId
              ? e.reason === 'usage_limit'
                ? 'The account ran out of usage. Continuing on your next account with a summary of this thread.'
                : 'Continuing on another of your accounts with a summary of this thread.'
              : `Paused: all your accounts for this agent are out of usage${e.resetsAt ? ` until ${new Date(e.resetsAt).toLocaleString()}` : ''}. Send a message to try again, for example after upgrading your plan, or add an account.`,
          })
          break
        case 'terminal.command': {
          const command = {
            kind: 'control',
            key: `n${seq}`,
            change: 'command',
            command: e.command,
          } as const
          commands.push(command)
          add(command)
          break
        }
        case 'preview.changed': {
          // Starting and checking show in the panel and the teammate's tool calls; what came of them here.
          const status =
            e.status === 'starting'
              ? undefined
              : e.status !== 'running'
                ? e.status
                : !e.startedAt
                  ? 'running'
                  : e.check?.status === 'passed'
                    ? 'ready'
                    : e.check?.status === 'failed'
                      ? 'attention'
                      : undefined
          // Once per outcome of a run: a restart after a crash, or a check again with the same result, says nothing new.
          if (
            !status ||
            (lastPreview?.previewId === e.previewId && lastPreview.status === status) ||
            // A restart: the new one says what came of it.
            e.reason === PREVIEW_REPLACED
          )
            break
          lastPreview = { previewId: e.previewId, status }
          add({
            kind: 'preview',
            key: `v${seq}`,
            previewId: e.previewId,
            status,
            ...(e.repository ? { repository: e.repository } : {}),
            ...(e.check?.failed?.length ? { failed: e.check.failed } : {}),
            ...(e.reason ? { reason: e.reason } : {}),
          })
          break
        }
        case 'control.changed':
          if (e.controller === 'human') {
            commands = []
            handed = undefined
            add({ kind: 'control', key: `n${seq}`, change: 'took' })
            break
          }
          // The commands go in the hand back's card, rather than in lines of their own.
          for (const command of commands) {
            const at = items.indexOf(command)
            if (at >= 0) items.splice(at, 1)
          }
          handed = {
            kind: 'control',
            key: `n${seq}`,
            change: 'handed',
            commands: commands.flatMap((c) => c.command ?? []),
          }
          commands = []
          add(handed)
          break
      }
    }
    // The turn running now, for an interrupt to name: the last one, unless it ended.
    const lastTurn = events.findLast(
      (e) => e.event.type === 'turn.started' || e.event.type === 'turn.completed',
    )?.event
    const turnId = lastTurn?.type === 'turn.started' ? lastTurn.turnId : undefined
    return {
      // A message of only zero-width characters shows nothing: no empty bubble for it.
      items: items.filter((i) => i.kind !== 'assistant' || hasVisibleText(i.text)),
      limits,
      queued: [...queued.values()],
      seen,
      turnId,
      background: [...background.values()],
    }
  }, [events, firstSeq, gaps])
}

const NO_GAPS: EventGap[] = []

/** The background work after one of Claude Code's task messages. */
function backgroundTasks(tasks: Map<string, BackgroundTask>, value: unknown) {
  const msg = value as {
    type?: string
    subtype?: string
    task_id?: string
    tasks?: { task_id: string; task_type: string; description: string; ambient?: boolean }[]
    usage?: { tool_uses?: number }
  } | null
  if (msg?.type !== 'system') return tasks
  if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks))
    return new Map(
      msg.tasks
        .filter(
          (t) => !t.ambient && (AGENT_TASKS.has(t.task_type) || COMMAND_TASKS.has(t.task_type)),
        )
        .map((t): [string, BackgroundTask] => [
          t.task_id,
          {
            id: t.task_id,
            kind: AGENT_TASKS.has(t.task_type) ? 'agent' : 'command',
            description: t.description,
            steps: tasks.get(t.task_id)?.steps ?? 0,
          },
        ]),
    )
  const task = msg.task_id ? tasks.get(msg.task_id) : undefined
  if (msg.subtype === 'task_progress' && task && typeof msg.usage?.tool_uses === 'number')
    task.steps = msg.usage.tool_uses
  return tasks
}

/** The bridge's word on whether the turn only waits on its background work now, from a harness event. */
function backgroundWait(value: unknown) {
  const msg = value as { type?: string; subtype?: string; waiting?: unknown } | null
  if (msg?.type === 'system' && msg.subtype === 'brigade_waiting') return msg.waiting === true
}

const clipText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text

/** What a reply quotes of a message: its start, as long as a reply carries. */
const replyText = (text: string) => clipText(text.trim(), 1999)

/**
 * Copy a message, and reply to it when the person can send one: shown while the
 * pointer is over it (always on phones).
 */
function MessageActions({ text, onReply }: { text: string; onReply?: () => void }) {
  const [copied, setCopied] = useState(false)
  const button =
    'shrink-0 rounded-full text-muted-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100'
  return (
    <div className="flex shrink-0 items-center">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={button}
        onClick={() =>
          void navigator.clipboard.writeText(mentionsToText(text).trim()).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
        aria-label={copied ? 'Copied' : 'Copy'}
        tooltip={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </Button>
      {onReply && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={button}
          onClick={onReply}
          aria-label="Reply"
          tooltip="Reply"
        >
          <Reply className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/** How tall a person's message shows before the rest folds under Show more (about 16 lines). */
const FOLDED_HEIGHT = 416

/**
 * A person's message bubble: a long one (a pasted page, a log) folds to its first lines,
 * fading out, with Show more to unfold it in place.
 */
export function MessageBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  // Fold only when there is clearly more to show than a few lines.
  const [long, setLong] = useState(false)
  const bubble = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => setLong(el.scrollHeight > FOLDED_HEIGHT + 80)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  const folded = long && !open
  return (
    <div
      ref={bubble}
      className="min-w-0 rounded-2xl rounded-br-md bg-primary px-4 py-2.5 leading-relaxed wrap-anywhere whitespace-pre-wrap text-primary-foreground"
    >
      <div
        ref={body}
        className={cn(folded && 'overflow-hidden')}
        style={
          folded
            ? {
                maxHeight: FOLDED_HEIGHT,
                maskImage: 'linear-gradient(to bottom, black 70%, transparent)',
              }
            : undefined
        }
      >
        <MessageWithCode text={text} />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open)
            // Folding a message read far down brings its start back into view.
            if (open && bubble.current && bubble.current.getBoundingClientRect().top < 0)
              bubble.current.scrollIntoView({ block: 'start' })
          }}
          className="mt-1.5 flex items-center gap-1 text-xs font-medium whitespace-normal text-primary-foreground/80 hover:text-primary-foreground"
        >
          {open ? 'Show less' : 'Show more'}
          <ChevronDown className={cn('size-3.5', open && 'rotate-180')} aria-hidden />
        </button>
      )}
    </div>
  )
}

/** The message a person's message replies to, above it: a click scrolls to it. */
function ReplyQuote({ reply, author }: { reply: ReplyTo; author?: string }) {
  return (
    <Hint label="Show the message it replies to">
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() =>
          document
            .querySelector(`[data-seq="${reply.seq}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      >
        <Reply className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {author && <span className="font-medium">{author}: </span>}“
          {mentionsToText(reply.text).replace(/\s+/g, ' ')}”
        </span>
      </button>
    </Hint>
  )
}

/** What else Brigade wrote, once child notes and emails, which have cards of their own, are told apart. */
function userNote(text: string, fromBrigade: boolean) {
  if (!fromBrigade || childNote(text) || receivedEmail(text).email) return {}
  const note = brigadeNote(text, true)
  return note ? { note } : {}
}

/** A trigger's email in a message Brigade wrote (memberId null), for its card. */
function receivedEmail(text: string) {
  const event = triggerEvent(text)
  const email = event && triggerEmail(event)
  return email ? { email: { event, email } } : {}
}

const json = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

/** An approval's question in words, for the writes people meet most: its tool name otherwise. */
function approvalAsk(toolName: string) {
  const name = bareToolName(toolName)
  if (isEmailSend(toolName)) return 'Allow sending this email?'
  if (/^github_merge_pull_request(_|$)/.test(name)) return 'Allow merging this pull request?'
  return null
}

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

/** The child thread a start_child call started, once it went through: its id and title. */
function startedChild(item: { toolName: string; input: unknown; output?: unknown }) {
  if (bareToolName(item.toolName) !== 'start_child') return null
  const found = json(item.output ?? '').match(/"threadId"\s*:\s*"([^"\\]+)"/)
  if (!found) return null
  const title = (item.input as { title?: unknown } | null)?.title
  return { threadId: found[1]!, title: typeof title === 'string' ? title : 'Child thread' }
}

/** The team a propose_team call put up, once it went through. */
function proposedTeam(item: Extract<Item, { kind: 'tool' }>) {
  if (item.toolName.replace(/^mcp__.+?__/, '') !== PROPOSE_TEAM_TOOL) return null
  if (!item.finished || item.isError) return null
  return TeamProposal.safeParse(item.input).data ?? null
}

/** The playbook card one of a teammate's install tools put up (playbook-cards.tsx), once it went through. */
function playbookCard(item: Extract<Item, { kind: 'tool' }>) {
  if (!item.finished || item.isError) return null
  const input = (item.input ?? {}) as { playbookKey?: unknown; installationId?: unknown }
  const id = typeof input.installationId === 'string' ? input.installationId : null
  switch (bareToolName(item.toolName)) {
    case 'show_playbook':
      return typeof input.playbookKey === 'string'
        ? { card: 'playbook' as const, id: input.playbookKey }
        : null
    case 'start_dry_run':
      return id ? { card: 'progress' as const, id } : null
    case 'dry_run_report':
      return id ? { card: 'report' as const, id } : null
    case 'activate_playbook':
      return id ? { card: 'activate' as const, id } : null
    default:
      return null
  }
}

/** A playbook card a person reads or acts on after the message that explains it. */
const playbookAction = (item: Extract<Item, { kind: 'tool' }>) => {
  const card = playbookCard(item)?.card
  return card === 'playbook' || card === 'activate'
}

/** The alternatives an offer_choices call put up, once it went through. */
function offeredChoices(item: Extract<Item, { kind: 'tool' }>) {
  if (item.toolName.replace(/^mcp__.+?__/, '') !== OFFER_CHOICES_TOOL) return null
  if (!item.finished || item.isError) return null
  return safeChoices(item.input)
}

/** The replies a suggest_replies call put up, once it went through. */
function suggestedReplies(item: Extract<Item, { kind: 'tool' }>) {
  if (bareToolName(item.toolName) !== SUGGEST_REPLIES_TOOL) return null
  if (!item.finished || item.isError) return null
  return safeReplies(item.input)
}

/** The visual a show_widget call drew, once it went through. */
function shownWidget(item: Extract<Item, { kind: 'tool' }>) {
  if (bareToolName(item.toolName) !== SHOW_WIDGET_TOOL) return null
  if (!item.finished || item.isError) return null
  return Widget.safeParse(item.input).data ?? null
}

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

/** A picture a teammate made, under its messages. Opens over the page, like an attached one. */
function ThreadImage({
  threadId,
  item,
}: {
  threadId: string
  item: Extract<Item, { kind: 'image' }>
}) {
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const name = item.path.split('/').pop()
  const src = threadImageUrl(threadId, item.path, item.teammateId)
  if (failed)
    return (
      <div className="pl-11 text-sm text-muted-foreground">
        Made <code className="font-mono text-xs text-foreground">{item.path}</code>, which can't be
        shown while the computer is offline.
      </div>
    )
  return (
    <div className="pl-11">
      <Hint label={item.prompt ?? name}>
        <button
          type="button"
          className="block cursor-zoom-in overflow-hidden rounded-lg border bg-muted"
          onClick={() => setOpen(true)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={item.prompt ?? name ?? 'A generated image'}
            className="max-h-96 max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        </button>
      </Hint>
      <MediaPreview
        media={open ? { name: name ?? item.path, src, kind: 'image' } : undefined}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}

type ActivityItem = Extract<Item, { kind: 'thinking' | 'tool' | 'file' }>

/** A step on a teammate's way to its answer: steps in a row fold under one line saying what they were. */
const isActivity = (item: Item): item is ActivityItem =>
  item.kind === 'thinking' ||
  item.kind === 'file' ||
  (item.kind === 'tool' &&
    !offeredChoices(item) &&
    !suggestedReplies(item) &&
    !shownWidget(item) &&
    !proposedTeam(item) &&
    !playbookCard(item) &&
    !(item.finished && !item.isError && (openedPull(item) || startedChild(item))))

/**
 * A step that does no work: thinking, loading a tool, a card refused and called
 * again (a reply too long for its button), a wake-up or a task closed after the
 * answer. A teammate often does one after its answer, so it does not end the
 * work: the answer before it stays out of the fold.
 */
const isAside = (item: Item) =>
  item.kind === 'thinking' || (item.kind === 'tool' && ASIDE_TOOLS.has(bareToolName(item.toolName)))

/** A card asking a person to act on what a message says: it reads after the message. */
const isActionCard = (item: Item) =>
  item.kind === 'tool' &&
  !!(
    offeredChoices(item) ||
    suggestedReplies(item) ||
    proposedTeam(item) ||
    playbookAction(item) ||
    (item.finished && !item.isError && openedPull(item))
  )

/**
 * Moves the action cards a teammate put up before its last message to just after it,
 * so the decision follows what explains it. Never past a person's message.
 */
function actionsLast(items: Item[], is: number[]) {
  const at = is.findLastIndex((i) => items[i]!.kind === 'assistant')
  if (at < 0) return is
  const moved: number[] = []
  for (let k = at - 1; k >= 0 && items[is[k]!]!.kind !== 'user'; k--)
    if (isActionCard(items[is[k]!]!)) moved.unshift(is[k]!)
  if (!moved.length) return is
  const rest = is.filter((i) => !moved.includes(i))
  const after = rest.indexOf(is[at]!) + 1
  return [...rest.slice(0, after), ...moved, ...rest.slice(after)]
}

/** What a long turn's "Worked for" line folds away: its steps and the messages between them. */
const FOLDS = new Set<Item['kind']>(['thinking', 'tool', 'file', 'assistant', 'plan', 'note'])

/** A turn quicker than this just answers: its steps fold, without a "Worked for" line. */
const QUICK_TURN_MS = 30_000

type Node =
  | { type: 'item'; i: number }
  | { type: 'activity'; is: number[]; live: boolean }
  | { type: 'control'; is: number[] }
  | { type: 'worked'; key: string; ms: number; inner: Node[] }

/**
 * How the thread reads: steps in a row fold together, and a long turn that ended
 * folds everything before its last message under how long it worked. What a person
 * must see (asks, pull requests, pictures, choices, team proposals, errors) stays out of the fold.
 * A message steered into a turn ends what came before it the same way, as a turn of its own,
 * and so does a report from its background work that sets the teammate going again.
 * `running` is when the turn still running began, or the message steered into it last.
 */
function layoutThread(items: Item[], working: boolean) {
  const group = (is: number[]): Node[] => {
    const nodes: Node[] = []
    for (const i of actionsLast(items, is)) {
      const last = nodes.at(-1)
      // Taking over, handing back and shell commands in a row fold the same way.
      // A hand back is a card of its own.
      const item = items[i]!
      const type = isActivity(item)
        ? 'activity'
        : item.kind === 'control' && item.change !== 'handed'
          ? 'control'
          : undefined
      if (!type) nodes.push({ type: 'item', i })
      else if (last?.type === type) last.is.push(i)
      else nodes.push(type === 'activity' ? { type, is: [i], live: false } : { type, is: [i] })
    }
    // A single step needs no line over it.
    return nodes.map((n) =>
      n.type !== 'item' && n.type !== 'worked' && n.is.length === 1
        ? { type: 'item', i: n.is[0]! }
        : n,
    )
  }
  /** A turn that worked for `ms`, keyed by the item it ends at; `steered` when that is a message steered into it. */
  const fold = (turn: number[], ms: number, end: string, steered = false): Node[] => {
    if (ms < QUICK_TURN_MS) return group(turn)
    turn = actionsLast(items, turn)
    // The answer: every message after its last step, and a long one before that step when only a line follows.
    const { first: final, messages } = turnAnswer(
      turn.map((i) => {
        const item = items[i]!
        if (item.kind === 'assistant') return { kind: 'message', chars: visibleChars(item.text) }
        return isActivity(item) && !isAside(item) ? { kind: 'step' } : { kind: 'other' }
      }),
      steered,
    )
    const answer = new Set(messages)
    const folded = turn.filter((i, at) => {
      const item = items[i]!
      return (
        !answer.has(at) &&
        (final < 0 || at < final || isAside(item)) &&
        (FOLDS.has(item.kind) ||
          // A preview's earlier outcomes: the last one says where it stands.
          (item.kind === 'preview' && turn.some((j) => j > i && items[j]!.kind === 'preview'))) &&
        (item.kind !== 'tool' || isActivity(item))
      )
    })
    if (!folded.some((i) => isActivity(items[i]!))) return group(turn)
    const first = turn.indexOf(folded[0]!)
    const kept = (from: number, to: number) =>
      turn.slice(from, to).filter((i) => !folded.includes(i))
    return [
      ...group(kept(0, first)),
      // Keyed by its end: an older page loading above does not close it.
      { type: 'worked', key: `w${end}`, ms, inner: group(folded) },
      ...group(kept(first, turn.length)),
    ]
  }
  const nodes: Node[] = []
  let running: number | undefined
  // When the last message steered into the running turn was given to it, or a report woke it.
  let steered: number | undefined
  // Since the last turn began or ended, or a message was steered into it, or a report woke it.
  let since: number[] = []
  const worked = (to: number, from?: number) => (from === undefined ? 0 : to - from)
  items.forEach((item, i) => {
    // What came before a gap stands on its own: its turn's end, if any, is in the gap.
    if (item.kind === 'gap') {
      nodes.push(...group(since), { type: 'item', i })
      since = []
      running = steered = undefined
      return
    }
    // A turn starting again before it ended (resumed) goes on.
    if (item.kind === 'start' && running === undefined) {
      nodes.push(...group(since))
      since = [i]
      running = item.at
      steered = undefined
      return
    }
    // A message not steered into it: the turn before never ended.
    if (item.kind === 'user' && !item.steeredTo && running !== undefined) {
      nodes.push(...group(since))
      since = []
      running = steered = undefined
    }
    // Steered into the turn, such as one that only waited on a server it left running, or woken
    // there by a report from that work: what came before answers the message before, and keeps
    // its answer out of the fold.
    if ((item.kind === 'user' && item.steeredTo) || item.kind === 'woke') {
      nodes.push(...fold(since, worked(item.at, steered ?? running), item.key, true))
      since = []
      steered = item.at
    }
    since.push(i)
    if (item.kind === 'turn') {
      nodes.push(...fold(since, worked(item.at, steered ?? running ?? item.startedAt), item.key))
      since = []
      running = steered = undefined
    }
  })
  // The running turn's steps fold under its Working line, below its messages and cards.
  const live = working && running !== undefined ? since.filter((i) => isActivity(items[i]!)) : []
  nodes.push(...group(live.length ? since.filter((i) => !live.includes(i)) : since))
  const last = nodes.at(-1)
  if (working && last?.type === 'activity') last.live = true
  return Object.assign(nodes, { running: steered ?? running, live })
}

/** "45s", "1m 52s", "2h 5m". */
function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`)

/** What kind of step a tool call is, by its name in any harness. */
function toolKind(toolName: string) {
  if (/^mcp__(browser|playwright|chrome|claude-in-chrome)/i.test(toolName)) return 'browser'
  const name = toolName.replace(/^mcp__.+?__/, '').toLowerCase()
  if (/^(bash|shell|exec_command|local_shell|commandexecution|run_command|terminal)$/.test(name))
    return 'command'
  if (/^(read|view|read_file|notebookread)$/.test(name)) return 'read'
  if (
    /^(edit|write|multiedit|apply_patch|filechange|notebookedit|write_file|create_file)$/.test(name)
  )
    return 'edit'
  if (/^(grep|glob|ls|list_files|search_workspace|codebase_search)$/.test(name)) return 'search'
  if (/^(websearch|web_search|webfetch|web_fetch)$/.test(name)) return 'web'
  if (name.startsWith('browser_')) return 'browser'
  return 'other'
}

/** "Ran 3 commands, read 2 files, used the browser": what a run of steps did. */
function activityLabel(group: ActivityItem[]) {
  const count = { command: 0, read: 0, search: 0, web: 0, browser: 0, other: 0 }
  const edited = new Set<string>()
  let edits = 0
  for (const item of group) {
    if (item.kind === 'file') edited.add(item.path)
    if (item.kind !== 'tool') continue
    const kind = toolKind(item.toolName)
    if (kind !== 'edit') count[kind]++
    else {
      const i = (item.input ?? {}) as Record<string, unknown>
      const path = i.file_path ?? i.path
      if (typeof path === 'string') edited.add(path)
      else edits++
    }
  }
  edits = Math.max(edits, edited.size)
  const parts = [
    count.command && `ran ${plural(count.command, 'a command', 'commands')}`,
    count.read && `read ${plural(count.read, 'a file', 'files')}`,
    edits && `edited ${plural(edits, 'a file', 'files')}`,
    count.search && `searched ${plural(count.search, 'once', 'times')}`,
    count.web && 'searched the web',
    count.browser && 'used the browser',
    count.other && `used ${plural(count.other, 'a tool', 'tools')}`,
  ].filter(Boolean) as string[]
  const text = parts.length ? parts.join(', ') : 'thought'
  return text[0]!.toUpperCase() + text.slice(1)
}

/** The step happening now, under a live group's line. */
function stepText(item: ActivityItem) {
  if (item.kind === 'thinking') return 'Thinking'
  if (item.kind === 'file') return `Changed ${item.path}`
  return `${item.toolName} ${toolSummary(item.toolName, item.input)}`.trim()
}

const VERBS: Partial<Record<ReturnType<typeof toolKind>, string>> = {
  command: 'Ran',
  read: 'Read',
  edit: 'Edited',
  search: 'Searched',
  web: 'Searched the web',
}

/** A tool call's line: "Ran npm test", "Read src/app.ts", else its name and what it was given. */
function ToolLine({ toolName, input }: { toolName: string; input: unknown }) {
  const verb = VERBS[toolKind(toolName)]
  const summary = toolSummary(toolName, input)
  return (
    <>
      {verb ? (
        <span className="flex-none">{verb}</span>
      ) : (
        <code className="flex-none font-mono text-xs font-medium text-foreground/80">
          {bareToolName(toolName)}
        </code>
      )}
      <span className={cn('min-w-0 truncate', verb && 'font-mono text-xs text-foreground/80')}>
        {summary}
      </span>
    </>
  )
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  prisma: 'graphql',
}

const languageOf = (path: unknown) =>
  (typeof path === 'string' && LANGUAGES[path.split('.').pop()!.toLowerCase()]) || 'text'

/** Long output is cut: highlighting a whole log would stall the page. */
const MAX_SHOWN = 20_000
const clipShown = (text: string) =>
  text.length > MAX_SHOWN
    ? `${text.slice(0, MAX_SHOWN)}\n… ${text.length - MAX_SHOWN} more characters`
    : text

/** What a shell command printed, from any harness's wrapping. */
function commandOutput(output: unknown) {
  if (typeof output === 'string') return { out: output, err: '' }
  const o = (output ?? {}) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const out =
    text(o.stdout) || text(o.aggregated_output) || text(o.output) || text(o.formatted_output)
  if (!out && !o.stderr) return undefined
  return { out, err: text(o.stderr) }
}

/** Old and new text as a diff: removed lines, then added ones. */
const editDiff = (before: string, after: string) =>
  [
    ...(before ? before.split('\n').map((line) => `-${line}`) : []),
    ...after.split('\n').map((line) => `+${line}`),
  ].join('\n')

const outputClass =
  'max-h-80 overflow-auto px-4 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-muted-foreground'

/** Code in a tool call, colored, scrolling past a screenful. */
const ToolCode = ({ code, language }: { code: string; language: string }) => (
  <div className="max-h-80 overflow-auto rounded-lg text-xs [&_pre]:border [&_pre]:text-xs [&_pre]:wrap-anywhere [&_pre]:whitespace-pre-wrap">
    <CodeSnippet code={clipShown(code)} language={language} bare />
  </div>
)

/** A visual a teammate drew, under its messages, with its HTML to read beneath. */
function WidgetCard({ widget }: { widget: Widget }) {
  return (
    <div className="flex flex-col gap-2 pl-11">
      <div className="rounded-xl border p-4">
        <WidgetFrame html={widget.html} title={widget.title} />
      </div>
      <Collapsible className="flex min-w-0 flex-col">
        <CollapsibleTrigger className="group flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground">
          {widget.title}
          <ChevronRight
            className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <ToolCode code={widget.html} language="html" />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** The names of the images and PDFs a tool returned that are kept apart from its event (STORED_FILE). */
function storedFiles(value: unknown, names = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const name = value.startsWith(STORED_FILE) && value.slice(STORED_FILE.length)
    if (name && STORED_FILE_NAME.test(name)) names.add(name)
  } else if (Array.isArray(value)) for (const v of value) storedFiles(v, names)
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) storedFiles(v, names)
  return names
}

/** The images and PDFs a tool returned, such as a screenshot, above its output. Each opens over the page. */
function ToolFiles({
  threadId,
  names,
  title,
}: {
  threadId: string
  names: string[]
  /** What each is called: the file read, else the tool. */
  title: string
}) {
  const [open, setOpen] = useState<string>()
  const titleOf = (name: string) =>
    names.length > 1 ? `${title} (${names.indexOf(name) + 1}/${names.length})` : title
  const isPdf = (name: string) => name.endsWith('.pdf')
  return (
    <div className="flex flex-wrap items-start gap-2">
      {names.map((name) =>
        isPdf(name) ? (
          <button
            key={name}
            type="button"
            className="flex max-w-64 items-center gap-2 rounded-lg border bg-card py-1.5 pr-3 pl-2 text-xs hover:border-ring"
            onClick={() => setOpen(name)}
          >
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{titleOf(name)}</span>
          </button>
        ) : (
          <button
            key={name}
            type="button"
            className="block cursor-zoom-in overflow-hidden rounded-lg border bg-muted"
            onClick={() => setOpen(name)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={storedFileUrl(threadId, name)}
              alt={titleOf(name)}
              loading="lazy"
              className="max-h-64 max-w-full object-contain"
            />
          </button>
        ),
      )}
      <MediaPreview
        media={
          open && !isPdf(open)
            ? { name: titleOf(open), src: storedFileUrl(threadId, open), kind: 'image' }
            : undefined
        }
        onClose={() => setOpen(undefined)}
      />
      <PdfPreview
        pdf={
          open && isPdf(open)
            ? { name: titleOf(open), url: storedFileUrl(threadId, open) }
            : undefined
        }
        onClose={() => setOpen(undefined)}
      />
    </div>
  )
}

/** A tool call opened: a command and what it printed, an edit as a diff, else its input and output. */
function ToolDetail({
  threadId,
  item,
}: {
  threadId: string
  item: Extract<Item, { kind: 'tool' }>
}) {
  const files = [...storedFiles(item.output)]
  if (!files.length) return <ToolOutput item={item} />
  const input = (item.input ?? {}) as Record<string, unknown>
  const path = input.file_path ?? input.path
  const read = toolKind(item.toolName) === 'read'
  const title =
    read && typeof path === 'string' ? (path.split('/').pop() ?? path) : bareToolName(item.toolName)
  const shown = <ToolFiles threadId={threadId} names={files} title={title} />
  // A file it read is shown as itself; any other tool's files come before what it returned.
  if (read && !item.isError) return shown
  return (
    <>
      {shown}
      <ToolOutput item={item} />
    </>
  )
}

function ToolOutput({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const kind = toolKind(item.toolName)
  const input = (item.input ?? {}) as Record<string, unknown>
  const path = input.file_path ?? input.path
  if (kind === 'command' && typeof input.command === 'string') {
    const printed = item.output === undefined ? undefined : commandOutput(item.output)
    return (
      <>
        <ToolCode code={`$ ${input.command}`} language="bash" />
        {printed
          ? (printed.out || printed.err) && (
              <pre className={outputClass}>
                {clipShown(printed.out)}
                {printed.err && (
                  <span className="text-destructive-text">
                    {printed.out && '\n'}
                    {clipShown(printed.err)}
                  </span>
                )}
              </pre>
            )
          : item.output !== undefined && (
              <pre className={outputClass}>{clipShown(json(item.output))}</pre>
            )}
      </>
    )
  }
  if (kind === 'edit') {
    const patch =
      typeof item.input === 'string'
        ? item.input
        : typeof input.patch === 'string'
          ? input.patch
          : typeof input.input === 'string'
            ? input.input
            : undefined
    const code =
      patch ??
      (typeof input.new_string === 'string'
        ? editDiff(typeof input.old_string === 'string' ? input.old_string : '', input.new_string)
        : typeof input.content === 'string'
          ? input.content
          : undefined)
    if (code !== undefined)
      return (
        <>
          <ToolCode
            code={code}
            language={patch !== undefined || 'new_string' in input ? 'diff' : languageOf(path)}
          />
          {item.isError && <pre className={outputClass}>{clipShown(json(item.output))}</pre>}
        </>
      )
  }
  if (kind === 'read' && !item.isError) {
    const file = ((item.output ?? {}) as { file?: { content?: unknown; type?: unknown } }).file
    const content =
      typeof file?.content === 'string'
        ? file.content
        : typeof item.output === 'string'
          ? item.output
          : undefined
    if (content !== undefined) return <ToolCode code={content} language={languageOf(path)} />
    if (typeof file?.type === 'string' && file.type.startsWith('image/'))
      return <p className="text-xs text-muted-foreground">An image ({file.type})</p>
  }
  return (
    <>
      <ToolCode code={json(item.input)} language="json" />
      {item.output !== undefined &&
        (typeof item.output === 'string' && !/^\s*[[{]/.test(item.output) ? (
          <pre className={outputClass}>{clipShown(item.output)}</pre>
        ) : (
          <ToolCode code={json(item.output)} language="json" />
        ))}
    </>
  )
}

/**
 * A tool call's line, opening to what it was given and returned. Memoized: the thread's items
 * are rebuilt at each event of a running turn, but a step's input and output keep their identity
 * (they come from its events), so only the step that changed renders again.
 */
const ToolStep = memo(
  function ToolStep({
    threadId,
    item,
  }: {
    threadId: string
    item: Extract<Item, { kind: 'tool' }>
  }) {
    return (
      <Collapsible className="min-w-0 text-sm">
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 text-left text-muted-foreground hover:text-foreground">
          <ToolLine toolName={item.toolName} input={item.input} />
          <ChevronRight
            className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90"
            aria-hidden
          />
          {!item.finished ? (
            <span
              role="img"
              aria-label="Running"
              className="size-1.5 flex-none animate-pulse rounded-full bg-primary"
            />
          ) : item.isError ? (
            // A failed call is common and the teammate goes on from it: said quietly, on the step only.
            <span className="flex-none text-xs text-destructive-text">failed</span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2">
          <ToolDetail threadId={threadId} item={item} />
        </CollapsibleContent>
      </Collapsible>
    )
  },
  (a, b) =>
    a.threadId === b.threadId &&
    a.item.key === b.item.key &&
    a.item.toolName === b.item.toolName &&
    a.item.input === b.item.input &&
    a.item.output === b.item.output &&
    a.item.finished === b.item.finished &&
    a.item.isError === b.item.isError,
)

/** What a teammate thought on its way, folded. */
const ThinkingStep = memo(function ThinkingStep({ text }: { text: string }) {
  return (
    <Collapsible className="self-start">
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        Thinking
        <ChevronRight
          className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown
          text={text}
          className="mt-2 max-h-80 overflow-auto rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
        />
      </CollapsibleContent>
    </Collapsible>
  )
})

/** Steps an unfolded line shows at first: a long turn's earlier ones wait behind a button. */
const RECENT_STEPS = 20

/** The latest steps of a run, with a line that shows the earlier ones. */
function RecentSteps({ children }: { children: React.ReactNode[] }) {
  const [all, setAll] = useState(false)
  const hidden = all ? 0 : Math.max(0, children.length - RECENT_STEPS)
  return (
    <>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start text-sm text-muted-foreground hover:text-foreground"
        >
          Show {plural(hidden, '1 earlier step', 'earlier steps')}
        </button>
      )}
      {hidden ? children.slice(hidden) : children}
    </>
  )
}

/** Lines in a row folded under one that says what they were; it opens to each of them. */
function Fold({
  label,
  after,
  children,
}: {
  label: string
  /** After the chevron: the step happening now. */
  after?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Collapsible className="flex min-w-0 flex-col">
      <CollapsibleTrigger className="group flex max-w-full min-w-0 items-center gap-1.5 self-start text-left text-sm text-muted-foreground hover:text-foreground">
        {/* Truncates on a narrow screen rather than widening the page; the step after it goes first. */}
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
        <ChevronRight
          className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
        {after}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-2 border-l pl-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Steps in a row, as one line that opens to each of them. */
function ActivityGroup({
  group,
  live,
  children,
}: {
  group: ActivityItem[]
  live: boolean
  children: React.ReactNode[]
}) {
  return (
    <Fold
      label={activityLabel(group)}
      after={
        live && (
          <span className="min-w-0 shrink-[100] truncate font-mono text-xs opacity-70 group-data-[state=open]:hidden">
            {stepText(group.at(-1)!)}
          </span>
        )
      }
    >
      <RecentSteps>{children}</RecentSteps>
    </Fold>
  )
}

/**
 * "A person took over once, ran 5 commands, has control": what a run of control lines did.
 * Handing back is a card of its own, which takes the commands before it.
 */
function controlLabel(group: Extract<Item, { kind: 'control' }>[]) {
  const took = group.filter((c) => c.change === 'took').length
  const commands = group.filter((c) => c.change === 'command').length
  const parts = [
    took && `A person took over ${plural(took, 'once', 'times')}`,
    commands && `ran ${plural(commands, 'a command', 'commands')}`,
  ].filter(Boolean) as string[]
  if (took) parts.push('has control')
  const text = parts.join(', ')
  return text[0]!.toUpperCase() + text.slice(1)
}

/**
 * A person handed the thread back: to whom, their note, and what they did while they had
 * control (files changed, commands run) folded under a line.
 */
function HandbackCard({
  teammate,
  note,
  files,
  commands,
}: {
  teammate?: string
  note: string
  files: string[]
  commands: string[]
}) {
  const did = [
    files.length > 0 && plural(files.length, '1 file changed', 'files changed'),
    commands.length > 0 && plural(commands.length, '1 command', 'commands'),
  ].filter(Boolean)
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <span className="size-2 rounded-full bg-primary" />
        </span>
        Handed back{teammate ? ` to ${teammate}` : ''}
      </p>
      {note && (
        <p className="ml-6 border-l-2 border-primary pl-3 leading-relaxed wrap-anywhere whitespace-pre-wrap">
          {note}
        </p>
      )}
      {did.length > 0 && (
        <Collapsible className="ml-6 flex min-w-0 flex-col">
          <CollapsibleTrigger className="group flex items-center gap-1.5 self-start text-left text-muted-foreground hover:text-foreground">
            {did.join(' · ')}
            <ChevronDown
              className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-0.5 font-mono text-xs wrap-anywhere text-muted-foreground">
            {files.map((file) => (
              <span key={file}>{file}</span>
            ))}
            {commands.map((command, i) => (
              <span
                key={i}
                className={cn('whitespace-pre-wrap', i === 0 && files.length > 0 && 'mt-2')}
              >
                $ {command}
              </span>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

/** A long turn's work before its answer, folded under how long it took. */
function WorkedFor({ ms, children }: { ms: number; children: React.ReactNode }) {
  return (
    <Collapsible className="flex flex-col gap-4">
      <CollapsibleTrigger className="group flex items-center gap-1.5 border-b pb-2 text-left text-sm text-muted-foreground hover:text-foreground">
        Worked for {duration(ms)}
        <ChevronDown
          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The running turn as one line: "Working · 4 steps · 1 in background", how long it has worked,
 * and its steps and background work under it. Not for the first seconds of a quick reply.
 */
function WorkingLine({
  since,
  steps,
  background,
  children,
}: {
  /** When the turn began; unset when how long it worked is not known or not to be said. */
  since?: number
  steps: ActivityItem[]
  background: BackgroundTask[]
  children: React.ReactNode[]
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  const ms = since === undefined ? 0 : now - since
  if (!steps.length && !background.length && ms < 5_000) return null
  // Thinking is no step of its own: it shows under the line, uncounted.
  const count = steps.filter((item) => item.kind !== 'thinking').length
  return (
    <Collapsible className="flex min-w-0 flex-col text-sm">
      <CollapsibleTrigger className="group flex max-w-full min-w-0 items-center gap-1.5 self-start text-left text-muted-foreground hover:text-foreground">
        <span
          className="mr-0.5 size-1.5 flex-none animate-pulse rounded-full bg-primary"
          aria-hidden
        />
        <span className="flex-none text-foreground">Working</span>
        {count > 0 && <span className="flex-none">· {plural(count, '1 step', 'steps')}</span>}
        {background.length > 0 && (
          <span className="min-w-0 truncate">· {background.length} in background</span>
        )}
        {/* How long it has worked, then the chevron, right after what it says: not at the far edge. */}
        {ms >= 5_000 && <span className="flex-none">· {duration(ms)}</span>}
        <ChevronRight
          className="size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ml-0.5 flex flex-col gap-2 border-l pl-3">
        <RecentSteps>{children}</RecentSteps>
        {background.map((task) => (
          <div key={task.id} className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span
              className="size-1.5 flex-none animate-pulse rounded-full bg-primary"
              aria-hidden
            />
            <span className="min-w-0 truncate text-foreground/80">{task.description}</span>
            <span className="ml-auto flex-none pl-2 text-xs">
              {task.kind === 'agent' && task.steps > 0
                ? `${plural(task.steps, '1 step', 'steps')} · in background`
                : 'in background'}
            </span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** When the thread picked up again, centred above the message (lib/thread-times.ts). */
function PauseTime({ at }: { at: number }) {
  return (
    <Hint label={new Date(at).toLocaleString()}>
      <time
        dateTime={new Date(at).toISOString()}
        className="text-muted-foreground self-center pt-2 text-xs"
      >
        {pauseLabel(at)}
      </time>
    </Hint>
  )
}

/**
 * Its updates stopped reaching Brigade (its computer keeps sending them): said plainly,
 * for a thread must never look at work for hours while nothing of it comes through.
 */
function EventsWaiting({ since }: { since: string }) {
  const at = new Date(since)
  const when =
    at.toDateString() === new Date().toDateString()
      ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <div
      role="status"
      className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive-text"
    >
      Updates from this thread have not reached Brigade since {when}. Its computer keeps sending
      them.
    </div>
  )
}

/** The computer a thread runs on, away during its turn: by the name Settings → Computers gives it. */
export type ComputerDown = { name: string; cloud: boolean; state: 'restarting' | 'offline' }

/**
 * Its computer went away during a turn (a restart, an update, a Mac asleep): the turn
 * waits on it, and goes on by itself once it is back, where "is reading" would show.
 */
function ComputerAway({
  computer,
  teammate,
}: {
  computer: ComputerDown
  teammate?: { name: string }
}) {
  const name = computer.cloud ? 'The cloud computer' : computer.name
  return computer.state === 'restarting' ? (
    <div role="status" className="animate-in self-start text-sm duration-300 fade-in">
      <span className="text-shimmer">{name} is restarting…</span>
    </div>
  ) : (
    <div role="status" className="self-start text-sm text-muted-foreground">
      {name} is offline.{teammate && ` ${teammate.name} carries on once it is back.`}
    </div>
  )
}

/**
 * Between a message and the first thing its teammate does: a line saying how far it got,
 * where the answer will show. It counts up past the first seconds.
 */
export function Answering({
  teammate,
  phase,
  since,
}: {
  teammate: { name: string }
  /** slot: its turn waits for one of that many turns running on its computer to end. */
  phase: 'starting' | 'reading' | 'thinking' | { slot: number }
  since?: number
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  const ms = since === undefined ? 0 : now - since
  const doing =
    typeof phase === 'object'
      ? `is waiting for ${phase.slot === 1 ? 'the turn' : `one of the ${phase.slot} turns`} running on this computer to end`
      : { starting: 'is starting up', reading: 'is reading your message', thinking: 'is thinking' }[
          phase
        ]
  return (
    // Fading in is an animation too: on the line itself it would replace the shimmer.
    <div role="status" className="animate-in self-start text-sm duration-300 fade-in">
      <span className="text-shimmer">
        {teammate.name} {doing}
        {ms >= 5_000 && ` · ${duration(ms)}`}
      </span>
    </div>
  )
}

export function ThreadItems({
  threadId,
  items,
  onApproval,
  onAnswer,
  onTicket,
  onChoose,
  onReply,
  canApprove,
  takeover,
  teammate,
  teammates = [],
  onOpenPreview,
  previewStart,
  working = false,
  starting = false,
  background = [],
  eventsWaitingSince,
  computerDown,
  childThreads = [],
  drafting = false,
  onRetry,
  admin = false,
  gapLine,
}: {
  threadId: string
  items: Item[]
  /** edited: an email's draft as the person changed it before allowing it. */
  onApproval: (
    approvalId: string,
    approved: boolean,
    always?: boolean,
    edited?: EditedEmail,
  ) => void
  onAnswer: (questionId: string, answer: QuestionAnswer) => Promise<void>
  onTicket: (requestId: string, answer: TicketAnswer) => Promise<void>
  /** Sends a choice someone clicked as their message, with the option's design it picks. Unset when they cannot send one now. */
  onChoose?: (text: string, pick?: string) => Promise<void>
  /** Quotes a message in the composer, for the next one to reply to it. Unset when they cannot send one. */
  onReply?: (reply: ReplyTo) => void
  canApprove: boolean
  /** Unset when this member cannot take over the computer (a member's own machine, another in control). */
  takeover?: TicketTakeover
  /** Who answers when a message does not say: shown beside its messages. */
  teammate?: { id: string; name: string; harness: string }
  /** Everyone in the thread. With several, each message shows who wrote it. */
  teammates?: { id: string; name: string; harness: string }[]
  /** Opens the thread's preview beside it; set while one runs. */
  onOpenPreview?: () => void
  /** Starts the thread's preview, for a teammate's preview button. Unset where it cannot. */
  previewStart?: ReplyPreview
  /** A teammate's turn runs now: its latest steps show live, with how long it has worked. */
  working?: boolean
  /** The thread's computer is starting for that turn. */
  starting?: boolean
  /** Agents the running turn left working in the background. */
  background?: BackgroundTask[]
  /** Since when its updates have not reached Brigade: said instead of how long it has worked. */
  eventsWaitingSince?: string | null
  /** Its computer is away (restarting, offline): said instead of how the turn goes, which waits on it. */
  computerDown?: ComputerDown
  /** The thread's child threads: where a teammate started one, its line shows how it is doing. */
  childThreads?: ThreadChild[]
  /** The person is writing a message: the buttons a teammate suggested step aside, their words win. */
  drafting?: boolean
  /** Tries the turn that failed last again. Unset when they cannot write in the thread. */
  onRetry?: () => Promise<void>
  /** An owner or admin: they alone allow what only admins may (a teammate's trigger). */
  admin?: boolean
  /** Where events are not loaded: what loads them. */
  gapLine?: (gap: EventGap) => React.ReactNode
}) {
  const byId = new Map(teammates.map((t) => [t.id, t]))
  const several = teammates.length > 1
  // Others write in it too: their messages say whose they are.
  const { me } = useDashboard()
  const othersWrote = items.some(
    (it) => it.kind === 'user' && it.memberId !== null && it.memberId !== me.memberId,
  )
  const memberNames = useMemberNames(othersWrote)
  const [retrying, setRetrying] = useState<string>()
  // The latest turn failed: nothing came after its error but notes (a try planned on its own, say).
  const retryable = (i: number) =>
    !!onRetry && !working && items.slice(i + 1).every((it) => it.kind === 'note')
  const skillNames = useSkillCommands().map((s) => s.name)
  // A card closing the running turn waits for it to end: under a reply still being written it reads too early.
  // A teammate's buttons stay until anyone answers, with a click or their own words, or
  // until what they were for happened another way (a note: its pull request merged from
  // the card). Only the latest set shows, and none while the person writes: their words win.
  const repliesOpen = (i: number) =>
    !drafting &&
    !!onChoose &&
    !items
      .slice(i + 1)
      .some(
        (it) =>
          it.kind === 'user' ||
          (it.kind === 'note' && it.settles) ||
          (it.kind === 'tool' && suggestedReplies(it)),
      )
  /** The pull request opened last before item i: the one a button's merge merges. */
  const pullBefore = (i: number) => {
    for (let j = i - 1; j >= 0; j--) {
      const it = items[j]!
      const opened = it.kind === 'tool' && it.finished && !it.isError ? openedPull(it) : null
      if (opened) return opened
    }
    return null
  }
  /** A button after the card at i merges its pull request: the card leaves merging to it. */
  const mergeOffered = (i: number, pull: { repository: string; number: number }) =>
    items.some((it, k) => {
      if (k <= i || it.kind !== 'tool') return false
      if (!suggestedReplies(it)?.actions?.some((a) => a.action === 'merge')) return false
      const target = pullBefore(k)
      return (
        target?.repository === pull.repository && target.number === pull.number && repliesOpen(k)
      )
    })
  const closingTurn = (i: number) =>
    working &&
    !items.slice(i + 1).some((it) => it.kind === 'turn' || (it.kind === 'user' && !it.steeredTo))
  /** Its place in a run of one teammate's messages: see `messageRuns`. */
  type Run = { follows: boolean; close: boolean; followed: boolean }
  const render = (item: Item, i: number, run?: Run): React.ReactNode => {
    switch (item.kind) {
      case 'user': {
        // An email a trigger received: a mail, with the files that came with it.
        if (item.email)
          return (
            <div key={item.key} data-seq={item.seq} className="min-w-0">
              <ReceivedEmailCard
                event={item.email.event}
                email={item.email.email}
                attachments={item.attachments}
                reply={
                  !!item.email.email.threadId && item.email.email.threadId !== item.email.email.id
                }
              />
            </div>
          )
        // Brigade's own words about child threads: a note, not a person's message.
        if (item.brigade) {
          // A report: one card per thread it tells about, that opens it.
          const reported = reportNote(item.text)
          if (reported) {
            return (
              <div key={item.key} data-seq={item.seq} className="flex flex-col gap-2">
                {reported.head && <p className="text-xs text-muted-foreground">{reported.head}</p>}
                {reported.threads.map((t) => (
                  <ReportedThread key={t.id} thread={t} />
                ))}
              </div>
            )
          }
          // What the parent's teammate wrote later: who, above their words.
          const parent = item.brigade === 'parent' ? fromParent(item.text) : null
          return (
            <div
              key={item.key}
              data-seq={item.seq}
              className="rounded-xl border bg-card px-4 py-3 text-sm"
            >
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {parent
                  ? `${parent.from} wrote from the parent thread “${parent.parentTitle}”`
                  : item.brigade === 'report'
                    ? 'Reports from child threads'
                    : item.brigade === 'follow'
                      ? 'Report from a thread this one follows'
                      : item.brigade === 'dry_run'
                        ? 'Dry run done'
                        : 'Work from the parent thread'}
              </p>
              {/* A teammate or Brigade wrote it, not a person: Markdown, like a teammate's reply. */}
              <Markdown text={parent ? parent.text : forPeople(item.text)} />
            </div>
          )
        }
        if (item.handback)
          return (
            <div key={item.key} data-seq={item.seq} className="min-w-0">
              <HandbackCard teammate={teammate?.name} {...item.handback} />
            </div>
          )
        // A wake-up, a schedule's run…: a line saying what it is, what it says folded under it.
        if (item.note)
          return (
            <div key={item.key} data-seq={item.seq} className="min-w-0">
              <BrigadeNoteLine note={item.note} />
              {item.attachments.length > 0 && (
                <MessageAttachments attachments={item.attachments} className="mt-2" />
              )}
            </div>
          )
        // A command it starts with (/design, a skill) is a label above it: what was asked for.
        // Elements picked in the preview are chips above it, out of its text; their
        // pictures show in them, not with its other files.
        const { text: written, elements } = splitPreviewElements(
          forPeople(item.handed ? item.handed.note : item.text),
        )
        const pictureOf = (name?: string) =>
          name ? item.attachments.find((a) => a.name === name && a.status === 'ready') : undefined
        const pictures = new Set(elements.flatMap((e) => pictureOf(e.image)?.id ?? []))
        const files = item.attachments.filter((a) => !pictures.has(a.id))
        const asked = startingCommand(written, skillNames)
        const text = asked ? asked.rest : written
        const bubble = (
          <div
            key={item.key}
            data-seq={item.seq}
            className="flex max-w-[85%] flex-col items-end gap-1.5 self-end"
          >
            {item.memberId !== null && item.memberId !== me.memberId && (
              <span className="text-xs font-medium text-muted-foreground">
                {memberNames.get(item.memberId) ?? 'Another member'}
              </span>
            )}
            {item.replyTo && (
              <ReplyQuote
                reply={item.replyTo}
                author={
                  item.replyTo.teammateId ? byId.get(item.replyTo.teammateId)?.name : undefined
                }
              />
            )}
            {asked && <CommandChip command={asked.command} />}
            <PreviewElementChips
              elements={elements.map((element) => {
                const picture = pictureOf(element.image)
                return { element, ...(picture && { picture: attachmentUrl(picture.id) }) }
              })}
              className="justify-end"
            />
            {text && (
              <div className="group/message flex items-center gap-1">
                <MessageActions
                  text={text}
                  onReply={onReply && (() => onReply({ seq: item.seq, text: replyText(written) }))}
                />
                <MessageBubble text={text} />
              </div>
            )}
            {files.length > 0 && <MessageAttachments attachments={files} className="justify-end" />}
            {item.steeredTo && asksParallel(item.text) ? (
              <span className="text-xs text-muted-foreground">
                Sent to run in parallel, in a child thread
              </span>
            ) : item.steeredTo ? (
              <span className="text-xs text-muted-foreground">
                Steered into{' '}
                {(byId.get(item.steeredTo) ?? teammate)?.name
                  ? `${(byId.get(item.steeredTo) ?? teammate)!.name}’s`
                  : 'the'}{' '}
                running turn
              </span>
            ) : null}
          </div>
        )
        // Handed over from the Inbox: their note, then the mail, which opens its conversation there.
        if (item.handed)
          return (
            <div key={item.key} className="flex min-w-0 flex-col gap-3">
              {(text || files.length > 0 || item.replyTo) && bubble}
              <div data-seq={item.seq} className="min-w-0">
                <ReceivedEmailCard
                  event={item.handed.event}
                  email={item.handed.email}
                  attachments={[]}
                  reply={false}
                  handed={{ item: item.handed.item }}
                />
              </div>
            </div>
          )
        return bubble
      }
      case 'assistant': {
        const author = (item.teammateId && byId.get(item.teammateId)) || teammate
        // With several teammates, name the author where the speaker changes.
        const previous = items
          .slice(0, i)
          .findLast((it): it is Extract<Item, { kind: 'assistant' }> => it.kind === 'assistant')
        const named =
          several &&
          author &&
          !run?.follows &&
          (!previous ||
            previous.teammateId !== item.teammateId ||
            items.slice(items.indexOf(previous), i).some((it) => it.kind === 'user'))
        return (
          <div
            key={item.key}
            data-seq={item.seq}
            className={cn('group/message flex items-start gap-3', run?.close && '-mt-3')}
          >
            {/* After its own message, no avatar again: the run shows it once, on its first. */}
            {author &&
              (run?.follows ? (
                <div className="w-8 flex-none" aria-hidden />
              ) : (
                <TeammateAvatar teammate={author} className="mt-0.5 size-8" />
              ))}
            <div className="relative flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
              {named && <span className="text-sm font-semibold">{author.name}</span>}
              {/* A file it names opens from its own working folder first. */}
              <FileLinksProvider
                value={{
                  teammateId: item.teammateId,
                  ...(item.images ? { images: item.images } : {}),
                }}
              >
                {/* A card it ends with shows once the reply is done, without its markup. */}
                <Markdown text={item.done ? item.text : withoutCard(item.text)} />
              </FileLinksProvider>
              {/* With its next message close under it, they float over its corner, where a pointer shows them. */}
              {item.done && (
                <div
                  className={cn(
                    '-ml-1.5 flex',
                    run?.followed &&
                      '[@media(hover:hover)]:absolute [@media(hover:hover)]:-top-3 [@media(hover:hover)]:right-0 [@media(hover:hover)]:ml-0 [@media(hover:hover)]:rounded-full [@media(hover:hover)]:bg-background [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:shadow-sm [@media(hover:hover)]:ring-1 [@media(hover:hover)]:ring-border [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:group-hover/message:pointer-events-auto [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:focus-within:opacity-100',
                  )}
                >
                  <MessageActions
                    text={item.text}
                    onReply={
                      onReply &&
                      (() =>
                        onReply({
                          seq: item.seq,
                          ...(author ? { teammateId: author.id } : {}),
                          text: replyText(item.text),
                        }))
                    }
                  />
                </div>
              )}
            </div>
          </div>
        )
      }
      case 'thinking':
        return <ThinkingStep key={item.key} text={item.text} />
      case 'tool': {
        const team = proposedTeam(item)
        if (
          (team || offeredChoices(item) || suggestedReplies(item) || playbookAction(item)) &&
          closingTurn(i)
        )
          return null
        const playbook = playbookCard(item)
        if (playbook)
          return (
            <div key={item.key} className="pl-11">
              {playbook.card === 'playbook' ? (
                <PlaybookCard playbookKey={playbook.id} />
              ) : playbook.card === 'progress' ? (
                <DryRunProgress installationId={playbook.id} />
              ) : playbook.card === 'report' ? (
                <DryRunReport installationId={playbook.id} />
              ) : (
                <ActivationCard
                  installationId={playbook.id}
                  threadId={threadId}
                  onSend={onChoose && ((text) => onChoose(text))}
                />
              )}
            </div>
          )
        if (team) {
          // Answered by the next message anyone sent: "Created the team: …" or their own words.
          const reply = items
            .slice(i + 1)
            .find((it): it is Extract<Item, { kind: 'user' }> => it.kind === 'user')
          return (
            <TeamProposalCard
              key={item.key}
              proposal={team}
              reply={reply?.text}
              onSend={onChoose && ((text) => onChoose(text))}
            />
          )
        }
        const choices = offeredChoices(item)
        if (choices) {
          // Answered by the next message anyone sent, a click or their own words.
          const reply = items
            .slice(i + 1)
            .find((it): it is Extract<Item, { kind: 'user' }> => it.kind === 'user')
          return (
            <ChoicesCard key={item.key} choices={choices} reply={reply?.text} onChoose={onChoose} />
          )
        }
        const replies = suggestedReplies(item)
        if (replies) {
          if (!repliesOpen(i) || !onChoose) return null
          return (
            <SuggestedReplyButtons
              key={item.key}
              replies={replies}
              pull={pullBefore(i)}
              {...(previewStart ? { preview: previewStart } : {})}
              onSend={onChoose}
            />
          )
        }
        const widget = shownWidget(item)
        if (widget) return <WidgetCard key={item.key} widget={widget} />
        const child = item.finished && !item.isError ? startedChild(item) : null
        if (child)
          return (
            <StartedChild
              key={item.key}
              threadId={child.threadId}
              title={child.title}
              children={childThreads}
            />
          )
        const opened = item.finished && !item.isError ? openedPull(item) : null
        if (opened)
          return (
            <PullCard
              key={item.key}
              repository={opened.repository}
              number={opened.number}
              title={opened.title}
              mergeElsewhere={mergeOffered(i, opened)}
              childThreads={childThreads}
            />
          )
        return <ToolStep key={item.key} threadId={threadId} item={item} />
      }
      case 'approval': {
        // A trigger lets outside events start work: only an owner or admin allows one.
        const adminsOnly = bareToolName(item.toolName) === 'create_trigger'
        return (
          <Card key={item.key} className="min-w-0 gap-3 border-warning/50 px-5 py-4 wrap-anywhere">
            <div className="flex items-start gap-2">
              <ShieldAlert aria-hidden className="mt-0.5 size-4 flex-none text-warning" />
              <div className="min-w-0 flex-1 font-semibold">
                {approvalAsk(item.toolName) ?? (
                  <>
                    Allow <code className="font-mono text-sm">{item.toolName}</code>{' '}
                    {toolSummary(item.toolName, item.input)}?
                  </>
                )}
              </div>
              {item.resolved && (
                <StatusBadge
                  status={item.resolved.approved ? 'approved' : 'denied'}
                  label={item.resolved.approved ? 'Allowed' : 'Denied'}
                />
              )}
            </div>
            {item.reason && <p className="text-sm text-muted-foreground">{item.reason}</p>}
            {/* An email may be changed before it is allowed. */}
            {!item.resolved && canApprove && isEmailSend(item.toolName) ? (
              <EditableEmailPreview
                input={item.input}
                onAllow={(edited) => onApproval(item.approvalId, true, false, edited)}
              />
            ) : (
              <ToolInputPreview input={item.input} />
            )}
            {item.resolved ? null : (adminsOnly ? admin : canApprove) ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onApproval(item.approvalId, true)}>
                  {item.always ? 'Allow in this thread' : 'Allow'}
                </Button>
                {item.always && (
                  <Button
                    size="sm"
                    variant="outline"
                    tooltip="Let this teammate use it from now on, in any thread, without asking"
                    onClick={() => onApproval(item.approvalId, true, true)}
                  >
                    Always allow
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onApproval(item.approvalId, false)}
                >
                  Deny
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {adminsOnly
                  ? 'Waiting for an owner or admin.'
                  : 'Only the member who started this thread can answer.'}
              </p>
            )}
          </Card>
        )
      }
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
            takeover={takeover}
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
            className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-2.5 text-sm text-destructive-text"
          >
            <span className="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap">{item.message}</span>
            {retryable(i) && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={retrying === item.key}
                onClick={() => {
                  setRetrying(item.key)
                  void onRetry!().catch(() => setRetrying(undefined))
                }}
              >
                Try again
              </Button>
            )}
          </div>
        )
      case 'note':
        return (
          <div key={item.key} className="text-sm text-muted-foreground">
            {item.text}
          </div>
        )
      case 'control':
        return item.change === 'command' ? (
          <div
            key={item.key}
            className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground"
          >
            $ {item.command}
          </div>
        ) : item.change === 'handed' ? (
          <HandbackCard
            key={item.key}
            teammate={teammate?.name}
            note=""
            files={[]}
            commands={item.commands ?? []}
          />
        ) : (
          <div key={item.key} className="text-sm text-muted-foreground">
            A person took over
          </div>
        )
      case 'preview':
        return (
          <div
            key={item.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
          >
            <Globe aria-hidden className="size-4 shrink-0" />
            <span>
              {item.status === 'ready'
                ? `Preview ready${item.repository ? ` · ${item.repository}` : ''}`
                : item.status === 'attention'
                  ? `The preview's check found problems${item.failed ? ` on ${item.failed.join(', ')}` : ''}`
                  : item.status === 'running'
                    ? 'Preview running'
                    : endedText(item.status, item.reason)}
            </span>
            {(item.status === 'ready' ||
              item.status === 'attention' ||
              item.status === 'running') &&
              onOpenPreview &&
              // Only the latest run opens: an earlier one has been replaced.
              !items.slice(i + 1).some((later) => later.kind === 'preview') && (
                <Button type="button" size="sm" variant="outline" onClick={onOpenPreview}>
                  Open preview
                </Button>
              )}
          </div>
        )
      case 'gap':
        return <Fragment key={item.key}>{gapLine?.(item.gap)}</Fragment>
      case 'start':
      case 'woke':
      case 'slot':
        return null
    }
  }
  const nodes = layoutThread(items, working)
  // Messages after a pause: their time above them.
  const marks = pauses(items)
  // Working, and nothing from the teammate since the last message (or only its turn waiting
  // for a slot, then starting).
  const lastUser = items.findLastIndex((it) => it.kind === 'user' && !it.steeredTo)
  const since = items.slice(lastUser + 1)
  const waiting =
    working && lastUser >= 0 && since.every((it) => it.kind === 'start' || it.kind === 'slot')
      ? (since.at(-1) as Extract<Item, { kind: 'start' | 'slot' }> | undefined)
      : false
  const waitingFor = waiting !== false && (byId.get(waiting?.teammateId ?? '') ?? teammate)
  // A turn waiting for a slot, even after output of its own (resumed) or another's reply.
  const slot = working ? slotWait(items) : undefined
  const slotTeammate = slot && (byId.get(slot.teammateId) ?? teammate)
  // Counted from its turn starting, else from the message.
  const from = waiting
    ? waiting.at
    : lastUser >= 0
      ? (items[lastUser] as Extract<Item, { kind: 'user' }>).at
      : undefined
  // What ends a run of one teammate's messages: anything shown but its steps.
  const runEntry = (node: Node): RunEntry => {
    if (node.type === 'activity') return 'step'
    if (node.type !== 'item' || marks.has(items[node.i]!.key)) return 'break'
    const item = items[node.i]!
    if (item.kind === 'assistant') return { author: item.teammateId ?? '' }
    return isActivity(item) ||
      item.kind === 'start' ||
      item.kind === 'woke' ||
      item.kind === 'slot' ||
      (item.kind === 'turn' && item.finishReason !== 'interrupted')
      ? 'step'
      : 'break'
  }
  const show = (list: Node[]): React.ReactNode[] => {
    const runs = messageRuns(list.map(runEntry))
    const runAt = (at: number): Run => ({
      follows: runs.follows.has(at),
      close: runs.close.has(at),
      followed: runs.close.has(at + 1),
    })
    return list.map((node, at) =>
      node.type === 'item' ? (
        marks.has(items[node.i]!.key) ? (
          <Fragment key={items[node.i]!.key}>
            <PauseTime at={marks.get(items[node.i]!.key)!} />
            {render(items[node.i]!, node.i)}
          </Fragment>
        ) : (
          render(items[node.i]!, node.i, runAt(at))
        )
      ) : node.type === 'activity' ? (
        <ActivityGroup
          key={items[node.is[0]!]!.key}
          group={node.is.map((i) => items[i]!) as ActivityItem[]}
          live={node.live}
        >
          {node.is.map((i) => render(items[i]!, i))}
        </ActivityGroup>
      ) : node.type === 'control' ? (
        <Fold
          key={items[node.is[0]!]!.key}
          label={controlLabel(
            node.is.map((i) => items[i]!) as Extract<Item, { kind: 'control' }>[],
          )}
        >
          {node.is.map((i) => render(items[i]!, i))}
        </Fold>
      ) : (
        <WorkedFor key={node.key} ms={node.ms}>
          {show(node.inner)}
        </WorkedFor>
      ),
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {show(nodes)}
      {working && ((nodes.running !== undefined && !waitingFor) || background.length > 0) && (
        <WorkingLine
          key="working"
          {...(nodes.running !== undefined && !eventsWaitingSince ? { since: nodes.running } : {})}
          steps={nodes.live.map((i) => items[i]!) as ActivityItem[]}
          background={background}
        >
          {nodes.live.map((i) => render(items[i]!, i))}
        </WorkingLine>
      )}
      {eventsWaitingSince ? (
        <EventsWaiting since={eventsWaitingSince} />
      ) : working && computerDown ? (
        <ComputerAway computer={computerDown} teammate={waitingFor || teammate} />
      ) : slot && slotTeammate ? (
        <Answering teammate={slotTeammate} phase={{ slot: slot.running }} since={slot.at} />
      ) : waitingFor ? (
        <Answering
          teammate={waitingFor}
          phase={waiting ? 'thinking' : starting ? 'starting' : 'reading'}
          {...(from !== undefined ? { since: from } : {})}
        />
      ) : null}
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
  intro = 'This asks for a secret. Pick a saved one, or add it: your teammate can then use it in this thread without ever seeing it.',
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
          <SelectTrigger aria-label="Secret" className="min-w-0 flex-[1_1_14rem]">
            <SelectValue placeholder={list.length ? 'Choose a secret…' : 'No secrets saved yet'} />
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
          New secret
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

/** What saving a credential of this kind is called on its button. */
const ADD_CREDENTIAL: Record<CredentialKind, string> = {
  api_key: 'Add the key',
  website: 'Add the login',
  database: 'Add the login',
  other: 'Add it',
}

/**
 * A teammate lacks a credential: one row of choices, the form folded away until
 * asked for. Save it to the vault right here, filled in with what the teammate
 * knows, grant one already there, or say something else (onSomethingElse, when
 * the card has nothing else to answer). Either way the teammate gets its mention
 * and carries on with it in this thread.
 */
function CredentialAccess({
  ask,
  askerName,
  onReply,
  onSomethingElse,
}: {
  ask: Extract<Ask, { type: 'access' }>
  askerName: string
  onReply: (reply: AskReply) => void
  onSomethingElse?: (note: string) => void
}) {
  const [mode, setMode] = useState<'choose' | 'new' | 'saved' | 'else'>('choose')
  const [picked, setPicked] = useState('')
  const grant = (mention: string) => onReply({ type: 'access', granted: true, credential: mention })
  const back = () => setMode('choose')
  if (mode === 'new')
    return (
      <CredentialForm
        inline
        draft={ask.credential}
        submitLabel="Save and grant"
        onCancel={back}
        onSaved={(saved) => grant(formatMention(mentionOf(saved)))}
      />
    )
  if (mode === 'saved')
    return (
      <div className="flex flex-col gap-2">
        <CredentialPicker
          value={picked}
          onChange={setPicked}
          disabled={false}
          intro={`Pick a saved secret: ${askerName} can then use it in this thread without ever seeing it.`}
          onNew={() => setMode('new')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!picked} onClick={() => grant(picked)}>
            Grant
          </Button>
          <Button size="sm" variant="ghost" onClick={back}>
            Back
          </Button>
        </div>
      </div>
    )
  if (mode === 'else' && onSomethingElse)
    return <SomethingElseForm disabled={false} onSend={onSomethingElse} onCancel={back} />
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm text-muted-foreground">
        {askerName} uses it in this thread right away and never sees it: it is encrypted the moment
        you save it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setMode('new')}>
          {ADD_CREDENTIAL[ask.credential?.kind ?? 'other']}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMode('saved')}>
          It&apos;s saved
        </Button>
        {onSomethingElse && (
          <Button size="sm" variant="outline" onClick={() => setMode('else')}>
            Something else
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => onReply({ type: 'access', granted: false })}
        >
          Decline
        </Button>
      </div>
    </div>
  )
}

/**
 * Turning down a whole ticket or question: in a menu at the card's top, since each of its
 * asks has its own "no" by its buttons.
 */
function DeclineMenu({
  label,
  disabled,
  onDecline,
  children = 'Decline',
}: {
  label: string
  disabled: boolean
  onDecline: () => void
  children?: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-my-1 -mr-2 flex-none"
          aria-label={label}
          disabled={disabled}
        >
          <EllipsisVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onDecline}>{children}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Something else, in place of what the teammate asked: the person's own words
 * ("use the Cloudflare App instead"), sent as the answer so the teammate stops
 * waiting and does that. Its Decline, with a note.
 */
function SomethingElse({
  disabled,
  onSend,
}: {
  disabled: boolean
  onSend: (note: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Something else
      </Button>
    )
  return <SomethingElseForm disabled={disabled} onSend={onSend} onCancel={() => setOpen(false)} />
}

function SomethingElseForm({
  disabled,
  onSend,
  onCancel,
}: {
  disabled: boolean
  onSend: (note: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const send = () => text.trim() && onSend(text.trim())
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <Textarea
        autoFocus
        rows={2}
        placeholder="What to do instead"
        aria-label="Something else"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={disabled || !text.trim()}>
          Send
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** What a person wrote in place of answering, once sent. */
function SentInstead({ note }: { note: string }) {
  return (
    <p className="mt-3 border-l-2 pl-3 text-sm wrap-anywhere whitespace-pre-wrap text-muted-foreground">
      {note}
    </p>
  )
}

/** A Declined badge, or Replied when the person wrote something else instead. */
const answerBadge = (answer: QuestionAnswer | TicketAnswer) =>
  answer.action === 'declined'
    ? answer.note
      ? { tone: 'success' as const, label: 'Replied' }
      : { tone: 'warning' as const, label: 'Declined' }
    : { tone: 'success' as const, label: 'Answered' }

/** The harness asks a person something: options, a free answer, or a decline. */
export function QuestionCard({
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
      {item.questions.map((q, i) => {
        const optionId = (o: { id: string }) => `${item.questionId}-${q.id}-${o.id}`
        const question = (
          <div className="min-w-0 flex-1 font-semibold">
            {q.header && <span className="text-muted-foreground">{q.header}: </span>}
            {/* The first paragraph stays on the header's line. */}
            <Markdown text={q.question} className="inline [&>p:first-child]:inline" />
          </div>
        )
        return (
          <div key={q.id} className="flex flex-col gap-3">
            {i === 0 ? (
              // The first question heads the card, with its answer or its Decline.
              <div className="flex items-start gap-2">
                <CircleHelp aria-hidden className="mt-0.5 size-4 flex-none text-primary" />
                {question}
                {item.answer ? (
                  <StatusBadge status={item.answer.action} {...answerBadge(item.answer)} />
                ) : (
                  canAnswer && (
                    <DeclineMenu
                      label="Question options"
                      disabled={busy}
                      onDecline={() => void send({ action: 'declined' })}
                    />
                  )
                )}
              </div>
            ) : (
              question
            )}
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
      {item.answer ? (
        item.answer.action === 'declined' &&
        item.answer.note && <SentInstead note={item.answer.note} />
      ) : canAnswer ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !complete}
              onClick={() => void send({ action: 'answered', answers })}
            >
              Answer
            </Button>
            {error && <span className="text-sm text-destructive-text">{error}</span>}
          </div>
          <SomethingElse
            disabled={busy}
            onSend={(note) => void send({ action: 'declined', note })}
          />
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

/** Taking over the workspace computer from a ticket, for an ask done in the teammate's browser. */
export type TicketTakeover = {
  /** This member already has control. */
  mine: boolean
  /** Take control, unless already theirs, and show the desktop, where the teammate's browser is. */
  open: () => Promise<void>
}

/**
 * Something to do in the teammate's browser, such as a "verify you are human"
 * check: take over from the ticket, do it, answer. Answering hands control back.
 */
function BrowserAction({
  askerName,
  takeover,
  onReply,
}: {
  askerName: string
  takeover: TicketTakeover
  onReply: (reply: AskReply) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function open() {
    setBusy(true)
    setError(undefined)
    try {
      await takeover.open()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {takeover.mine
          ? `You have control. Do it in ${askerName}'s browser on the desktop, then answer here: control goes back to ${askerName} with your answer.`
          : `${askerName} left the page open in its browser and waits. Take over to do it there.`}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {takeover.mine ? (
          <>
            <Button size="sm" onClick={() => onReply({ type: 'action', done: true })}>
              Done, hand back
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>
              <Monitor aria-hidden />
              Show computer
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy} onClick={() => void open()}>
              <Hand aria-hidden />
              Take over {askerName}&apos;s browser
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReply({ type: 'action', done: true })}
            >
              Done
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => onReply({ type: 'action', done: false })}>
          Can&apos;t do it
        </Button>
      </div>
      {error && <p className="text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

/**
 * A ticket the teammate opened: one or more asks, each answered with its own
 * buttons. The teammate waits; the answers go to it once every ask has one,
 * kept in this browser until then (useTicketReplies).
 */
export function TicketCard({
  item,
  canAnswer,
  takeover,
  teammates,
  askerId,
  askerName,
  onAnswer,
}: {
  item: Extract<Item, { kind: 'ticket' }>
  canAnswer: boolean
  takeover: TicketTakeover | undefined
  teammates: { id: string; name: string }[]
  askerId: string | undefined
  askerName: string
  onAnswer: (answer: TicketAnswer) => Promise<void>
}) {
  const done = Boolean(item.answer)
  const [replies, setReplies, forget] = useTicketReplies(item.requestId, item.asks, done)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function send(answer: TicketAnswer) {
    setBusy(true)
    setError(undefined)
    try {
      await onAnswer(answer)
      forget()
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
  const undo = (askId: string) => {
    const { [askId]: _, ...rest } = replies
    setReplies(rest)
  }

  const answered = item.answer?.action === 'answered' ? item.answer.replies : undefined
  const disabled = !canAnswer || busy || done
  const soleAccess = item.asks.length === 1 && item.asks[0]!.type === 'access'
  // A lone credential ask has Something else among its own buttons.
  const sole = item.asks.length === 1 ? item.asks[0]! : undefined
  const elseInline = sole?.type === 'access' && sole.kind === 'credential' && !sole.app
  const somethingElse = (note: string) => void send({ action: 'declined', note })

  const several = item.asks.length > 1
  const count = Object.keys(answered ?? replies).length
  // Some asks answered, not all: nothing has gone to the teammate yet, access included.
  const partly = several && !done && count > 0 && count < item.asks.length
  const granting = Object.values(replies).some((r) => r.type === 'access' && r.granted)

  return (
    <Card className="gap-0 border-primary/40 px-5 py-4">
      <div className="flex items-start gap-2">
        <ClipboardList aria-hidden className="mt-0.5 size-4 flex-none text-primary" />
        <div className="min-w-0 flex-1 font-semibold">{item.title}</div>
        {item.answer ? (
          <StatusBadge status={item.answer.action} {...answerBadge(item.answer)} />
        ) : (
          <>
            {several && (
              <span className="flex-none pt-0.5 text-xs text-muted-foreground tabular-nums">
                {count}/{item.asks.length}
              </span>
            )}
            {/* A single access ask has a Decline of its own: no second one in a menu. */}
            {canAnswer && !soleAccess && (
              <DeclineMenu
                label="Ticket options"
                disabled={busy}
                onDecline={() => void send({ action: 'declined' })}
              >
                Decline ticket
              </DeclineMenu>
            )}
          </>
        )}
      </div>
      {item.asks.map((ask, i) => (
        <div
          key={ask.id}
          className={cn('flex flex-col gap-2.5', i === 0 ? 'mt-3' : 'mt-3 border-t pt-3')}
        >
          <AskView
            ask={ask}
            reply={answered?.[ask.id] ?? replies[ask.id]}
            disabled={disabled}
            takeover={takeover}
            teammates={teammates}
            askerId={askerId}
            askerName={askerName}
            onReply={(value) => reply(ask.id, value)}
            onUndo={done || busy ? undefined : () => undo(ask.id)}
            onSomethingElse={elseInline && canAnswer ? somethingElse : undefined}
          />
        </div>
      ))}
      {partly && (
        <p className="mt-3 text-sm text-muted-foreground">
          {granting
            ? `${askerName} gets the access and your answers when every ask is answered.`
            : `Your answers go to ${askerName} when every ask is answered.`}
        </p>
      )}
      {item.answer?.action === 'declined' && item.answer.note && (
        <SentInstead note={item.answer.note} />
      )}
      {!done && canAnswer && !elseInline && (
        <div className="mt-3 flex flex-col">
          <SomethingElse disabled={busy} onSend={somethingElse} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-destructive-text">{error}</p>}
      {!done && !canAnswer && (
        <p className="mt-3 text-sm text-muted-foreground">
          Only the member who started this thread can answer.
        </p>
      )}
    </Card>
  )
}

/** Whether a reply gives the teammate what it asked for, or leaves it without. */
function replyTone(ask: Ask, reply: AskReply): 'success' | 'warning' {
  return (reply.type === 'approval' && !reply.approved) ||
    (reply.type === 'decision' &&
      !('options' in ask && ask.options) &&
      reply.optionId === 'decline') ||
    (reply.type === 'access' && !reply.granted) ||
    (reply.type === 'action' && !reply.done) ||
    (reply.type === 'variables' && reply.set.length === 0)
    ? 'warning'
    : 'success'
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
    case 'variables':
      return reply.skipped.length
        ? `Set ${reply.set.length}, skipped ${reply.skipped.length}`
        : `Set ${reply.set.length === 1 ? reply.set[0] : `${reply.set.length} variables`}`
  }
}

function AskView({
  ask,
  reply,
  disabled,
  takeover,
  teammates,
  askerId,
  askerName,
  onReply,
  onUndo,
  onSomethingElse,
}: {
  ask: Ask
  reply: AskReply | undefined
  disabled: boolean
  takeover: TicketTakeover | undefined
  teammates: { id: string; name: string }[]
  askerId: string | undefined
  askerName: string
  onReply: (reply: AskReply) => void
  onUndo: (() => void) | undefined
  /** Something else from the ask's own buttons, rather than below the card's asks. */
  onSomethingElse?: (note: string) => void
}) {
  const [showDraft, setShowDraft] = useState(true)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sendTo, setSendTo] = useState(askerId ?? '')

  const heading =
    ask.type === 'approval' || ask.type === 'action'
      ? ask.title
      : ask.type === 'access'
        ? ask.app?.repository
          ? `Access to ${ask.app.repository} on GitHub`
          : `Access to ${ask.app ? (APP_NAMES[ask.app.kind] ?? ask.what) : ask.what}`
        : ask.type === 'variables'
          ? `Values for the preview of ${ask.repository}`
          : ask.question
  // Answered: one line, so what is still to do stands out.
  if (reply)
    return (
      <div className="flex min-w-0 items-start gap-2 text-sm">
        {replyTone(ask, reply) === 'success' ? (
          <CircleCheck className="mt-0.5 size-4 flex-none text-success" aria-hidden />
        ) : (
          <CircleX className="mt-0.5 size-4 flex-none text-warning" aria-hidden />
        )}
        <div className="min-w-0 flex-1 text-muted-foreground">
          <Markdown text={heading} className="inline [&>p]:inline" />
          <span aria-hidden> · </span>
          <span>{replyLabel(ask, reply, teammates)}</span>
        </div>
        {onUndo && (
          <Button variant="link" size="sm" className="h-auto flex-none p-0" onClick={onUndo}>
            Change
          </Button>
        )}
      </div>
    )

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <CopyableCode>
          <Markdown text={heading} className="font-medium" />
        </CopyableCode>
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
        // Plain numbers: the text stays selectable and its links open.
        <CopyableCode>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:text-muted-foreground">
            {ask.steps.map((step, i) => (
              <li key={i} className="pl-1">
                <Markdown text={step} className="leading-snug" />
              </li>
            ))}
          </ol>
        </CopyableCode>
      ) : null}

      {disabled ? null : ask.type === 'approval' ? (
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
                tooltip={o.description}
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
                variant="ghost"
                onClick={() => onReply({ type: 'decision', optionId: 'decline' })}
              >
                Decline
              </Button>
            </>
          )}
        </div>
      ) : ask.type === 'variables' ? (
        <VariablesAsk ask={ask} askerName={askerName} onReply={onReply} />
      ) : ask.type === 'access' && ask.app ? (
        <AppAccessAsk ask={{ ...ask, app: ask.app }} askerName={askerName} onReply={onReply} />
      ) : ask.type === 'access' && ask.kind === 'credential' ? (
        <CredentialAccess
          ask={ask}
          askerName={askerName}
          onReply={onReply}
          onSomethingElse={onSomethingElse}
        />
      ) : ask.type === 'access' ? (
        // A connection asked for in words: given by hand on the Apps page.
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => onReply({ type: 'access', granted: true })}>
            I&apos;ve given access
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href="/app/connections" target="_blank" rel="noreferrer">
              Open Apps →
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onReply({ type: 'access', granted: false })}
          >
            Decline
          </Button>
        </div>
      ) : ask.type === 'action' && ask.browser && takeover ? (
        <BrowserAction askerName={askerName} takeover={takeover} onReply={onReply} />
      ) : ask.type === 'action' ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onReply({ type: 'action', done: true })}>
            Done
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
        <Button size="sm" className="self-start" onClick={() => setOpen(true)}>
          Provide details
        </Button>
      )}
    </>
  )
}

/**
 * Alternatives a teammate offers: a card each, with the design's picture when
 * the option is one (it opens beside the thread). Picking sends the choice as a
 * message; any message after it closes the offer.
 */
function ChoicesCard({
  choices,
  reply,
  onChoose,
}: {
  choices: Choices
  /** The next message in the thread, if there is one. */
  reply?: string
  onChoose?: (text: string, pick?: string) => Promise<void>
}) {
  const links = useFileLinks()
  const designs = choices.options.some((o) => o.design)
  const library = useApi<LibraryFile[]>(designs ? '/library' : null)
  const [sending, setSending] = useState<string>()
  const [error, setError] = useState<string>()
  const picked = reply === undefined ? undefined : pickedChoice(choices.options, reply)
  const open = reply === undefined && !!onChoose && !sending

  async function choose(option: Choices['options'][number]) {
    if (!onChoose) return
    setSending(option.id)
    setError(undefined)
    try {
      // A design from an options folder becomes the design: the message says where.
      const design = option.design?.replace(/\/+$/, '')
      const options = design && designOptionsOf(design)
      if (options) await onChoose(choiceMessage(option, pickedDesignPath(options)), design)
      else await onChoose(choiceMessage(option))
    } catch (e) {
      setError((e as Error).message)
      setSending(undefined)
    }
  }

  return (
    <Card className="gap-4 border-primary/40 px-5 py-4">
      <div className="flex items-start gap-2">
        <LayoutTemplate aria-hidden className="mt-0.5 size-4 flex-none text-primary" />
        <div className="min-w-0 flex-1 font-semibold">
          <Markdown text={choices.question} className="[&>p]:inline" />
        </div>
        {reply !== undefined && (
          <StatusBadge
            status={picked ? 'answered' : 'replied'}
            tone={picked ? 'success' : 'neutral'}
            label={picked ? 'Picked' : 'Replied'}
          />
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {choices.options.map((o) => {
          const offered = o.design?.replace(/\/+$/, '')
          const chosen = picked?.id === o.id || sending === o.id
          // Once picked, an option from an options folder is copied to the design, which it opens;
          // every option keeps its picture. Picks from before moved the option there and trashed the rest.
          const options = offered && designOptionsOf(offered)
          const made = options && picked?.id === o.id ? pickedDesignPath(options) : undefined
          const has = (folder?: string) =>
            !!folder && !!library.data?.some((f) => f.path.startsWith(`${folder}/`))
          const design = made && has(made) ? made : offered
          const thumbnail = [offered, made]
            .map((d) => d && library.data?.find((f) => f.path === `${d}/${DESIGN_THUMBNAIL}`))
            .find(Boolean)
          const trashed = !!options && !!picked && !!library.data && !has(offered) && !has(made)
          return (
            <li
              key={o.id}
              className={cn(
                'flex flex-col overflow-hidden rounded-lg border bg-card',
                chosen && 'border-primary ring-2 ring-primary/30',
                picked && !chosen && 'opacity-60',
              )}
            >
              {design && trashed && (
                <span className="flex aspect-[16/10] items-center justify-center border-b bg-muted/50 text-xs text-muted-foreground">
                  In the trash
                </span>
              )}
              {design && !trashed && (
                <Hint label={`Open ${design}`}>
                  <button
                    type="button"
                    className="group relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/50"
                    aria-label={`Open ${o.label}`}
                    onClick={() => links?.open({ path: design })}
                  >
                    {thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a library file through the API
                      <img
                        src={contentUrl(thumbnail.id)}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover object-top transition group-hover:scale-[1.02]"
                      />
                    ) : (
                      <LayoutTemplate aria-hidden className="size-7 text-muted-foreground/60" />
                    )}
                    <span className="absolute right-2 bottom-2 rounded-full bg-background/85 px-2.5 py-1 text-xs font-semibold backdrop-blur-sm">
                      Open
                    </span>
                  </button>
                </Hint>
              )}
              <div className="flex flex-1 flex-col gap-1 px-3.5 py-3">
                <span className="font-semibold">{o.label}</span>
                {o.description && (
                  <span className="text-sm text-muted-foreground">{o.description}</span>
                )}
                {open && (
                  <div className="mt-auto pt-2">
                    <Button size="sm" variant="outline" onClick={() => void choose(o)}>
                      Pick this one
                    </Button>
                  </div>
                )}
                {sending === o.id && !picked && (
                  <span className="mt-2 text-sm text-muted-foreground">Sending…</span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {open && (
        <p className="text-xs text-muted-foreground">
          Or write what you want instead: mix two, or change one.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </Card>
  )
}

/** What a teammate's preview button needs from the thread: whether one runs, and starting it. */
export type ReplyPreview = {
  /** One starts or runs: the button steps aside, Preview and its panel show it. */
  live: boolean
  /** It is being started, from this button or Preview. */
  busy: boolean
  /** As Preview starts it; `words` go to the teammate when the runner cannot start it alone. */
  start: (words: string) => void
}

/** Answers a teammate suggested under its reply: a click sends one as the person's message. */
function SuggestedReplyButtons({
  replies,
  pull,
  preview,
  onSend,
}: {
  replies: SuggestedReplies
  /** The pull request opened last in the thread: what a merge button merges. */
  pull: { repository: string; number: number } | null
  /** The thread's preview: what a preview button starts. */
  preview?: ReplyPreview
  onSend: (text: string) => Promise<void>
}) {
  const [sending, setSending] = useState<string>()
  const [error, setError] = useState<string>()

  async function send(reply: string) {
    setSending(reply)
    setError(undefined)
    try {
      await onSend(reply)
    } catch (e) {
      setError((e as Error).message)
      setSending(undefined)
    }
  }

  return (
    <div className="flex flex-col -mt-2 gap-1.5 pl-11">
      <div className="flex flex-wrap gap-2">
        {replies.actions?.map((a) =>
          a.action === 'merge'
            ? pull && (
                <PullMergeButton
                  key={`${a.action}:${a.label}`}
                  repository={pull.repository}
                  number={pull.number}
                  label={a.label}
                />
              )
            : preview &&
              !preview.live && (
                <Button
                  key={`${a.action}:${a.label}`}
                  type="button"
                  size="sm"
                  className="rounded-full"
                  disabled={preview.busy || sending !== undefined}
                  onClick={() => preview.start(a.label)}
                >
                  {preview.busy ? (
                    <LoaderCircle aria-hidden className="animate-spin" />
                  ) : (
                    <Globe aria-hidden />
                  )}
                  {a.label}
                </Button>
              ),
        )}
        {replies.replies.map((reply) => (
          <Button
            key={reply}
            type="button"
            size="sm"
            variant="outline"
            className="rounded-full"
            disabled={sending !== undefined}
            onClick={() => void send(reply)}
          >
            {reply}
          </Button>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
