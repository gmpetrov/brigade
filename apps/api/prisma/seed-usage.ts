// Sample tokens for Settings › Usage: a month of teammate turns in each sample thread, and
// Brigade's own runs (memory, titles), spread over days with one busy day to look into.
// Made up, as the rest of the sample; seed-workspace.ts calls it once its threads exist.
import { prisma } from '../src/db.js'
import { threadSource } from '../src/usage.js'

const DAY_MS = 24 * 60 * 60_000

/** A number in [0, 1) from a seed: the same sample on each setup. */
const noise = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export async function seedUsage(scope: { organizationId: string; workspaceId: string }) {
  const [sessions, accounts] = await Promise.all([
    prisma.session.findMany({
      where: { workspaceId: scope.workspaceId },
      select: {
        id: true,
        teammateId: true,
        accountId: true,
        origin: true,
        playbookRunId: true,
        projectId: true,
        scheduleId: true,
        createdAt: true,
        teammate: { select: { harness: true, model: true } },
        _count: { select: { reviewsOf: true } },
      },
    }),
    prisma.account.findMany({
      where: { workspaceId: scope.workspaceId },
      select: { id: true, memberId: true },
    }),
  ])
  const owner = new Map(accounts.map((a) => [a.id, a.memberId]))
  const now = Date.now()
  // One thread spends far more each turn than the others: what Usage is there to find.
  const heavy = sessions.find((s) => s.origin === 'member' && !s.playbookRunId)?.id
  const rows = sessions.flatMap((s, n) => {
    const source = threadSource({ ...s, reviews: s._count.reviewsOf })
    // A playbook's run is a short one: the sample has many.
    const scale = s.id === heavy ? 6 : source === 'playbook' ? 0.3 : 1
    const turns =
      source === 'playbook' ? 1 + Math.round(noise(n) * 2) : 3 + Math.round(noise(n + 1) * 12)
    const started = Math.max(s.createdAt.getTime(), now - 29 * DAY_MS)
    return Array.from({ length: turns }, (_, i) => {
      const at = new Date(started + noise(n * 31 + i) * (now - started))
      const input = Math.round((90_000 + noise(n * 7 + i) * 400_000) * scale)
      return {
        ...scope,
        sessionId: s.id,
        seq: 10_000 + i,
        teammateId: s.teammateId,
        accountId: s.accountId,
        memberId: (s.accountId && owner.get(s.accountId)) || null,
        projectId: s.projectId,
        scheduleId: s.scheduleId,
        provider: s.teammate.harness,
        model:
          s.teammate.model ??
          (s.teammate.harness === 'codex' ? 'gpt-5.5-codex' : 'claude-opus-5-5'),
        source,
        inputTokens: input,
        cacheReadTokens: Math.round(input * 0.9),
        cacheWriteTokens: Math.round(input * 0.07),
        outputTokens: Math.round(input * (0.012 + noise(i) * 0.015)),
        reasoningTokens: Math.round(input * 0.004),
        at,
      }
    })
  })
  // Brigade's own runs: each thread's title, and its memory once it went quiet.
  const runs = sessions.flatMap((s, n) =>
    (['title', 'memory'] as const).map((kind, k) => {
      const input = kind === 'title' ? 1_800 : 24_000 + Math.round(noise(n + k) * 30_000)
      return {
        ...scope,
        sessionId: s.id,
        teammateId: s.teammateId,
        accountId: s.accountId,
        memberId: (s.accountId && owner.get(s.accountId)) || null,
        projectId: s.projectId,
        scheduleId: s.scheduleId,
        provider: s.teammate.harness,
        model: kind === 'title' ? 'claude-haiku-4-5' : 'claude-opus-5-5',
        source: kind,
        inputTokens: input,
        cacheReadTokens: 0,
        cacheWriteTokens: Math.round(input * 0.5),
        outputTokens: kind === 'title' ? 12 : 900,
        reasoningTokens: 0,
        at: new Date(Math.max(s.createdAt.getTime(), now - 29 * DAY_MS) + 60_000 * (k ? 90 : 1)),
      }
    }),
  )
  await prisma.tokenUsage.createMany({ data: [...rows, ...runs] })
}
