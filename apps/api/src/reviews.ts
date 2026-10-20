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
import { parse as parseYaml } from 'yaml'
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
  stateOf,
  trackedRow,
  type GhPull,
  type GitHub,
} from './pull-requests.js'
import { reviewUnderWay } from './review-state.js'
import { usableAccounts } from './routes/accounts.js'
import type { WorkspaceScope } from './scope.js'
import { loadThread, type LoadedThread } from './thread-spec.js'
import { startThread } from './work.js'

/** How much of the request that started the author's thread the reviewer reads. */
const ASK_CHARS = 2_000
/** Workflow files read to tell whether a repository runs checks on its pull requests. */
const WORKFLOWS_READ = 20
/** Pages of a pull request's files read for workflows that filter on paths (100 a page). */
const CHANGED_PAGES = 3
/** How long one request's claim to start a review holds before another may take it over. */
const CLAIM_MS = 5 * 60_000

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

/** GitHub's filter glob: `*` within a path segment, `**` across them, the rest as it is. */
function globMatches(pattern: string, value: string) {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${source}$`).test(value)
}

/**
 * Whether a filter's patterns keep a value, as GitHub reads them: in order, a pattern keeps
 * what it matches and one starting with `!` leaves it out again, so the last one matching
 * decides. With none matching, it is left out.
 */
function filterKeeps(patterns: string[], value: string) {
  let kept = false
  for (const pattern of patterns)
    if (pattern.startsWith('!')) {
      if (globMatches(pattern.slice(1), value)) kept = false
    } else if (globMatches(pattern, value)) kept = true
  return kept
}

const listOf = (v: unknown) =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : null
const objectOf = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** What a workflow's filters are read against: a pull request's branches and files. */
export type Change = {
  /** Its branch, and the one it goes into. */
  head: string
  base: string
  /** The files it changes; null when there are too many to list. */
  files: string[] | null
}

/**
 * Whether an event's filters let it run for this branch and these files: branches (or
 * branches-ignore), and paths (or paths-ignore) when the files are known.
 */
function filtersLet(filters: Record<string, unknown>, branch: string, files: string[] | null) {
  const branches = listOf(filters.branches)
  if (branches && !filterKeeps(branches, branch)) return false
  if (listOf(filters['branches-ignore'])?.some((b) => globMatches(b, branch))) return false
  if (!files?.length) return true
  const paths = listOf(filters.paths)
  if (paths && !files.some((f) => filterKeeps(paths, f))) return false
  const ignored = listOf(filters['paths-ignore'])
  return !(ignored && files.every((f) => ignored.some((p) => globMatches(p, f))))
}

/** The activity types a pull_request workflow runs on by default: opening it and each push. */
const PULL_TYPES = ['opened', 'synchronize', 'reopened']

/**
 * Whether a workflow runs on a pull request: on pull_request (or pull_request_target) into its
 * base, or on a push to its branch, as their filters say. One for tags, releases or a schedule
 * (a desktop release, say) does not.
 */
export function workflowRunsOn(text: string, change: Change) {
  let doc: Record<string, unknown> | null
  try {
    doc = parseYaml(text) as Record<string, unknown> | null
  } catch {
    return false
  }
  // YAML 1.1 reads the `on` key as true.
  const on = doc?.on ?? doc?.['true']
  const events: Record<string, unknown> =
    typeof on === 'string'
      ? { [on]: null }
      : Array.isArray(on)
        ? Object.fromEntries(on.map((e) => [String(e), null]))
        : objectOf(on)
  for (const event of ['pull_request', 'pull_request_target']) {
    if (!(event in events)) continue
    const filters = objectOf(events[event])
    const types = listOf(filters.types)
    if (types && !types.some((t) => PULL_TYPES.includes(t))) continue
    if (filtersLet(filters, change.base, change.files)) return true
  }
  if (!('push' in events)) return false
  const push = objectOf(events.push)
  // Tags alone: it runs for a release, not for a branch.
  const tags = listOf(push.tags) ?? listOf(push['tags-ignore'])
  if (tags && !listOf(push.branches) && !listOf(push['branches-ignore'])) return false
  return filtersLet(push, change.head, change.files)
}

/** The files a pull request changes, or null past what is worth listing. */
async function changedFiles(gh: GitHub, repo: string, number: number) {
  const files: string[] = []
  for (let page = 1; page <= CHANGED_PAGES; page++) {
    const response = await gh.fetch(
      `${repoPath(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
    )
    if (!response.ok) return null
    const list = (await response.json().catch(() => [])) as { filename: string }[]
    files.push(...list.map((f) => f.filename))
    if (list.length < 100) return files
  }
  return null
}

/**
 * The checks the repository runs on this pull request: those reported on its head, else its
 * workflows that run on it, as a pull request just opened may not list its runs yet. Empty:
 * it runs none.
 */
