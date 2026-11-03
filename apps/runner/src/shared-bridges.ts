// One copy of each harness bridge for all the teammates of a cloud computer.
//
// The harness adapters install their bridge (Claude Code or Codex, its SDK and their
// binaries, 600 to 900 MB) under each OS user's home, at
// ~/.ai-sdk-harness/.harness-bootstrap/<harness>, and keep the versions an update left
// there. Here the runner installs it once, with the adapter's own recipe, into
// <install dir>/bridges/<harness>-<identity>, readable by every teammate and writable by
// none, and each teammate's bootstrap folder becomes a link to it. The adapter then finds
// its marker through the link and installs nothing; a teammate's bridge runs from the
// shared copy.
//
// A teammate's own copy is replaced by the link only while none of its bridges or
// installs runs (a running bridge starts the CLI again from its own folder). Whenever
// the shared copy is not ready (its install failed, say), a link is taken away and the
// adapter installs into the teammate's home, as before. Older shared copies go a day
// after a newer one replaced them, once nothing runs from them.
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarnessSandboxTemplate } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createCodex } from '@ai-sdk/harness-codex'
import { CLOUD } from './config.js'
import { harnessEnv } from './harness/env.js'
import { createLocalSandboxSession } from './harness/local-sandbox.js'
import { run } from './repos.js'
import { teammateHome } from './teammates.js'

export type BridgeHarness = 'claude-code' | 'codex'
export const BRIDGE_HARNESSES: BridgeHarness[] = ['claude-code', 'codex']

/** Where a teammate's adapter looks for its bridge, under its home. */
export const bridgeLink = (home: string, harness: BridgeHarness) =>
  join(home, '.ai-sdk-harness', '.harness-bootstrap', harness)

/**
 * Beside the runner's own install (/opt/brigade/bridges), which its updates leave alone.
 * Only for an installed runner on a cloud computer: there, every teammate can read it.
 */
const INSTALL_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const ROOT = process.env.BRIGADE_BRIDGES_DIR ?? join(INSTALL_DIR, 'bridges')
const ENABLED =
  CLOUD &&
  process.env.BRIGADE_SHARED_BRIDGES !== '0' &&
  (Boolean(process.env.BRIGADE_BRIDGES_DIR) ||
    existsSync(join(INSTALL_DIR, 'bin', 'brigade-runner')))

/** An older shared copy stays this long after a newer one replaced it. */
const SUPERSEDED_KEEP_MS = 24 * 60 * 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** What the shared copy's folder is called: one per harness and recipe. */
export const sharedName = (harness: BridgeHarness, identity: string) => `${harness}-${identity}`

/**
 * The shell, run as the teammate, that points its bootstrap folder at the shared copy.
 * $1 the folder, $2 the shared copy, $3 "convert" to replace a folder of its own. Exit 0:
 * linked; 3: its own folder stays (not asked to convert, or a bridge or an install of its
 * own runs). A link is swapped in one rename: a bridge started from the old target keeps it.
 */
export const LINK_SCRIPT = `
L=$1; T=$2
[ "$(readlink -- "$L" 2>/dev/null)" = "$T" ] && exit 0
if [ -e "$L" ] && [ ! -L "$L" ]; then
  [ "$3" = convert ] || exit 3
  # Its bridges name a file in the folder, and the adapter installs with this store. Both
  # searched for from the environment, and this shell left out: its own words never match.
  B="--store-dir .pnpm"; B="$B-store"
  ps -o pid=,args= -u "$(id -u)" | A="$L/" B="$B" awk -v me="$$" \\
    '$1 != me && (index($0, ENVIRON["A"]) || index($0, ENVIRON["B"])) { found = 1 } END { exit !found }' &&
    exit 3
  mv -T -- "$L" "$L.old-$$" || exit 3
fi
mkdir -p -- "$(dirname -- "$L")"
ln -sfn -- "$T" "$L.link-$$" && mv -Tf -- "$L.link-$$" "$L" || exit 1
rm -rf -- "$L.old-$$"
`
/** As the teammate: take a link away, so that the adapter installs into its home again. */
export const UNLINK_SCRIPT = `[ -L "$1" ] && rm -f -- "$1"; exit 0`

type Shared = { identity: string; dir: string }

export type Adapter = Parameters<typeof createHarnessSandboxTemplate>[0]['harnesses'][number]
/** The adapters as turns make them: their recipe does not depend on the settings. */
const adapters: Record<BridgeHarness, () => Adapter> = {
  'claude-code': () => createClaudeCode({ auth: {} }),
  codex: () => createCodex({ auth: {} }),
}

/** The adapter's recipe identity: what names the shared copy. Null without a recipe. */
async function identityOf(harness: BridgeHarness) {
  const template = await createHarnessSandboxTemplate({ harnesses: [adapters[harness]()] })
  return template ? { identity: template.identity } : null
}

const installs = new Map<string, Promise<Shared | null>>()
/** When an install last failed: turns install in their homes meanwhile, without waiting on it. */
const failed = new Map<string, number>()
const RETRY_AFTER_MS = 10 * 60_000

/**
 * The shared copy of a harness's bridge, installed if needed: its folder, or null when there
 * is none (not a cloud computer, or the install failed: tried again RETRY_AFTER_MS later).
 */
export function sharedBridge(harness: BridgeHarness, now = Date.now()): Promise<Shared | null> {
  if (!ENABLED) return Promise.resolve(null)
  let install = installs.get(harness)
  if (!install) {
    if (now - (failed.get(harness) ?? -Infinity) < RETRY_AFTER_MS) return Promise.resolve(null)
    install = installShared(harness).catch((error: unknown) => {
      console.warn(`could not install the shared ${harness} bridge: ${String(error)}`)
      failed.set(harness, Date.now())
      installs.delete(harness)
      return null
    })
    installs.set(harness, install)
  }
  return install
}

