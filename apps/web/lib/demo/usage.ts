// Settings › Usage in the demo: made up from the sample's threads, teammates and routines,
// the same on each visit (a seeded sequence), as Ada, an owner, would see it.
import type { UsageGroup, UsagePeriod, UsageResponse, UsageSource } from '@brigade/contracts'

type Thread = { id: string; title: string; teammateId: string; origin: string }
type Named = { id: string; name?: string; title?: string; harness?: string }

const DAY_MS = 24 * 60 * 60_000

/** A number in [0, 1) from a seed: the demo's figures, the same on each visit. */
const noise = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** A run's tokens: input mostly the cache read again, a little written. */
function spent(scale: number, runs: number) {
  const input = Math.round(scale)
  return {
    input,
    cacheRead: Math.round(input * 0.91),
    cacheWrite: Math.round(input * 0.06),
    output: Math.round(input * 0.018),
    runs,
  }
}

const sum = <T extends { input: number; output: number }>(rows: T[]) =>
  rows.sort((a, b) => b.input + b.output - (a.input + a.output))

export function demoUsage(
  days: UsagePeriod,
  input: { threads: Thread[]; teammates: Named[]; schedules: Named[]; member: Named },
): UsageResponse {
  const now = Date.now()
  const since = new Date(now - days * DAY_MS)
  const daily: UsageResponse['daily'] = []
  for (let i: number = days; i >= 0; i--) {
    const day = new Date(now - i * DAY_MS).toISOString().slice(0, 10)
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    // Quieter at the weekend; one day out of line, as Usage is there to show.
    const busy = weekday === 0 || weekday === 6 ? 0.35 : 1
    const spike = i === 3 ? 2.6 : 1
    const runs = Math.round((18 + noise(i + 1) * 14) * busy * spike)
    daily.push({ day, ...spent(runs * (260_000 + noise(i + 7) * 120_000), runs) })
  }
  const total = daily.reduce(
    (t, d) => ({
      input: t.input + d.input,
      cacheRead: t.cacheRead + d.cacheRead,
      cacheWrite: t.cacheWrite + d.cacheWrite,
      output: t.output + d.output,
      runs: t.runs + d.runs,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, runs: 0 },
  )
  const share = (parts: [string, string, number][]): UsageGroup[] =>
    sum(
      parts.map(([id, label, part]) => ({
        id,
        label,
        ...spent(total.input * part, Math.max(1, Math.round(total.runs * part))),
      })),
    )
  const sources: [UsageSource, number][] = [
    ['member', 0.58],
    ['schedule', 0.17],
    ['child', 0.09],
    ['review', 0.07],
    ['trigger', 0.04],
    ['memory', 0.03],
    ['playbook', 0.015],
    ['title', 0.005],
  ]
  const teammates = input.teammates.slice(0, 6)
  const weights = teammates.map((_, i) => 1 / (i + 1.4))
  const weight = weights.reduce((a, b) => a + b, 0)
  const threads = input.threads.slice(0, 10)
  return {
    days,
    scope: 'all',
    since: since.toISOString(),
    totals: total,
    daily,
    byProvider: share([
      ['claude_code', 'Claude', 0.82],
      ['codex', 'Codex', 0.18],
    ]),
    bySource: share(sources.map(([id, part]) => [id, id, part])),
    byTeammate: share(
      teammates.map((t, i) => [t.id, t.name ?? 'Teammate', (weights[i]! / weight) * 0.97]),
    ),
    byModel: share([
      ['claude-opus-5-5', 'claude-opus-5-5', 0.71],
      ['gpt-5.5-codex', 'gpt-5.5-codex', 0.18],
      ['claude-haiku-4-5', 'claude-haiku-4-5', 0.11],
    ]),
    byMember: share([
      [input.member.id, input.member.name ?? 'Ada', 0.64],
      ['bob', 'Bob', 0.36],
    ]),
    topThreads: sum(
      threads.map((t, i) => ({
        id: t.id,
        label: t.title,
        source: (t.origin as UsageSource) ?? 'member',
        teammateId: t.teammateId,
        // The first one spends far more per turn than the rest: the kind of thread to look into.
        ...spent(
          total.input * (i === 0 ? 0.12 : 0.05 * noise(i + 3) + 0.01),
          i === 0 ? 9 : 4 + Math.round(noise(i + 11) * 20),
        ),
      })),
    ),
    topSchedules: share(
      input.schedules.slice(0, 4).map((s, i) => [s.id, s.title ?? 'Routine', 0.17 / (i + 1.6)]),
    ).map((s) => ({ ...s, runs: days })),
  }
}
