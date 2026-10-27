// The inbox of vendors' webhooks: each event is kept as it comes (InboundEvent, one row per source
// and vendor id), answered 2xx at once, then processed from here: right away, and again on the
// minute's tick until it went through, with a growing wait between tries. A restart, a deploy or a
// failure partway loses nothing, and a vendor's retry of an event is processed once. Resend's mail
// follows the same pattern with its own table (src/mail/inbound.ts).
import { prisma } from './db.js'
import { noteFailure } from './ops/failures.js'
import { enqueue } from './platform/node.js'

/** What processing an event came to: done, or to be tried again later. */
export type Processed = 'done' | 'retry'
type Handler = (event: {
  id: string
  source: string
  externalId: string
  type: string
  payload: unknown
}) => Promise<Processed>

const handlers = new Map<string, Handler>()

/** How a source's events are processed (by the part of its source before any ':'). */
export function onInbound(kind: string, handler: Handler) {
  handlers.set(kind, handler)
}

/** One try owns an event this long: past it (the API restarted mid-way), the tick tries again. */
const LEASE_MS = 5 * 60_000
/** Waits between tries: 1, 2, 4… minutes, at most an hour. */
const backoff = (attempts: number) => Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000
/** Past this, an event still not through is given up, and operators hear of it. */
const GIVE_UP_MS = 24 * 60 * 60_000
/** Processed events are kept this long, for a vendor's late retry to be recognised, then deleted. */
const KEEP_MS = 3 * 24 * 60 * 60_000

/**
 * Keep an event; a second time (the vendor's retry), it is recognised and not kept again.
 * Processing starts at once, apart from the request (a job, src/jobs.ts).
 */
export async function keepInbound(event: {
  source: string
  externalId: string
  type: string
  payload: unknown
}): Promise<{ id: string; duplicate: boolean }> {
  try {
    const row = await prisma.inboundEvent.create({
      data: {
        ...event,
        externalId: event.externalId.slice(0, 500),
        payload: event.payload as never,
      },
      select: { id: true },
    })
    // Processed apart from the request (src/jobs.ts): on the jobs' queue, or in the background.
    await enqueue({ job: 'inbound-event', key: row.id }).catch((error) =>
      console.error(`inbound ${event.source} ${event.externalId}: left to the tick`, error),
    )
    return { id: row.id, duplicate: false }
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const row = await prisma.inboundEvent.findUniqueOrThrow({
      where: {
        source_externalId: { source: event.source, externalId: event.externalId.slice(0, 500) },
      },
      select: { id: true },
    })
    return { id: row.id, duplicate: true }
  }
}

/** Process one kept event if it is due and nobody else is on it: claimed, then done or tried later. */
export async function processInbound(id: string, now = new Date()) {
  const { count } = await prisma.inboundEvent.updateMany({
    where: { id, status: 'pending', nextAt: { lte: now } },
    data: { nextAt: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
  })
  if (!count) return
  const event = await prisma.inboundEvent.findUniqueOrThrow({ where: { id } })
  const handler = handlers.get(event.source.split(':')[0]!)
  let outcome: Processed
  let error: string | null = null
  try {
    if (!handler) throw new Error(`no handler for ${event.source}`)
    outcome = await handler(event)
  } catch (failure) {
    outcome = 'retry'
    error = failure instanceof Error ? failure.message : String(failure)
    console.error(`inbound ${event.source} ${event.externalId}:`, failure)
  }
  if (outcome === 'done') {
    await prisma.inboundEvent.updateMany({
      where: { id },
      data: { status: 'done', error: null },
    })
    return
  }
  const late = Date.now() - event.createdAt.getTime() > GIVE_UP_MS
  if (late)
    noteFailure(
      'inbound',
      `${event.source} ${event.type} ${event.externalId}: not processed in 24 hours${error ? ` (${error})` : ''}`,
    )
  await prisma.inboundEvent.updateMany({
    where: { id },
    data: late
      ? { status: 'failed', error: error ?? 'not through in 24 hours' }
      : { nextAt: new Date(Date.now() + backoff(event.attempts)), error },
  })
}

let ticking = false

/** The minute's tick: events due (new ones a restart left, retries) are processed, oldest first. */
export async function processDueInbound() {
  if (ticking) return
  ticking = true
  try {
    const due = await prisma.inboundEvent.findMany({
      where: { status: 'pending', nextAt: { lte: new Date() } },
      orderBy: { nextAt: 'asc' },
      select: { id: true },
      take: 50,
    })
    for (const { id } of due) await processInbound(id)
  } finally {
    ticking = false
  }
}

/** Processed and given-up events, after a few days: deleted. */
export const sweepInbound = (now = Date.now()) =>
  prisma.inboundEvent.deleteMany({
    where: { status: { not: 'pending' }, updatedAt: { lt: new Date(now - KEEP_MS) } },
  })
