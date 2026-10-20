// Reviews: another teammate reads a pull request with a fresh context and gives its
// verdict, in a child thread of the thread that opened it. Brigade starts it with a
// standard brief rather than the author's: the pull request, how that thread started,
// and whether the repository runs checks (then the reviewer reads the logic and leaves
// the rest to them; without, it also runs the typecheck and the tests). Its report wakes
// the author, which fixes what it rightly found and may ask it to look again
// (message_thread). The pull request waits on a person once its review is done
// (waitingOnPerson). A project says who decides there is one (ReviewPolicy): the teammate
// that opens a pull request, saying why (github_create_pull_request's review), or only
// someone who asks: request_review in the thread, or Ask for a review on its page.
//
// A pull request a child thread opened is reviewed in a child of that child's parent,
// whose teammate tells the child what to fix: children stay one level deep. One opened
// outside Brigade is reviewed in a thread of its own, which posts its verdict on GitHub.
import { randomUUID } from 'node:crypto'
import {
  childPrompt,
  REVIEW_RECHECKS,
  REVIEW_WAIT_MINUTES,
  ReviewChoice,
  type ReviewPolicy,
  type ScheduleOperation,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { parentChanged, settleAwaited } from './children.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { teammateGitHub } from './git.js'
import { dispatch } from './hub.js'
import { projectOfRepository } from './projects.js'
import {
  checksOf,
  github,
  pullOf,
  repoPath,
  reviewInclude,
  reviewUnderWay,
  stateOf,
  trackedRow,
  type GhPull,
  type GitHub,
} from './pull-requests.js'
import { usableAccounts } from './routes/accounts.js'
import type { WorkspaceScope } from './scope.js'
import { loadThread, type LoadedThread } from './thread-spec.js'
import { startThread } from './work.js'

/** How much of the request that started the author's thread the reviewer reads. */
const ASK_CHARS = 2_000

type Teammate = { id: string; name: string; harness: 'claude_code' | 'codex'; kind: string }

/** Who asks for a review: a teammate in its thread, or a member on the pull request's page. */
type Asker =
  { kind: 'teammate'; teammateId: string; sessionId: string } | { kind: 'member'; memberId: string }

/**
 * Who decides whether a thread's pull requests get a review: its project's setting (the
 * teammate, when it has no project). In a child thread or a playbook's run, nobody on their
 * own: the thread a person talks to, or the playbook, decides.
 */
export async function reviewPolicyOf(
  db: ScopedDb,
  session: { projectId: string | null; parentId: string | null; playbookRunId: string | null },
): Promise<ReviewPolicy | 'none'> {
  if (session.playbookRunId) return 'none'
  if (session.parentId) return 'manual'
  if (!session.projectId) return 'teammate'
  const project = await db.project.findFirst({
    where: { id: session.projectId },
    select: { reviewPolicy: true },
  })
  return project?.reviewPolicy ?? 'teammate'
}

/** What the author is told once its review started. */
const startedNote = (reviewer: string) =>
  `${reviewer} reviews it in a child thread, from a brief of Brigade's. You are woken here with its ` +
  'report: fix what it rightly found and push, then ask it to look at what changed with ' +
  `message_thread (${REVIEW_RECHECKS} times at most), and tell the person where it stands. Until ` +
  'then, do not offer to merge it. Tell the person in a line that it is in review, then end your ' +
  'turn: do not wait or poll.'

/**
 * The checks the repository runs on this pull request: those reported on its head, else its
 * workflows, as a pull request just opened may not list its runs yet. Empty: it runs none.
 */
async function checksRun(gh: GitHub, repo: string, p: GhPull): Promise<string[]> {
  const checks = await checksOf(gh, repo, p.head.sha)
  if (checks.length) return [...new Set(checks.map((c) => c.name))]
  const response = await gh.fetch(
    `${repoPath(repo)}/contents/.github/workflows?ref=${encodeURIComponent(p.head.sha)}`,
  )
  if (!response.ok) return []
  const files = (await response.json().catch(() => [])) as unknown
  return Array.isArray(files)
    ? (files as { name: string; type: string }[])
        .filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name))
        .map((f) => f.name)
    : []
}

