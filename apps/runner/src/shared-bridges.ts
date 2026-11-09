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
// after a newer one replaced them, once no teammate's link points to them and no bridge
// runs from them: a bridge started through a link keeps the copy it started from when the
// link moves on, so the runner keeps, beside that copy, which processes still hold it. A
// teammate whose turns stopped keeps its link on the copy of its last turn: the runner's tidy
// moves it on (tidyBridges), or that copy would stay for good.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
/** A cloud computer's installed runner: where teammates' bootstrap folders may be links. */
const ON_CLOUD =
  CLOUD &&
  (Boolean(process.env.BRIGADE_BRIDGES_DIR) ||
    existsSync(join(INSTALL_DIR, 'bin', 'brigade-runner')))
/**
 * Shared bridges in use. BRIGADE_SHARED_BRIDGES=0 turns them off: the teammates' links are
 * then taken away (useSharedBridge), and the adapters install in their homes as before.
 */
const enabled = () => ON_CLOUD && process.env.BRIGADE_SHARED_BRIDGES !== '0'

/** An older shared copy stays this long after a newer one replaced it. */
const SUPERSEDED_KEEP_MS = 24 * 60 * 60_000
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** What the shared copy's folder is called: one per harness and recipe. */
export const sharedName = (harness: BridgeHarness, identity: string) => `${harness}-${identity}`

/**
 * In the scripts below, `holders` prints the pids of the teammate's processes that name a
 * file in its bootstrap folder ($L: its bridges) or run the adapter's install (its store).
 * Both are searched for from the environment, and the script's own shell left out, so that
 * its own words never match.
 */
const HOLDERS = `
B="--store-dir .pnpm"; B="$B-store"
holders() {
  ps -o pid=,args= -u "$(id -u)" | A="$L/" B="$B" awk -v me="$$" \\
    '$1 != me && (index($0, ENVIRON["A"]) || index($0, ENVIRON["B"])) { printf "%s ", $1 }'
}
`

/**
 * The shell, run as the teammate, that points its bootstrap folder at the shared copy.
 * $1 the folder, $2 the shared copy, $3 "convert" to replace a folder of its own. Exit 0:
 * linked; 3: its own folder stays (not asked to convert, or a bridge or an install of its
 * own runs). A link to another copy is swapped in one rename: the bridges started through
 * it keep running from that copy, and are printed as "held <copy> <pid>…" (recordHolders).
 */
export const LINK_SCRIPT = `
L=$1; T=$2
${HOLDERS}
O=$(readlink -- "$L" 2>/dev/null)
[ "$O" = "$T" ] && exit 0
if [ -n "$O" ]; then
  H=$(holders); [ -z "$H" ] || echo "held $O $H"
elif [ -e "$L" ]; then
  [ "$3" = convert ] || exit 3
  [ -z "$(holders)" ] || exit 3
  mv -T -- "$L" "$L.old-$$" || exit 3
fi
mkdir -p -- "$(dirname -- "$L")"
ln -sfn -- "$T" "$L.link-$$" && mv -Tf -- "$L.link-$$" "$L" || exit 1
rm -rf -- "$L.old-$$"
`
/**
 * As the teammate: take a link away, so that the adapter installs into its home again. The
 * bridges started through it are printed as with LINK_SCRIPT. A folder of its own stays.
 */
export const UNLINK_SCRIPT = `
L=$1
${HOLDERS}
O=$(readlink -- "$L" 2>/dev/null) || exit 0
H=$(holders); [ -z "$H" ] || echo "held $O $H"
rm -f -- "$L"
`
/**
 * As the teammate, before its link moves on or goes: who runs through it now, as with
 * LINK_SCRIPT ("held <copy> <pid>…"), so that the copy it leaves is kept from the start.
 * $2: the copy it is to point to; nothing printed when it points there already.
 */
export const HOLDERS_SCRIPT = `
L=$1
${HOLDERS}
O=$(readlink -- "$L" 2>/dev/null) || exit 0
[ "$O" = "$2" ] && exit 0
H=$(holders); [ -z "$H" ] || echo "held $O $H"
`

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
  if (!enabled()) return Promise.resolve(null)
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

/** A script run as the teammate (`sh -c script sh args…`): what it printed. Rejects on failure. */
export type Exec = (script: string, args: string[]) => Promise<string>

const asTeammateSh =
  (runAs: string): Exec =>
  (script, args) =>
    run('sh', ['-c', script, 'sh', ...args], { runAs }).then(String)

/**
 * Point a teammate's bootstrap folder at a shared copy (LINK_SCRIPT), or take its link away
 * when there is none (UNLINK_SCRIPT), and keep which processes still hold the copy it left.
 */