const installShared = (harness: BridgeHarness) => installInto(ROOT, harness, adapters[harness]())

/**
 * The runner's children keep its low OOM score (cgroups.conf in the API's setup): an install
 * that grows would have other processes killed first. Its commands give it up, so that when
 * memory runs out the install goes first, and turns install in their homes meanwhile.
 */
const OOM_FIRST = '{ echo 1000 >/proc/self/oom_score_adj; } 2>/dev/null; '

/** Install an adapter's bridge under root, as this user, with the adapter's own recipe. */
export async function installInto(root: string, harness: BridgeHarness, adapter: Adapter) {
  const template = await createHarnessSandboxTemplate({ harnesses: [adapter] })
  if (!template) return null
  const home = join(root, sharedName(harness, template.identity))
  await mkdir(home, { recursive: true, mode: 0o755 })
  // The adapter's own install into that home: it writes the recipe's files, runs its pnpm
  // install, and writes its marker last. Again on each start, it only reads the marker.
  const sandbox = createLocalSandboxSession({
    id: `shared-${harness}`,
    workingDirectory: home,
    port: 0,
    env: harnessEnv({ HOME: home }),
  })
  const session: typeof sandbox = {
    ...sandbox,
    run: (options) => sandbox.run({ ...options, command: `${OOM_FIRST}${options.command}` }),
  }
  await template.prepare({ session, abortSignal: AbortSignal.timeout(INSTALL_TIMEOUT_MS) })
  // Readable by every teammate, whatever umask the runner had.
  await run('chmod', ['-R', 'a+rX', home])
  return { identity: template.identity, dir: bridgeLink(home, harness) }
}

/** Serialized per teammate and harness: two turns starting together link once. */
const linking = new Map<string, Promise<unknown>>()

function serially<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = linking.get(key) ?? Promise.resolve()
  const next = before.then(work, work)
  linking.set(
    key,
    next.catch(() => undefined),
  )
  return next
}

/**
 * Before a teammate's turn: its bootstrap folder made a link to the shared bridge (its own
 * copy replaced when nothing of it runs, with `convert`), or, with no shared copy, a link
 * taken away so that the adapter installs as before. Never throws: the turn goes on either way.
 */
export function useSharedBridge(
  runAs: string,
  harness: BridgeHarness,
  options: { convert?: boolean } = { convert: true },
): Promise<'linked' | 'own'> {
  if (!ENABLED) return Promise.resolve('own')
  const link = bridgeLink(teammateHome(runAs), harness)
  return serially(`${runAs}:${harness}`, async () => {
    const shared = await sharedBridge(harness)
    try {
      if (!shared) {
        await run('sh', ['-c', UNLINK_SCRIPT, 'sh', link], { runAs })
        return 'own' as const
      }
      await run(
        'sh',
        ['-c', LINK_SCRIPT, 'sh', link, shared.dir, options.convert ? 'convert' : ''],
        {
          runAs,
        },
      )
      return 'linked' as const
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code !== 3) console.warn(`could not link ${runAs}'s ${harness} bridge: ${String(error)}`)
      return 'own' as const
    }
  })
}

/** Whether a teammate has a bootstrap folder of its own for this harness (not a link). */
async function hasOwn(runAs: string, harness: BridgeHarness) {
  const link = bridgeLink(teammateHome(runAs), harness)
  return run('sh', ['-c', '[ -d "$1" ] && [ ! -L "$1" ]', 'sh', link], { runAs }).then(
    () => true,
    () => false,
  )
}

/**
 * Now and then on a cloud computer: the teammates' own copies replaced by links (those that
 * keep theirs for now are tried again next time), then the older shared copies removed.
 */
export async function tidyBridges(teammates: string[], now = Date.now()) {
  if (!ENABLED) return
  for (const harness of BRIDGE_HARNESSES)
    for (const runAs of teammates)
      if (await hasOwn(runAs, harness)) await useSharedBridge(runAs, harness, { convert: true })
  await removeSuperseded(now)
}

/**
 * The names under ROOT of shared copies no current recipe names, with the time each was
 * first seen superseded; those superseded for SUPERSEDED_KEEP_MS that no process runs
 * from go. A teammate's link to one then points nowhere until its next turn links it again.
 */
async function removeSuperseded(now: number) {
  const current = new Set<string>()
  for (const harness of BRIDGE_HARNESSES) {
    const template = await identityOf(harness).catch(() => null)
    if (template) current.add(sharedName(harness, template.identity))
  }
  const names = await readdir(ROOT).catch(() => [] as string[])
  const old = staleCopies(names, current)
  if (old.length === 0) return
  const args = (await run('ps', ['-A', '-o', 'args=']).catch(() => Buffer.alloc(0))).toString()
  for (const name of old) {
    const home = join(ROOT, name)
    const mark = join(home, '.superseded')
    const since = await stat(mark).then(
      (s) => s.mtimeMs,
      async () => {
        await writeFile(mark, '').catch(() => undefined)
        return now
      },
    )
    if (now - since < SUPERSEDED_KEEP_MS) continue
    if (args.includes(home)) continue
    await rm(home, { recursive: true, force: true }).then(
      () => console.log(`removed the shared bridge ${name}, replaced by a newer one`),
      (error: unknown) => console.warn(`could not remove ${home}: ${String(error)}`),
    )
  }
}

/** Shared copies (harness-identity) that are not current. */
export function staleCopies(names: string[], current: Set<string>) {
  return names.filter(
    (name) =>
      BRIDGE_HARNESSES.some((harness) => new RegExp(`^${harness}-[0-9a-f]{8,64}$`).test(name)) &&
      !current.has(name),
  )
}