async function checksRun(gh: GitHub, repo: string, p: GhPull): Promise<string[]> {
  const checks = await checksOf(gh, repo, p.head.sha)
  if (checks.length) return [...new Set(checks.map((c) => c.name))]
  const ref = encodeURIComponent(p.head.sha)
  const response = await gh.fetch(`${repoPath(repo)}/contents/.github/workflows?ref=${ref}`)
  if (!response.ok) return []
  const listed = (await response.json().catch(() => [])) as unknown
  if (!Array.isArray(listed)) return []
  const workflows: { name: string; text: string }[] = []
  for (const f of (listed as { name: string; path: string; type: string }[])
    .filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name))
    .slice(0, WORKFLOWS_READ)) {
    const path = f.path.split('/').map(encodeURIComponent).join('/')
    const file = await gh.fetch(`${repoPath(repo)}/contents/${path}?ref=${ref}`)
    if (!file.ok) continue
    const body = (await file.json().catch(() => null)) as { content?: string } | null
    if (body?.content)
      workflows.push({ name: f.name, text: Buffer.from(body.content, 'base64').toString('utf8') })
  }
  // Its files only when a workflow filters on paths.
  const files = workflows.some((w) => /\bpaths(-ignore)?\s*:/.test(w.text))
    ? await changedFiles(gh, repo, p.number)
    : null
  const change = { head: p.head.ref, base: p.base.ref, files }
  return workflows.filter((w) => workflowRunsOn(w.text, change)).map((w) => w.name)
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
        ? `This repository runs checks on its pull requests (${input.checks.join(', ')}): leave to ` +
          'them what they cover, and read the change for what they miss. If none of them runs its ' +
          'typecheck and tests (a deploy preview, say), run those yourself on a checkout of the ' +
          'branch, and say how they went.'
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
  // Through an account it may use in a thread that member starts: a member's own, only theirs.
  const posts = async (t: Teammate) =>
    !!(await teammateGitHub(db, scope, t.id, input.repo, { startedByMemberId: input.memberId }))
      ?.write
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
  const { id } = await trackedRow(db, input.repo, p)
  const claim = await claimReview(db, id)
  if (!claim) throw new HTTPException(409, { message: 'A review of it is starting' })
  try {
    return await startClaimed(db, scope, input, gh, p, id, claim)
  } finally {
    await releaseReview(db, id, claim)
  }
}

/**
 * Claim a pull request to start its review, one request at a time: when, which is the claim's
 * mark, or null while another request holds it. A claim older than CLAIM_MS, left by a crash,
 * may be taken over.
 */
export async function claimReview(db: ScopedDb, id: string, now = new Date()) {
  const { count } = await db.pullRequest.updateMany({
    where: {
      id,
      OR: [
        { reviewClaimedAt: null },
        { reviewClaimedAt: { lt: new Date(now.getTime() - CLAIM_MS) } },
      ],
    },
    data: { reviewClaimedAt: now },
  })
  return count ? now : null
}

/** Let go of a claim, if it is still this one: past its time, another request may hold it. */
export async function releaseReview(db: ScopedDb, id: string, claim: Date) {
  await db.pullRequest.updateMany({
    where: { id, reviewClaimedAt: claim },
    data: { reviewClaimedAt: null },
  })
}

/** startReview, once it holds the pull request's claim: no other review starts meanwhile. */
async function startClaimed(
  db: ScopedDb,
  scope: Scope,
  input: { repo: string; number: number; reviewer?: string; by: Asker },
  gh: GitHub,
  p: GhPull,
  id: string,
  claim: Date,
) {
  const row = (await db.pullRequest.findFirst({
    where: { id },
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
  // It becomes the pull request's review only while this request still holds the claim.
  const linked = await db.pullRequest.updateMany({
    where: { id: row.id, reviewClaimedAt: claim },
    data: {
      reviewSessionId: thread.id,
      reviewClaimedAt: null,
      noReviewReason: null,
      ...(by.kind === 'member' ? { requestedByMemberId: by.memberId } : {}),
      // Opened outside Brigade: the review's thread becomes its own, where it waits on a person after.
      ...(row.sessionId ? {} : { sessionId: thread.id }),
    },
  })
  if (!linked.count) {
    // Its claim ran out and another request took it over: that one's review stands.
    await stopReviewThread(scope, thread.id, 'Stopped: another review of it started.', {
      archive: true,
    })
    throw new HTTPException(409, { message: 'Another review of it started meanwhile' })
  }
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
  const row = await scoped(scope).pullRequest.findFirst({
    where: { id: pullRequestId },
    select: { reviewSession: reviewInclude.reviewSession },
  })
  const review = row?.reviewSession
  if (!review || !reviewUnderWay(review)) return
  await stopReviewThread(scope, review.id, 'Stopped: the pull request was closed.')
}

/**
 * Stop a review's thread: its turn is interrupted, and the thread that waited for it does no
 * more. archive: one that should never have run (a second review), out of sight too.
 */
async function stopReviewThread(
  scope: Scope,
  threadId: string,
  summary: string,
  options: { archive?: boolean } = {},
) {
  const db = scoped(scope)
  const thread = await loadThread(db, threadId)
  if (['starting', 'running', 'waiting'].includes(thread.status))
    await dispatch(thread.computer, {
      type: 'thread.interrupt',
      commandId: randomUUID(),
      sessionId: thread.id,
    })
  if (options.archive)
    await db.session.updateMany({ where: { id: thread.id }, data: { archivedAt: new Date() } })
  if (!thread.parentId) return
  await db.session.updateMany({
    where: { id: thread.id },
    data: {
      report: { status: 'cancelled', summary, at: new Date().toISOString() },
      awaited: false,
      reportDeliveredAt: new Date(),
    } as never,
  })
  // The others its parent waits for may all be in now.
  await settleAwaited(scope, thread.parentId)
  await parentChanged(scope, thread.parentId)
}
