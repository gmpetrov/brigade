// The sample workspace's playbook (seed-workspace.ts calls it once, when it makes Acme). Sam runs
// Support and bugs (brigade/support-bugs) on Ada's accounts, installed from a chat with Chief 24
// days ago after a dry run of five past mails. Its runs since fill its sheet and its numbers:
// each triage case and outcome, people stepping in, first responses, a bug fixed by a child
// thread two other runs followed, a run Ada joined (so it is in the sidebar), writes done on
// their own (one marked as wrong) and a weekly review. Waiting now: three replies and a merge,
// one "Support and bugs · 4 to approve" item, and the proposal to let it reply on its own.
//
// Rows are written as the API writes them (its own functions where they need no network):
// threads and their events as the runner sends them, calls and tickets as connector-calls.ts
// records them. Nothing reaches Gmail or GitHub: no runner answers in a preview, the Gmail
// account's secret is a placeholder and the GitHub account has none.
import { randomBytes, randomUUID } from 'node:crypto'
import {
  batchNote,
  childPrompt,
  DRY_RUN_HEAD,
  followNote,
  nextRun,
  type AgentEvent,
  type ChildReport,
} from '@brigade/contracts'
import { triggersOf } from '../src/connectors/index.js'
import { prisma, scoped, type Prisma } from '../src/db.js'
import { proposePromotion } from '../src/playbook-autonomy.js'
import { dryRunView } from '../src/playbook-dry-runs.js'
import {
  activatePlaybook,
  createInstallation,
  entryOptions,
  fill,
  templates,
} from '../src/playbooks.js'
import { createSchedule, localTime, memberTimezone } from '../src/schedules.js'
import { savePack } from '../src/skills.js'
import { eventMessage } from '../src/triggers.js'

