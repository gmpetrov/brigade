// Notifications: web push to the dashboard, installed as an app or open in a
// browser. Sparse by design. A push says something waits on the member (the
// Needs you items that are theirs); with a preset, also each finished task or
// merged pull request, and replies in threads they started. Nothing else.
//
// A sweep every half minute compares what should notify each member with what
// did (PushNotice), so every rule lives in one place:
// - a Needs you item is sent once it has lasted a minute (most bursts settle
//   by then), and reminded at most once, after 4 hours;
// - everything due in one sweep is one push, and a member gets at most 4 an
//   hour: past that, what is due waits and goes out together;
// - nothing is sent while the member has a dashboard in view, or had one in
//   the last 2 minutes: it is in front of them;
// - one notification per thread (its tag), closed by the next push once it no
//   longer waits; the app icon badge counts what waits, as the sidebar does;
// - a playbook's approvals are one item: one push when its queue fills, nothing
//   more (not even a reminder) while it stays full, a new one once it emptied.
// Apple drops subscriptions that receive pushes showing nothing, so every push
// shows a notification: closing and the badge ride along with real ones, and
// the dashboard catches both up when it opens.
import {
  playbookApprovalOf,
  toApprove,
  type NotifyPreset,
  type PlaybookManifest,
  type PushMessage,
} from '@brigade/contracts'
import { env } from './config.js'
import { prisma } from './db.js'
import { hubs } from './hub.js'
import { laterKey, latersIn } from './later.js'
import { waitingNow } from './pull-requests.js'
import { REVIEW_THREAD } from './review-state.js'
import { columnOf } from './tasks.js'
import { sendPush, type Vapid } from './web-push.js'

const SWEEP_MS = 30_000
/** A Needs you item waits this long before it is sent: most settle sooner. */
const SETTLE_MS = 60_000
/** One reminder for an item still waiting this long after its push. */
const REMIND_MS = 4 * 60 * 60_000
/** A member who looked at a dashboard this recently is not notified. */
const LOOKING_MS = 2 * 60_000
const PUSHES_PER_HOUR = 4
/** Finished work and replies are news for this long; older, they are not sent. */
const FRESH_MS = 15 * 60_000
/** What was sent is kept this long once over: past the cap's hour and the news window. */
const KEEP_MS = 2 * 60 * 60_000

export const vapid = (): Vapid | null =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
    ? {
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT ?? env.WEB_URL[0]!,
      }
    : null

/** Something a member may be notified of. */
type Item = {
  key: string
  workspaceId: string
  title: string
  body: string
  url: string
  /** Notifications with the same tag replace each other. */
  tag: string
  /** Waits on the member: counts in the badge, is reminded and closed once resolved. */
  needs: boolean
  /** Sent once while it waits, never reminded: a playbook's queue. */
  once?: boolean
}

type Recipient = { id: string; role: string; notify: NotifyPreset }

const isAdmin = (m: Recipient) => m.role === 'owner' || m.role === 'admin'

type OpenTicket = {
  id: string
  type: string
  title: string
  payload: unknown
  session: {
    id: string
    title: string
    startedByMemberId: string
    parentId: string | null
    teammate: { name: string }
  } | null
}

const payloadOf = (t: OpenTicket) => (t.payload ?? {}) as Record<string, unknown>
const managedOnly = (t: OpenTicket) =>
  payloadOf(t).credentialAction === 'grant' || payloadOf(t).credentialAction === 'update'
/** A skill a teammate proposes, or a playbook a member asks to activate: only an owner or admin decides. */
const adminsOnly = (t: OpenTicket) =>
  t.type === 'approval' && (!!payloadOf(t).skillAction || payloadOf(t).playbookActivation === true)

/** Whether a ticket waits on this member: apps/web/lib/api.ts's waitsOn, which the sidebar counts. */
function waitsOn(t: OpenTicket, m: Recipient) {
  const admin = isAdmin(m)
  const starter = t.session?.startedByMemberId === m.id
  const p = payloadOf(t)
  if (adminsOnly(t)) return admin
  if (t.type === 'approval')
    return managedOnly(t) ? admin || p.credentialOwnerId === m.id : admin || starter
  if (t.type === 'cap') return admin
  if ((t.type === 'question' || t.type === 'request') && p.source === 'harness')
    return admin || starter
  return admin || (p.memberId ? p.memberId === m.id : starter)
}

