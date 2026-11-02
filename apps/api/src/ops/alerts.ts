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

/**
 * The problem is there now. Safe to call on every run of a check. `lastAt`: when it was last
 * seen, for a problem counted from failures (the newest one's time, never the check's); by
 * default, now.
 */
export async function raise(alert: Alert, now = new Date(), lastAt = now) {
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
  const notifiedAt = notified ? now : null
  const notifiedSeverity = notified ? step.severity : null
  // One statement, decided on the row as it is when it applies, never on the one read above:
  // a statement sent may wait in Postgres and apply after others wrote, even after the process
  // that sent it died. So `lastAt` only moves on (a failure written meanwhile, by
  // src/ops/last-seen.ts or by another raise, may be newer), and what this raise read only
  // decides what it writes when the row is still as it read it: resolved, for a reopening.
  //  - severity: as bad as it got while it lasts (onRaise), the row's own if still open;
  //  - firstAt: the row's while open, this one's when this raise opens it again;
  //  - resolvedAt: open again only when this raise reopens it, else as the row is;
  //  - notifiedAt/notifiedSeverity: this notice's when it was sent and is not older than the
  //    row's; owed (null) when this raise opens it again without having told it; else the row's.
  await prisma.$executeRaw`
    INSERT INTO "OpsAlert" ("key", "severity", "title", "detail", "firstAt", "lastAt", "notifiedAt", "notifiedSeverity", "resolvedAt")
    VALUES (${alert.key}, ${step.severity}, ${alert.title}, ${detail}, ${step.firstAt}, ${lastAt}, ${notifiedAt}::timestamp(3), ${notifiedSeverity}::text, NULL)
    ON CONFLICT ("key") DO UPDATE SET
      "title" = EXCLUDED."title",
      "detail" = EXCLUDED."detail",
      "severity" = CASE
        WHEN "OpsAlert"."resolvedAt" IS NULL AND "OpsAlert"."severity" = 'critical' THEN 'critical'
        ELSE EXCLUDED."severity" END,
      "firstAt" = CASE
        WHEN ${step.reopen}::boolean AND "OpsAlert"."resolvedAt" IS NOT NULL THEN EXCLUDED."firstAt"
        ELSE "OpsAlert"."firstAt" END,
      "resolvedAt" = CASE WHEN ${step.reopen}::boolean THEN NULL ELSE "OpsAlert"."resolvedAt" END,
      "lastAt" = GREATEST("OpsAlert"."lastAt", EXCLUDED."lastAt"),
      "notifiedAt" = CASE
        WHEN EXCLUDED."notifiedAt" IS NOT NULL
          AND ("OpsAlert"."notifiedAt" IS NULL OR "OpsAlert"."resolvedAt" IS NOT NULL OR "OpsAlert"."notifiedAt" <= EXCLUDED."notifiedAt")
          THEN EXCLUDED."notifiedAt"
        WHEN ${step.reopen}::boolean AND "OpsAlert"."resolvedAt" IS NOT NULL THEN NULL
        ELSE "OpsAlert"."notifiedAt" END,
      "notifiedSeverity" = CASE
        WHEN EXCLUDED."notifiedAt" IS NOT NULL
          AND ("OpsAlert"."notifiedAt" IS NULL OR "OpsAlert"."resolvedAt" IS NOT NULL OR "OpsAlert"."notifiedAt" <= EXCLUDED."notifiedAt")
          THEN EXCLUDED."notifiedSeverity"
        WHEN ${step.reopen}::boolean AND "OpsAlert"."resolvedAt" IS NOT NULL THEN NULL
        ELSE "OpsAlert"."notifiedSeverity" END`
}

/**
 * Move an alert's `lastAt` on to `at`, never back, in one statement: its writers (the checks,
 * each failure as it comes) may race. `openOnly`: not once it is resolved.
 */
export const seenAt = (key: string, at: Date, { openOnly = false } = {}) =>
  openOnly
    ? prisma.$executeRaw`UPDATE "OpsAlert" SET "lastAt" = GREATEST("lastAt", ${at}) WHERE "key" = ${key} AND "resolvedAt" IS NULL`
    : prisma.$executeRaw`UPDATE "OpsAlert" SET "lastAt" = GREATEST("lastAt", ${at}) WHERE "key" = ${key}`

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