/** What the sample workspace gives the playbook: who, where, and the accounts it uses. */
export type PlaybookSeed = {
  organizationId: string
  workspaceId: string
  ada: { memberId: string; userId: string }
  bob: { memberId: string }
  chief: { id: string; name: string }
  sam: { id: string; name: string }
  computerId: string
  /** Ada's Claude account: the playbook runs on her subscription. */
  accountId: string
  /** The support inbox, support@acme.test, already granted to Sam. */
  gmail: { id: string; label: string; externalAccount: string | null }
  stripeId: string
  /** The Support project, where the playbook is installed. */
  projectId: string
  /** The sample repository, where bugs are fixed. */
  repository: string
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(Date.now() - ms)
const id = () => randomBytes(8).toString('hex')
/** A Gmail message or thread id. */
const gmailId = () => `19${randomBytes(7).toString('hex')}`
const harness = (name: string) => `mcp__harness-tools__${name}`

const KEY = 'brigade/support-bugs'
const SUPPORT = 'support@acme.test'
const DOCS = 'https://docs.acme.test'
const SIGNATURE = 'The Acme team'
/** A reply in the playbook's voice: a greeting, its paragraphs, its signature. */
const letter = (first: string, ...paragraphs: string[]) =>
  [`Hi ${first},`, ...paragraphs, SIGNATURE].join('\n\n')

/** The Gmail labels Sam sorts mail with, as gmail_list_labels lists them. */
const LABELS = {
  bug: { id: 'Label_11', name: 'Support/Bug' },
  idea: { id: 'Label_12', name: 'Support/Idea' },
  escalated: { id: 'Label_13', name: 'Support/Escalated' },
  noise: { id: 'Label_14', name: 'Support/Noise' },
}
type LabelKey = keyof typeof LABELS

/** An event as the runner sends it, without its time: a thread's timeline gives it one. */
type Draft = {
  [T in AgentEvent['type']]: Omit<Extract<AgentEvent, { type: T }>, 'at'>
}[AgentEvent['type']]

type Status = 'idle' | 'running' | 'waiting' | 'failed'

/** A mail to support@acme.test, as Gmail's trigger hands it over. */
type Mail = {
  id: string
  threadId: string
  from: string
  first: string
  email: string
  subject: string
  body: string
  at: Date
}

/** "Priya Natarajan <priya@northwind.test>" and what is needed of it. */
function mail(from: string, subject: string, body: string, at: Date, threadId?: string): Mail {
  const email = from.match(/<(.+)>/)?.[1] ?? from
  const messageId = gmailId()
  return {
    id: messageId,
    threadId: threadId ?? messageId,
    from,
    first: from.split(' ')[0]!,
    email,
    subject,
    body,
    at,
  }
}

const re = (subject: string) => (subject.startsWith('Re: ') ? subject : `Re: ${subject}`)
const rfc2822 = (date: Date) => date.toUTCString().replace('GMT', '+0000')

/** Events in order, each at its own time: a few seconds apart, or longer while a person decides. */
class Timeline {
  readonly events: { draft: Draft; at: Date }[] = []
  private t: number

  constructor(
    start: Date,
    readonly teammateId: string,
    private readonly accountId: string,
  ) {
    this.t = start.getTime()
  }

  get now() {
    return new Date(this.t)
  }

  /** Time passes: a person deciding, the next mail, a fix. */
  wait(ms: number) {
    this.t += ms
  }

  /** On to a later moment, such as a child's report. */
  until(at: Date) {
    this.t = Math.max(this.t, at.getTime())
  }

  push(draft: Draft, gap = 20_000) {
    this.events.push({ draft, at: new Date(this.t) })
    this.t += gap
  }

  user(text: string, memberId: string | null) {
    this.push({ type: 'message.user', text, memberId }, 3_000)
  }

  start() {
    this.push(
      {
        type: 'turn.started',
        teammateId: this.teammateId,
        accountId: this.accountId,
        turnId: id(),
      },
      8_000,
    )
  }

  /** A tool call, started now; `finished` gives its result. Returns its id. */
  started(toolName: string, input: unknown) {
    const toolCallId = `call_${id()}`
    this.push(
      { type: 'tool.started', toolCallId, toolName, input, teammateId: this.teammateId },
      2_000,
    )
    return toolCallId
  }

  finished(toolCallId: string, toolName: string, output: unknown, isError = false, gap = 15_000) {
    this.push(
      {
        type: 'tool.finished',
        toolCallId,
        toolName,
        output,
        isError,
        teammateId: this.teammateId,
      },
      gap,
    )
  }

  tool(toolName: string, input: unknown, output: unknown, takes = 4_000) {
    const toolCallId = this.started(toolName, input)
    this.wait(takes)
    this.finished(toolCallId, toolName, output)
  }

  file(path: string) {
    this.push({ type: 'file.changed', path, toolName: 'Edit', teammateId: this.teammateId }, 25_000)
  }

  say(text: string) {
    this.push({ type: 'message.done', id: id(), text, teammateId: this.teammateId }, 2_000)
  }

  end() {
    this.push({ type: 'turn.completed', finishReason: 'stop', teammateId: this.teammateId }, 0)
  }
}

/** A person's decision on an approval: who, how long after it was asked, and how. */
type Decision = {
  by: string
  after: number
  denied?: string
  /** Approved with others at once from the playbook's group: it does not count toward trust. */
  bulk?: boolean
}

export async function seedPlaybooks(input: PlaybookSeed) {
  const { organizationId, workspaceId, ada, bob, sam, chief } = input
  const inWorkspace = { organizationId, workspaceId }
  const scope = { organizationId, workspaceId }
  const db = scoped(scope)
  const template = templates().get(KEY)
  if (!template) throw new Error(`No playbook template ${KEY}`)
  const manifest = template.manifest

  // -------------------------------------------------------------------------
  // GitHub: the account the fixes go through, granted to Sam. It has no credential, so
  // nothing in a preview calls GitHub with it (git.ts and the pull requests skip it).
  // -------------------------------------------------------------------------
  const githubApp = await prisma.app.create({
    data: {
      ...inWorkspace,
      key: 'github',
      createdByMemberId: ada.memberId,
      createdAt: ago(25 * DAY),
    },
  })
  const github = await prisma.connection.create({
    data: {
      ...inWorkspace,
      appId: githubApp.id,
      kind: 'github',
      label: 'GitHub',
      externalAccount: input.repository.split('/')[0]!,
      createdByMemberId: ada.memberId,
      createdAt: ago(25 * DAY),
    },
  })
  await prisma.grant.create({
    data: { ...inWorkspace, teammateId: sam.id, connectionId: github.id, scope: 'read_write' },
  })
  const inbox = input.gmail.externalAccount ?? input.gmail.label

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------
  type ThreadRow = {
    id: string
    title: string
    teammateId: string
    status: Status
    origin: 'member' | 'trigger' | 'schedule' | 'child'
    createdAt: Date
    triggerId?: string
    scheduleId?: string
    conversationKey?: string
    playbookRunId?: string
    surfacedAt?: Date | null
    parentId?: string
    parentTeammateId?: string
    awaited?: boolean
    report?: ChildReport
    reportDeliveredAt?: Date
  }
  const createThread = (row: ThreadRow) => {
    const { report, ...rest } = row
    return prisma.session.create({
      data: {
        ...inWorkspace,
        ...rest,
        ...(report ? { report: report as Prisma.InputJsonValue } : {}),
        startedByMemberId: ada.memberId,
        computerId: input.computerId,
        accountId: input.accountId,
        projectId: input.projectId,
        updatedAt: row.createdAt,
      },
    })
  }
  const writeEvents = async (sessionId: string, timeline: Timeline) => {
    const { events } = timeline
    const last = events.at(-1)!.at
    await prisma.sessionEvent.createMany({
      data: events.map(({ draft, at }, i) => ({
        ...inWorkspace,
        sessionId,
        seq: i + 1,
        type: draft.type,
        data: { ...draft, at: at.toISOString() } as Prisma.InputJsonValue,
        at,
      })),
    })
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastSeq: events.length, updatedAt: last },
    })
    await prisma.threadTeammate.create({
      data: {
        ...inWorkspace,
        sessionId,
        teammateId: timeline.teammateId,
        joinedAt: events[0]!.at,
        lastTurnAt: last,
      },
    })
  }

  // -------------------------------------------------------------------------
  // Installed from a chat with Chief: its settings, its parts, a dry run, then activated
  // -------------------------------------------------------------------------
  const installed = ago(24 * DAY + 4 * HOUR)
  const chat = await createThread({
    id: randomUUID(),
    title: 'Install the support playbook',
    teammateId: chief.id,
    status: 'idle',
    origin: 'member',
    createdAt: installed,
  })
  const installer = { ...scope, memberId: ada.memberId }
  const installation = await createInstallation(db, installer, {
    template,
    teammateId: sam.id,
    projectId: input.projectId,
    settings: {
      product: 'Acme',
      inbox,
      address: SUPPORT,
      docs: DOCS,
      repo: input.repository,
      signature: SIGNATURE,
    },
  })
  const installationId = installation.id
  const settings = installation.settings as Record<string, string | number>

  // Its parts, as buildParts makes them, without subscribing Gmail: that would call Google.
  await prisma.playbookAction.createMany({
    data: manifest.actions.map((a) => ({
      ...inWorkspace,
      installationId,
      key: a.key,
      level: a.start,
    })),
  })
  const actor = { type: 'member' as const, id: ada.memberId }
  const pack = await savePack(db, scope, actor, {
    name: manifest.name,
    source: `playbook:${installationId}`,
    everywhere: true,
    teammateIds: [],
    projectIds: [],
    skills: template.skills.map((s) => ({
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      files: [],
      enabled: true,
    })),
  })
  await prisma.skillPack.update({
    where: { id: pack.id },
    data: { playbookInstallationId: installationId, createdAt: installed },
  })
  await prisma.skill.updateMany({ where: { packId: pack.id }, data: { createdAt: installed } })
  let triggerId = ''
  let scheduleId = ''
  for (const entry of manifest.entries) {
    if ('trigger' in entry) {
      const [kind, event] = entry.trigger.split('.') as ['gmail', string]
      const trigger = await prisma.trigger.create({
        data: {
          ...inWorkspace,
          connectionId: fill(entry.account, settings),
          teammateId: sam.id,
          label: entry.label ?? `${manifest.name}: ${triggersOf(kind)[event]!.label}`,
          event,
          options: entryOptions(entry, settings),
          createdByMemberId: ada.memberId,
          projectId: input.projectId,
          playbookInstallationId: installationId,
          createdAt: installed,
        },
      })
      triggerId = trigger.id
    } else {
      const schedule = await createSchedule(
        db,
        scope,
        {
          teammateId: sam.id,
          title: entry.title ?? manifest.name,
          instructions: fill(entry.instructions, settings),
          cron: entry.schedule,
          timezone: entry.timezone ?? (await memberTimezone(db, ada.memberId)),
          projectId: input.projectId,
        },
        { memberId: ada.memberId },
      )
      await prisma.schedule.update({
        where: { id: schedule.id },
        data: {
          playbookInstallationId: installationId,
          pausedAt: installed,
          nextRunAt: null,
          createdAt: installed,
        },
      })
      scheduleId = schedule.id
    }
  }
  const trigger = await prisma.trigger.findUniqueOrThrow({ where: { id: triggerId } })
  const schedule = await prisma.schedule.findUniqueOrThrow({ where: { id: scheduleId } })
  const emailReceived = triggersOf('gmail').email_received!
  const gmailConnection = { externalAccount: input.gmail.externalAccount, label: input.gmail.label }

  /** A mail as the inbox reader hands it to the trigger (ReceivedEmail). */
  const payloadOf = (m: Mail) => ({
    id: m.id,
    threadId: m.threadId,
    from: m.from,
    to: SUPPORT,
    subject: m.subject,
    date: rfc2822(m.at),
    snippet: m.body.replace(/\s+/g, ' ').slice(0, 120),
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    body: m.body,
    attachments: [],
    rfcMessageId: `<${m.id}@mail.${m.email.split('@')[1]}>`,
  })
  /** A mail's first message in its thread, as the trigger starts it: a few lines, then the raw (untrusted) event. */
  const received = (m: Mail) =>
    eventMessage(
      trigger,
      emailReceived,
      gmailConnection,
      { id: m.id, type: 'email', payload: payloadOf(m) },
      new Date(m.at.getTime() + 40_000).toISOString(),
    )

  // -------------------------------------------------------------------------
  // What a run's thread does, and what it leaves: connector calls, tickets, the run's numbers
  // -------------------------------------------------------------------------
  const calls: Prisma.ConnectionCallCreateManyInput[] = []
  const tickets: Prisma.TicketCreateManyInput[] = []
  const tasks: Prisma.TaskCreateManyInput[] = []
  /** People's decisions on the reply action, newest last: the latest one earns the proposal. */
  const replyDecisions: { at: Date; sessionId: string; counted: boolean }[] = []

  type Call = {
    connectionId: string
    operation: string
    write: boolean
    target: string
    result: string
    at: Date
    actionKey?: string
    ticketId?: string
    error?: string
    simulated?: boolean
    input?: unknown
    id?: string
  }

  /** A thread of the playbook: its timeline, and what its calls and tickets leave behind. */
  class PlaybookThread {
    readonly id = randomUUID()
    readonly tl: Timeline
    status: Status = 'idle'
    /** Times a person stepped in: a decision on its tickets, a member's message. */
    interventions = 0
    firstResponseAt: Date | null = null

    constructor(
      start: Date,
      readonly runId: string,
      readonly dryRun = false,
    ) {
      this.tl = new Timeline(start, sam.id, input.accountId)
    }

    record(call: Call) {
      calls.push({
        ...inWorkspace,
        ...(call.id ? { id: call.id } : {}),
        sessionId: this.id,
        connectionId: call.connectionId,
        teammateId: sam.id,
        operation: call.operation,
        write: call.write,
        target: call.target,
        result: call.result,
        ...(call.actionKey ? { playbookActionKey: call.actionKey } : {}),
        ...(call.ticketId ? { ticketId: call.ticketId } : {}),
        ...(call.error ? { error: call.error } : {}),
        ...(call.simulated ? { simulated: true } : {}),
        ...(call.input !== undefined ? { input: call.input as Prisma.InputJsonValue } : {}),
        createdAt: call.at,
      })
    }

    /** A read through an App: it goes through, in a dry run too. */
    read(connectionId: string, operation: string, input: unknown, target: string, output: unknown) {
      this.tl.tool(harness(operation), input, output, 3_000)
      this.record({ connectionId, operation, write: false, target, result: 'ok', at: this.tl.now })
    }

    /**
     * A write of the playbook's actions done on its own: in a dry run, recorded with what it would
     * have sent and answered with a fake success; live, with only its numbers kept.
     */
    auto(
      connectionId: string,
      operation: string,
      actionKey: string,
      input: unknown,
      target: string,
      output: unknown,
      callId?: string,
    ) {
      const toolName = harness(operation)
      const toolCallId = this.tl.started(toolName, input)
      this.tl.wait(3_000)
      const at = this.tl.now
      this.tl.finished(
        toolCallId,
        toolName,
        this.dryRun
          ? {
              simulated: true,
              id: `dry-run-${toolCallId}`,
              note: `Dry run: ${operation} (${target}) was recorded for the report and not sent. Carry on as if it went through.`,
            }
          : output,
      )
      this.record({
        id: callId,
        connectionId,
        operation,
        write: true,
        target,
        result: 'ok',
        at,
        actionKey,
        ...(this.dryRun ? { simulated: true, input } : { input: {} }),
      })
    }

    /**
     * A write that asks a person first: its approval ticket, then the decision (approved or
     * denied after a while), or still waiting. Returns whether it went through.
     */
    ask(
      connection: { id: string; account: string },
      operation: string,
      actionKey: string,
      input: unknown,
      target: string,
      output: unknown,
      decision: Decision | 'pending',
    ) {
      const toolName = harness(operation)
      const ticketId = randomUUID()
      const toolCallId = this.tl.started(toolName, input)
      const asked = this.tl.now
      this.tl.push(
        {
          type: 'approval.requested',
          approvalId: ticketId,
          toolCallId,
          toolName,
          input,
          teammateId: sam.id,
        },
        0,
      )
      const ticket = {
        ...inWorkspace,
        id: ticketId,
        sessionId: this.id,
        type: 'approval' as const,
        title: `${sam.name}: ${operation.replace(/_/g, ' ')} (${target})`,
        createdAt: asked,
      }
      const payload = {
        connectionId: connection.id,
        connection: connection.account,
        operation,
        target,
        input,
        playbookInstallationId: installationId,
        playbookActionKey: actionKey,
        playbookRunId: this.runId,
      }
      if (decision === 'pending') {
        tickets.push({ ...ticket, payload: payload as Prisma.InputJsonValue })
        this.status = 'waiting'
        return false
      }
      this.tl.wait(decision.after)
      const at = this.tl.now
      const approved = !decision.denied
      this.tl.push(
        {
          type: 'approval.resolved',
          approvalId: ticketId,
          approved,
          memberId: decision.by,
          teammateId: sam.id,
        },
        approved ? 3_000 : 1_000,
      )
      tickets.push({
        ...ticket,
        status: approved ? 'approved' : 'denied',
        payload: (decision.bulk
          ? { ...payload, decidedInBulk: true }
          : payload) as Prisma.InputJsonValue,
        resolvedByMemberId: decision.by,
        resolvedAt: at,
      })
      this.interventions++
      if (actionKey === 'reply')
        replyDecisions.push({ at, sessionId: this.id, counted: !decision.bulk })
      const sent = this.tl.now
      this.tl.finished(
        toolCallId,
        toolName,
        approved ? output : `A person denied this: ${decision.denied}`,
        !approved,
      )
      this.record({
        connectionId: connection.id,
        operation,
        write: true,
        target,
        result: approved ? 'ok' : 'denied',
        at: sent,
        actionKey,
        ticketId,
        ...(approved ? {} : { error: decision.denied }),
      })
      return approved
    }

    /** Its case, once sorted, before its first write. */
    triage(kase: string) {
      this.tl.tool(
        harness('playbook_triage'),
        { case: kase },
        {
          recorded: { case: kase },
          note: 'Recorded on the run: from now on its writes are judged by this case. Go on with the recipe; playbook_report may still change the case at the end.',
        },
        1_000,
      )
    }

    /** Sorted into Gmail: listed labels first, then its own, archived when it is noise. */
    label(m: Mail, key: LabelKey, callId?: string) {
      const label = LABELS[key]
      this.read(input.gmail.id, 'gmail_list_labels', {}, 'labels', {
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
          ...Object.values(LABELS).map((l) => ({ ...l, type: 'user' })),
        ],
      })
      const archive = key === 'noise'
      const args = {
        messageId: m.id,
        addLabelIds: [label.id],
        removeLabelIds: archive ? ['INBOX', 'UNREAD'] : [],
      }
      this.auto(
        input.gmail.id,
        'gmail_modify_labels',
        'label',
        args,
        `message ${m.id}`,
        {
          id: m.id,
          labels: archive
            ? ['CATEGORY_PERSONAL', label.id]
            : ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL', label.id],
        },
        callId,
      )
    }

    /** A page of the public documentation. */
    docs(path: string, text: string) {
      this.tl.tool(
        'WebFetch',
        { url: `${DOCS}${path}`, prompt: 'What does this page say?' },
        text,
        5_000,
      )
    }

    /** A customer looked up in Stripe, read only. */
    stripe(operation: string, args: Record<string, unknown>, target: string, output: unknown) {
      this.read(input.stripeId, operation, args, target, output)
    }

    /** A reply in the mail's Gmail thread; in a dry run, simulated with no one asked. */
    reply(m: Mail, body: string, decision: Decision | 'pending' = 'pending') {
      const args = { to: [m.email], subject: re(m.subject), body, replyToMessageId: m.id }
      const target = `email to ${m.email}: "${re(m.subject)}"`
      if (this.dryRun) {
        this.auto(input.gmail.id, 'gmail_send', 'reply', args, target, null)
        return true
      }
      const sent = this.ask(
        { id: input.gmail.id, account: inbox },
        'gmail_send',
        'reply',
        args,
        target,
        { id: gmailId(), threadId: m.threadId },
        decision,
      )
      if (sent) this.firstResponseAt ??= this.tl.now
      return sent
    }

    draft(m: Mail, body: string) {
      const args = { to: [m.email], subject: re(m.subject), body, replyToMessageId: m.id }
      this.auto(
        input.gmail.id,
        'gmail_create_draft',
        'draft',
        args,
        `draft to ${m.email}: "${re(m.subject)}"`,
        { draftId: `r-${randomBytes(6).toString('hex')}`, messageId: gmailId() },
      )
    }
  }

  /** A dry run's event: the mail replayed, and the dry run it is one event of. */
  type Replay = { title: string; text: string; at: string; dryRunId: string }

  /**
   * A run: its root thread, started by a mail (replayed, in a dry run) or by the schedule
   * (first message written by the caller), and the run's own row.
   */
  class Run extends PlaybookThread {
    kase: string | null = null
    outcome: string | null = null
    summary: string | null = null
    endedAt: Date | null = null
    surfacedAt: Date | null = null
    /** When it followed another run's child (follow_thread). */
    followedAt: Date | null = null
    readonly startedAt: Date
    readonly children: Child[] = []

    constructor(
      readonly first: Mail | null,
      start: Date,
      readonly replay?: Replay,
    ) {
      super(start, randomUUID(), !!replay)
      this.startedAt = start
      if (first) {
        this.tl.user(replay?.text ?? received(first).text, null)
        this.tl.start()
      }
    }

    get title() {
      if (this.replay) return `Dry run · ${this.replay.title}`
      return this.first
        ? received(this.first).title
        : `${schedule.title} · ${localTime(this.startedAt, schedule.timezone)}`
    }

    /** A later mail of the same conversation: the run goes on. */
    incoming(m: Mail) {
      this.tl.until(m.at)
      this.tl.wait(40_000)
      this.tl.user(received(m).text, null)
      this.tl.start()
      this.endedAt = null
    }

    /** A member writes in it: from now on it is in the sidebar's Threads. */
    member(text: string, memberId: string, at: Date) {
      this.tl.until(at)
      this.tl.user(text, memberId)
      this.tl.start()
      this.surfacedAt ??= at
      this.interventions++
    }

    /** Woken by a note: a child's report, or a thread it follows. */
    wake(text: string, at: Date) {
      this.tl.until(at)
      this.tl.wait(5_000)
      this.tl.user(text, null)
      this.tl.start()
    }

    report(kase: string, outcome: 'resolved' | 'escalated' | 'noise' | 'failed', summary: string) {
      this.tl.tool(
        harness('playbook_report'),
        { case: kase, outcome, summary },
        {
          recorded: { case: kase, outcome },
          note: 'Recorded on the run. A later event of the same conversation continues it.',
        },
        1_000,
      )
      this.kase = kase
      this.outcome = outcome
      this.summary = summary
      this.endedAt = this.tl.now
    }

    async save() {
      const status = this.outcome
        ? this.outcome === 'failed'
          ? 'failed'
          : 'done'
        : this.dryRun
          ? 'done'
          : 'running'
      await prisma.playbookRun.create({
        data: {
          ...inWorkspace,
          id: this.runId,
          installationId,
          conversationKey: this.dryRun ? null : (this.first?.threadId ?? null),
          case: this.kase,
          status,
          outcome: this.outcome,
          summary: this.summary,
          interventions:
            this.interventions + this.children.reduce((n, c) => n + c.interventions, 0),
          firstResponseAt: this.firstResponseAt,
          dryRun: this.dryRun,
          ...(this.replay
            ? {
                dryRunId: this.replay.dryRunId,
                replay: {
                  title: this.replay.title,
                  text: this.replay.text,
                  attachmentIds: [],
                  at: this.replay.at,
                  origin: { kind: 'trigger', triggerId },
                },
              }
            : {}),
          startedAt: this.startedAt,
          endedAt: this.endedAt ?? (this.dryRun ? this.tl.now : null),
        },
      })
      await createThread({
        id: this.id,
        title: this.title,
        teammateId: sam.id,
        status: this.status,
        origin: this.first ? 'trigger' : 'schedule',
        createdAt: this.startedAt,
        ...(this.first ? { triggerId } : { scheduleId }),
        ...(this.first && !this.dryRun ? { conversationKey: this.first.threadId } : {}),
        playbookRunId: this.runId,
        surfacedAt: this.surfacedAt,
      })
      await writeEvents(this.id, this.tl)
      await prisma.playbookRun.update({
        where: { id: this.runId },
        data: { rootSessionId: this.id },
      })
      for (const child of this.children) await child.save(this)
    }
  }

  /** A child thread of a run, a fix: part of the run, out of the sidebar, shown in its parent. */
  class Child extends PlaybookThread {
    report: ChildReport | null = null
    /** When its pull request was opened. */
    openedAt: Date | null = null
    readonly startedAt: Date

    constructor(
      readonly parent: Run,
      readonly title: string,
      instructions: string,
    ) {
      super(parent.tl.now, parent.runId, parent.dryRun)
      this.startedAt = parent.tl.now
      parent.children.push(this)
      // The parent's call that starts it.
      parent.tl.tool(
        harness('start_child'),
        { title, instructions, wait: true },
        { threadId: this.id, title, teammate: sam.name },
        2_000,
      )
      this.tl.wait(10_000)
      this.tl.user(childPrompt({ from: sam.name, parentTitle: parent.title, instructions }), null)
      this.tl.start()
    }

    /** Its fix, made and tested in the repository: `failing` is the test run before. */
    fix(branch: string, failing: string, files: string[], passing: string) {
      this.tl.tool(
        harness('checkout_repository'),
        { repository: input.repository },
        { directory: 'web', branch },
        6_000,
      )
      this.tl.tool('Bash', { command: 'pnpm test' }, failing, 40_000)
      for (const file of files) this.tl.file(file)
      this.tl.tool('Bash', { command: 'pnpm test' }, passing, 45_000)
    }

    push(branch: string) {
      if (this.dryRun) {
        const refusal =
          "Brigade: this is a playbook's dry run, so nothing is pushed: the work stays in this folder"
        this.tl.tool(
          'Bash',
          { command: 'git push -u origin HEAD' },
          `remote: ${refusal}\nfatal: unable to access the repository: The requested URL returned error: 403`,
          5_000,
        )
        this.record({
          connectionId: github.id,
          operation: 'git_push',
          write: true,
          target: input.repository,
          result: 'denied',
          error: refusal.replace(/^Brigade: /, ''),
          at: this.tl.now,
        })
        return
      }
      this.tl.tool(
        'Bash',
        { command: 'git push -u origin HEAD' },
        `To ${input.repository}\n * [new branch]      ${branch} -> ${branch}\nbranch '${branch}' set up to track 'origin/${branch}'.`,
        6_000,
      )
      this.tl.push({
        type: 'repositories.changed',
        repositories: [input.repository],
        teammateId: sam.id,
      })
    }

    openPullRequest(number: number, title: string, branch: string, body: string) {
      const args = {
        repository: input.repository,
        title,
        head: branch,
        base: 'main',
        body,
        draft: false,
      }
      const at = this.tl.now
      this.openedAt = at
      this.auto(
        github.id,
        'github_create_pull_request',
        'open_pr',
        args,
        `pull request ${branch} → main in ${input.repository}`,
        {
          number,
          title,
          state: 'open',
          author: 'brigade-app[bot]',
          labels: [],
          assignees: [],
          comments: 0,
          created: at.toISOString(),
          updated: at.toISOString(),
          closed: null,
          url: `https://github.com/${input.repository}/pull/${number}`,
          draft: false,
          merged: null,
          head: branch,
          base: 'main',
        },
      )
    }

    merge(number: number, decision: Decision | 'pending') {
      const args = { repository: input.repository, number, method: 'squash' }
      return this.ask(
        { id: github.id, account: github.externalAccount ?? github.label },
        'github_merge_pull_request',
        'merge',
        args,
        `merge ${input.repository}#${number} (squash)`,
        {
          number,
          merged: true,
          method: 'squash',
          sha: randomBytes(20).toString('hex'),
          base: 'main',
          url: `https://github.com/${input.repository}/pull/${number}`,
        },
        decision,
      )
    }

    reportBack(summary: string) {
      this.tl.tool(harness('report'), { status: 'report', summary }, { ok: true }, 1_000)
      this.report = { status: 'report', summary, at: this.tl.now.toISOString() }
    }

    async save(parent: Run) {
      await createThread({
        id: this.id,
        title: this.title,
        teammateId: sam.id,
        status: this.status,
        origin: 'child',
        createdAt: this.startedAt,
        playbookRunId: parent.runId,
        parentId: parent.id,
        parentTeammateId: sam.id,
        awaited: true,
        ...(this.report
          ? { report: this.report, reportDeliveredAt: new Date(this.report.at) }
          : {}),
      })
      await writeEvents(this.id, this.tl)
    }
  }

  /** A note a run wakes up to when the children it waits for reported. */
  const childrenNote = (child: Child) =>
    batchNote([{ id: child.id, title: child.title, teammate: sam.name, report: child.report! }], [])

  /** A feature request goes in the backlog: create_task, as the teammate's tool does. */
  const backlog = (run: Run, title: string, description: string) => {
    const taskId = randomUUID()
    run.tl.tool(
      harness('create_task'),
      { title, description, priority: 'medium', assignee: 'none' },
      { taskId, column: 'backlog', note: 'In Backlog, assigned to nobody.' },
      2_000,
    )
    tasks.push({
      ...inWorkspace,
      id: taskId,
      title,
      description,
      priority: 'medium',
      createdByMemberId: ada.memberId,
      createdByTeammateId: sam.id,
      projectId: input.projectId,
      createdAt: run.tl.now,
    })
  }

  // -------------------------------------------------------------------------
  // The dry run, from the chat: five mails before it was installed, every write simulated
  // -------------------------------------------------------------------------
  const dryRunStart = new Date(installed.getTime() + 9 * MIN)
  const replayed = [
    mail(
      'Ana Souza <ana@initrode.test>',
      'Inviting my team',
      'Hi, how do I invite my team? I only see my own name in Members.\nAna',
      ago(27 * DAY + 7 * HOUR),
    ),
    mail(
      'Lucas Martin <lucas@cyberdyne.test>',
      'Slack notifications stopped',
      'Since we renamed our Slack channel, Acme stopped posting to it. Reconnecting did not help.\nLucas',
      ago(26 * DAY + 19 * HOUR),
    ),
    mail(
      'Offshore Devs <sales@devs-offshore.test>',
      'Senior developers at $25/hour',
      'Hi! Scale your team with vetted senior developers from $25/hour. Free trial week. Book a call?',
      ago(26 * DAY + 2 * HOUR),
    ),
    mail(
      'Omar Haddad <omar@globex.test>',
      'Refund for unused seats',
      'Hello, we bought 4 seats too many last month and never used them. Could you refund them?\nOmar',
      ago(25 * DAY + 9 * HOUR),
    ),
    mail(
      'Elena García <elena@monarch.test>',
      'Cannot add a 6th member',
      'We are on Pro and I cannot add a sixth person: the button is greyed out.\nElena',
      ago(24 * DAY + 14 * HOUR),
    ),
  ]
  const dryRun = await prisma.playbookDryRun.create({
    data: {
      ...inWorkspace,
      installationId,
      sessionId: chat.id,
      teammateId: chief.id,
      startedByMemberId: ada.memberId,
      status: 'done',
      firstEventAt: replayed[0]!.at,
      lastEventAt: replayed.at(-1)!.at,
      startedAt: dryRunStart,
    },
  })
  // Three at a time: the fourth and fifth start as the first ones end.
  const dryRuns = replayed.map((m, i) => {
    // As startDryRun reads it: received when the mail came.
    const { title, text } = eventMessage(
      trigger,
      emailReceived,
      gmailConnection,
      { id: m.id, type: 'email', payload: payloadOf(m) },
      m.at.toISOString(),
    )
    const start = new Date(dryRunStart.getTime() + (i < 3 ? i * 4_000 : (i - 2) * 6 * MIN))
    return new Run(m, start, { title, text, at: m.at.toISOString(), dryRunId: dryRun.id })
  })
  {
    const [question, bug, noise, refund, seats] = dryRuns as [Run, Run, Run, Run, Run]
    const [q, b, n, r, s] = replayed as [Mail, Mail, Mail, Mail, Mail]

    question.triage('documented_question')
    question.docs(
      '/invites',
      'Invite people from Settings → Members → Invite, one email per line. Each invite link is valid for 7 days.',
    )
    question.reply(
      q,
      letter(
        q.first,
        'Go to Settings → Members → Invite and enter their emails, one per line. Each person gets an email with a link that is valid for 7 days.',
        `The guide: ${DOCS}/invites`,
      ),
    )
    question.report(
      'documented_question',
      'resolved',
      'Would have explained how to invite members, with the docs link.',
    )
    question.tl.say('Answered from the docs: invites are in Settings → Members → Invite.')
    question.tl.end()

    bug.triage('bug')
    bug.label(b, 'bug')
    bug.reply(
      b,
      letter(
        b.first,
        'Thanks for the report: renaming a channel breaks the link to it on our side, and we are fixing it now. In the meantime, picking the channel again in Settings → Integrations → Slack brings the posts back.',
      ),
    )
    const slack = new Child(
      bug,
      'Fix Slack posts after a channel is renamed',
      'Acme stops posting to a Slack channel once the channel is renamed; reconnecting Slack does not help. Find the cause in acme/web, fix it with a test and open a pull request.',
    )
    bug.tl.say('Acknowledged and started a fix in a child thread.')
    bug.tl.end()
    slack.fix(
      'brigade/sam-slack-rename',
      '✗ slack › posts to a channel after it is renamed\n  Error: channel_not_found (#product-updates)\nTests: 1 failed, 23 passed, 24 total',
      ['web/lib/slack/post.ts', 'web/lib/slack/post.test.ts'],
      'Tests: 24 passed, 24 total',
    )
    slack.push('brigade/sam-slack-rename')
    slack.openPullRequest(
      0,
      'Post to Slack channels by id, so a rename does not break them',
      'brigade/sam-slack-rename',
      'Slack posts used the channel name saved when Slack was connected; a renamed channel was not found. They now use the channel id. Covered by a test.',
    )
    slack.reportBack(
      'Fix ready on brigade/sam-slack-rename: posts now use the channel id, not its name, with a test. Dry run: nothing was pushed, and the pull request was simulated.',
    )
    slack.tl.say('The fix and its test are ready on the branch; nothing left the computer.')
    slack.tl.end()
    bug.wake(childrenNote(slack), slack.tl.now)
    bug.report(
      'bug',
      'resolved',
      'Would have acknowledged Lucas, fixed the Slack posts in a child thread (kept on the computer) and told him once merged.',
    )
    bug.tl.say('The fix is ready; I would tell Lucas once it is merged.')
    bug.tl.end()

    noise.triage('noise')
    noise.label(n, 'noise')
    noise.report('noise', 'noise', 'Cold outreach: would have labeled it Noise and archived it.')
    noise.tl.say('Cold outreach: labeled Noise and archived.')
    noise.tl.end()

    refund.triage('billing_or_data')
    refund.label(r, 'escalated')
    refund.draft(
      r,
      letter(
        r.first,
        'We have received your request about the 4 unused seats. A person from our billing team will look at it and get back to you within one business day.',
      ),
    )
    refund.report(
      'billing_or_data',
      'escalated',
      'Refund request: would have escalated it to a person, with a holding reply drafted. Nothing sent.',
    )
    refund.tl.say('A refund is for a person: drafted a holding reply and escalated.')
    refund.tl.end()

    seats.triage('account_problem')
    seats.stripe(
      'stripe_search_customers',
      { query: `email:'${s.email}'`, limit: 5 },
      `customer search email:'${s.email}'`,
      [{ id: 'cus_Monarch', name: 'Monarch', email: s.email }],
    )
    seats.stripe(
      'stripe_list_subscriptions',
      { customerId: 'cus_Monarch' },
      'subscriptions of customer cus_Monarch',
      [{ id: 'sub_Monarch', status: 'active', plan: 'Pro', quantity: 5 }],
    )
    seats.reply(
      s,
      letter(
        s.first,
        'Your Pro plan has 5 seats and all of them are in use, which is why the button is greyed out. Add a seat in Settings → Billing → Seats and you can invite the sixth person right away.',
        `${DOCS}/seats`,
      ),
    )
    seats.report('account_problem', 'resolved', 'Would have explained the seat limit: 5 of 5 used.')
    seats.tl.say('All 5 seats are taken: explained how to add one.')
    seats.tl.end()
  }
  for (const run of dryRuns) await run.save()
  const dryRunEnd = new Date(Math.max(...dryRuns.map((r) => r.tl.now.getTime())))
  await prisma.playbookDryRun.update({ where: { id: dryRun.id }, data: { endedAt: dryRunEnd } })
  await prisma.playbookInstallation.update({
    where: { id: installationId },
    data: { status: 'dry_run' },
  })

  // Activated by Ada from the chat's card: every action at its starting level.
  await activatePlaybook(
    db,
    { ...scope, userId: ada.userId, memberId: ada.memberId, role: 'owner' },
    installationId,
  )
  const activated = new Date(dryRunEnd.getTime() + 25 * MIN)
  await prisma.playbookInstallation.update({
    where: { id: installationId },
    data: { createdAt: installed, activatedAt: activated },
  })

  // The chat itself: the card, the answers, the dry run's report and the activation.
  {
    const report = await dryRunView(db, dryRun.id)
    const minutes = (n: number) =>
      n < 1 ? 'under a minute' : `${Math.round(n)} minute${Math.round(n) === 1 ? '' : 's'}`
    const note =
      `${DRY_RUN_HEAD}${report.name} is done: ${report.events.length} events` +
      `, ${minutes(report.minutes)} of session on the owner's subscription` +
      (report.week
        ? `, about ${minutes(report.week.minutes)} a week at the pace of these events (${report.week.events} a week).`
        : '.') +
      ' Nothing was sent: every write was simulated and no push left. ' +
      `Call dry_run_report with installationId ${installationId} to show its report in this thread, ` +
      'one card per event, and read what each run found and would have done. Then tell the person in a few ' +
      'lines what stands out and what you would change in its recipe (propose_skill), and offer to activate ' +
      'it (activate_playbook) when it looks right.'
    const tl = new Timeline(installed, chief.id, input.accountId)
    const settingsShown = (keys: string[]) =>
      keys.map((key) => ({
        key,
        value: key === 'inbox' ? inbox : settings[key],
      }))
    tl.user(
      `Can you install the support playbook? Sam should run it on ${SUPPORT}, and bugs get fixed in ${input.repository}.`,
      ada.memberId,
    )
    tl.start()
    tl.tool(
      harness('show_playbook'),
      { playbookKey: KEY },
      {
        playbook: { id: KEY, name: manifest.name, version: manifest.version, source: 'brigade' },
        installed: [],
        next: 'Its card shows under your reply.',
      },
    )
    tl.tool(
      harness('configure_playbook'),
      {
        playbookKey: KEY,
        teammate: sam.name,
        settings: { product: 'Acme', inbox: SUPPORT, address: SUPPORT, repo: input.repository },
      },
      {
        installationId,
        playbook: manifest.name,
        status: 'setup',
        teammate: sam.name,
        settings: settingsShown(['product', 'inbox', 'address', 'repo']),
        missing: [{ key: 'docs', type: 'url', ask: 'Where is the public documentation?' }],
        next: 'Ask the person next: "Where is the public documentation?" (url).',
      },
    )
    tl.say(
      `**Support and bugs** fits: it sorts each mail to ${SUPPORT}, answers from your docs, and starts a fix in ${input.repository} when a customer reports a bug. I set it up for Sam with the inbox, the address and the repository.\n\nOne question left: where is your public documentation?`,
    )
    tl.end()
    tl.wait(6 * MIN)
    tl.user(`It's ${DOCS}. Sign the mails "${SIGNATURE}".`, ada.memberId)
    tl.start()
    tl.tool(
      harness('configure_playbook'),
      { installationId, settings: { docs: DOCS, signature: SIGNATURE } },
      {
        installationId,
        playbook: manifest.name,
        status: 'setup',
        teammate: sam.name,
        settings: settingsShown(['product', 'inbox', 'address', 'docs', 'repo', 'signature']),
        missing: [],
        next: 'Every setting has an answer: its triggers, schedules and skills are made, and nothing runs yet.',
      },
    )
    tl.tool(
      harness('start_dry_run'),
      { installationId, last: replayed.length },
      { dryRunId: dryRun.id, events: replayed.length, next: 'Started.' },
    )
    tl.say(
      `Every setting has an answer. I started a dry run on the last ${replayed.length} mails to ${SUPPORT}: each one runs as it would live, but every write is simulated and nothing is sent. I'll be back here with the report.`,
    )
    tl.end()
    tl.until(new Date(dryRunEnd.getTime() + 20_000))
    tl.user(note, null)
    tl.start()
    tl.tool(
      harness('dry_run_report'),
      { installationId },
      {
        id: dryRun.id,
        status: 'done',
        finished: report.finished,
        minutes: report.minutes,
        week: report.week,
        events: report.events.map((e) => ({ title: e.title, case: e.case, outcome: e.outcome })),
      },
    )
    tl.tool(
      harness('activate_playbook'),
      { installationId },
      {
        installationId,
        playbook: manifest.name,
        owner: 'Ada',
        actions: manifest.actions.map((a) => ({ label: a.label, level: a.start })),
        next: 'Its summary card shows under your reply, with an Activate button.',
      },
    )
    tl.say(
      [
        'The report is above. What stands out:',
        '- 5 mails, 5 cases that look right: a question, a bug, a cold email, a refund request and a seat limit.',
        '- The answers read well and link the right pages of the docs.',
        `- The Slack bug started a fix in ${input.repository}; its push was held back, so it stayed on the computer.`,
        '- The refund was escalated with a holding reply drafted, as the recipe asks.',
        '',
        `It took ${minutes(report.minutes)} for 5 mails${report.week ? `, about ${minutes(report.week.minutes)} a week at this pace` : ''}. I would not change the recipe yet. Once active, every reply and merge asks you first.`,
      ].join('\n'),
    )
    tl.end()
    tl.until(activated)
    tl.user(`Activated the playbook ${manifest.name}.`, ada.memberId)
    tl.start()
    tl.say(
      `It's live. Each new mail to ${SUPPORT} starts a run for Sam, kept out of your Threads; replies and merges wait for your approval on Home, grouped under ${manifest.name}. Its sheet is on Routines.`,
    )
    tl.end()
    await writeEvents(chat.id, tl)
  }

  // -------------------------------------------------------------------------
  // Live runs, the oldest first. Each reply asks first; labels, drafts and pull requests
  // are done on their own.
  // -------------------------------------------------------------------------
  const runs: Run[] = []
  const live = (m: Mail) => {
    const run = new Run(m, new Date(m.at.getTime() + 40_000))
    runs.push(run)
    return run
  }

  // Three weeks of runs before this one: questions and account problems answered, noise put away.
  type Earlier = {
    days: number
    from: string
    subject: string
    body: string
  } & (
    | {
        case: 'documented_question'
        page: string
        page_text: string
        answer: string[]
        by: 'ada' | 'bob'
        after: number
        summary: string
      }
    | {
        case: 'account_problem'
        customer: string
        lookup: { operation: string; output: unknown }
        answer: string[]
        by: 'ada' | 'bob'
        after: number
        summary: string
      }
    | { case: 'noise'; summary: string }
  )
  const earlier: Earlier[] = [
    {
      days: 23.4,
      from: 'Ben Carter <ben@initrode.test>',
      subject: 'Keyboard shortcuts',
      body: 'Is there a list of keyboard shortcuts somewhere? I keep reaching for the mouse.\nBen',
      case: 'documented_question',
      page: '/shortcuts',
      page_text:
        'Press ? anywhere to see every shortcut. Most used: C creates a task, / searches, G then P opens projects.',
      answer: [
        'Press ? anywhere in Acme to see every shortcut. The ones people use most: C to create a task, / to search, and G then P to jump to your projects.',
        `The full list: ${DOCS}/shortcuts`,
      ],
      by: 'ada',
      after: 14 * MIN,
      summary: 'Pointed Ben to the shortcuts list.',
    },
    {
      days: 22.7,
      from: 'Chloé Durand <chloe@soylent.test>',
      subject: 'Our trial ended early?',
      body: 'Hi, our Pro trial says it has ended, but I signed up less than two weeks ago. Can you check?\nChloé',
      case: 'account_problem',
      customer: 'cus_Soylent',
      lookup: {
        operation: 'stripe_list_subscriptions',
        output: [{ id: 'sub_Soylent', plan: 'Pro', status: 'incomplete', trial_days: 14 }],
      },
      answer: [
        'The trial started when a colleague of yours created the workspace, 15 days ago, so its 14 days ended yesterday. Nothing is lost: pick a plan in Settings → Billing and everything is there as you left it.',
      ],
      by: 'ada',
      after: 41 * MIN,
      summary:
        'The trial began when a colleague created the workspace; explained how to pick a plan.',
    },
    {
      days: 21.8,
      from: 'Arjun Mehta <arjun@hooli.test>',
      subject: 'Import from Trello',
      body: 'We are moving from Trello. Can we bring our boards over, with the comments?\nArjun',
      case: 'documented_question',
      page: '/import',
      page_text:
        'Import from Trello, Asana or a CSV in Settings → Import. Cards, checklists, comments and attachments come over; members are matched by email.',
      answer: [
        'Yes: Settings → Import → Trello brings your boards over with their cards, checklists, comments and attachments. Members are matched by email, so invite your team first.',
        `Step by step: ${DOCS}/import`,
      ],
      by: 'bob',
      after: 37 * MIN,
      summary: 'Explained the Trello import.',
    },
    {
      days: 21.0,
      from: 'DevTools Daily <digest@devtools-daily.test>',
      subject: 'Your weekly digest: 12 tools we loved',
      body: 'This week: a faster test runner, a new terminal, and 10 more tools we loved. Unsubscribe anytime.',
      case: 'noise',
      summary: 'A newsletter: labeled Noise and archived.',
    },
    {
      days: 20.2,
      from: 'Sara Lind <sara@vandelay.test>',
      subject: 'Custom fields on tasks',
      body: 'Can we add our own fields to tasks, like a budget or a client name?\nSara',
      case: 'documented_question',
      page: '/custom-fields',
      page_text:
        'Custom fields: project settings → Fields → Add field. Text, number, date, select and person fields.',
      answer: [
        "Yes: in the project's settings, open Fields and click Add field. Text, number, date, select and person fields are there, so a budget (number) and a client name (text) both work.",
        `More: ${DOCS}/custom-fields`,
      ],
      by: 'ada',
      after: 8 * MIN,
      summary: 'Explained custom fields.',
    },
    {
      days: 19.4,
      from: 'Paul Martin <paul@cyberdyne.test>',
      subject: 'Invoices in our company name',
      body: "Our invoices show my name instead of Cyberdyne's. Our accountant needs the company name and VAT number. Can you fix it?\nPaul",
      case: 'account_problem',
      customer: 'cus_Cyberdyne',
      lookup: {
        operation: 'stripe_get_customer',
        output: {
          id: 'cus_Cyberdyne',
          name: 'Paul Martin',
          email: 'paul@cyberdyne.test',
          tax_ids: [],
        },
      },
      answer: [
        'Your billing details are under your own name, which is why the invoices show it. Add Cyberdyne and your VAT number in Settings → Billing → Company details, and every invoice from then on uses them.',
        'For invoices already issued, reply with the ones you need and a person from the team will reissue them.',
      ],
      by: 'ada',
      after: 52 * MIN,
      summary:
        "Billing details were in Paul's name; explained where to set the company and VAT number.",
    },
    {
      days: 18.1,
      from: 'Yuki Sato <yuki@tyrell.test>',
      subject: 'Mobile app offline',
      body: 'Does the mobile app work offline? I travel a lot.\nYuki',
      case: 'documented_question',
      page: '/mobile',
      page_text:
        'The mobile apps keep the projects opened in the last 30 days offline. Changes sync when you are back online.',
      answer: [
        'Yes: the mobile app keeps the projects you opened in the last 30 days on your phone, and you can edit them offline. Everything syncs when you are back online.',
        `${DOCS}/mobile`,
      ],
      by: 'bob',
      after: 21 * MIN,
      summary: 'Explained offline use of the mobile app.',
    },
    {
      days: 16.9,
      from: 'Fatima Zahra <fatima@monarch.test>',
      subject: 'Slack notifications',
      body: 'Can Acme post to a Slack channel when a task is done?\nFatima',
      case: 'documented_question',
      page: '/slack',
      page_text:
        'Slack: Settings → Integrations → Slack, then pick a channel per project and the events to post.',
      answer: [
        'Yes: connect Slack in Settings → Integrations → Slack, then pick a channel for each project and the events to post, such as tasks completed.',
        `${DOCS}/slack`,
      ],
      by: 'ada',
      after: 6 * MIN,
      summary: 'Explained the Slack integration.',
    },
    {
      days: 15.6,
      from: 'Leo Novak <leo@wayne.test>',
      subject: 'Still on Pro after cancelling?',
      body: 'We cancelled last week, so why does our account still show Pro?\nLeo',
      case: 'account_problem',
      customer: 'cus_Wayne',
      lookup: {
        operation: 'stripe_list_subscriptions',
        output: [
          {
            id: 'sub_Wayne',
            plan: 'Pro',
            status: 'active',
            cancel_at_period_end: true,
            ends_in_days: 16,
          },
        ],
      },
      answer: [
        'Your cancellation takes effect at the end of the period you already paid for, in 16 days. Until then you keep Pro, and nothing renews after it.',
        'If you meant to stop right away, reply and a person from the team will look at it.',
      ],
      by: 'ada',
      after: 44 * MIN,
      summary: 'Cancelled at the end of the paid period; explained it.',
    },
    {
      days: 13.8,
      from: 'Mia Hoffmann <mia@duff.test>',
      subject: 'Archive a finished project',
      body: 'How do I archive a project without deleting it? We want to keep the history.\nMia',
      case: 'documented_question',
      page: '/archive',
      page_text:
        'Archive a project from its ⋯ menu → Archive. Archived projects are read-only and can be restored anytime.',
      answer: [
        "Open the project's ⋯ menu and choose Archive. It becomes read-only and leaves your sidebar with its whole history kept, and you can restore it anytime from Projects → Archived.",
        `${DOCS}/archive`,
      ],
      by: 'bob',
      after: 33 * MIN,
      summary: 'Explained how to archive a project.',
    },
    {
      days: 12.9,
      from: 'Calendar Bot <no-reply@calendar-bot.test>',
      subject: 'Invitation: Product demo with Growthly',
      body: 'You have been invited to: Product demo with Growthly. Accept or decline.',
      case: 'noise',
      summary: 'An unsolicited calendar invite: labeled Noise and archived.',
    },
    {
      days: 12.1,
      from: 'Noah Williams <noah@stark.test>',
      subject: 'Two-factor authentication',
      body: 'Can we make two-factor mandatory for everyone in our workspace?\nNoah',
      case: 'documented_question',
      page: '/security',
      page_text:
        'Admins can require two-factor for all members: Settings → Security → Require two-factor.',
      answer: [
        'Yes: an admin can turn on Settings → Security → Require two-factor. Members without it are asked to set it up the next time they sign in.',
        `${DOCS}/security`,
      ],
      by: 'ada',
      after: 11 * MIN,
      summary: 'Explained how to require two-factor.',
    },
    {
      days: 11.2,
      from: 'Clara Silva <clara@pied-piper.test>',
      subject: 'Upgrading mid-month',
      body: 'If we upgrade from Pro to Business today, do we pay for the month twice?\nClara',
      case: 'account_problem',
      customer: 'cus_PiedPiper',
      lookup: {
        operation: 'stripe_list_subscriptions',
        output: [{ id: 'sub_PiedPiper', plan: 'Pro', status: 'active', quantity: 7 }],
      },
      answer: [
        'No: the upgrade is prorated. For your 7 seats you pay only the difference for the days left in this period, on your next invoice, and Business starts right away.',
        `${DOCS}/billing/upgrade`,
      ],
      by: 'bob',
      after: 26 * MIN,
      summary: 'Explained the prorated upgrade for 7 seats.',
    },
    {
      days: 10.4,
      from: 'Hugo Lefebvre <hugo@globex.test>',
      subject: 'Due date reminders',
      body: 'Can Acme remind people the day before a task is due?\nHugo',
      case: 'documented_question',
      page: '/notifications',
      page_text:
        'Reminders: Settings → Notifications → Due dates. Choose when (the day before, the morning of) and how (email, push).',
      answer: [
        'Yes: in Settings → Notifications → Due dates, each person picks when to be reminded (the day before, or the morning of) and how (email or push).',
        `${DOCS}/notifications`,
      ],
      by: 'ada',
      after: 19 * MIN,
      summary: 'Explained due date reminders.',
    },
    {
      days: 9.7,
      from: 'Aisha Bello <aisha@initrode.test>',
      subject: 'Project templates',
      body: 'We start the same kind of project every month. Can we save one as a template?\nAisha',
      case: 'documented_question',
      page: '/templates',
      page_text:
        'Save any project as a template from its ⋯ menu → Save as template. New projects can start from it; tasks are copied without their dates.',
      answer: [
        "Yes: from the project's ⋯ menu, choose Save as template. Next time, New project → From template starts a copy with its lists and tasks, without the dates.",
        `${DOCS}/templates`,
      ],
      by: 'bob',
      after: 64 * MIN,
      summary: 'Explained project templates.',
    },
    {
      days: 9.0,
      from: 'PM Summit <events@pm-summit.test>',
      subject: 'Webinar: AI for project managers',
      body: 'Join 2,000 project managers on Thursday for a free webinar. Save your seat!',
      case: 'noise',
      summary: 'A webinar invite: labeled Noise and archived.',
    },
    {
      days: 8.4,
      from: 'Daniel Cohen <daniel@vandelay.test>',
      subject: 'Still paying for 10 seats',
      body: 'We removed two people last month but still pay for 10 seats. Can you fix it?\nDaniel',
      case: 'account_problem',
      customer: 'cus_Vandelay',
      lookup: {
        operation: 'stripe_list_subscriptions',
        output: [{ id: 'sub_Vandelay', plan: 'Pro', status: 'active', quantity: 10 }],
      },
      answer: [
        'Removing a member frees their seat but does not take it off the plan, so you still have 10. Lower it to 8 in Settings → Billing → Seats and your next invoice follows; the unused time is credited.',
        `${DOCS}/seats`,
      ],
      by: 'ada',
      after: 17 * MIN,
      summary: 'Seats stay on the plan after members leave; explained how to lower them.',
    },
    {
      days: 7.9,
      from: 'Emma Johansson <emma@umbrella.test>',
      subject: 'Dark mode',
      body: 'Is there a dark mode? My eyes would thank you.\nEmma',
      case: 'documented_question',
      page: '/appearance',
      page_text: 'Settings → Appearance: Light, Dark or System.',
      answer: [
        'There is: Settings → Appearance → Dark, or System to follow your computer.',
        `${DOCS}/appearance`,
      ],
      by: 'bob',
      after: 9 * MIN,
      summary: 'Pointed Emma to dark mode.',
    },
    {
      days: 7.3,
      from: 'Ryo Tanaka <ryo@soylent.test>',
      subject: "Mentions don't notify",
      body: 'When I @mention a colleague in a comment, they do not get notified. Is that normal?\nRyo',
      case: 'documented_question',
      page: '/mentions',
      page_text:
        "Mentions notify people who can see the project. Someone outside it isn't notified; invite them to the project first.",
      answer: [
        "Mentions notify only people who can see the project. If your colleague isn't a member of that project, add them from Share and the next mention reaches them.",
        `${DOCS}/mentions`,
      ],
      by: 'ada',
      after: 23 * MIN,
      summary: 'Mentions reach project members only; explained how to add the colleague.',
    },
  ]
  const memberOf = { ada: ada.memberId, bob: bob.memberId }
  for (const e of earlier) {
    const m = mail(e.from, e.subject, e.body, ago(e.days * DAY))
    const run = live(m)
    run.triage(e.case)
    if (e.case === 'noise') {
      run.label(m, 'noise')
      run.report('noise', 'noise', e.summary)
      run.tl.say(e.summary)
      run.tl.end()
      continue
    }
    if (e.case === 'documented_question') run.docs(e.page, e.page_text)
    else {
      run.stripe(
        'stripe_search_customers',
        { query: `email:'${m.email}'`, limit: 5 },
        `customer search email:'${m.email}'`,
        [{ id: e.customer, email: m.email }],
      )
      const args = { customerId: e.customer }
      run.stripe(
        e.lookup.operation,
        args,
        e.lookup.operation === 'stripe_get_customer'
          ? `customer ${e.customer}`
          : `subscriptions of customer ${e.customer}`,
        e.lookup.output,
      )
    }
    run.reply(m, letter(m.first, ...e.answer), { by: memberOf[e.by], after: e.after })
    run.report(e.case, 'resolved', e.summary)
    run.tl.say(`Answered ${m.first}. ${e.summary}`)
    run.tl.end()
  }

  // This week.
  {
    const run = live(
      mail(
        'Lena Fischer <lena@hooli.test>',
        'Adding a client to one project',
        "Hi! We'd like to give a client access to a single project, without them seeing the rest of our workspace. Is that possible, and does it cost a seat?\n\nThanks,\nLena",
        ago(6 * DAY + 14 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('documented_question')
    run.docs(
      '/guests',
      'Guests: invite someone to one project from Share → Invite as guest. Guests see only the projects they are invited to, and are free on every plan.',
    )
    run.reply(
      m,
      letter(
        m.first,
        "Yes: open the project, then Share → Invite as guest. A guest sees only the projects you invite them to, and guests are free on every plan, so it doesn't use a seat.",
        `The guide: ${DOCS}/guests`,
      ),
      { by: ada.memberId, after: 22 * MIN },
    )
    run.report(
      'documented_question',
      'resolved',
      'Explained guest access: one project, no seat, with the docs link.',
    )
    run.tl.say('Answered Lena: guests are invited from Share → Invite as guest and use no seat.')
    run.tl.end()
  }

  // A bug three customers hit the same morning: one fix, the two others follow it.
  const csv = live(
    mail(
      'Priya Natarajan <priya@northwind.test>',
      'CSV export fails with an error',
      'Hello, since this morning exporting our invoices to CSV from Billing gives "Something went wrong (500)". PDF still works. We need the CSV for our month-end close, can you help?\nPriya, Northwind',
      ago(6 * DAY + 5 * HOUR),
    ),
  )
  const csvMail = csv.first!
  csv.triage('bug')
  csv.label(csvMail, 'bug')
  csv.reply(
    csvMail,
    letter(
      csvMail.first,
      "Thanks for the report, and sorry about this. We can reproduce the error on the CSV export and are fixing it now. I'll write again as soon as it's fixed; in the meantime the PDF export has the same invoices.",
    ),
    { by: ada.memberId, after: 9 * MIN },
  )
  const csvFix = new Child(
    csv,
    'Fix the 500 on the invoice CSV export',
    'Exporting invoices to CSV from /billing returns a 500 for some workspaces since this morning; the PDF export works. Find the cause in acme/web, fix it with a test, open a pull request and merge it once its checks pass.',
  )
  csv.tl.say(
    "Acknowledged Priya's report and started a fix in a child thread; I'll tell her once it's merged.",
  )
  csv.tl.end()
  csvFix.fix(
    'brigade/sam-csv-export-500',
    "✗ billing export › CSV with an invoice that has no due date\n  TypeError: Cannot read properties of null (reading 'toISOString')\nTests: 1 failed, 17 passed, 18 total",
    ['web/app/billing/export/csv.ts', 'web/app/billing/export/csv.test.ts'],
    'Tests: 19 passed, 19 total',
  )
  csvFix.push('brigade/sam-csv-export-500')
  csvFix.openPullRequest(
    141,
    'Fix the CSV export for invoices without a due date',
    'brigade/sam-csv-export-500',
    'Invoices without a due date made the CSV export throw (500). The column is now left empty for them. Covered by a test.',
  )

  // Two more customers hit it while the fix waits for its merge: they follow it.
  const followers: Run[] = []
  for (const [from, subject, body, at, after] of [
    [
      'Tomás Reyes <tomas@initech.test>',
      'Billing export broken?',
      'Hi, the CSV export on the billing page throws an error for us. Is it just us?\nTomás',
      ago(6 * DAY + 3 * HOUR + 40 * MIN),
      25 * MIN,
    ],
    [
      'Mei Chen <mei@umbrella.test>',
      'Export to CSV not working',
      'Hello, the invoice CSV export fails with an error 500. Any idea?\nMei, Umbrella',
      ago(6 * DAY + 2 * HOUR + 30 * MIN),
      40 * MIN,
    ],
  ] as const) {
    const run = live(mail(from, subject, body, at))
    const m = run.first!
    run.triage('bug')
    run.label(m, 'bug')
    const brief = {
      threadId: csvFix.id,
      title: csvFix.title,
      teammate: sam.name,
      status: 'waiting',
      startedAt: csvFix.startedAt.toISOString(),
    }
    run.tl.tool(
      harness('list_children'),
      {},
      { children: [], fromOtherRuns: [{ ...brief, waitingForIt: false, following: false }] },
      1_000,
    )
    run.followedAt = run.tl.now
    run.tl.tool(
      harness('follow_thread'),
      { threadId: csvFix.id },
      {
        following: { ...brief, waitingForIt: true, following: true },
        note: 'Following. You are woken here once, with a short note, when it reports (read_child then gives all of it). Finish what you do now (e.g. tell your customer the team is on it), then end your turn: never wait or poll.',
      },
      1_000,
    )
    run.reply(
      m,
      letter(
        m.first,
        "It's not just you: the CSV export fails for some workspaces since this morning. A fix is being tested now, and I'll write as soon as it's live. The PDF export works in the meantime.",
      ),
      { by: ada.memberId, after },
    )
    run.tl.say(
      `Same bug as Priya's at Northwind: following its fix, and told ${m.first} we're on it.`,
    )
    run.tl.end()
    followers.push(run)
  }

  // Bob approves the merge in the afternoon; the fix reports, and the three runs hear it.
  csvFix.merge(141, { by: bob.memberId, after: 3 * HOUR + 50 * MIN })
  csvFix.reportBack(
    'Fixed and merged in acme/web#141: invoices without a due date made the CSV export throw. A test covers it, and main deploys on merge.',
  )
  csvFix.tl.say(
    'Fixed and merged: acme/web#141. Invoices with no due date made the CSV export throw; the column is now left empty for them, with a test.',
  )
  csvFix.tl.end()
  const fixed = new Date(csvFix.report!.at)
  csv.wake(childrenNote(csvFix), fixed)
  csv.reply(
    csvMail,
    letter(
      csvMail.first,
      'The CSV export is fixed: invoices without a due date made it fail, and the fix is live now. Could you try again and tell me if anything looks off?',
    ),
    { by: ada.memberId, after: 14 * MIN },
  )
  csv.report('bug', 'resolved', 'CSV export 500 fixed in acme/web#141 (merged); told Priya.')
  csv.tl.say('Told Priya the CSV export is fixed (acme/web#141).')
  csv.tl.end()
  for (const [i, run] of followers.entries()) {
    const m = run.first!
    run.wake(
      followNote({
        id: csvFix.id,
        title: csvFix.title,
        teammate: sam.name,
        report: csvFix.report!,
      }),
      new Date(fixed.getTime() + (i + 1) * 20_000),
    )
    run.reply(
      m,
      letter(m.first, 'The CSV export works again: the fix is live. Thanks for your patience!'),
      { by: i ? ada.memberId : bob.memberId, after: (18 + i * 7) * MIN },
    )
    run.report(
      'bug',
      'resolved',
      `Same CSV export bug as Northwind's; followed its fix (acme/web#141) and told ${m.first}.`,
    )
    run.tl.say(`Told ${m.first} the export works again.`)
    run.tl.end()
  }

  {
    const run = live(
      mail(
        'Omar Haddad <omar@globex.test>',
        'Invites not arriving',
        'Hello, I invited two new colleagues yesterday but they never got the email. I checked spam. Can you look?\nOmar',
        ago(5 * DAY + 11 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('account_problem')
    run.stripe(
      'stripe_search_customers',
      { query: "email~'globex.test'", limit: 5 },
      "customer search email~'globex.test'",
      [{ id: 'cus_Globex', name: 'Globex', email: 'ops@globex.test' }],
    )
    run.stripe(
      'stripe_list_subscriptions',
      { customerId: 'cus_Globex' },
      'subscriptions of customer cus_Globex',
      [{ id: 'sub_Globex', plan: 'Pro', status: 'active', quantity: 18, seats_used: 18 }],
    )
    run.reply(
      m,
      letter(
        m.first,
        'The invites did not go out because all 18 seats on your Pro plan are taken: new invites wait until a seat is free. Add seats in Settings → Billing → Seats and the invites are sent right away.',
        `${DOCS}/seats`,
      ),
      { by: ada.memberId, after: 31 * MIN },
    )
    run.report(
      'account_problem',
      'resolved',
      'All 18 seats were taken; explained how to add seats.',
    )
    run.tl.say('Answered Omar: the invites wait for a free seat (18 of 18 used).')
    run.tl.end()
  }
  {
    const run = live(
      mail(
        'Maxine from SEO Rocket <maxine@seo-rocket.test>',
        'Partnership: 10x your organic traffic',
        "Hi there, I noticed acme.test could rank for 300+ new keywords. We'd love to partner. Do you have 15 minutes this week?",
        ago(5 * DAY + 2 * HOUR),
      ),
    )
    run.triage('noise')
    run.label(run.first!, 'noise')
    run.report('noise', 'noise', 'Cold outreach: labeled Noise and archived.')
    run.tl.say('Cold outreach: labeled Noise and archived, nothing sent.')
    run.tl.end()
  }
  {
    const run = live(
      mail(
        'Sofia Rossi <sofia@vandelay.test>',
        'Recurring tasks?',
        'Love Acme so far! Is there a way to make a task repeat every week, like our Monday planning? If not, please consider it :)\nSofia',
        ago(4 * DAY + 7 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('feature_request')
    backlog(
      run,
      'Recurring tasks',
      'Customers ask for tasks that repeat on a schedule, such as a planning task every Monday. First asked by Sofia at Vandelay.',
    )
    run.label(m, 'idea')
    run.reply(
      m,
      letter(
        m.first,
        "Thanks, glad you like it! Tasks can't repeat yet; I've added recurring tasks to our list, with your Monday planning as the example. I'll let you know when it ships.",
      ),
      { by: ada.memberId, after: 50 * MIN },
    )
    run.report(
      'feature_request',
      'resolved',
      'Added "Recurring tasks" to the backlog and thanked Sofia.',
    )
    run.tl.say('Added recurring tasks to the backlog and thanked Sofia.')
    run.tl.end()
  }
  {
    // Ada denies the first draft: calendar sync is a Business feature, and they are on Pro.
    const run = live(
      mail(
        'Kenji Watanabe <kenji@soylent.test>',
        'Google Calendar sync',
        "Hi, can we sync task due dates to Google Calendar? We're on the Pro plan.\nKenji",
        ago(3 * DAY + 22 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('documented_question')
    run.docs(
      '/calendar',
      'Calendar sync (Business plan): due dates appear in Google Calendar or Outlook. Settings → Integrations → Calendar.',
    )
    run.reply(
      m,
      letter(
        m.first,
        'Yes: go to Settings → Integrations → Calendar and connect Google Calendar; due dates then show up there within a few minutes.',
      ),
      {
        by: ada.memberId,
        after: 12 * MIN,
        denied:
          "Calendar sync is Business only and they're on Pro. Say so, and mention the Business trial.",
      },
    )
    run.reply(
      m,
      letter(
        m.first,
        'Calendar sync comes with the Business plan: due dates then show up in Google Calendar or Outlook. You can try Business free for 14 days from Settings → Billing, and go back to Pro if it is not for you.',
        `The guide: ${DOCS}/calendar`,
      ),
      { by: ada.memberId, after: 4 * MIN },
    )
    run.report(
      'documented_question',
      'resolved',
      'Calendar sync needs Business; offered the 14-day trial (first draft corrected by Ada).',
    )
    run.tl.say('Answered Kenji: calendar sync needs Business, with the trial offered.')
    run.tl.end()
  }
  {
    // A deletion request is a person's: escalated with a ticket and a reply drafted for them.
    const run = live(
      mail(
        'Amara Okafor <amara@wonka.test>',
        'Please delete our account',
        "Hello, we've moved to another tool. Please close our Wonka workspace and delete all our data, as per GDPR. Thank you.\nAmara",
        ago(3 * DAY + 9 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('billing_or_data')
    run.label(m, 'escalated')
    run.draft(
      m,
      letter(
        m.first,
        "We've received your request to close the Wonka workspace and delete its data. A member of our team will confirm within two business days, and we'll send a confirmation once everything is deleted.",
      ),
    )
    const requestId = `call_${id()}`
    const asks = [
      {
        id: 'delete',
        type: 'action' as const,
        title: "Close Wonka's workspace and delete its data, then send the reply drafted in Gmail",
        steps: [
          'Check that the request comes from an owner of the Wonka workspace',
          'Close the workspace and delete its data from the admin console',
          `Send the reply drafted in ${SUPPORT}`,
        ],
      },
    ]
    const title = "Delete Wonka's workspace and data (GDPR request)"
    const opened = run.tl.now
    run.tl.push({ type: 'ticket.opened', requestId, title, asks, teammateId: sam.id }, 0)
    run.tl.wait(2 * HOUR + 35 * MIN)
    const answered = run.tl.now
    const answer = {
      action: 'answered' as const,
      replies: {
        delete: {
          type: 'action' as const,
          done: true,
          note: 'Done, and I sent the confirmation from Gmail.',
        },
      },
    }
    run.tl.push({ type: 'ticket.answered', requestId, answer, memberId: ada.memberId }, 8_000)
    tickets.push({
      ...inWorkspace,
      sessionId: run.id,
      type: 'request',
      status: 'resolved',
      title: `${sam.name}: ${title}`,
      payload: { source: 'harness', teammateId: sam.id, requestId, asks },
      resolvedByMemberId: ada.memberId,
      resolvedAt: answered,
      createdAt: opened,
    })
    run.interventions++
    run.report(
      'billing_or_data',
      'escalated',
      'GDPR deletion request: escalated to Ada, who deleted the data and sent the drafted reply.',
    )
    run.tl.say('Ada handled the deletion and sent the reply; closed as escalated.')
    run.tl.end()
  }
  {
    // Ada joins this one after it ended: it is in the sidebar's Threads from then on.
    const run = live(
      mail(
        'Jonas Berg <jonas@pied-piper.test>',
        'Our workspace is read-only',
        'Hi, since this morning we cannot edit anything, the whole workspace says "read-only". We have a release tomorrow, please help!\nJonas, Pied Piper',
        ago(2 * DAY + 22 * HOUR),
      ),
    )
    const m = run.first!
    run.triage('account_problem')
    run.stripe(
      'stripe_search_customers',
      { query: `email:'${m.email}'`, limit: 5 },
      `customer search email:'${m.email}'`,
      [{ id: 'cus_PiedPiper', name: 'Pied Piper', email: m.email }],
    )
    run.stripe(
      'stripe_list_invoices',
      { customerId: 'cus_PiedPiper', status: 'open' },
      'invoices of customer cus_PiedPiper',
      [
        {
          id: 'in_PiedPiper_1042',
          status: 'open',
          amount_due: 9600,
          attempt_count: 3,
          last_error: 'card_declined',
        },
      ],
    )
    run.reply(
      m,
      letter(
        m.first,
        "Your workspace went read-only because this month's invoice ($96) couldn't be charged: the card on file was declined three times. Update the card in Settings → Billing → Payment method and everything is editable again within a minute.",
        `${DOCS}/billing/card`,
      ),
      { by: ada.memberId, after: 11 * MIN },
    )
    run.report(
      'account_problem',
      'resolved',
      'Card declined, invoice unpaid: explained how to update the card.',
    )
    run.tl.say('Answered Jonas: the card was declined; told him how to update it.')
    run.tl.end()
    const thanks = mail(
      m.from,
      re(m.subject),
      "Card updated, we're back. Thanks for the fast answer!\nJonas",
      new Date(run.tl.now.getTime() + 2 * HOUR + 50 * MIN),
      m.threadId,
    )
    run.incoming(thanks)
    run.triage('account_problem')
    run.stripe(
      'stripe_list_invoices',
      { customerId: 'cus_PiedPiper' },
      'invoices of customer cus_PiedPiper',
      [{ id: 'in_PiedPiper_1042', status: 'paid', amount_due: 0, amount_paid: 9600 }],
    )
    run.report(
      'account_problem',
      'resolved',
      'Card updated and the invoice paid; nothing more to answer.',
    )
    run.tl.say('Jonas updated the card and the invoice is paid; nothing to answer.')
    run.tl.end()
    run.member(
      'Sam, our payment reminders went to their spam, so they had no warning. Tell Jonas we added a free month as an apology; I put the credit on their account in Stripe.',
      ada.memberId,
      new Date(run.tl.now.getTime() + 4 * HOUR),
    )
    run.reply(
      thanks,
      letter(
        m.first,
        "Glad you're back! Our payment reminders ended up in your spam folder, so you had no warning, and that's on us. We've added a free month to your account as an apology; it shows on your next invoice.",
      ),
      { by: ada.memberId, after: 3 * MIN },
    )
    run.report(
      'account_problem',
      'resolved',
      'Told Jonas about the free month Ada credited, as an apology.',
    )
    run.tl.say('Sent: Jonas knows about the free month, credited on his next invoice.')
    run.tl.end()
  }

  // Three questions that piled up overnight, approved together by Bob: they do not count
  // toward trust. Sam labeled the last one as a bug by mistake; Ada marked that as wrong.
  const flaggedCall = randomUUID()
  const overnight: { run: Run; page: string; answer: string }[] = []
  for (const [from, subject, body, at, page, text, answer] of [
    [
      'Nadia Petrova <nadia@tyrell.test>',
      'API token',
      'Where do I find an API token? I want to pull our tasks into a dashboard.\nNadia',
      ago(2 * DAY + 5 * HOUR),
      '/api-tokens',
      'API tokens: Settings → API → New token. Choose read-only or read and write.',
      'Create one in Settings → API → New token. A token can read everything you can, so pick read-only for a dashboard.',
    ],
    [
      'Lucas Martin <lucas@cyberdyne.test>',
      'Export a project to PDF',
      'Hi, can I export a whole project, tasks and comments, as a PDF for a client report?\nLucas',
      ago(DAY + 19 * HOUR),
      '/export',
      'Export a project from its ⋯ menu → Export: PDF or CSV. Tick "Include comments" to add them.',
      'Yes: open the project, then ⋯ → Export → PDF. Tick "Include comments" and they are in it too.',
    ],
    [
      'Grace Kim <grace@wayne.test>',
      'Change the workspace owner',
      'Our workspace owner is leaving the company. How do we make someone else the owner?\nGrace',
      ago(DAY + 17 * HOUR),
      '/members',
      "The owner transfers ownership in Settings → Members: the new owner's ⋯ menu → Make owner.",
      "The current owner can hand it over in Settings → Members: open the new owner's ⋯ menu and choose Make owner. If they have already left, write from an admin's address and we'll do it for you.",
    ],
  ] as const) {
    const run = live(mail(from, subject, body, at))
    run.triage('documented_question')
    run.docs(page, text)
    if (overnight.length === 2) run.label(run.first!, 'bug', flaggedCall)
    overnight.push({ run, page, answer })
  }
  // Each asked as its turn went; all decided when Bob opened the group.
  const together = ago(DAY + 13 * HOUR)
  for (const { run, page, answer } of overnight) {
    const m = run.first!
    run.reply(m, letter(m.first, answer, `${DOCS}${page}`), {
      by: bob.memberId,
      after: together.getTime() - run.tl.now.getTime(),
      bulk: true,
    })
    run.report('documented_question', 'resolved', `Answered from the docs (${DOCS}${page}).`)
    run.tl.say(`Answered ${m.first} from the docs.`)
    run.tl.end()
  }
  const flaggedAt = ago(DAY + 12 * HOUR)
  const restoredAt = ago(DAY + 11 * HOUR)

  {
    const run = live(
      mail(
        'Ravi Kumar <ravi@oscorp.test>',
        'Automatic reply: Your Acme invoice',
        "I'm out of the office until Monday with limited access to email. For urgent matters, contact finance@oscorp.test.",
        ago(DAY + 5 * HOUR),
      ),
    )
    run.triage('noise')
    run.label(run.first!, 'noise')
    run.report('noise', 'noise', 'An out-of-office reply: labeled Noise and archived.')
    run.tl.say('An automatic reply: labeled Noise and archived.')
    run.tl.end()
  }

  // A new bug: its fix's pull request waits for a person to merge it.
  const invites = live(
    mail(
      'Elena García <elena@monarch.test>',
      'Invite link says expired',
      'Hi, every invite link I send says "This invite has expired" as soon as people click it, even brand-new ones. We are trying to onboard 6 people today.\nElena',
      ago(21 * HOUR + 40 * MIN),
    ),
  )
  {
    const m = invites.first!
    invites.triage('bug')
    invites.label(m, 'bug')
    invites.reply(
      m,
      letter(
        m.first,
        'Sorry about this, and thanks for the clear report. We can see the problem with new invite links and are fixing it now. Until then, you can add people directly from Settings → Members → Add by email, which does not use the link.',
      ),
      { by: ada.memberId, after: 38 * MIN },
    )
    invites.tl.tool(
      harness('list_children'),
      {},
      {
        children: [],
        fromOtherRuns: [
          {
            threadId: csvFix.id,
            title: csvFix.title,
            teammate: sam.name,
            status: 'finished',
            waitingForIt: false,
            startedAt: csvFix.startedAt.toISOString(),
            report: { status: 'report', summary: csvFix.report!.summary },
            following: false,
          },
        ],
      },
      1_000,
    )
    const fix = new Child(
      invites,
      'Fix invite links that expire at once',
      'New invite links say "This invite has expired" as soon as they are opened, even right after they are sent. Find the cause in acme/web, fix it with a test, open a pull request and merge it once its checks pass.',
    )
    invites.tl.say(
      'Told Elena we are on it, with a way to add people meanwhile, and started a fix in a child thread.',
    )
    invites.tl.end()
    fix.fix(
      'brigade/sam-invite-expiry',
      "✗ invites › a new link is valid for 7 days\n  expected 'valid', received 'expired'\nTests: 1 failed, 31 passed, 32 total",
      ['web/lib/invites.ts', 'web/lib/invites.test.ts'],
      'Tests: 33 passed, 33 total',
    )
    fix.push('brigade/sam-invite-expiry')
    fix.openPullRequest(
      146,
      'Invite links: compare the expiry in milliseconds',
      'brigade/sam-invite-expiry',
      'The expiry was saved in seconds and compared with Date.now() in milliseconds, so every link read as expired. Both are now milliseconds. Covered by a test.',
    )
    fix.merge(146, 'pending')
  }

  // The weekly review, last Monday: the schedule's run.
  const monday = nextRun(schedule.cron, schedule.timezone, ago(7 * DAY))
  if (monday && monday.getTime() < Date.now() - 10 * MIN) {
    const run = new Run(null, monday)
    runs.push(run)
    run.tl.user(
      [
        `Scheduled run of "${schedule.title}", due ${localTime(monday, schedule.timezone)} (${schedule.timezone}). Nobody is watching this thread live: do the work below, and open a ticket if you need a person.`,
        '',
        schedule.instructions,
      ].join('\n'),
      null,
    )
    run.tl.start()
    const week = runs.filter(
      (r) =>
        r.first &&
        r.startedAt.getTime() < monday.getTime() &&
        r.startedAt.getTime() >= monday.getTime() - 7 * DAY,
    )
    run.read(
      input.gmail.id,
      'gmail_search',
      { query: `to:${SUPPORT} newer_than:7d`, maxResults: 25 },
      `search "to:${SUPPORT} newer_than:7d"`,
      {
        messages: week.map((r) => ({
          id: r.first!.id,
          threadId: r.first!.threadId,
          from: r.first!.from,
          subject: r.first!.subject,
          date: rfc2822(r.first!.at),
        })),
      },
    )
    const count = (kase: string) => week.filter((r) => r.kase === kase).length
    const lines = [
      `Last week: ${week.length} mail${week.length === 1 ? '' : 's'} to ${SUPPORT}.`,
      `- ${count('documented_question')} questions answered from the docs, ${count('account_problem')} account problems, ${count('bug')} bugs, ${count('feature_request')} feature requests, ${count('noise')} noise.`,
      '- Every reply went out after a person approved it.',
      '- Nothing is still open.',
      'For the recipe: account answers could link the billing pages of the docs more often.',
    ]
    run.report('weekly_review', 'resolved', lines[0]!)
    run.tl.say(lines.join('\n'))
    run.tl.end()
  }

  // Waiting now: three replies, newest last.
  {
    const run = live(
      mail(
        'Hannah Weber <hannah@initrode.test>',
        'Move a task to another project',
        'Hi! Can I move a task with its comments from one project to another, or do I have to copy it?\nHannah',
        ago(5 * HOUR + 10 * MIN),
      ),
    )
    const m = run.first!
    run.triage('documented_question')
    run.docs(
      '/move-tasks',
      'Move a task from its ⋯ menu → Move to project. Comments, files and history move with it.',
    )
    run.reply(
      m,
      letter(
        m.first,
        'You can move it: open the task, then ⋯ → Move to project. Its comments, files and history move with it.',
        `${DOCS}/move-tasks`,
      ),
      'pending',
    )
  }
  {
    const run = live(
      mail(
        'Marco Bianchi <marco@stark.test>',
        'Billed for 12 seats, we are 9',
        'Hello, our last invoice charged 12 seats but we only have 9 people. Can you check?\nMarco, Stark',
        ago(3 * HOUR + 5 * MIN),
      ),
    )
    const m = run.first!
    run.triage('account_problem')
    run.stripe(
      'stripe_search_customers',
      { query: `email:'${m.email}'`, limit: 5 },
      `customer search email:'${m.email}'`,
      [{ id: 'cus_Stark', name: 'Stark', email: m.email }],
    )
    run.stripe(
      'stripe_list_subscriptions',
      { customerId: 'cus_Stark' },
      'subscriptions of customer cus_Stark',
      [{ id: 'sub_Stark', plan: 'Pro', status: 'active', quantity: 12, seats_used: 9 }],
    )
    run.reply(
      m,
      letter(
        m.first,
        'Your plan has 12 seats: 3 were added two weeks ago and are still on it, even though nobody uses them. Remove them in Settings → Billing → Seats and your next invoice is for 9; the unused time is credited automatically.',
        `${DOCS}/seats`,
      ),
      'pending',
    )
  }
  {
    const run = live(
      mail(
        'Ines Moreau <ines@duff.test>',
        'Timeline view?',
        'Do you plan a timeline or Gantt view? We plan launches across several teams and miss it a lot.\nInes',
        ago(52 * MIN),
      ),
    )
    const m = run.first!
    run.triage('feature_request')
    backlog(
      run,
      'Timeline view for projects',
      'A timeline (Gantt) view of a project, to plan launches across several teams. First asked by Ines at Duff.',
    )
    run.label(m, 'idea')
    run.reply(
      m,
      letter(
        m.first,
        "Not yet, but you're not the first to ask: I've added a timeline view to our list, with launches across teams as the use case. I'll write when it ships.",
      ),
      'pending',
    )
  }

  // -------------------------------------------------------------------------
  // Saved, oldest first: runs and their children, then what they left
  // -------------------------------------------------------------------------
  runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
  for (const run of runs) await run.save()
  await prisma.task.createMany({ data: tasks })
  await prisma.connectionCall.createMany({ data: calls })
  await prisma.ticket.createMany({ data: tickets })

  // The fixes' pull requests, as the GitHub calls recorded them: one merged, one waiting.
  const pullRequest = (fix: Child, number: number, title: string, headRef: string) => ({
    ...inWorkspace,
    repository: input.repository,
    number,
    title,
    headRef,
    baseRef: 'main',
    sessionId: fix.id,
    authorTeammateId: sam.id,
    createdAt: fix.openedAt!,
  })
  await prisma.pullRequest.createMany({
    data: [
      {
        ...pullRequest(
          csvFix,
          141,
          'Fix the CSV export for invoices without a due date',
          'brigade/sam-csv-export-500',
        ),
        state: 'merged',
        mergedAt: fixed,
        updatedAt: fixed,
      },
      pullRequest(
        invites.children[0]!,
        146,
        'Invite links: compare the expiry in milliseconds',
        'brigade/sam-invite-expiry',
      ),
    ],
  })

  // Audit entries of what happened back then, at their time (audit() writes the present).
  const audits = (
    rows: {
      actor: { type: 'member' | 'teammate'; id: string }
      action: string
      target: { type: string; id: string }
      data: object
      at: Date
    }[],
  ) =>
    prisma.auditEntry.createMany({
      data: rows.map((r) => ({
        organizationId,
        workspaceId,
        actorType: r.actor.type,
        actorId: r.actor.id,
        action: r.action,
        targetType: r.target.type,
        targetId: r.target.id,
        data: r.data as Prisma.InputJsonValue,
        at: r.at,
      })),
    })

  // The two runs that followed the CSV fix, told when it reported.
  await prisma.threadFollow.createMany({
    data: followers.map((run) => ({
      ...inWorkspace,
      sessionId: csvFix.id,
      followerId: run.id,
      deliveredAt: fixed,
      createdAt: run.followedAt!,
    })),
  })
  await audits(
    followers.map((run) => ({
      actor: { type: 'teammate', id: sam.id },
      action: 'thread.followed',
      target: { type: 'thread', id: csvFix.id },
      data: { followerId: run.id },
      at: run.followedAt!,
    })),
  )

  // The mislabeled mail, marked as wrong: labels went back to asking, until Ada let them
  // act on their own again an hour later (flagCall, then changeAction).
  const asAda = { type: 'member' as const, id: ada.memberId }
  await audits([
    {
      actor: asAda,
      action: 'playbook.call_flagged',
      target: { type: 'connection_call', id: flaggedCall },
      data: { installationId, action: 'label', demoted: true },
      at: flaggedAt,
    },
    {
      actor: asAda,
      action: 'playbook.action_changed',
      target: { type: 'playbook', id: installationId },
      data: { action: 'label', from: 'ask', to: 'auto', conditions: {} },
      at: restoredAt,
    },
  ])
  await prisma.playbookAction.updateMany({
    where: { installationId, key: 'label' },
    data: { level: 'auto', levelChangedAt: restoredAt, levelChangedByMemberId: ada.memberId },
  })

  // People approved 29 of the last 30 replies they decided one by one: the latest decision
  // earned the proposal to let it reply on its own, in that decision's thread.
  const counted = replyDecisions
    .filter((d) => d.counted)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const latest = counted.at(-1)!
  const promotion = await proposePromotion(db, scope, {
    installationId,
    actionKey: 'reply',
    sessionId: latest.sessionId,
  })
  if (!promotion)
    throw new Error(
      `The sample's reply decisions do not earn a proposal: ${counted.length} counted`,
    )
  await prisma.ticket.update({
    where: { id: promotion },
    data: { createdAt: new Date(latest.at.getTime() + 1_000) },
  })

  console.log(
    `created: playbook ${manifest.name} for ${sam.name} (${runs.length} runs, ${dryRuns.length} in its dry run)`,
  )
}