/**
 * Whether a ticket is this member's to answer, so worth a push: as waitsOn, but
 * admins only for what only they decide, or what has nobody else.
 */
function isFor(t: OpenTicket, m: Recipient) {
  const p = payloadOf(t)
  const starter = t.session?.startedByMemberId
  if (t.type === 'cap' || adminsOnly(t)) return isAdmin(m)
  if (t.type === 'approval' && managedOnly(t))
    return p.credentialOwnerId ? p.credentialOwnerId === m.id : isAdmin(m)
  const harness = (t.type === 'question' || t.type === 'request') && p.source === 'harness'
  const person = t.type === 'approval' || harness ? starter : ((p.memberId as string) ?? starter)
  return person ? person === m.id : isAdmin(m)
}

const ASKS: Record<string, string> = {
  approval: 'needs your approval',
  question: 'has a question',
  sign_in: 'needs you to sign in',
  cap: 'reached a spending cap',
  usage_limit: 'reached a usage limit',
}

const threadUrl = (workspaceId: string, threadId: string) =>
  `/app/threads/${threadId}?workspace=${workspaceId}`

/** Who wrote each thread's latest person's message, of the last day. */
async function latestAskers(sessionIds: string[], now: Date) {
  const askers = new Map<string, string>()
  if (!sessionIds.length) return askers
  const messages = await prisma.sessionEvent.findMany({
    where: {
      sessionId: { in: sessionIds },
      type: 'message.user',
      at: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
    },
    select: { sessionId: true, data: true },
    orderBy: { seq: 'desc' },
  })
  for (const { sessionId, data } of messages) {
    const memberId = (data as { memberId?: string | null } | null)?.memberId
    if (memberId && !askers.has(sessionId)) askers.set(sessionId, memberId)
  }
  return askers
}

