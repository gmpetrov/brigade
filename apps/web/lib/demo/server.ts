// The demo's API, in the browser: the responses recorded from the sample Acme workspace
// (fixtures.json, scripts/demo-record.mjs), with the writes that matter done in memory
// (approve or decline a ticket, answer a question, merge a pull request, archive a thread,
// send a message) and the others accepted without effect. A reload starts over.
import type { ApiToBrowser, SequencedEvent } from '@brigade/contracts'
import fixtures from './fixtures.json'
import { demoUsage } from './usage'
import { DEMO_API, DEMO_THREAD } from './flag'
import { demoPulls, mergedPull, newPull, type DemoPull, type NewPull } from './pulls'
import { afterDecision, replyTo, type Run } from './scripts'
import { keyOf, reviveDates } from './shared'

type Stored = { status: number; body: unknown }
type AgentEvent = SequencedEvent['event']
type Json = Record<string, unknown>

// Dates move with the time the demo is opened, so the workspace always looks current.
const shift = Date.now() - Date.parse(fixtures.recordedAt)
const store = new Map<string, Stored>(
  Object.entries(
    reviveDates(fixtures.responses, shift, typeof location === 'undefined' ? '' : location.origin),
  ) as [string, Stored][],
)

// No computer is there in the demo; it acts as though the cloud one runs.
walk((o) => {
  if (typeof o.online === 'boolean' && (o.kind === 'cloud' || 'restarting' in o)) {
    o.online = true
    if (o.status === 'stopped') o.status = 'running'
  }
})

const body = <T>(key: string) => store.get(key)?.body as T | undefined
const me = body<{ memberId: string; user: { name: string } }>('GET /me')!
const teammates =
  body<{ id: string; name: string; harness: string; model: string | null }[]>('GET /teammates') ??
  []

// What a first-time visitor sees: three teammates with a job each and a few quiet threads. The
// sample workspace has more (a failed upgrade, a stalled thread, App writes waiting in their raw
// form), right for trying the dashboard, noise for someone meeting Brigade. The rest stays out
// of every list, and no ticket waits: the walkthroughs (lib/demo/tour.ts) start their own
// threads and ask for their own approvals.
const SHOWN_THREADS = [
  'Annual billing toggle on the pricing page',
  'Weekly support digest',
  'Launch post outline',
]
const HIDDEN_TEAMMATES = ['Kai']
// Each one shown says its job (the sample was recorded before Chief and Maya had a title).
const TITLES: Record<string, string> = { Chief: 'Chief of staff', Maya: 'Marketing lead' }
// The tickets as recorded, before calm() empties the lists: a new approval copies one of its kind.
const ticketTemplates = structuredClone(body<Json[]>('GET /tickets') ?? [])
calm()
const pulls = demoPulls(store)

function calm() {
  const hidden = new Set(
    (body<Json[]>('GET /threads') ?? [])
      .filter((t) => !SHOWN_THREADS.includes(String(t.title)))
      .map((t) => String(t.id)),
  )
  const mates = new Set(teammates.filter((t) => HIDDEN_TEAMMATES.includes(t.name)).map((t) => t.id))
  const ref = (v: unknown) => (v && typeof v === 'object' ? String((v as Json).id) : undefined)
  const gone = (o: Json) =>
    (typeof o.title === 'string' && 'status' in o && hidden.has(String(o.id))) ||
    hidden.has(String(o.sessionId)) ||
    hidden.has(ref(o.session) ?? '') ||
    hidden.has(ref(o.thread) ?? '') ||
    // Home's loose ends: a missed routine, a quiet thread, an offer left unanswered.
    o.kind === 'stalled' ||
    o.kind === 'proposal' ||
    (o.kind === 'routine' && 'error' in o) ||
    (mates.has(String(o.id)) && 'harness' in o)
  const prune = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value
        .filter((v) => !(v && typeof v === 'object' && !Array.isArray(v) && gone(v as Json)))
        .map(prune)
    if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) (value as Json)[k] = prune(v)
    return value
  }
  for (const [key, stored] of store)
    // A hidden thread's own page stays as it was, should a link still lead there.
    if (!/^GET \/threads\/[^/?]+(\/events)?$/.test(key)) stored.body = prune(stored.body)
  // Nothing waits on the visitor yet: the walkthrough's own approval is the first thing that does.
  for (const [key, stored] of store) if (key.startsWith('GET /tickets')) stored.body = []
  // No pull request waits either: the walkthroughs open theirs (and demoPulls() builds the open
  // ones from this list).
  const attention = body<Json>('GET /pulls/attention')
  if (attention) Object.assign(attention, { pulls: [], count: 0, open: 0 })
  teammates.splice(0, teammates.length, ...teammates.filter((t) => !mates.has(t.id)))
  walk((o) => {
    if ('harness' in o && typeof o.name === 'string' && TITLES[o.name] && !o.title)
      o.title = TITLES[o.name]
  })
}

