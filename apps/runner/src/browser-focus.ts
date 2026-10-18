// Brings a thread's own tab to the front of its teammate's browser, so people
// watching the thread's desktop see the page it works on, not another thread's.
// Runs as the teammate's Linux user (the only user that can reach its browser).
//
// Usage: browser-focus <chrome-port> <tabs-file>
import { readFileSync } from 'node:fs'

type Target = { id: string; type: string }

const [port, tabsFile] = process.argv.slice(2)
/** A browser that does not answer is given up on after this. */
const TIMEOUT_MS = 5_000

async function main() {
  if (!port || !tabsFile) throw new Error('usage: browser-focus <chrome-port> <tabs-file>')
  let owned: string[] = []
  try {
    owned = JSON.parse(readFileSync(tabsFile, 'utf8')) as string[]
  } catch {
    return // The thread never opened a tab.
  }
  const base = `http://127.0.0.1:${port}/json`
  const response = await fetch(`${base}/list`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const pages = new Set(
    ((await response.json()) as Target[]).filter((t) => t.type === 'page').map((t) => t.id),
  )
  // The tab it opened last is the likeliest to be the one it works on.
  const tab = owned.findLast((id) => pages.has(id))
  if (tab) await fetch(`${base}/activate/${tab}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
