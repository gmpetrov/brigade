// Alerts to Brigade's operators: one OpsAlert row per problem, by key. A check raises what it
// sees each time it runs and resolves what it no longer sees; operators hear when a problem
// starts, every few hours while it lasts, and when it ends, not on each run of the check.
import { env } from '../config.js'
import { prisma } from '../db.js'
import { addressesIn } from '../mail/text.js'
import {
  ALERT_SUBJECT,
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

/** Where alert emails come from (the Worker's watchdog sends from the same, src/worker.ts). */
export const alertsAddress = () => `alerts@${env.MAIL_DOMAIN}`.toLowerCase()

export const destinations = (): Destinations => ({
  webhookUrl: env.OPS_ALERT_WEBHOOK_URL,
  webhookSecret: env.OPS_ALERT_WEBHOOK_SECRET,
  emails: env.OPS_ALERT_EMAILS,
  resendKey: env.RESEND_API_KEY,
  from: `Brigade alerts <${alertsAddress()}>`,
})

/**
 * One of these alert emails, come back in: to an inbox an operator's address forwards to, or a
 * Gmail a trigger watches. From the alerts address, or, relayed by a list that rewrites the
 * sender, automatic (Auto-Submitted) with an alert's subject. Other automatic mail (receipts,
 * notifications) is not this: triggers watch it on purpose.
 */
export function isOwnAlert(mail: { from?: unknown; subject?: unknown; automatic?: unknown }) {
  if (typeof mail.from === 'string' && addressesIn(mail.from).includes(alertsAddress())) return true
  return (
    mail.automatic === true && typeof mail.subject === 'string' && ALERT_SUBJECT.test(mail.subject)
  )
}

export const alertsConfigured = () => anyDestination(destinations())

type Row = {
  key: string
  severity: string
  firstAt: Date
  notifiedAt: Date | null
  notifiedSeverity: string | null
  resolvedAt: Date | null
}

type Step = {
  reopen: boolean
  firstAt: Date
  /** How bad it is now: while it lasts, as bad as it got. */
  severity: Severity
  notify: 'firing' | 'reminder' | null
}

/**
 * What raising an alert does to its row: open it again (new), keep it (still), how bad it
 * is, and whether operators are told now. While it lasts it stays as bad as it got: a count
 * that wavers around a threshold would otherwise make it critical again each time it
 * crosses. Critical when operators were last told less is told at once, and on each run
 * until it is sent, whatever the count does meanwhile.
 */
export function onRaise(row: Row | null, severity: Severity, now: Date): Step {
  if (!row) return { reopen: true, firstAt: now, severity, notify: 'firing' }
  if (row.resolvedAt) {
    const flapped = now.getTime() - row.resolvedAt.getTime() < FLAP_MS
    return flapped
      ? { reopen: true, firstAt: row.firstAt, severity, notify: 'reminder' }
      : { reopen: true, firstAt: now, severity, notify: 'firing' }
  }
  const worst = row.severity === 'critical' ? 'critical' : severity
  const worse = worst === 'critical' && !!row.notifiedAt && row.notifiedSeverity !== 'critical'
  const due = !row.notifiedAt || now.getTime() - row.notifiedAt.getTime() >= REMIND_MS
  return {
    reopen: false,
    firstAt: row.firstAt,
    severity: worst,
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
      severity: step.severity,
      title: alert.title,
      detail,
      firstAt: step.firstAt,
      at: now,
    }))
  const data = {
    severity: step.severity,
    title: alert.title,
    detail,
    lastAt: now,
    firstAt: step.firstAt,
    ...(step.reopen ? { resolvedAt: null } : {}),
    // Not sent: tried again on the next run.
    ...(notified
      ? { notifiedAt: now, notifiedSeverity: step.severity }
      : step.reopen && step.notify
        ? { notifiedAt: null, notifiedSeverity: null }
        : {}),
  }
  await prisma.opsAlert.upsert({
    where: { key: alert.key },
    create: { key: alert.key, ...data },
    update: data,
  })
}

/**
 * The problem is gone. Operators who were told it started are told it ended; until that is
 * sent, it stays open, and the check's next run, still finding it gone, tries again.
 */
export async function resolve(key: string, now = new Date()) {
  const row = await prisma.opsAlert.findUnique({ where: { key } })
  if (!row || row.resolvedAt) return
  // Nowhere to tell (no destination set any more): it ends without being told.
  if (row.notifiedAt && alertsConfigured()) {
    const told = await tell({
      kind: 'resolved',
      key,
      severity: row.severity as Severity,
      title: row.title,
      detail: '',
      firstAt: row.firstAt,
      at: now,
    })
    if (!told) return
  }
  await prisma.opsAlert.update({ where: { key }, data: { resolvedAt: now } })
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