/** Every object in every response, for a change that shows wherever the thing is. */
function walk(visit: (o: Json, parent: unknown[] | Json) => void) {
  const seen = new Set<unknown>()
  const go = (value: unknown, parent: unknown[] | Json) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) value.forEach((v) => go(v, value))
    else {
      visit(value as Json, parent)
      for (const v of Object.values(value)) go(v, value as Json)
    }
  }
  for (const s of store.values()) go(s.body, [])
}

/** Changes the thread wherever it shows: its page, the lists, Home. */
function patchThread(id: string, patch: Json) {
  walk((o) => {
    if (o.id === id && 'status' in o && 'title' in o) Object.assign(o, patch)
  })
}

/** Takes the ticket out of every list it is in (Tickets, Home, its thread's). */
function removeTicket(id: string) {
  for (const s of store.values()) {
    const prune = (value: unknown): unknown => {
      if (Array.isArray(value))
        return value
          .filter((v) => !(v && typeof v === 'object' && (v as Json).id === id))
          .map(prune)
      if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) (value as Json)[k] = prune(v)
      return value
    }
    s.body = prune(s.body)
  }
}

// The dashboard's sockets: each one gets every message, and a page keeps its own thread's.
const sockets = new Set<(message: ApiToBrowser) => void>()
export function connect(send: (message: ApiToBrowser) => void) {
  sockets.add(send)
  return () => void sockets.delete(send)
}
export function receive(data: string, reply: (message: ApiToBrowser) => void) {
  const message = JSON.parse(data) as { type?: string; sessionId?: string }
  if (message.type !== 'subscribe' || !message.sessionId) return
  const thread = body<{ status: string; computer?: Json }>(`GET /threads/${message.sessionId}`)
  if (thread)
    reply({
      type: 'thread.updated',
      sessionId: message.sessionId,
      status: thread.status,
      ...(thread.computer?.id
        ? {
            computer: {
              id: String(thread.computer.id),
              online: true,
              restarting: false,
              status: String(thread.computer.status ?? 'running'),
            },
          }
        : {}),
    })
}
const broadcast = (message: ApiToBrowser) => sockets.forEach((send) => send(message))

// ---- Threads and their events ----

type Page = {
  firstSeq: number
  lastSeq: number
  context: SequencedEvent[]
  events: SequencedEvent[]
}
const page = (threadId: string) => {
  const key = `GET /threads/${threadId}/events`
  if (!store.has(key))
    store.set(key, { status: 200, body: { firstSeq: 1, lastSeq: 0, context: [], events: [] } })
  return store.get(key)!.body as Page
}
const allEvents = (threadId: string) => {
  const p = page(threadId)
  return [...p.context, ...p.events]
}

function emit(threadId: string, events: AgentEvent[]) {
  const p = page(threadId)
  const sequenced = events.map((event) => ({ sessionId: threadId, seq: ++p.lastSeq, event }))
  p.events.push(...sequenced)
  // Not for each word of a reply: that goes through every response, and the reply's end does it.
  if (events.some((e) => e.type !== 'message.delta'))
    patchThread(threadId, { lastSeq: p.lastSeq, updatedAt: new Date().toISOString() })
  broadcast({ type: 'events', events: sequenced })
}

