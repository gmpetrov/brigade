// Alerts to Brigade's operators: one OpsAlert row per problem, by key. A check raises what it
// sees each time it runs and resolves what it no longer sees; operators hear when a problem
// starts, every few hours while it lasts, and when it ends, not on each run of the check.
import { env } from '../config.js'
import { prisma } from '../db.js'
import {
  anyDestination,
  sendNotice,
  type Destinations,
  type Notice,
  type Severity,
} from './send.js'

export type Alert = { key: string; severity: Severity; title: string; detail?: string }

/** How often a problem that lasts is told again. */
export const REMIND_MS = 6 * 60 * 60_000
/** A problem back this soon after it ended is the same one: told as still lasting, not new. */
export const FLAP_MS = 30 * 60_000

export const destinations = (): Destinations => ({
  webhookUrl: env.OPS_ALERT_WEBHOOK_URL,
  webhookSecret: env.OPS_ALERT_WEBHOOK_SECRET,
  emails: env.OPS_ALERT_EMAILS,
  resendKey: env.RESEND_API_KEY,
  from: `Brigade alerts <alerts@${env.MAIL_DOMAIN}>`,
})

export const alertsConfigured = () => anyDestination(destinations())

type Row = {
  key: string
  severity: string
  firstAt: Date
  notifiedAt: Date | null
  resolvedAt: Date | null
}

/**
 * What raising an alert does to its row: open it again (new), keep it (still), and whether
 * operators are told now. A raise that turns a warning critical is told at once.
 */
export function onRaise(
  row: Row | null,
  severity: Severity,
  now: Date,
): { reopen: boolean; firstAt: Date; notify: 'firing' | 'reminder' | null } {
  if (!row) return { reopen: true, firstAt: now, notify: 'firing' }
  if (row.resolvedAt) {
    const flapped = now.getTime() - row.resolvedAt.getTime() < FLAP_MS
    return flapped
      ? { reopen: true, firstAt: row.firstAt, notify: 'reminder' }
      : { reopen: true, firstAt: now, notify: 'firing' }
  }
  const worse = severity === 'critical' && row.severity !== 'critical'
  const due = !row.notifiedAt || now.getTime() - row.notifiedAt.getTime() >= REMIND_MS
  return {
    reopen: false,
    firstAt: row.firstAt,
    notify: worse ? 'firing' : due ? (row.notifiedAt ? 'reminder' : 'firing') : null,
  }
}

async function tell(notice: Notice) {
  if (!alertsConfigured()) {
    console.error(`ops alert (no destination set): ${notice.kind} ${notice.title}`)
    return false
  }
  try {
    await sendNotice(destinations(), notice)
    return true
  } catch (error) {
    console.error(String(error))
    return false
  }
}

/** The problem is there now. Safe to call on every run of a check. */
export async function raise(alert: Alert, now = new Date()) {
  const detail = (alert.detail ?? '').slice(0, 4000)
  const row = await prisma.opsAlert.findUnique({ where: { key: alert.key } })
  const step = onRaise(row, alert.severity, now)
  const notified =
    step.notify &&
    (await tell({
      kind: step.notify,
      key: alert.key,
      severity: alert.severity,
      title: alert.title,
      detail,
      firstAt: step.firstAt,
      at: now,
    }))
  // While it lasts, it stays as bad as it got: a count that wavers around a threshold
  // would otherwise tell it worse again each time it crosses.
  const kept = !step.reopen && row?.severity === 'critical' ? 'critical' : alert.severity
  const data = {
    severity: kept,
    title: alert.title,
    detail,
    lastAt: now,
    firstAt: step.firstAt,
    ...(step.reopen ? { resolvedAt: null } : {}),
    // Not sent: tried again on the next run.
    ...(notified ? { notifiedAt: now } : step.reopen && step.notify ? { notifiedAt: null } : {}),
  }
  await prisma.opsAlert.upsert({
    where: { key: alert.key },
    create: { key: alert.key, ...data },
    update: data,
  })
}

/** The problem is gone. Operators who were told it started are told it ended. */
export async function resolve(key: string, now = new Date()) {
  const row = await prisma.opsAlert.findUnique({ where: { key } })
  if (!row || row.resolvedAt) return
  await prisma.opsAlert.update({ where: { key }, data: { resolvedAt: now } })
  if (row.notifiedAt)
    await tell({
      kind: 'resolved',
      key,
      severity: row.severity as Severity,
      title: row.title,
      detail: '',
      firstAt: row.firstAt,
      at: now,
    })
}

/**
 * For a check over many things (computers, Workers): raise what it found under `prefix`,
 * and resolve the open alerts under it that it no longer finds.
 */
export async function settle(prefix: string, found: Alert[], now = new Date()) {
  for (const alert of found) await raise(alert, now)
  const open = await prisma.opsAlert.findMany({
    where: { key: { startsWith: prefix }, resolvedAt: null },
    select: { key: true },
  })
  const still = new Set(found.map((a) => a.key))
  for (const { key } of open) if (!still.has(key)) await resolve(key, now)
}

/** What is wrong now, for GET /health/ops. */
export const openAlerts = () =>
  prisma.opsAlert.findMany({
    where: { resolvedAt: null },
    orderBy: { firstAt: 'asc' },
    select: { key: true, severity: true, title: true, detail: true, firstAt: true, lastAt: true },
  })