export async function linkTeammate(
  folder: string,
  shared: string | null,
  convert: boolean,
  exec: Exec,
  root = ROOT,
): Promise<'linked' | 'own'> {
  // Noted before the link moves, so that a cleanup in between, or a runner stopped there,
  // never finds the copy it leaves unheld. When that fails, the link stays where it is.
  await recordHolders(await exec(HOLDERS_SCRIPT, [folder, shared ?? '']), root)
  // And again after, for a bridge started meanwhile: the link has moved by then.
  const again = (out: unknown) =>
    recordHolders(String(out ?? ''), root).catch((error: unknown) => console.warn(String(error)))
  try {
    const out = shared
      ? await exec(LINK_SCRIPT, [folder, shared, convert ? 'convert' : ''])
      : await exec(UNLINK_SCRIPT, [folder])
    await again(out)
    return shared ? 'linked' : 'own'
  } catch (error) {
    // It may have said which processes hold the copy before it failed.
    await again((error as { stdout?: unknown }).stdout)
    throw error
  }
}

/**
 * Before a teammate's turn: its bootstrap folder made a link to the shared bridge (its own
 * copy replaced when nothing of it runs, with `convert`), or, with no shared copy (shared
 * bridges off, or its install failed), a link taken away so that the adapter installs as
 * before. Never throws: the turn goes on either way. `home` and `exec`: for tests.
 */
export function useSharedBridge(
  runAs: string,
  harness: BridgeHarness,
  options: { convert?: boolean; home?: string; exec?: Exec } = {},
): Promise<'linked' | 'own'> {
  if (!ON_CLOUD) return Promise.resolve('own')
  const folder = bridgeLink(options.home ?? teammateHome(runAs), harness)
  const exec = options.exec ?? asTeammateSh(runAs)
  return serially(`${runAs}:${harness}`, async () => {
    const shared = enabled() ? await sharedBridge(harness) : null
    try {
      return await linkTeammate(folder, shared?.dir ?? null, options.convert ?? true, exec)
    } catch (error) {
      const code = (error as { code?: number }).code
      if (code !== 3) console.warn(`could not link ${runAs}'s ${harness} bridge: ${String(error)}`)
      return 'own' as const
    }
  })
}

/**
 * As the teammate: exit 0 when its bootstrap folder ($1) is to be pointed at the current copy
 * ($2): a folder of its own, or a link to another copy. None at all is left so: a harness it
 * never ran gets no link, nor its copy installed for it.
 */
export const STALE_SCRIPT = `
L=$1; T=$2
if [ -L "$L" ]; then [ "$(readlink -- "$L")" != "$T" ]; else [ -d "$L" ]; fi
`

/** Whether a teammate's bootstrap folder is its own or a link to a copy other than `current`. */
async function isStale(runAs: string, harness: BridgeHarness, current: string) {
  const link = bridgeLink(teammateHome(runAs), harness)
  return run('sh', ['-c', STALE_SCRIPT, 'sh', link, current], { runAs }).then(
    () => true,
    () => false,
  )
}

/** Where the teammates' bootstrap folders point, as each reads its own; null if one could not. */
async function linkTargets(teammates: string[]) {
  const targets: string[] = []
  for (const runAs of teammates) {
    const out = await run(
      'sh',
      [
        '-c',
        'D=$1; shift; for H; do readlink -- "$D/$H" || true; done',
        'sh',
        join(teammateHome(runAs), '.ai-sdk-harness', '.harness-bootstrap'),
        ...BRIDGE_HARNESSES,
      ],
      { runAs },
    ).catch(() => null)
    if (!out) return null
    targets.push(...out.toString().split('\n').filter(Boolean))
  }
  return targets
}

/**
 * Now and then on a cloud computer: the teammates' own copies, and their links to older
 * copies, pointed at the current copy (those that keep theirs for now are tried again next
 * time), or, shared bridges off, their links taken away; then the older shared copies removed
 * (removeSuperseded). A teammate idle since an update would otherwise keep its old copy.
 */
export async function tidyBridges(teammates: string[], now = Date.now()) {
  if (!ON_CLOUD) return
  if (!enabled()) {
    for (const harness of BRIDGE_HARNESSES)
      for (const runAs of teammates) await useSharedBridge(runAs, harness)
    return
  }
  const current = new Set<string>()
  for (const harness of BRIDGE_HARNESSES) {
    const template = await identityOf(harness).catch(() => null)
    if (!template) return
    const name = sharedName(harness, template.identity)
    current.add(name)
    const dir = bridgeLink(join(ROOT, name), harness)
    for (const runAs of teammates)
      if (await isStale(runAs, harness, dir)) await useSharedBridge(runAs, harness)
  }
  // Unknown where a teammate's folder points: nothing goes.
  const linked = await linkTargets(teammates)
  if (!linked) return
  const processes = (await run('ps', ['-A', '-o', 'args=']).catch(() => null))?.toString()
  if (processes === undefined) return
  await removeSuperseded({ root: ROOT, current, linked, processes, now })
}