function setStatus(threadId: string, status: string) {
  patchThread(threadId, { status })
  broadcast({ type: 'thread.updated', sessionId: threadId, status })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const id = () => Math.random().toString(16).slice(2, 18)
const now = () => new Date().toISOString()
// One run at a time per thread: a message sent meanwhile waits for it.
const running = new Map<string, Promise<void>>()

/** Plays a scripted turn the way a runner streams one: steps, then the reply word by word. */
function play(threadId: string, run: Run) {
  const previous = running.get(threadId) ?? Promise.resolve()
  const next = previous.then(async () => {
    const thread = body<{ teammate?: { id: string }; accountId?: string }>(
      `GET /threads/${threadId}`,
    )
    const teammateId = run.teammateId ?? thread?.teammate?.id ?? teammates[0]?.id ?? ''
    const by = { teammateId }
    setStatus(threadId, 'running')
    if (!run.continues)
      emit(threadId, [
        {
          at: now(),
          type: 'turn.started',
          turnId: id(),
          accountId: thread?.accountId ?? '',
          ...by,
        },
      ])
    for (const step of run.steps) {
      await wait(step.ms ?? 900)
      if ('tool' in step) {
        const toolCallId = step.toolCallId ?? `call_${id()}`
        if (!step.toolCallId)
          emit(threadId, [
            {
              at: now(),
              type: 'tool.started',
              toolCallId,
              toolName: step.tool,
              input: step.input,
              ...by,
            },
          ])
        await wait(step.takes ?? 1200)
        emit(threadId, [
          {
            at: now(),
            type: 'tool.finished',
            toolCallId,
            toolName: step.tool,
            output: step.output,
            isError: step.isError ?? false,
            ...by,
          },
        ])
        if (step.then) step.then()
      } else if ('file' in step) {
        emit(threadId, [
          { at: now(), type: 'file.changed', path: step.file, toolName: 'Edit', ...by },
        ])
      } else if ('say' in step) {
        const messageId = id()
        const words = step.say.split(/(?<=\s)/)
        for (let i = 0; i < words.length; i += 4) {
          emit(threadId, [
            {
              at: now(),
              type: 'message.delta',
              id: messageId,
              text: words.slice(i, i + 4).join(''),
              ...by,
            },
          ])
          await wait(45)
        }
        emit(threadId, [{ at: now(), type: 'message.done', id: messageId, text: step.say, ...by }])
      } else if ('approval' in step) {
        // The turn waits on a person here: no end, and a ticket in Needs you.
        requestApproval(threadId, teammateId, step.approval)
        return
      }
    }
    if (run.replies?.length || run.merge) {
      const toolCallId = `call_${id()}`
      const input = {
        replies: run.replies ?? [],
        ...(run.merge ? { actions: [{ action: 'merge', label: run.merge }] } : {}),
      }
      emit(threadId, [
        { at: now(), type: 'tool.started', toolCallId, toolName: 'suggest_replies', input },
        {
          at: now(),
          type: 'tool.finished',
          toolCallId,
          toolName: 'suggest_replies',
          output: { shown: input.replies.length },
          isError: false,
        },
      ])
    }
    // After the reply's buttons, as the runner records a replies block.
    emit(threadId, [{ at: now(), type: 'turn.completed', finishReason: 'stop', ...by }])
    setStatus(threadId, run.status ?? 'idle')
    if (run.done) run.done()
  })
  running.set(
    threadId,
    next.catch(() => undefined),
  )
}

function sendMessage(threadId: string, text: string) {
  emit(threadId, [{ at: now(), type: 'message.user', text, memberId: me.memberId }])
  // Written in again, an archived thread is back in the sidebar.
  if (body<Json>(`GET /threads/${threadId}`)?.archivedAt) unarchive(threadId)
  const thread = body<{ title: string; teammate?: { id: string; name: string } }>(
    `GET /threads/${threadId}`,
  )
  play(threadId, replyTo(text, { threadId, thread, teammates, actions }))
}

/** What scripted runs may do to the workspace (lib/demo/scripts.ts). */
const actions = {
  openPull: (
    threadId: string,
    teammate: { id: string; name: string },
    kind?: NewPull,
    merged?: Run,
  ) => {
    const pull = newPull(threadId, teammate, kind)
    pulls.set(pull.number, pull)
    if (merged) afterMerge.set(pull.number, { threadId, run: merged })
    syncPulls()
    return pull
  },
  addRoutine,
  openTickets: () => body<{ title: string; session?: { title: string } }[]>('GET /tickets') ?? [],
  playbook: () =>
    body<{
      playbooks?: { count: number; onItsOwn: number; approvedByYou: number; withPerson: number }[]
    }>('GET /home')?.playbooks?.[0],
}

let threadCount = 0
/** A new thread from Home or a teammate's page: a copy of the teammate's latest one, empty. */
function newThread(input: {
  /** The id the dashboard chose, which opened the thread already (lib/pending-threads.ts). */
  id?: string
  text?: string
  teammateId?: string
  title?: string
  projectId?: string | null
}) {
  const teammate =
    teammates.find((t) => t.id === input.teammateId) ??
    teammates.find((t) => t.name !== 'Chief') ??
    teammates[0]!
  const list = body<Json[]>('GET /threads') ?? []
  const template =
    (list.find((t) => (t.teammate as Json | undefined)?.id === teammate.id) as Json | undefined) ??
    list[0]!
  const project = (body<Json[]>('GET /projects') ?? []).find((p) => p.id === input.projectId)
  const threadId = input.id ?? `${DEMO_THREAD}${++threadCount}-${id()}`
  const title = input.title ?? (input.text ?? 'New thread').split('\n')[0]!.slice(0, 70)
  const fresh = {
    ...structuredClone(template),
    id: threadId,
    title,
    status: 'running',
    origin: 'member',
    parentId: null,
    parentTeammateId: null,
    taskId: null,
    playbookRunId: null,
    archivedAt: null,
    pinnedAt: null,
    laterAt: null,
    lastSeq: 0,
    createdAt: now(),
    updatedAt: now(),
    startedByMemberId: me.memberId,
    startedBy: { id: me.memberId, user: { name: me.user.name } },
    // The visitor's own: they write in it, whoever started the thread it is copied from.
    private: false,
    controlledByMemberId: null,
    mayPrompt: true,
    teammateId: teammate.id,
    teammate: { id: teammate.id, name: teammate.name },
    teammates: [{ teammate: { id: teammate.id, name: teammate.name } }],
    projectId: project?.id ?? null,
    replies: 0,
    unread: false,
  }
  const detail: Json = structuredClone(body<Json>(`GET /threads/${template.id}`) ?? fresh)
  // The page's computer, with whether it is there: the list's has only its kind and name.
  const computer = detail.computer
  Object.assign(detail, fresh, {
    parent: null,
    children: [],
    tickets: [],
    attachments: [],
    task: null,
    wakeups: [],
    replyWatches: [],
    followers: [],
    reportingSchedules: [],
    trigger: null,
    schedule: null,
    // The thread's page shows the teammate's harness and model, which lists leave out.
    teammate: {
      id: teammate.id,
      name: teammate.name,
      harness: teammate.harness,
      model: teammate.model,
    },
    project: project
      ? { id: project.id, name: project.name, icon: project.icon, logo: null, archivedAt: null }
      : null,
  })
  detail.teammates = [{ joinedAt: now(), lastTurnAt: now(), teammate: detail.teammate }]
  detail.computer = computer
  store.set(`GET /threads/${threadId}`, { status: 200, body: detail })
  list.unshift(fresh)
  if (input.text) sendMessage(threadId, input.text)
  return { id: threadId }
}

// ---- Tickets ----

type Ticket = { id: string; type: string; sessionId: string | null; payload: Json; title: string }
const findTicket = (pred: (t: Ticket) => boolean) =>
  (body<Ticket[]>('GET /tickets') ?? []).find(pred)

/** A person decided: the thread goes on from where it waited, as the real one would. */
function decide(ticket: Ticket, outcome: { approved?: boolean; answer?: unknown }) {
  removeTicket(ticket.id)
  broadcast({ type: 'tickets.updated' })
  const threadId = ticket.sessionId
  if (!threadId || !store.has(`GET /threads/${threadId}`)) return
  const events = allEvents(threadId)
  const asked = [...events]
    .reverse()
    .find((e) => ['approval.requested', 'question.asked', 'ticket.opened'].includes(e.event.type))
    ?.event as Json | undefined
  if (asked?.type === 'approval.requested')
    emit(threadId, [
      {
        at: now(),
        type: 'approval.resolved',
        approvalId: String(asked.approvalId),
        approved: outcome.approved !== false,
        memberId: me.memberId,
      },
    ])
  else if (asked?.type === 'question.asked')
    emit(threadId, [
      {
        at: now(),
        type: 'question.answered',
        questionId: String(asked.questionId),
        answer: outcome.answer as never,
        memberId: me.memberId,
      },
    ])
  else if (asked?.type === 'ticket.opened')
    emit(threadId, [
      {
        at: now(),
        type: 'ticket.answered',
        requestId: String(asked.requestId),
        answer: outcome.answer as never,
        memberId: me.memberId,
      },
    ])
  const run = afterDecision(ticket, outcome, {
    asked,
    pending: pendingTool(threadId),
    merge: (number: number) => merge(number),
  })
  if (run) play(threadId, { ...run, continues: true })
}

/** The tool call an approval held, still without its result. */
function pendingTool(threadId: string) {
  const finished = new Set<string>()
  let pending: { toolCallId: string; toolName: string; input: unknown } | undefined
  for (const { event } of allEvents(threadId)) {
    if (event.type === 'tool.finished') finished.add(event.toolCallId)
    if (event.type === 'tool.started') pending = event
  }
  return pending && !finished.has(pending.toolCallId) ? pending : undefined
}

// ---- Pull requests ----

function syncPulls() {
  const open = [...pulls.values()].filter((p) => p.summary.state === 'open')
  const list = {
    pulls: [...pulls.values()].map((p) => p.summary),
    repositories: ['acme/web'],
    errors: [],
  }
  for (const key of store.keys())
    if (key.startsWith('GET /pulls?')) store.set(key, { status: 200, body: structuredClone(list) })
  const attention = store.get('GET /pulls/attention')?.body as {
    pulls: Json[]
    count: number
    open: number
  }
  if (attention) {
    const waiting = open.map((p) => ({
      repository: p.summary.repository,
      number: p.summary.number,
      title: p.summary.title,
      mergeStatus: 'none',
      updatedAt: p.summary.updatedAt,
      session: p.session,
      authorTeammate: p.summary.tracking?.author ?? null,
      review: p.summary.tracking?.review ?? null,
    }))
    Object.assign(attention, { pulls: waiting, count: waiting.length, open: waiting.length })
  }
  walk((o) => {
    if ('pullsWaiting' in o && typeof o.id === 'string')
      o.pullsWaiting = open.filter((p) => p.session?.id === o.id).length
  })
  broadcast({ type: 'pulls.updated' })
}
syncPulls()

/** What a teammate goes on with once its pull request is merged, as Brigade tells its thread. */
const afterMerge = new Map<number, { threadId: string; run: Run }>()

function merge(number: number) {
  const pull = pulls.get(number)
  if (!pull || pull.summary.state !== 'open') return false
  pulls.set(number, mergedPull(pull))
  syncPulls()
  const next = afterMerge.get(number)
  afterMerge.delete(number)
  if (next) play(next.threadId, next.run)
  return true
}

/**
 * A teammate's write to an App held for a person: its call starts, and its ticket opens in
 * Tickets, Home and the thread, as a template from the recorded ones (a Gmail send).
 */
function requestApproval(
  threadId: string,
  teammateId: string,
  ask: { tool: string; input: unknown; operation: string; target: string },
) {
  const toolCallId = `call_${id()}`
  const approvalId = `demo-approval-${id()}`
  const thread = body<Json>(`GET /threads/${threadId}`)
  const teammate = teammates.find((t) => t.id === teammateId)
  const template = (ticketTemplates as Ticket[]).find(
    (t) => t.payload?.operation === ask.operation,
  ) as (Ticket & Json) | undefined
  const ticket = {
    ...structuredClone(template ?? {}),
    id: approvalId,
    sessionId: threadId,
    type: 'approval',
    status: 'open',
    title: `${teammate?.name ?? 'Teammate'} wants to ${ask.target}`,
    payload: {
      input: ask.input,
      target: ask.target,
      operation: ask.operation,
      connection: (template?.payload?.connection as string | undefined) ?? 'support@acme.test',
      connectionId: template?.payload?.connectionId ?? null,
    },
    createdAt: now(),
    session: {
      id: threadId,
      title: thread?.title,
      origin: 'member',
      startedByMemberId: me.memberId,
      projectId: thread?.projectId ?? null,
      parentId: null,
      archivedAt: null,
      teammate: teammate ? { id: teammate.id, name: teammate.name } : null,
      laterAt: null,
    },
    playbook: null,
  }
  for (const key of ['GET /tickets', 'GET /tickets?status=open']) {
    const list = body<Json[]>(key)
    if (list) list.unshift(structuredClone(ticket))
  }
  const detail = body<{ tickets?: Json[] }>(`GET /threads/${threadId}`)
  if (detail)
    (detail.tickets ??= []).push({
      id: approvalId,
      type: 'approval',
      title: ticket.title,
      payload: ticket.payload,
      createdAt: ticket.createdAt,
    })
  emit(threadId, [
    {
      at: now(),
      type: 'tool.started',
      toolCallId,
      toolName: ask.tool,
      input: ask.input,
      teammateId,
    },
    {
      at: now(),
      type: 'approval.requested',
      approvalId,
      toolCallId,
      toolName: ask.tool,
      input: ask.input,
      teammateId,
    },
  ])
  setStatus(threadId, 'waiting')
  broadcast({ type: 'tickets.updated' })
}

/** A routine a teammate made: in Routines, from the recorded ones as a template. */
function addRoutine(routine: {
  title: string
  cron: string
  instructions: string
  teammateId: string
}) {
  const list = body<Json[]>('GET /schedules')
  const teammate = teammates.find((t) => t.id === routine.teammateId)
  if (!list || !teammate) return
  const template = list.find((s) => (s.teammate as Json | undefined)?.id === teammate.id) ?? list[0]
  list.unshift({
    ...structuredClone(template ?? {}),
    id: `demo-routine-${id()}`,
    ...routine,
    pausedAt: null,
    lastError: null,
    lastRun: null,
    parentSessionId: null,
    parentSession: null,
    createdByTeammateId: teammate.id,
    createdByTeammate: { id: teammate.id, name: teammate.name },
    nextRunAt: new Date(Date.now() + 18 * 3600_000).toISOString(),
    createdAt: now(),
    updatedAt: now(),
  })
  broadcast({ type: 'schedule.updated', scheduleId: 'demo-routine' })
}

function pullResponse(number: number, part: 'detail' | 'state'): Stored {
  const pull = pulls.get(number)
  if (!pull) return { status: 404, body: { error: 'Pull request not found' } }
  return { status: 200, body: part === 'detail' ? pull.detail() : pull.state() }
}

// ---- Requests ----

/** The sidebar's Archived (recorded, else empty), with what the visitor archived. */
const ARCHIVED = 'GET /threads?archived=1'
function archivedList() {
  if (!store.has(ARCHIVED)) store.set(ARCHIVED, { status: 200, body: [] })
  return store.get(ARCHIVED)!.body as Json[]
}

/** The thread lists (all threads, a project's) an archived thread left, and where it was. */
const leftLists = new Map<string, { key: string; index: number }[]>()
const isThreadList = (key: string) => /^GET \/threads(\?|$)/.test(key) && key !== ARCHIVED

function archive(threadId: string) {
  patchThread(threadId, { archivedAt: now() })
  let row: Json | undefined
  const left: { key: string; index: number }[] = []
  for (const [key, s] of store) {
    if (!isThreadList(key) || !Array.isArray(s.body)) continue
    const index = s.body.findIndex((t: Json) => t.id === threadId)
    if (index === -1) continue
    row ??= s.body[index]
    left.push({ key, index })
    s.body = s.body.filter((t: Json) => t.id !== threadId)
  }
  leftLists.set(threadId, left)
  // To the sidebar's Archived, where it can be found and brought back.
  const archived = archivedList()
  if (!archived.some((t) => t.id === threadId))
    archived.unshift(structuredClone(row ?? body<Json>(`GET /threads/${threadId}`) ?? {}))
}

/** Back in every list it left; one archived before the demo opened, in all threads and its project's. */
function unarchive(threadId: string) {
  const archived = archivedList()
  const row = archived.find((t) => t.id === threadId) ?? body<Json>(`GET /threads/${threadId}`)
  store.get(ARCHIVED)!.body = archived.filter((t) => t.id !== threadId)
  patchThread(threadId, { archivedAt: null })
  if (!row) return
  const projectId = row.projectId as string | null | undefined
  const left = leftLists.get(threadId) ?? [
    { key: 'GET /threads', index: 0 },
    ...(projectId ? [{ key: `GET /threads?project=${projectId}`, index: 0 }] : []),
  ]
  leftLists.delete(threadId)
  for (const { key, index } of left) {
    const list = store.get(key)?.body
    if (!Array.isArray(list) || list.some((t: Json) => t.id === threadId)) continue
    list.splice(Math.min(index, list.length), 0, { ...structuredClone(row), archivedAt: null })
  }
}

const OFF = 'That is off in the demo workspace. Sign up to do it for real.'
const CREATES =
  /^\/(teammates|teammates\/team|tasks|projects|projects\/site(\/brief)?|schedules|credentials|triggers|accounts|workspaces|uploads|attachments\/uploads|library\/assets\/uploads|library\/(text|folders|files)|skills\/packs|skills\/import.*|connections\/.+|computers\/(link-code|cloud)|billing\/(checkout|portal)|notifications\/devices)$/

/** Gets the pattern's groups, the request's JSON body and its URL. */
const sidebarOrder: Record<'teammates' | 'projects', string[]> = { teammates: [], projects: [] }

type Handler = (params: [string, string], input: Json, url: URL) => Stored | unknown | undefined
const ok = { ok: true }
const routes: [string, RegExp, Handler][] = [
  ['POST', /^\/threads$/, (_, input) => newThread(input as never)],
  // Lists (docs/lists.md) were recorded before they existed: none, and handing lines over is off.
  ['GET', /^\/lists$/, () => []],
  ['POST', /^\/lists\/.+$/, () => ({ status: 403, body: { error: OFF } })],
  ['PUT', /^\/lists\/.+$/, () => ({ status: 403, body: { error: OFF } })],
  [
    'POST',
    /^\/threads\/([^/]+)\/messages$/,
    ([threadId], input) => {
      sendMessage(threadId, String(input.text ?? ''))
      return { ok: true, paused: false, delivery: 'sent' }
    },
  ],
  [
    'POST',
    /^\/threads\/([^/]+)\/approvals$/,
    ([threadId], input) => {
      const t = findTicket(
        (t) =>
          t.sessionId === threadId &&
          (t.id === input.approvalId || t.payload?.approvalId === input.approvalId),
      )
      if (t) decide(t, { approved: Boolean(input.approved) })
      return { ok: true, live: true }
    },
  ],
  [
    'POST',
    /^\/threads\/([^/]+)\/answers$/,
    ([threadId], input) => {
      const t = findTicket(
        (t) => t.sessionId === threadId && t.payload?.questionId === input.questionId,
      )
      if (t) decide(t, { answer: input.answer })
      return ok
    },
  ],
  [
    'POST',
    /^\/threads\/([^/]+)\/tickets$/,
    ([threadId], input) => {
      const t = findTicket(
        (t) => t.sessionId === threadId && t.payload?.requestId === input.requestId,
      )
      if (t) decide(t, { answer: input.answer })
      return ok
    },
  ],
  [
    'POST',
    /^\/tickets\/([^/]+)\/resolve$/,
    ([ticketId], input) => {
      const t = findTicket((t) => t.id === ticketId)
      if (t) decide(t, { approved: Boolean(input.approved) })
      return { ok: true, live: true }
    },
  ],
  [
    'POST',
    /^\/tickets\/([^/]+)\/answer$/,
    ([ticketId], input) => {
      const t = findTicket((t) => t.id === ticketId)
      if (t) decide(t, { answer: input.answer })
      return ok
    },
  ],
  [
    'POST',
    /^\/threads\/([^/]+)\/archive$/,
    ([threadId]) => {
      archive(threadId)
      broadcast({
        type: 'thread.updated',
        sessionId: threadId,
        status: String(body<Json>(`GET /threads/${threadId}`)?.status ?? 'idle'),
      })
      return ok
    },
  ],
  [
    'DELETE',
    /^\/threads\/([^/]+)\/archive$/,
    ([threadId]) => {
      unarchive(threadId)
      return ok
    },
  ],
  [
    'POST',
    /^\/threads\/([^/]+)\/(pin|later)$/,
    ([threadId, what]) => (
      patchThread(threadId, { [`${what === 'pin' ? 'pinned' : 'later'}At`]: now() }),
      ok
    ),
  ],
  [
    'DELETE',
    /^\/threads\/([^/]+)\/(pin|later)$/,
    ([threadId, what]) => (
      patchThread(threadId, { [`${what === 'pin' ? 'pinned' : 'later'}At`]: null }),
      ok
    ),
  ],
  // The sidebar's teammates and projects, in the order dragged to, for this visit.
  ['GET', /^\/me\/sidebar-order$/, () => structuredClone(sidebarOrder)],
  [
    'PUT',
    /^\/me\/sidebar-order$/,
    (_, input) => {
      if (input.list === 'teammates' || input.list === 'projects')
        sidebarOrder[input.list] = Array.isArray(input.ids) ? input.ids.map(String) : []
      return { status: 204, body: null }
    },
  ],
  [
    'POST',
    /^\/pulls\/acme\/web\/(\d+)\/merge$/,
    ([number]) => (merge(Number(number)) ? ok : { status: 409, body: { error: 'Already merged' } }),
  ],
  ['GET', /^\/usage$/, (_, __, url) => demoUsageFor(url)],
  ['GET', /^\/pulls\/acme\/web\/(\d+)$/, ([number]) => pullResponse(Number(number), 'detail')],
  [
    'GET',
    /^\/pulls\/acme\/web\/(\d+)\/state$/,
    ([number]) => pullResponse(Number(number), 'state'),
  ],
  [
    'GET',
    /^\/threads\/([^/]+)\/events$/,
    ([threadId], _, url) =>
      url.searchParams.has('before')
        ? { firstSeq: 1, events: [] }
        : // A demo thread is loaded whole: the timeline never needs a page of it.
          url.searchParams.has('from')
          ? { firstSeq: 1, endSeq: 1, events: [] }
          : structuredClone(page(threadId)),
  ],
  ['GET', /^\/threads\/([^/]+)\/prompts$/, () => []],
  // What makes something new (a teammate, a task, a project, an App, a file) answers with
  // what it made, which the page then opens: in the demo it says it is off, where the
  // page shows errors, rather than open nothing.
  ['POST', CREATES, () => ({ status: 403, body: { error: OFF } })],
  ['PUT', /^\/library\/(text|folders)$/, () => ({ status: 403, body: { error: OFF } })],
  // Signing out of the demo leads to signing up for real.
  ['POST', /^\/auth\/sign-out$/, () => ({ success: true })],
  [
    'GET',
    /^\/auth\/get-session$/,
    () => ({ session: { id: 'demo' }, user: body<Json>('GET /me')?.user }),
  ],
]

/** Settings › Usage, made up from the sample's threads, teammates and routines. */
function demoUsageFor(url: URL) {
  const asked = Number(url.searchParams.get('days'))
  return demoUsage(asked === 1 || asked === 30 ? asked : 7, {
    threads:
      body<{ id: string; title: string; teammateId: string; origin: string }[]>('GET /threads') ??
      [],
    teammates,
    schedules: body<{ id: string; title: string }[]>('GET /schedules') ?? [],
    member: { id: me.memberId, name: me.user.name },
  })
}

function respond({ status, body }: Stored) {
  if (status === 204) return new Response(null, { status })
  if (body && typeof body === 'object' && '$text' in body) {
    const { $text, type } = body as { $text: string; type: string }
    return new Response($text, { status, headers: { 'content-type': type } })
  }
  return Response.json(body ?? {}, { status })
}

const isStored = (value: unknown): value is Stored =>
  !!value &&
  typeof value === 'object' &&
  'status' in value &&
  'body' in value &&
  Object.keys(value).length === 2

/** Answers one request to DEMO_API. */
export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '')
  const method = request.method.toUpperCase()
  let input: Json = {}
  if (method !== 'GET' && method !== 'HEAD') {
    const text = await request.text().catch(() => '')
    try {
      input = text ? JSON.parse(text) : {}
    } catch {}
  }
  // A beat, as a network would take: the pages show what they show while loading.
  await wait(method === 'GET' ? 60 : 120)
  for (const [m, pattern, handler] of routes) {
    const match = m === method ? path.match(pattern) : null
    if (!match) continue
    const out = handler(match.slice(1) as [string, string], input, url)
    if (out !== undefined) return respond(isStored(out) ? out : { status: 200, body: out })
  }
  if (method === 'GET') {
    const key = keyOf('GET', `${DEMO_API}${url.pathname}${url.search}`)
    const found = store.get(key) ?? store.get(key.split('?')[0]!)
    if (found) return respond({ status: found.status, body: structuredClone(found.body) })
    if (process.env.NODE_ENV !== 'production') console.warn(`[demo] no fixture for ${key}`)
    return respond({ status: 404, body: { error: 'Not in the demo' } })
  }
  // Any other write: accepted, with nothing changed.
  return respond({ status: 200, body: ok })
}

export type { DemoPull }