/** How the thread that wrote it started: what the change answers, besides its description. */
async function firstAsk(db: ScopedDb, sessionId: string) {
  const event = await db.sessionEvent.findFirst({
    where: { sessionId, type: 'message.user' },
    orderBy: { seq: 'asc' },
    select: { data: true },
  })
  const text = ((event?.data as { text?: string } | undefined)?.text ?? '').trim()
  return text.length > ASK_CHARS ? `${text.slice(0, ASK_CHARS - 1).trimEnd()}…` : text
}

/** The reviewer's brief: the same for every review, whoever asked. */
export function reviewBrief(input: {
  repo: string
  p: GhPull
  author: string | null
  self: boolean
  asked: string
  checks: string[]
  child: boolean
}) {
  const { p } = input
  return [
    `Review pull request #${p.number} "${p.title}" in ${input.repo} (\`${p.head.ref}\` into ` +
      `\`${p.base.ref}\`)${input.author ? `, which ${input.self ? 'you' : input.author} wrote` : ''}, ` +
      `before it reaches a person: ${p.html_url}` +
      (input.self
        ? '. You wrote it in another thread: read it as if someone else had, from its diff and the code around it.'
        : ''),
    input.asked &&
      `The thread that wrote it started with this request:\n\n${input.asked
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')}`,
    'Read it with `github_get_pull_request`, and whatever else you need to judge it: the files at its ' +
      'branch with `github_read_file`, or a checkout of the branch. ' +
      (input.checks.length
        ? `This repository runs checks on its pull requests (${input.checks.join(', ')}): leave what ` +
          'they check to them, and read the change for what they miss.'
        : 'No checks run on its pull requests, so nobody else runs its tests: check out the branch, ' +
          'run its typecheck and tests (its README or AGENTS.md says how), and say which ran and how ' +
          'they went.'),
    'Look for what would hurt once it is merged: bugs, cases it gets wrong, what it does that the ' +
      'request or its description does not say, data it could lose or corrupt, security and ' +
      'permission holes, races, and missing tests where a mistake is likely. Leave out style a ' +
      'formatter would fix, and taste. For each problem, say where (file and line) and a concrete ' +
      'case where it goes wrong; leave out what you cannot make concrete.',
    'Then call `github_review_pull_request` once, with verdict "approve" or "request_changes", a ' +
      'short summary and line comments for the problems. Do not push to its branch, do not merge it, ' +
      'and do not mention other teammates. ' +
      (input.child
        ? 'Then `report` the verdict and the problems in a few lines. The thread that waits for it ' +
          'has them fixed and may ask you to look again: then review what changed since, and give a ' +
          'new verdict the same way.'
        : 'Then say the verdict and the problems in your reply, in a few lines.'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Who reviews: the teammate asked for, or another one that can post on the repository and runs
 * on the person's accounts here, preferably on another model than the author's (other blind
 * spots); with nobody else, the author itself, in a fresh context.
 */
async function pickReviewer(
  db: ScopedDb,
  scope: Scope,
  input: {
    repo: string
    author: Teammate | null
    asked?: string
    memberId: string
    computerId: string
  },
): Promise<Teammate> {
  const posts = async (t: Teammate) => !!(await teammateGitHub(db, scope, t.id, input.repo))?.write
  const runs = async (t: Teammate) =>
    (
      await usableAccounts(db, {
        memberId: input.memberId,
        computerId: input.computerId,
        provider: t.harness,
      })
    ).length > 0
  if (input.asked) {
    const asked =
      (await db.teammate.findFirst({ where: { id: input.asked, archivedAt: null } })) ??
      (await db.teammate.findFirst({
        where: { name: { equals: input.asked, mode: 'insensitive' }, archivedAt: null },
      }))
    if (!asked) throw new HTTPException(404, { message: `No teammate is called "${input.asked}"` })
    if (!(await posts(asked)))
      throw new HTTPException(409, {
        message: `${asked.name} cannot post a review on ${input.repo}: it needs read and write access to it through GitHub.`,
      })
    if (!(await runs(asked)))
      throw new HTTPException(409, {
        message: `${asked.name} runs on ${asked.harness === 'codex' ? 'Codex' : 'Claude Code'}, and the person has no account for it on this computer.`,
      })
    return asked
  }
  const others = await db.teammate.findMany({
    where: {
      archivedAt: null,
      kind: 'teammate',
      ...(input.author ? { id: { not: input.author.id } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })
  const sameModel = (t: Teammate) => Number(t.harness === input.author?.harness)
  for (const t of others.sort((a, b) => sameModel(a) - sameModel(b)))
    if ((await posts(t)) && (await runs(t))) return t
  if (input.author && (await posts(input.author)) && (await runs(input.author))) return input.author
  throw new HTTPException(409, {
    message: `No teammate can review it: give one read and write access to ${input.repo} through GitHub.`,
  })
}

/** The thread a review reports to: the one that opened the pull request, or its parent for a child's. */
async function reviewParent(db: ScopedDb, home: LoadedThread | null) {
  if (!home) return null
  return home.parentId ? loadThread(db, home.parentId) : home
}

/** Where a review of a pull request with no thread runs: the cloud computer, else the member's machine. */
async function defaultComputer(db: ScopedDb, memberId: string) {
  const computer =
    (await db.computer.findFirst({ where: { kind: 'cloud', status: { not: 'destroyed' } } })) ??
    (await db.computer.findFirst({
      where: { kind: 'member_machine', memberId },
      orderBy: { updatedAt: 'desc' },
    }))
  if (!computer) throw new HTTPException(409, { message: 'The workspace has no computer' })
  return computer
}

/**
 * Start a pull request's review. Throws, with what stops it, when the pull request is closed,
 * a review of it is already under way, the asker may not, or no teammate can review it.
 */
export async function startReview(
  db: ScopedDb,
  scope: Scope,
  input: { repo: string; number: number; reviewer?: string; by: Asker },
) {
  const gh = await github(db, scope, input.repo)
  const p = await pullOf(gh, input.repo, input.number)
  if (stateOf(p) !== 'open')
    throw new HTTPException(409, { message: 'This pull request is closed' })
  const tracked = await trackedRow(db, input.repo, p)
  const row = (await db.pullRequest.findFirst({
    where: { id: tracked.id },
    include: { authorTeammate: true, reviewSession: reviewInclude.reviewSession },
  }))!
  if (row.reviewSession && reviewUnderWay(row.reviewSession))
    throw new HTTPException(409, {
      message: `${row.reviewSession.teammate.name} is already reviewing it`,
    })
  const home = row.sessionId ? await loadThread(db, row.sessionId) : null
  const parent = await reviewParent(db, home)
  const by = input.by
  if (by.kind === 'teammate' && parent?.id !== by.sessionId)
    throw new HTTPException(403, {
      message:
        'request_review is for a pull request this thread, or one of its child threads, opened. A person can ask for a review of another one on its page.',
    })
  if (by.kind === 'member' && parent) {
    if (parent.startedByMemberId !== by.memberId && !parent.othersMayPrompt)
      throw new HTTPException(403, {
        message:
          "This pull request's thread runs on another member's subscription. They can ask for the review, or let others prompt in the thread.",
      })
    if (parent.controlledByMemberId)
      throw new HTTPException(409, {
        message: 'A person has control of the thread that opened it. Hand it back first.',
      })
  }
  const memberId = parent?.startedByMemberId ?? (by.kind === 'member' ? by.memberId : null)
  if (!memberId) throw new HTTPException(409, { message: 'This pull request has no thread' })
  const computer = parent?.computer ?? (await defaultComputer(db, memberId))
  const author = row.authorTeammate
  const reviewer = await pickReviewer(db, scope, {
    repo: input.repo,
    author,
    ...(input.reviewer ? { asked: input.reviewer } : {}),
    memberId,
    computerId: computer.id,
  })
  const [checks, asked] = await Promise.all([
    checksRun(gh, input.repo, p).catch(() => []),
    home ? firstAsk(db, home.id) : '',
  ])
  const instructions = reviewBrief({
    repo: input.repo,
    p,
    author: author?.name ?? null,
    self: reviewer.id === author?.id,
    asked,
    checks,
    child: !!parent,
  })
  // Who its report wakes: the author, when it sits in the thread that waits for it.
  const waker = author && parent?.teammates.some((t) => t.teammateId === author.id) ? author : null
  const { thread, outcome } = await startThread(db, scope, {
    teammate: reviewer,
    computer,
    memberId,
    accountId: parent && reviewer.harness === parent.teammate.harness ? parent.accountId : null,
    title: `Review #${p.number}: ${p.title}`,
    text: parent
      ? childPrompt({
          from: (waker ?? parent.teammate).name,
          parentTitle: parent.title,
          instructions,
        })
      : instructions,
    ...(parent
      ? {
          origin: {
            kind: 'child' as const,
            parent,
            byTeammateId: (waker ?? parent.teammate).id,
            awaited: true,
            awaitUntil: new Date(Date.now() + REVIEW_WAIT_MINUTES * 60_000),
          },
        }
      : {}),
    projectId: parent?.projectId ?? (await projectOfRepository(db, input.repo)),
    effort: (parent?.effort as never) ?? null,
  })
  if (outcome === 'offline') {
    // It never ran: nothing waits for it.
    await db.session.updateMany({ where: { id: thread.id }, data: { awaited: false } })
    throw new HTTPException(409, {
      message: 'The computer is offline: the review could not start. Ask again once it is back.',
    })
  }
  await db.pullRequest.updateMany({
    where: { id: row.id },
    data: {
      reviewSessionId: thread.id,
      noReviewReason: null,
      ...(by.kind === 'member' ? { requestedByMemberId: by.memberId } : {}),
      // Opened outside Brigade: the review's thread becomes its own, where it waits on a person after.
      ...(row.sessionId ? {} : { sessionId: thread.id }),
    },
  })
  if (parent) await parentChanged(scope, parent.id)
  const actor: Actor =
    by.kind === 'member'
      ? { type: 'member', id: by.memberId }
      : { type: 'teammate', id: by.teammateId }
  await audit({
    ...scope,
    actor,
    action: 'pull_request.review_requested',
    target: { type: 'pull_request', id: row.id },
    data: {
      repository: input.repo,
      number: input.number,
      reviewerId: reviewer.id,
      threadId: thread.id,
      checks: checks.length > 0,
    },
  })
  return { thread, reviewer }
}

/**
 * A teammate opened a pull request (github_create_pull_request): where it decides, its review
 * field starts the review, or keeps why it asked for none. What the tool's result tells it.
 */
export async function reviewOnCreate(
  db: ScopedDb,
  scope: Scope,
  call: { sessionId: string; teammateId: string; input: Record<string, unknown>; output: unknown },
): Promise<{ review: object } | undefined> {
  const session = await db.session.findFirst({
    where: { id: call.sessionId },
    select: { projectId: true, parentId: true, playbookRunId: true },
  })
  if (!session) return undefined
  const choice = ReviewChoice.safeParse(call.input.review)
  const policy = await reviewPolicyOf(db, session)
  if (policy === 'none') return undefined
  if (policy === 'manual')
    return choice.success
      ? {
          review: {
            started: false,
            note: session.parentId
              ? 'A child thread starts no review: say in your report whether this pull request needs one, and the thread that started you asks for it.'
              : "This project's pull requests get a review only when someone asks: none was started. When the person asks for one, call request_review.",
          },
        }
      : undefined
  if (!choice.success)
    return {
      review: {
        started: false,
        note:
          'Here you decide whether a pull request gets a review by another teammate. If this one deserves ' +
          'one, call request_review now; if not, tell the person in a few words why it needs none.',
      },
    }
  const repo = String(call.input.repository).toLowerCase()
  const number = Number((call.output as { number?: unknown }).number)
  if (!choice.data.wanted) {
    await db.pullRequest.updateMany({
      where: { repository: repo, number },
      data: { noReviewReason: choice.data.reason },
    })
    return {
      review: {
        started: false,
        note: 'No review: the person sees your reason on the pull request.',
      },
    }
  }
  try {
    const { thread, reviewer } = await startReview(db, scope, {
      repo,
      number,
      by: { kind: 'teammate', teammateId: call.teammateId, sessionId: call.sessionId },
    })
    return {
      review: {
        started: true,
        reviewer: reviewer.name,
        threadId: thread.id,
        note: startedNote(reviewer.name),
      },
    }
  } catch (error) {
    return {
      review: {
        started: false,
        error: error instanceof Error ? error.message : String(error),
        note: "The review could not start: tell the person why, and that they can ask for one on the pull request's page.",
      },
    }
  }
}

type ReviewOperation = Extract<ScheduleOperation, { name: 'request_review' }>

export const isReviewOperation = (op: ScheduleOperation): op is ReviewOperation =>
  op.name === 'request_review'

/** A teammate's request_review, from a thread on this runner's computer. */
export async function handleReviewCall(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; parentId: string | null },
  teammate: { id: string; name: string },
  op: ReviewOperation,
): Promise<object | { error: string }> {
  if (session.parentId)
    return {
      error:
        'This is a child thread: say in your report that the pull request needs a review, and the thread that started you asks for it.',
    }
  try {
    const { thread, reviewer } = await startReview(db, scope, {
      repo: op.repository,
      number: op.number,
      ...(op.reviewer ? { reviewer: op.reviewer } : {}),
      by: { kind: 'teammate', teammateId: teammate.id, sessionId: session.id },
    })
    return { threadId: thread.id, reviewer: reviewer.name, note: startedNote(reviewer.name) }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}

/** A member asks for a review on the pull request's page; Brigade picks the reviewer unless they did. */
export async function requestReview(
  scope: WorkspaceScope,
  repo: string,
  number: number,
  input: { reviewerId?: string | undefined },
) {
  const { thread } = await startReview(scoped(scope), scope, {
    repo,
    number,
    ...(input.reviewerId ? { reviewer: input.reviewerId } : {}),
    by: { kind: 'member', memberId: scope.memberId },
  })
  return { threadId: thread.id }
}

/** A pull request closed without merging: its review under way stops, and nothing waits for it. */
export async function cancelReview(scope: Scope, pullRequestId: string) {
  const db = scoped(scope)
  const row = await db.pullRequest.findFirst({
    where: { id: pullRequestId },
    select: { reviewSession: reviewInclude.reviewSession },
  })
  const review = row?.reviewSession
  if (!review || !reviewUnderWay(review)) return
  const thread = await loadThread(db, review.id)
  if (['starting', 'running', 'waiting'].includes(thread.status))
    await dispatch(thread.computer, {
      type: 'thread.interrupt',
      commandId: randomUUID(),
      sessionId: thread.id,
    })
  if (!review.parentId) return
  await db.session.updateMany({
    where: { id: review.id },
    data: {
      report: {
        status: 'cancelled',
        summary: 'Stopped: the pull request was closed.',
        at: new Date().toISOString(),
      },
      awaited: false,
      reportDeliveredAt: new Date(),
    } as never,
  })
  // The others its parent waits for may all be in now.
  await settleAwaited(scope, review.parentId)
  await parentChanged(scope, review.parentId)
}