/** A process, by its pid and start time (/proc/<pid>/stat), so that a reused pid is not it. */
type Holder = { pid: number; start: string }

/** When a process started, in clock ticks since boot; null when it is gone. */
async function startOf(pid: number) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  // Its name, in parentheses, may hold spaces: the fields after it, the 22nd counting from 1.
  return stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
}

/** The shared copy (its folder under root) a path is in, if any. */
function copyOf(path: string, root: string) {
  if (!path.startsWith(`${root}/`)) return null
  const name = path.slice(root.length + 1).split('/')[0]
  return name ? join(root, name) : null
}

const holdersFile = (copy: string) => join(copy, '.holders')

/** The processes noted as holding a copy: none without a file, null when it cannot be read. */
async function readHolders(copy: string): Promise<Holder[] | null> {
  const text = await readFile(holdersFile(copy), 'utf8').catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? '[]' : null,
  )
  if (text === null) return null
  try {
    const holders = JSON.parse(text) as unknown
    return Array.isArray(holders) &&
      holders.every((h) => typeof h?.pid === 'number' && typeof h?.start === 'string')
      ? (holders as Holder[])
      : null
  } catch {
    return null
  }
}

/** The holders being noted (recordHolders), in turn. */
let noting: Promise<unknown> = Promise.resolve()

/**
 * From what LINK_SCRIPT or UNLINK_SCRIPT printed ("held <copy> <pid>…"): beside each copy a
 * link left, the processes still running from it, which keep it (removeSuperseded).
 */
export function recordHolders(out: string, root = ROOT) {
  const lines = out.split('\n').filter((line) => line.startsWith('held '))
  if (lines.length === 0) return Promise.resolve()
  // One at a time, whichever teammate: two leaving the same copy would each write it whole.
  const next = noting.then(async () => {
    for (const line of lines) {
      const match = /^held (\S+) ([\d ]+)$/.exec(line.trim())
      const copy = match && copyOf(match[1]!, root)
      if (!copy || !existsSync(copy)) continue
      const holders = await readHolders(copy)
      if (!holders) throw new Error(`what runs from ${copy} cannot be read`)
      for (const pid of match[2]!.trim().split(/\s+/).map(Number)) {
        const start = await startOf(pid)
        if (start && !holders.some((h) => h.pid === pid && h.start === start))
          holders.push({ pid, start })
      }
      // Whole or not at all: read half written, it would say no process holds the copy. Not
      // written (a full disk), it fails: the link that would leave the copy then stays.
      const file = holdersFile(copy)
      const temporary = `${file}.${process.pid}-${Date.now()}`
      try {
        await writeFile(temporary, JSON.stringify(holders))
        await rename(temporary, file)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw new Error(`could not note what runs from ${copy}: ${String(error)}`)
      }
    }
  })
  noting = next.catch(() => undefined)
  return next
}

/**
 * Remove the shared copies under root that no current recipe names (current), once they have
 * been superseded for SUPERSEDED_KEEP_MS, while no teammate's folder points to them (linked),
 * no process names them (processes) and none of the processes a link left on them runs.
 */
export async function removeSuperseded(options: {
  root: string
  current: Set<string>
  linked: string[]
  processes: string
  now: number
}) {
  const { root, current, linked, processes, now } = options
  const names = await readdir(root).catch(() => [] as string[])
  for (const name of staleCopies(names, current)) {
    const copy = join(root, name)
    const mark = join(copy, '.superseded')
    const since = await stat(mark).then(
      (s) => s.mtimeMs,
      async () => {
        await writeFile(mark, '').catch(() => undefined)
        return now
      },
    )
    if (now - since < SUPERSEDED_KEEP_MS) continue
    if (processes.includes(copy)) continue
    if (linked.some((target) => copyOf(target, root) === copy)) continue
    // What runs from it unknown: it stays.
    const holders = await readHolders(copy)
    if (!holders) continue
    let held = false
    for (const holder of holders) if ((await startOf(holder.pid)) === holder.start) held = true
    if (held) continue
    await rm(copy, { recursive: true, force: true }).then(
      () => console.log(`removed the shared bridge ${name}, replaced by a newer one`),
      (error: unknown) => console.warn(`could not remove ${copy}: ${String(error)}`),
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
