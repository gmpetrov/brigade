import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

// What a workspace's sockets and what waits on them hold lives in its hub (src/hub/), never in a
// module (docs/workspace-hubs-plan.md, Phase 1): once hubs are Durable Objects, a module's state is
// the isolate's, which several objects may share, while a workspace's state is its own object's.
// So a Map, Set or array a module keeps for the life of the process is one of these, with why:
const ALLOWED: Record<string, string> = {
  'src/hub.ts:made': "hubs.get's proxies, by workspace: routing, no workspace state",
  'src/hub/memory-host.ts:local': "this process's hubs themselves",
  'src/inbound.ts:handlers': 'webhook handlers, registered as modules load',
  'src/held-calls.ts:executors': 'how each kind of held call is made, registered as modules load',
  'src/db.ts:writeListeners': 'listeners registered as modules load',
  'src/mcp-tools.ts:listed': "a cache of MCP servers' tool lists: data, by connection",
  'src/git.ts:repoLists': "a cache of GitHub installations' repositories: data",
  'src/git.ts:publicRepos': 'a cache of public repositories: data',
  'src/connectors/github-app.ts:tokens': "a cache of the GitHub App's installation tokens: data",
  'src/spec-parts.ts:kept': 'when parts were last written, a cache to skip writes: data',
  'src/project-sites.ts:recent':
    'reads of websites for the HTTP routes that ask, deduped: never reached from a hub',
  'src/cloud.ts:desktopRequests':
    'desktop sign-ins asked for by the HTTP routes, deduped: never reached from a hub',
  'src/desktop-proxy.ts:views': 'desktop relays the HTTP routes open: never reached from a hub',
  'src/designs.ts:editing': 'design edits the HTTP routes make, one at a time: never in a hub',
  'src/teaching.ts:recordings': 'who records on a computer, held by HTTP routes alone',
  'src/routes/threads.ts:editsNoted': 'edits already told to their thread, an HTTP route only',
  'src/subscriptions/common.ts:running':
    "subscriptions' readers, one at a time: jobs and webhooks, never a hub",
  'src/ops/failures.ts:failures': 'failures counted for the checks of the process that runs them',
  'src/ops/checks.ts:reported':
    "what hub objects last said of their threads' events: the checks' own memory, renewed each tick",
  'src/ops/checks.ts:offlineSince': "the checks' own memory, in the process that runs them",
  'src/ops/watchdog.ts:downs': "the cron's own memory",
  'src/account-health.ts:failures':
    "by account, each a workspace's whose events go through its one hub: a count that a restart or a hibernation resets, then counts again",
  'src/front.ts:routes': "where each workspace's sockets went lately: the front Worker's own cache",
  'src/jobs.ts:running': "jobs running on the process's own timers: one run of each at a time",
  'src/platform/workers.ts:modes': "each workspace's hub mode as last read: data, by workspace",
}

const root = new URL('../', import.meta.url).pathname
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path)
    return path.endsWith('.ts') ? [path] : []
  })

/** A module-level Map, Set or array that starts empty: state, unlike a table of constants. */
const STATE =
  /^(?:export )?(?:const|let) (\w+)(?::[^=]+)? = (?:new (?:Map|Set|WeakMap|WeakSet)\b.*\(\)\s*(?:\/\/.*)?$|\[\])/

test('modules keep no state of their own but what is listed, with why', () => {
  const found: string[] = []
  for (const file of files(join(root, 'src')))
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const name = STATE.exec(line)?.[1]
      if (name) found.push(`${relative(root, file)}:${name}`)
    }
  const unknown = found.filter((key) => !(key in ALLOWED))
  assert.deepEqual(
    unknown,
    [],
    'keep it in the workspace hub (currentHub().local, perHub), or list it here with why',
  )
  const gone = Object.keys(ALLOWED).filter((key) => !found.includes(key))
  assert.deepEqual(gone, [], 'no longer in the code: remove it from the list')
})
