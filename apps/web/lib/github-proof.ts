// The landing's live proof: how much of Brigade its own teammates build, read from
// GitHub's public REST API (no token) and cached for an hour. A number GitHub does not
// give back is null, and the page leaves out the sentence that needs it.

export const REPO = 'gmpetrov/brigade'
export const REPO_URL = `https://github.com/${REPO}`
const API = 'https://api.github.com'
const REVALIDATE = 3600

export type ProofNumbers = {
  /** Pull requests merged in the last 30 days. */
  mergedPrs: number | null
  /** Commits whose author name is Riley, a Brigade teammate. */
  rileyCommits: number | null
  /** Commits on the default branch. */
  totalCommits: number | null
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

function get(path: string) {
  return fetch(`${API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'brigade-landing',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    next: { revalidate: REVALIDATE },
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

export async function getProofNumbers(now = new Date()): Promise<ProofNumbers> {
  const [mergedPrs, rileyCommits, totalCommits] = await Promise.all([
    searchCount('issues', mergedPrsQuery(now)),
    searchCount('commits', rileyCommitsQuery),
    commitCount(),
  ])
  // Riley's share means nothing without the total, and the other way round.
  const commits = rileyCommits !== null && totalCommits !== null && rileyCommits <= totalCommits
  return {
    mergedPrs,
    rileyCommits: commits ? rileyCommits : null,
    totalCommits: commits ? totalCommits : null,
  }
}
