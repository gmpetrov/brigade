// The thread's attached files on its machine of its own, for the commands teammates run there
// (machine-runs.ts, docs/previews.md, "Heavy commands there too"). Each goes at the same place in
// the teammate's copy there as in its working folder here (`commands/<teammate>/attachments/…`),
// so a command names it as it would here. The machine fetches each itself, straight from the
// bucket, through the short-lived signed URL the API redirects the runner to: never through this
// computer, whose memory every teammate shares, and never with the runner's token, which stays
// here. Only the signed URL of one file goes there, on curl's stdin, never on a command line.
// Without a bucket (on a laptop) the API sends the bytes itself: they go over the link as they
// come, never held whole. The machine writes each to a temporary file, checks its size and SHA-256,
// then moves it into place, and remembers what it placed: the next command fetches only what it
// lacks. What it gets is the file as given to the thread, whatever the teammate changed in its
// copy here; only in a folder the sync sends as it is (a command run in the attachments folder) is
// a copy the teammate changed left to the sync, as any file of that folder.
import { randomBytes } from 'node:crypto'
import { join, posix, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { ATTACHMENTS_DIR, type ThreadAttachmentRef } from '@brigade/contracts'
import { shellQuote, type MachineLink } from './preview-machine.js'
import { runAsUser } from './run-as.js'

/** How the runner asks the API for one of a thread's files: `GET /runner/attachments/<id>`. */
export type FilesApi = {
  apiUrl: string
  /** The runner's token: for the API only, never given to the machine. */
  token: string
  /** Tests: the API. */
  fetch?: typeof fetch
}

/** What was put on the machine now, and what could not be, with why. */
export type Placement = {
  fetched: { path: string; size: number }[]
  failed: { path: string; why: string }[]
}

/** Files fetched at once, at most. */
const AT_ONCE = 3
/** How long one file may take to come (or be checked there), and the API to answer. */
const FETCH_MS = 30 * 60_000
const ANSWER_MS = 60_000
/** On the machine, in its user's home: each teammate's record of what it placed, and files on their way. */
const FILES_DIR = '.brigade/attachments'
const TEMP_DIR = `${FILES_DIR}/tmp`
/** Readable by its owner and group, never executable: as the runner puts it in the working folder. */
const FILE_MODE = 0o644
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SHA256 = /^[0-9a-f]{64}$/
const MTIME = /^\d+(\.\d+)?$/
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\\]/
// eslint-disable-next-line no-control-regex
const UNSAFE_ALL = /[\u0000-\u001f\u007f\\]/g

/** What `stat` says of a path, as STATS prints it. */
type Stat = { size: number; mtime: string; mode: number; file: boolean }
/** What the machine's record keeps of a file it placed: as it was once there. */
type Placed = { sha256: string; size: number; mtime: string }

/**
 * Each path read from stdin, one per line, stat'ed in order: `<i> <size> <mtime> <mode in hex>`,
 * or `<i> -` when it is not there. Its time to the nanosecond (the sync compares milliseconds);
 * a link itself, never what it points to.
 */
const STATS =
  'i=0; while IFS= read -r p; do s=$(LC_ALL=C stat -c "%s %.9Y %f" -- "$p" 2>/dev/null) || s=-; ' +
  'echo "$i $s"; i=$((i+1)); done'

/** A ref's path, as it is in the working folder: inside its attachments folder, said plainly. */
export function attachmentPath(path: string) {
  const parts = path.split('/')
  if (UNSAFE.test(path) || parts.length < 2 || parts[0] !== ATTACHMENTS_DIR) return null
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') ? path : null
}

function parseStat(text: string): Stat | null {
  const [size, mtime, raw] = text.trim().split(' ')
  if (!size || !/^\d+$/.test(size) || !mtime || !MTIME.test(mtime) || !raw) return null
  const mode = Number.parseInt(raw, 16)
  if (Number.isNaN(mode)) return null
  return { size: Number(size), mtime, mode: mode & 0o777, file: (mode & 0o170000) === 0o100000 }
}