/** What each member of an organization may be notified of in one workspace. */
async function workspaceItems(workspaceId: string, members: Recipient[], now: Date) {
  const fresh = new Date(now.getTime() - FRESH_MS)
  const wantsFinished = members.some((m) => m.notify !== 'needed')
  const wantsReplies = members.some((m) => m.notify === 'everything')
  const thread = {
    select: {
      id: true,
      title: true,
      startedByMemberId: true,
      parentId: true,
      teammate: { select: { name: true } },
    },
  }
  const [laters, tickets, tasks, waitingPulls, done, merged, turns] = await Promise.all([
    latersIn(workspaceId),
    prisma.ticket.findMany({
      // Not those of an archived thread: put away, they no longer wait on anyone.
      where: {
        workspaceId,
        status: 'open',
        OR: [{ sessionId: null }, { session: { archivedAt: null } }],
      },
      select: { id: true, type: true, title: true, payload: true, session: thread },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        trashedAt: null,
        completedAt: null,
        session: { isNot: null },
      },
      select: {
        id: true,
        title: true,
        completedAt: true,
        session: {
          select: {
            ...thread.select,
            status: true,
            _count: { select: { tickets: { where: { status: 'open' as const } } } },
            pullRequests: {
              select: { state: true, mergeStatus: true, reviewSession: { select: REVIEW_THREAD } },
            },
          },
        },
      },
    }),
    // Pull requests waiting on a person, as Home lists them, whether or not a task is behind them.
    prisma.pullRequest.findMany({
      where: { workspaceId, ...waitingNow },
      select: {
        id: true,
        repository: true,
        number: true,
        title: true,
        requestedByMemberId: true,
        session: {
          select: {
            ...thread.select,
            _count: { select: { tickets: { where: { status: 'open' as const } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    wantsFinished
      ? prisma.task.findMany({
          where: { workspaceId, completedAt: { gt: fresh }, trashedAt: null },
          select: { id: true, title: true, createdByMemberId: true, session: thread },
        })
      : [],
    wantsFinished
      ? prisma.pullRequest.findMany({
          where: { workspaceId, state: 'merged', mergedAt: { gt: fresh } },
          select: {
            id: true,
            repository: true,
            number: true,
            title: true,
            requestedByMemberId: true,
            session: { select: { ...thread.select, task: { select: { completedAt: true } } } },
          },
        })
      : [],
    wantsReplies
      ? prisma.sessionEvent.findMany({
          // A child's turns go to its parent, which says what matters: no push of their own.
          // Nor a playbook's run nobody joined: out of the sidebar, what it needs is its queue.
          where: {
            workspaceId,
            type: 'turn.completed',
            at: { gt: fresh },
            session: {
              parentId: null,
              OR: [{ playbookRunId: null, quiet: false }, { surfacedAt: { not: null } }],
            },
          },
          select: {
            at: true,
            session: {
              select: {
                ...thread.select,
                taskId: true,
                reads: { select: { memberId: true, seenAt: true } },
              },
            },
          },
          orderBy: { at: 'asc' },
        })
      : [],
  ])

  const items = new Map<string, Item[]>(members.map((m) => [m.id, []]))
  /** The member put the thread away for later: nothing in it waits on them (src/later.ts). */
  const putAway = (m: { id: string }, s: { id: string; parentId: string | null } | null) =>
    !!s && laters.has(laterKey(m.id, s.parentId ?? s.id))
  /** Added once per key: a thread with several tickets is one item. */
  const add = (memberId: string, item: Item) => {
    const list = items.get(memberId)!
    if (!list.some((i) => i.key === item.key)) list.push(item)
  }
  /** Items that count in the badge but are someone else's to answer. */
  const counted = new Map<string, Set<string>>(members.map((m) => [m.id, new Set()]))

  // A playbook's approvals, by its installation: one item each, below.
  const queues = new Map<string, OpenTicket[]>()
  for (const t of tickets) {
    const playbook = playbookApprovalOf(t)
    if (playbook) {
      queues.set(playbook.installationId, [...(queues.get(playbook.installationId) ?? []), t])
      continue
    }
    const key = t.session ? `needs:${t.session.id}` : `needs:ticket:${t.id}`
    for (const m of members) {
      if (!waitsOn(t, m) || putAway(m, t.session)) continue
      counted.get(m.id)!.add(key)
      if (!isFor(t, m)) continue
      add(m.id, {
        key,
        workspaceId,
        needs: true,
        title: t.session
          ? `${t.session.teammate.name} ${ASKS[t.type] ?? 'needs you'}`
          : 'Brigade needs you',
        body: t.title,
        url: t.session
          ? threadUrl(workspaceId, t.session.id)
          : `/app/tickets?workspace=${workspaceId}`,
        tag: t.session?.id ?? t.id,
      })
    }
  }

  // A playbook's queue: one item, counted once in the badge, and told to whoever its approvals
  // are for (as each ticket's own would be). Its key stays while the queue is not empty, so a
  // second approval sends nothing; emptied, the item goes, and the next one is sent again.
  const playbooks = queues.size
    ? await prisma.playbookInstallation.findMany({
        where: { workspaceId, id: { in: [...queues.keys()] } },
        select: { id: true, manifest: true },
      })
    : []
  for (const [installationId, queue] of queues) {
    const key = `needs:playbook:${installationId}`
    const manifest = playbooks.find((p) => p.id === installationId)?.manifest as
      PlaybookManifest | undefined
    for (const m of members) {
      if (!queue.some((t) => waitsOn(t, m))) continue
      counted.get(m.id)!.add(key)
      const theirs = queue.filter((t) => isFor(t, m))
      if (!theirs.length) continue
      add(m.id, {
        key,
        workspaceId,
        needs: true,
        once: true,
        title: `${manifest?.name ?? 'A playbook'} · ${toApprove(theirs.length)}`,
        body: theirs[theirs.length - 1]!.title,
        url: `/app?workspace=${workspaceId}&approvals=${installationId}`,
        tag: installationId,
      })
    }
  }

  // Tasks in Needs you: every member's sidebar shows them; the thread's starter is told,
  // unless it is there for a ticket, which says whose it is.
  for (const task of tasks) {
    const s = task.session!
    if (columnOf({ completedAt: task.completedAt, session: s }) !== 'needs_you') continue
    const key = `needs:${s.id}`
    for (const m of members) if (!putAway(m, s)) counted.get(m.id)!.add(key)
    if (
      s._count.tickets > 0 ||
      !items.has(s.startedByMemberId) ||
      putAway({ id: s.startedByMemberId }, s)
    )
      continue
    const review = s.status !== 'waiting'
    add(s.startedByMemberId, {
      key,
      workspaceId,
      needs: true,
      title: review
        ? `${s.teammate.name} opened a pull request for you to review`
        : `${s.teammate.name} needs you`,
      body: task.title,
      url: threadUrl(workspaceId, s.id),
      tag: s.id,
    })
  }

  // Pull requests to review: every member's Home lists them, as the badge counts them;
  // whoever asked for the work is told, else the thread's starter. Not when the thread
  // has a ticket open: that says whose it is.
  for (const pr of waitingPulls) {
    const s = pr.session
    const key = s ? `needs:${s.id}` : `needs:pull:${pr.id}`
    for (const m of members) if (!putAway(m, s)) counted.get(m.id)!.add(key)
    const who = pr.requestedByMemberId ?? s?.startedByMemberId
    if (!who || !items.has(who) || (s && s._count.tickets > 0) || putAway({ id: who }, s)) continue
    add(who, {
      key,
      workspaceId,
      needs: true,
      title: s
        ? `${s.teammate.name} opened a pull request for you to review`
        : 'A pull request waits for review',
      body: `${pr.title} (${pr.repository}#${pr.number})`,
      url: s ? threadUrl(workspaceId, s.id) : `/app/pulls?workspace=${workspaceId}`,
      tag: s?.id ?? pr.id,
    })
  }

  const finishedFor = (memberId: string | null | undefined) =>
    memberId && members.find((m) => m.id === memberId && m.notify !== 'needed')
  for (const task of done) {
    const who = task.session?.startedByMemberId ?? task.createdByMemberId
    if (!finishedFor(who)) continue
    add(who, {
      key: `done:${task.id}`,
      workspaceId,
      needs: false,
      title: task.session ? `${task.session.teammate.name} finished a task` : 'Task done',
      body: task.title,
      url: task.session
        ? threadUrl(workspaceId, task.session.id)
        : `/app/tasks?workspace=${workspaceId}`,
      tag: task.session?.id ?? task.id,
    })
  }
  for (const pr of merged) {
    // Its task is done with it: that says it.
    if (pr.session?.task?.completedAt) continue
    const who = pr.requestedByMemberId ?? pr.session?.startedByMemberId
    if (!who || !finishedFor(who)) continue
    add(who, {
      key: `merged:${pr.id}`,
      workspaceId,
      needs: false,
      title: 'Pull request merged',
      body: `${pr.title} (${pr.repository}#${pr.number})`,
      url: pr.session
        ? threadUrl(workspaceId, pr.session.id)
        : `/app/pulls?workspace=${workspaceId}`,
      tag: pr.session?.id ?? pr.id,
    })
  }
  // A thread's latest turn only: one notification per thread.
  const latest = new Map(turns.map((turn) => [turn.session.id, turn]))
  // In a thread others write in, the reply is also news for whoever asked for it last.
  const askers = await latestAskers([...latest.keys()], now)
  for (const turn of latest.values()) {
    const s = turn.session
    // A task's thread says when it is done, not each turn on the way.
    if (s.taskId) continue
    for (const id of new Set([s.startedByMemberId, askers.get(s.id)])) {
      const m = members.find((r) => r.id === id && r.notify === 'everything')
      if (!m || counted.get(m.id)!.has(`needs:${s.id}`)) continue
      // Read since: they saw it.
      const seen = s.reads.find((r) => r.memberId === m.id)?.seenAt
      if (seen && seen >= turn.at) continue
      add(m.id, {
        key: `reply:${s.id}:${turn.at.getTime()}`,
        workspaceId,
        needs: false,
        title: `${s.teammate.name} replied`,
        body: s.title,
        url: threadUrl(workspaceId, s.id),
        tag: s.id,
      })
    }
  }

  return { items, counted }
}

/**
 * One pass over every member with a device that receives pushes (in one organization: tests),
 * every SWEEP_MS (src/jobs.ts).
 */
export async function sweep(now = new Date(), organizationId?: string) {
  const keys = vapid()
  if (!keys) return
  const members = await prisma.member.findMany({
    where: { ...(organizationId ? { organizationId } : {}), user: { pushDevices: { some: {} } } },
    select: { id: true, organizationId: true, role: true, notify: true, userId: true },
  })
  const byOrganization = new Map<string, typeof members>()
  for (const m of members)
    byOrganization.set(m.organizationId, [...(byOrganization.get(m.organizationId) ?? []), m])
  for (const [organizationId, orgMembers] of byOrganization) {
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId },
      select: { id: true },
    })
    const items = new Map<string, Item[]>(orgMembers.map((m) => [m.id, []]))
    const badges = new Map<string, number>(orgMembers.map((m) => [m.id, 0]))
    for (const w of workspaces) {
      const found = await workspaceItems(w.id, orgMembers, now)
      for (const m of orgMembers) {
        items.get(m.id)!.push(...found.items.get(m.id)!)
        badges.set(m.id, badges.get(m.id)! + found.counted.get(m.id)!.size)
      }
    }
    const ids = workspaces.map((w) => w.id)
    for (const m of orgMembers)
      await settle(keys, m, organizationId, ids, items.get(m.id)!, badges.get(m.id)!, now).catch(
        (error) => console.warn(`notifications for ${m.id} failed: ${String(error)}`),
      )
  }
}

/** Bring a member's notices up to date with what is, and send what is due. */
async function settle(
  keys: Vapid,
  member: { id: string; userId: string },
  organizationId: string,
  /** The organization's workspaces: a dashboard of any of them in view counts. */
  workspaceIds: string[],
  items: Item[],
  badge: number,
  now: Date,
) {
  const at = now.getTime()
  const notices = await prisma.pushNotice.findMany({ where: { memberId: member.id } })
  const known = new Map(notices.map((n) => [n.key, n]))
  const current = new Map(items.map((i) => [i.key, i]))

  const fresh = items.filter((i) => !known.has(i.key))
  if (fresh.length)
    await prisma.pushNotice.createMany({
      data: fresh.map((i) => ({
        organizationId,
        workspaceId: i.workspaceId,
        memberId: member.id,
        key: i.key,
        firstSeenAt: now,
      })),
      skipDuplicates: true,
    })

  // Gone: never sent, forget it; sent and waited on, close its notification with the
  // next push. Sent ones stay a while after: the hourly cap counts them.
  const gone = notices.filter((n) => !current.has(n.key))
  const forget = gone.filter(
    (n) =>
      !n.sentAt ||
      (!n.key.startsWith('needs:') && at - n.firstSeenAt.getTime() > KEEP_MS) ||
      (n.resolvedAt && at - n.resolvedAt.getTime() > KEEP_MS),
  )
  const resolve = gone.filter((n) => n.sentAt && !n.resolvedAt && n.key.startsWith('needs:'))
  if (forget.length)
    await prisma.pushNotice.deleteMany({ where: { id: { in: forget.map((n) => n.id) } } })
  if (resolve.length)
    await prisma.pushNotice.updateMany({
      where: { id: { in: resolve.map((n) => n.id) } },
      data: { resolvedAt: now },
    })
  // Back on the list (a new ticket in the same thread): a new item, sent again.
  const back = notices.filter((n) => n.resolvedAt && current.has(n.key))
  if (back.length)
    await prisma.pushNotice.updateMany({
      where: { id: { in: back.map((n) => n.id) } },
      data: {
        resolvedAt: null,
        closedAt: null,
        sentAt: null,
        pushed: false,
        remindedAt: null,
        firstSeenAt: now,
      },
    })
  const reopened = new Set(back.map((n) => n.key))

  const due = items.filter((i) => {
    const n = known.get(i.key)
    if (n && reopened.has(i.key)) return false
    if (!n) return !i.needs
    return !n.sentAt && (!i.needs || at - n.firstSeenAt.getTime() >= SETTLE_MS)
  })
  const remind = items.filter((i) => {
    const n = known.get(i.key)
    return (
      i.needs &&
      !i.once &&
      n?.pushed &&
      n.sentAt &&
      !n.remindedAt &&
      at - n.sentAt.getTime() >= REMIND_MS
    )
  })
  if (!due.length && !remind.length) return

  // In front of them: what is due counts as seen, never sent. Reminders wait.
  const looking = await Promise.all(
    workspaceIds.map((id) => hubs.get(id).isLooking(member.id, LOOKING_MS)),
  )
  if (looking.some(Boolean)) {
    if (due.length)
      await prisma.pushNotice.updateMany({
        where: { memberId: member.id, key: { in: due.map((i) => i.key) }, sentAt: null },
        data: { sentAt: now, pushed: false },
      })
    return
  }

  // Pushes in the last hour: everything sent in one push shares its time.
  const hourAgo = new Date(at - 60 * 60_000)
  const recent = await prisma.pushNotice.findMany({
    where: {
      memberId: member.id,
      pushed: true,
      OR: [{ sentAt: { gt: hourAgo } }, { remindedAt: { gt: hourAgo } }],
    },
    select: { sentAt: true, remindedAt: true },
  })
  const times = new Set(
    recent
      .flatMap((n) => [n.sentAt, n.remindedAt])
      .filter((d) => d && d > hourAgo)
      .map((d) => d!.getTime()),
  )
  if (times.size >= PUSHES_PER_HOUR) return

  const close = notices
    .filter((n) => (n.resolvedAt && !n.closedAt) || resolve.includes(n))
    .map((n) => tagOf(n.key))
    .filter((tag) => !items.some((i) => i.tag === tag))
  const message = compose([...due, ...remind], badge, [...new Set(close)])

  const devices = await prisma.pushDevice.findMany({ where: { userId: member.userId } })
  let delivered = false
  for (const device of devices) {
    const result = await sendPush(keys, device, message, {
      topic: message.tag,
      urgency: due.some((i) => i.needs) || remind.length ? 'high' : 'normal',
    })
    if (result.status === 'gone') await prisma.pushDevice.deleteMany({ where: { id: device.id } })
    delivered ||= result.status === 'sent'
  }
  if (!delivered) return

  if (due.length)
    await prisma.pushNotice.updateMany({
      where: { memberId: member.id, key: { in: due.map((i) => i.key) } },
      data: { sentAt: now, pushed: true },
    })
  if (remind.length)
    await prisma.pushNotice.updateMany({
      where: { memberId: member.id, key: { in: remind.map((i) => i.key) } },
      data: { remindedAt: now },
    })
  // Closed with this push.
  await prisma.pushNotice.updateMany({
    where: { memberId: member.id, resolvedAt: { not: null }, closedAt: null },
    data: { closedAt: now },
  })
}

/** The tag of a notice's notification, from its key: a thread's id, else the ticket's, playbook's, task's or pull request's. */
const tagOf = (key: string) => {
  const [, id, more] = key.split(':')
  return key.startsWith('needs:ticket:') || key.startsWith('needs:playbook:') ? more! : id!
}

/** One push for everything due: the thing itself, or how many and which. */
export function compose(items: Item[], badge: number, close: string[]): PushMessage {
  if (items.length === 1) {
    const [i] = items
    return { title: i!.title, body: i!.body, url: i!.url, tag: i!.tag, badge, close }
  }
  const waiting = items.filter((i) => i.needs).length
  const title =
    waiting === items.length
      ? `${items.length} things need you`
      : waiting
        ? `${waiting} ${waiting === 1 ? 'thing needs' : 'things need'} you, and ${items.length - waiting} more`
        : `${items.length} updates`
  const body = items
    .slice(0, 3)
    .map((i) => i.body)
    .join(' · ')
  const workspaces = new Set(items.map((i) => i.workspaceId))
  const [workspaceId] = workspaces
  return {
    title,
    body: items.length > 3 ? `${body} · +${items.length - 3}` : body,
    url: workspaces.size === 1 ? `/app/tasks?workspace=${workspaceId}` : '/app/tasks',
    tag: 'brigade',
    badge,
    close,
  }
}

/**
 * A notification to check a device receives them, sent at once to each of the
 * user's devices: how many took it, and what the push services said of the others.
 */
export async function sendTest(userId: string) {
  const keys = vapid()
  if (!keys)
    return { devices: 0, sent: 0, errors: ['Notifications are not set up on this Brigade'] }
  const devices = await prisma.pushDevice.findMany({ where: { userId } })
  let sent = 0
  const errors: string[] = []
  for (const device of devices) {
    const result = await sendPush(
      keys,
      device,
      {
        title: 'Notifications are on',
        body: 'Brigade will tell you here when something needs you.',
        url: '/app',
        tag: 'brigade-test',
        close: [],
      } satisfies PushMessage,
      // A topic as real pushes have one: Apple refused those alone (BadWebPushTopic).
      { topic: 'brigade-test', ttlSeconds: 60, urgency: 'high' },
    )
    if (result.status === 'gone') await prisma.pushDevice.deleteMany({ where: { id: device.id } })
    if (result.status === 'sent') sent++
    if (result.status === 'failed') errors.push(result.detail)
  }
  return { devices: devices.length, sent, errors }
}
