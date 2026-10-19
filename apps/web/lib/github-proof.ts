// The landing's proof: how much of Brigade its own teammates build, read from GitHub's
// REST API once, when the dashboard is built. next.config.ts calls fetchProofNumbers()
// and inlines the result into the build as BRIGADE_LANDING_PROOF; the page reads it with
// getProofNumbers(). So the numbers are as of the last deploy, and a visitor never waits on
// GitHub or spends its rate limit, even where the host renders the page per request
// (OpenNext on Workers). A number GitHub does not give back is null, and the page leaves
// out the sentence that needs it. GITHUB_TOKEN, when set at build, raises GitHub's limit.

export const REPO = 'gmpetrov/brigade'
export const REPO_URL = `https://github.com/${REPO}`
const API = 'https://api.github.com'

export type ProofNumbers = {
  /** Pull requests merged in the last 30 days. */
  mergedPrs: number | null
  /** Commits whose author name is Riley, a Brigade teammate. */
  rileyCommits: number | null
  /** Commits on the default branch. */
  totalCommits: number | null
  /** The last pull requests merged into main, newest first. */
  recentMerges: RecentMerge[] | null
}

export type RecentMerge = {
  number: number
  title: string
  url: string
  /** The head branch when it is a Brigade teammate's (`brigade/…`), else null. */
  branch: string | null
  mergedAt: string
}

type PullsItem = {
  number?: unknown
  title?: unknown
  html_url?: unknown
  merged_at?: unknown
  head?: { ref?: unknown }
}

/** `YYYY-MM-DD` (UTC), `days` before `now`. */
export function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

/** Search query for the pull requests merged since 30 days before `now`. */
export function mergedPrsQuery(now: Date) {
  return `repo:${REPO} is:pr is:merged merged:>=${daysAgo(now, 30)}`
}

export const rileyCommitsQuery = `repo:${REPO} author-name:Riley`

/** The page number of `rel="last"` in a Link header: with per_page=1, the item count. */
export function lastPageFromLink(link: string | null) {
  const match = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)
  return match ? Number(match[1]) : null
}

export function formatCount(n: number) {
  return n.toLocaleString('en-US')
}

/** How much of the history Riley wrote, in words: "half of all its commits" when it is about half. */
export function rileyShare(riley: number, total: number) {
  const ratio = riley / total
  if (ratio >= 0.45 && ratio <= 0.55) return 'half of all its commits'
  return `${formatCount(riley)} of its ${formatCount(total)} commits`
}

/** The day a pull request merged, in UTC: "Oct 19". A date, not "2h ago", since the page
 * keeps it until the next deploy. */
export function mergeDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** The `count` most recently merged pull requests in a pulls API reply, newest first. */
export function pickRecentMerges(items: PullsItem[], count = 4): RecentMerge[] {
  const merges: RecentMerge[] = []
  for (const item of items) {
    const { number, title, html_url, merged_at } = item
    if (typeof merged_at !== 'string' || Number.isNaN(Date.parse(merged_at))) continue
    if (typeof number !== 'number' || typeof title !== 'string' || typeof html_url !== 'string')
      continue
    const ref = item.head?.ref
    merges.push({
      number,
      title,
      url: html_url,
      branch: typeof ref === 'string' && ref.startsWith('brigade/') ? ref : null,
      mergedAt: merged_at,
    })
  }
  return merges.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, count)
}

function get(path: string) {
  const token = process.env.GITHUB_TOKEN
  return fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'brigade-landing',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(5000),
  })
}

async function searchCount(kind: 'issues' | 'commits', query: string) {
  try {
    const res = await get(`/search/${kind}?per_page=1&q=${encodeURIComponent(query)}`)
    if (!res.ok) return null
    const body = (await res.json()) as { total_count?: unknown; incomplete_results?: unknown }
    if (body.incomplete_results === true || typeof body.total_count !== 'number') return null
    return body.total_count
  } catch {
    return null
  }
}

async function commitCount() {
  try {
    const res = await get(`/repos/${REPO}/commits?per_page=1`)
    if (!res.ok) return null
    return lastPageFromLink(res.headers.get('link'))
  } catch {
    return null
  }
}

async function recentMerges() {
  try {
    // Closed pull requests into main, most recently updated first: a merge updates one,
    // so the last merges are among them.
    const res = await get(
      `/repos/${REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=30`,
    )
    if (!res.ok) return null
    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) return null
    const merges = pickRecentMerges(body as PullsItem[])
    return merges.length > 0 ? merges : null
  } catch {
    return null
  }
}

const none: ProofNumbers = {
  mergedPrs: null,
  rileyCommits: null,
  totalCommits: null,
  recentMerges: null,
}

/** Asks GitHub for the numbers. For next.config.ts, at build: never call it from a page. */
export async function fetchProofNumbers(now = new Date()): Promise<ProofNumbers> {
  const [mergedPrs, rileyCommits, totalCommits, merges] = await Promise.all([
    searchCount('issues', mergedPrsQuery(now)),
    searchCount('commits', rileyCommitsQuery),
    commitCount(),
    recentMerges(),
  ])
  // Riley's share means nothing without the total, and the other way round.
  const commits = rileyCommits !== null && totalCommits !== null && rileyCommits <= totalCommits
  return {
    mergedPrs,
    rileyCommits: commits ? rileyCommits : null,
    totalCommits: commits ? totalCommits : null,
    recentMerges: merges,
  }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null)

/** Reads the numbers baked into the build (see fetchProofNumbers); none when absent or malformed. */
export function parseProofNumbers(json: string | undefined): ProofNumbers {
  if (!json) return none
  try {
    const raw = JSON.parse(json) as Record<string, unknown>
    const rileyCommits = count(raw.rileyCommits)
    const totalCommits = count(raw.totalCommits)
    const commits = rileyCommits !== null && totalCommits !== null && rileyCommits <= totalCommits
    const merges = Array.isArray(raw.recentMerges)
      ? pickRecentMerges(
          (raw.recentMerges as Partial<RecentMerge>[]).map((m) => ({
            number: m.number,
            title: m.title,
            html_url: m.url,
            merged_at: m.mergedAt,
            head: { ref: m.branch },
          })),
        )
      : []
    return {
      mergedPrs: count(raw.mergedPrs),
      rileyCommits: commits ? rileyCommits : null,
      totalCommits: commits ? totalCommits : null,
      recentMerges: merges.length > 0 ? merges : null,
    }
  } catch {
    return none
  }
}

export function getProofNumbers(): ProofNumbers {
  return parseProofNumbers(process.env.BRIGADE_LANDING_PROOF)
}