function parseStats(lines: string[], count: number) {
  const stats: (Stat | null)[] = Array.from({ length: count }, () => null)
  for (const line of lines) {
    const space = line.indexOf(' ')
    const i = Number(line.slice(0, space))
    if (space > 0 && Number.isInteger(i) && i >= 0 && i < count)
      stats[i] = parseStat(line.slice(space + 1))
  }
  return stats
}

/** The machine's record as it reads: what it holds that is not an entry is left out. */
function parseIndex(text: string) {
  const index: Record<string, Placed> = {}
  let saved: unknown
  try {
    saved = JSON.parse(text)
  } catch {
    return index
  }
  if (!saved || typeof saved !== 'object') return index
  for (const [path, entry] of Object.entries(saved as Record<string, unknown>)) {
    const { sha256, size, mtime } = (entry ?? {}) as Partial<Placed>
    if (typeof sha256 === 'string' && typeof size === 'number' && typeof mtime === 'string')
      index[path] = { sha256, size, mtime }
  }
  return index
}

/** The paths, stat'ed here as the teammate: what it can read, never what it cannot. */
async function localStats(paths: string[], runAs: string | undefined) {
  if (!paths.length) return []
  const out = await runAsUser(['sh', '-c', STATS], runAs, `${paths.join('\n')}\n`).catch(() => '')
  return parseStats(out.split('\n'), paths.length)
}

const within = (root: string, path: string) => path === root || path.startsWith(`${root}${sep}`)

