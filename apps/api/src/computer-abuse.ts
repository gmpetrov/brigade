// Abuse a cloud computer's runner saw (its abuse.ts, docs/abuse.md): what its egress limits
// stopped, miners it killed, a teammate keeping the CPU for hours. For Brigade's operators, as
// the abuse:<computerId> alert, open while reports keep coming and resolved an hour after the
// last one (src/ops/checks.ts). Members are not told: an operator decides what to do.
import type { RunnerToApi } from '@brigade/contracts'
import { prisma } from './db.js'
import { raise, resolve } from './ops/alerts.js'

type Report = Extract<RunnerToApi, { type: 'abuse' }>
type Runner = { workspaceId: string; computerId: string }

/** An abuse: alert with no report for this long is over. */
export const ABUSE_QUIET_MS = 60 * 60_000

const WHAT: Record<keyof Report['blocked'], string> = {
  smtp: 'mail sent straight to mail servers (port 25)',
  metadata: "the cloud's metadata address (169.254.0.0/16)",
  scan: 'bursts of new connections, as a network scan makes',
  mining: "a mining pool's protocol",
}

/** The alert a report raises: critical for a miner, mail or a scan; a warning for CPU alone. */
export function abuseAlert(report: Report, computerId: string, workspace: string) {
  const blocked = (Object.keys(WHAT) as (keyof Report['blocked'])[]).filter(
    (k) => report.blocked[k] > 0,
  )
  const lines: string[] = [`Workspace: ${workspace}. Computer: ${computerId}.`]
  if (blocked.length)
    lines.push(
      `Stopped by the egress limits since the last report:\n${blocked
        .map((k) => `- ${WHAT[k]}: ${report.blocked[k]} packet(s)`)
        .join('\n')}`,
    )
  if (report.miners.length)
    lines.push(
      `Miners found:\n${report.miners
        .map(
          (m) =>
            `- ${m.user} pid ${m.pid}${m.killed ? ' (killed)' : ' (NOT killed)'}: ${m.command}`,
        )
        .join('\n')}`,
    )
  if (report.cpu.length)
    lines.push(
      `CPU kept for long:\n${report.cpu
        .map((c) => `- ${c.user}: ${Math.round(c.share * 100)}% of all cores for ${c.minutes} min`)
        .join('\n')}`,
    )
  lines.push('What to do: docs/abuse.md.')
  const serious = blocked.length > 0 || report.miners.length > 0
  return {
    key: `abuse:${computerId}`,
    severity: serious ? ('critical' as const) : ('warning' as const),
    title: `Abuse on a cloud computer: ${workspace}`,
    detail: lines.join('\n\n'),
  }
}

/** What the runner said (an `abuse` message). */
export async function noteAbuse(runner: Runner, report: Report, now = new Date()) {
  const computer = await prisma.computer.findFirst({
    where: { id: runner.computerId, workspaceId: runner.workspaceId },
    select: { kind: true, workspace: { select: { name: true } } },
  })
  // A member's own machine is theirs: its runner never looks anyway.
  if (computer?.kind !== 'cloud') return
  await raise(abuseAlert(report, runner.computerId, computer.workspace.name), now)
}

/** abuse: alerts with no report for ABUSE_QUIET_MS, resolved. */
export async function settleAbuse(now = new Date()) {
  const quiet = await prisma.opsAlert.findMany({
    where: {
      key: { startsWith: 'abuse:' },
      resolvedAt: null,
      lastAt: { lt: new Date(now.getTime() - ABUSE_QUIET_MS) },
    },
    select: { key: true },
  })
  for (const { key } of quiet) await resolve(key, now)
}