/** In a curl config file, a value in double quotes: its \ and " escaped. */
const curlQuoted = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`

/** A failure in a few words, without the signed URL in them should a tool repeat it. */
function why(error: unknown, url?: string) {
  const text = (error instanceof Error ? error.message : String(error)).trim()
  const plain = url ? text.split(url).join('its signed URL') : text
  return plain.split('\n').slice(-3).join(' ') || 'it failed'
}

/** The address a redirect gives, when it is one curl fetches there: http or https. */
function fetchable(location: string | null, base: string) {
  if (!location) return null
  try {
    const url = new URL(location, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Where the machine gets a file: the bucket's signed URL, read from the API's redirect without
 * following it (the runner never downloads it), or, without a bucket, the bytes the API streams.
 */
export async function fileSource(
  api: FilesApi,
  ref: Pick<ThreadAttachmentRef, 'id'>,
): Promise<{ url: string } | { body: ReadableStream<Uint8Array> }> {
  const answering = new AbortController()
  const timer = setTimeout(() => answering.abort(), ANSWER_MS)
  let response: Response
  try {
    response = await (api.fetch ?? fetch)(
      new URL(`/runner/attachments/${encodeURIComponent(ref.id)}`, api.apiUrl),
      {
        redirect: 'manual',
        headers: { authorization: `Bearer ${api.token}` },
        signal: answering.signal,
      },
    )
  } catch (error) {
    throw new Error(`the API did not answer: ${why(error)}`)
  } finally {
    // Once it answered, its bytes take as long as they take.
    clearTimeout(timer)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined)
    const url = fetchable(response.headers.get('location'), api.apiUrl)
    if (!url) throw new Error('the API sent it elsewhere than to storage')
    return { url }
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`the API refused it (${response.status})`)
  }
  return { body: response.body }
}

/**
 * The script the machine runs for one file, from its user's home: written to a temporary file
 * (from curl, or its stdin), checked, given its mode and time, then moved into place; what it
 * placed said as `<size> <mtime>`. One that fails leaves nothing behind.
 */
export function fetchScript(input: {
  from: 'url' | 'stdin'
  target: string
  size: number
  sha256: string
  mode: number
  mtime?: string
}) {
  const target = shellQuote(input.target)
  return [
    'umask 077',
    `t=${TEMP_DIR}/${randomBytes(8).toString('hex')}`,
    `mkdir -p ${TEMP_DIR} && : > "$t" || exit 1`,
    `trap 'rm -f -- "$t"' EXIT`,
    input.from === 'url'
      ? // The signed URL comes on stdin, as curl's config (-K -): never on a command line. Tried
        // again from the start on any error (a connection cut halfway), stopped when it stalls.
        'curl -fsS --proto =http,https --retry 3 --retry-all-errors --connect-timeout 30 -Y 1024 -y 120 ' +
        '-o "$t" -K - || exit 2'
      : 'cat > "$t" || exit 2',
    'n=$(stat -c %s -- "$t") || exit 3',
    `[ "$n" = ${input.size} ] || { echo "it came with $n bytes instead of ${input.size}" >&2; exit 3; }`,
    's=$(sha256sum -- "$t") || exit 4',
    `[ "\${s%% *}" = ${input.sha256} ] || { echo 'its SHA-256 is not the one it was given' >&2; exit 4; }`,
    `chmod ${input.mode.toString(8)} -- "$t" || exit 5`,
    ...(input.mtime ? [`touch -m -d @${input.mtime} -- "$t" || exit 5`] : []),
    `mkdir -p -- ${shellQuote(posix.dirname(input.target))} && mv -f -T -- "$t" ${target} || exit 5`,
    `LC_ALL=C stat -c '%s %.9Y' -- ${target}`,
  ].join('\n')
}

/** Run `command` there with `body` on its stdin as it comes; resolves to its output. */
function streamTo(link: MachineLink, command: string, body: ReadableStream<Uint8Array>) {
  return new Promise<string>((done, fail) => {
    const child = link.spawn(command, 'pipe')
    const input = Readable.fromWeb(body as WebReadableStream<Uint8Array>)
    let out = ''
    let err = ''
    let cut: Error | undefined
    const timer = setTimeout(() => child.kill(), FETCH_MS)
    child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.stdin!.on('error', () => undefined)
    input.once('error', (error) => {
      cut = error
      child.kill()
    })
    input.pipe(child.stdin!)
    child.once('error', (error) => {
      clearTimeout(timer)
      input.destroy()
      fail(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      input.destroy()
      if (code === 0 && !cut) done(out)
      else
        fail(
          new Error(
            cut
              ? `it stopped coming from the API: ${why(cut)}`
              : err.trim() || `the machine could not write it (${code})`,
          ),
        )
    })
  })
}

/** Run `work` on each item, at most `limit` at once. */
async function atMost<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!)
    }),
  )
}

/**
 * Put a teammate's attached files in its copy on the machine, each at the same place as in its
 * working folder: those it lacks fetched there, a few at a time. A file that cannot be fetched or
 * does not match is left out, said in `failed`; only reading what the machine has can throw.
 */
export async function placeAttachments(input: {
  link: MachineLink
  api: FilesApi
  refs: ThreadAttachmentRef[]
  /** The teammate's working folder here, and its user on a cloud computer. */
  workDir: string
  runAs?: string
  teammateId: string
  /** Its copy there, relative to the machine's home: `commands/<teammate>`. */
  copy: string
  /** Folders here a sync sends as they are, the command's own included: what is in them is the sync's. */
  syncRoots: string[]
}): Promise<Placement> {
  const { link } = input
  const placement: Placement = { fetched: [], failed: [] }
  const refs: ThreadAttachmentRef[] = []
  for (const ref of input.refs) {
    if (ref.status !== 'ready') continue
    if (
      attachmentPath(ref.path) &&
      SAFE_ID.test(ref.id) &&
      SHA256.test(ref.sha256) &&
      Number.isSafeInteger(ref.size) &&
      ref.size >= 0
    )
      refs.push(ref)
    else
      placement.failed.push({
        path: ref.path.replace(UNSAFE_ALL, '?'),
        why: 'not a file of the thread',
      })
  }
  if (!refs.length) return placement
  const indexFile = shellQuote(`${FILES_DIR}/${input.teammateId}.json`)
  const there = (ref: ThreadAttachmentRef) => posix.join(input.copy, ref.path)
  const here = (ref: ThreadAttachmentRef) => join(input.workDir, ...ref.path.split('/'))
  // Its record, then where each file is now; what fetches cut short left behind goes.
  const [first = '', ...rest] = (
    await link.exec(
      `find ${TEMP_DIR} -type f -mmin +1440 -delete 2>/dev/null; f=${indexFile}; ` +
        `[ -s "$f" ] && cat -- "$f"; echo; ${STATS}`,
      `${refs.map(there).join('\n')}\n`,
    )
  ).split('\n')
  const index = parseIndex(first)
  const stats = parseStats(rest, refs.length)
  let changed = false
  const lacking: { ref: ThreadAttachmentRef; stat: Stat | null }[] = []
  const unsure: { ref: ThreadAttachmentRef; stat: Stat }[] = []
  for (const [i, ref] of refs.entries()) {
    const stat = stats[i] ?? null
    const known = index[ref.path]
    if (!stat?.file || stat.size !== ref.size) lacking.push({ ref, stat })
    // There as placed, unless something wrote it since: its time says so.
    else if (known?.sha256 !== ref.sha256 || known.size !== ref.size || known.mtime !== stat.mtime)
      unsure.push({ ref, stat })
  }
  // Its size, but not as placed (the sync wrote it, or a command): its SHA-256 says what it is.
  if (unsure.length) {
    const sums = (
      await link.exec(
        'while IFS= read -r p; do s=$(sha256sum -- "$p" 2>/dev/null) && echo "${s%% *}" || echo -; done',
        `${unsure.map(({ ref }) => there(ref)).join('\n')}\n`,
        FETCH_MS,
      )
    ).split('\n')
    for (const [i, { ref, stat }] of unsure.entries()) {
      if (sums[i] !== ref.sha256) {
        lacking.push({ ref, stat })
        continue
      }
      index[ref.path] = { sha256: ref.sha256, size: ref.size, mtime: stat.mtime }
      changed = true
    }
  }
  // The teammate's copies, as it reads them. One still its size, as given, lends the placed file
  // its time and mode: a sync that sends its folder finds that file there already, and leaves it.
  const mine = await localStats(
    lacking.map(({ ref }) => here(ref)),
    input.runAs,
  )
  const fetching: { ref: ThreadAttachmentRef; mode: number; mtime?: string }[] = []
  for (const [i, { ref, stat }] of lacking.entries()) {
    const local = mine[i]
    const asGiven = !!local?.file && local.size === ref.size
    // A copy the teammate changed, in a folder a sync sends: the sync's, as any file of it there.
    if (!asGiven && stat && input.syncRoots.some((root) => within(root, here(ref)))) continue
    fetching.push(
      asGiven ? { ref, mode: local.mode, mtime: local.mtime } : { ref, mode: FILE_MODE },
    )
  }
  await atMost(fetching, AT_ONCE, async ({ ref, mode, mtime }) => {
    let url: string | undefined
    try {
      const source = await fileSource(input.api, ref)
      const script = (from: 'url' | 'stdin') =>
        fetchScript({
          from,
          target: there(ref),
          size: ref.size,
          sha256: ref.sha256,
          mode,
          ...(mtime ? { mtime } : {}),
        })
      let out: string
      if ('url' in source) {
        url = source.url
        out = await link.exec(script('url'), `url = ${curlQuoted(source.url)}\n`, FETCH_MS)
      } else out = await streamTo(link, script('stdin'), source.body)
      const [size, placed] = (out.trim().split('\n').pop() ?? '').split(' ')
      if (Number(size) !== ref.size || !placed || !MTIME.test(placed))
        throw new Error('the machine did not say it is there')
      index[ref.path] = { sha256: ref.sha256, size: ref.size, mtime: placed }
      changed = true
      placement.fetched.push({ path: ref.path, size: ref.size })
    } catch (error) {
      placement.failed.push({ path: ref.path, why: why(error, url) })
    }
  })
  // Kept as best it can: without it, the next command checks those files by their SHA-256.
  if (changed)
    await link
      .exec(
        `mkdir -p ${FILES_DIR} && f=${indexFile} && cat > "$f.$$" && mv -f -- "$f.$$" "$f"`,
        JSON.stringify(index),
      )
      .catch(() => undefined)
  // In the order the thread gave them, whichever came first.
  const order = (path: string) => input.refs.findIndex((ref) => ref.path === path)
  placement.fetched.sort((a, b) => order(a.path) - order(b.path))
  placement.failed.sort((a, b) => order(a.path) - order(b.path))
  return placement
}
