// Files a command on the thread's machine of its own makes, saved to the workspace library
// straight from there (machine-runs.ts, docs/previews.md, "Saved to the library from there"): a
// render goes from the machine to the bucket, never through this computer, whose memory and disk
// every teammate shares. The steps and rules are save_to_library's (uploads.ts): the runner asks the
// API, with its token, where to PUT the file (POST /runner/uploads: the teammate, its access to
// that path, the size and SHA-256 the machine read), the machine PUTs it at that signed URL, the
// API reads back what arrived and checks it (its complete), then the hub's library.call saves it
// as the teammate and says its mention. Only the signed URL goes to the machine, as curl's config
// on stdin, never on a command line; the runner's token stays here. Without a bucket (on a laptop)
// the ticket is the API's own stand-in: the bytes go over the link as they come, never held whole.
//
// A save is sent once. Its upload's id is told (`saving`) before it goes, for the run to keep, and
// it does not go unless kept: a runner that stopped before hearing its answer leaves it to the
// next, which sends that same save again, never a new upload. The API takes an upload for one save
// alone, so the second writes nothing when the first did, and never over what was saved at that
// path since. A save whose answer was lost, or whose second sending was refused, may have been
// made: it is left for someone to check, never sent or uploaded again.
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { LIBRARY_FILE_MAX, LibraryPath } from '@brigade/contracts'
import type { FilesApi } from './machine-files.js'
import { shellQuote, type MachineLink } from './preview-machine.js'

/** A file a command makes, by its path in the command's folder, and where it goes in the library. */
export type LibrarySave = { from: string; to: string }

/** A file saved, as asked: the library path the API gave it, its size, and the mention to name it by. */
export type SavedFile = LibrarySave & { path: string; size: number; mention?: string }

/** A save sent before the runner stopped, by its upload: sent again as it was, never uploaded again. */
export type SentSave = LibrarySave & { upload: string }

/** The hub's library.call save, as the teammate: what the API answers (its path and mention). */
export type LibrarySaver = (
  seat: { sessionId: string; teammateId: string },
  operation: { name: 'save'; path: string; upload: { id: string } },
) => Promise<unknown>

/** How long the machine may take to read a file's SHA-256, or to PUT it. */
const READ_MS = 30 * 60_000
const PUT_MS = 60 * 60_000
/** On the machine, in its user's home: a safe name for the file curl uploads. */
const UPLOADS_DIR = '.brigade/uploads'
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const SHA256 = /^[0-9a-f]{64}$/
const TOO_LARGE = `files saved from a thread can be up to ${LIBRARY_FILE_MAX / 1024 / 1024} MB`

/** A library path as the API takes it, said plainly; null when it is not one. */
export function libraryPath(path: string) {
  const parsed = LibraryPath.safeParse(path)
  return parsed.success ? parsed.data : null
}

/** Whether `from` can be read there on a line of its own (a path the command named). */
export const plainPath = (path: string) => !CONTROL.test(path)

/** A step the API or the bucket refused: its status, and what it said. */
class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** A failure in a few words, without the signed URL in them should a tool repeat it. */
function why(error: unknown, url?: string) {
  const text = (error instanceof Error ? error.message : String(error)).trim()
  const plain = url ? text.split(url).join('its signed URL') : text
  return plain.split('\n').slice(-3).join(' ') || 'it failed'
}

/** In a curl config file, a value in double quotes: its \ and " escaped. */
const curlQuoted = (value: string) => `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`

/** The API's JSON answer to a POST with the runner's token, or what it refused. */
async function post<T>(api: FilesApi, path: string, body: unknown): Promise<T> {
  const response = await (api.fetch ?? fetch)(new URL(path, api.apiUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok)
    throw new Refused(answer.error || `the API refused it (${response.status})`, response.status)
  return answer
}

type Ticket = { id: string; url: string; headers?: Record<string, string> }
type Read = { size: number; sha256: string } | { why: string }

/**
 * Each path read from stdin, one per line, in the command's folder: `<size> <sha256>` for a file
 * (what a link points to), `<size> -` for one too large to save (not read whole for nothing),
 * else `! <why>`.
 */
const READS =
  'while IFS= read -r p; do if [ -f "$p" ]; then ' +
  'if n=$(stat -L -c %s -- "$p"); then if [ "$n" -gt ' +
  String(LIBRARY_FILE_MAX) +
  ' ]; then echo "$n -"; else s=$(sha256sum -- "$p") && echo "$n ${s%% *}" || echo "! it could not be read"; fi; ' +
  'else echo "! it could not be read"; fi; ' +
  'elif [ -d "$p" ]; then echo "! a folder: name each of its files"; ' +
  'elif [ -e "$p" ]; then echo "! not a file"; else echo "! not made"; fi; done'

/** What the machine says of each file: its size and SHA-256, read there. */
async function readFiles(link: MachineLink, cwd: string, paths: string[]): Promise<Read[]> {
  const out = await link.exec(
    `cd -- ${shellQuote(cwd)} 2>/dev/null || { echo 'its folder is not on the machine' >&2; exit 1; }; ${READS}`,
    `${paths.join('\n')}\n`,
    READ_MS,
  )
  const lines = out.split('\n')
  return paths.map((_, i) => {
    const line = lines[i] ?? ''
    if (line.startsWith('! ')) return { why: line.slice(2) }
    const [size, sha256] = line.split(' ')
    if (!size || !/^\d+$/.test(size)) return { why: 'the machine did not say what it is' }
    if (Number(size) > LIBRARY_FILE_MAX) return { why: TOO_LARGE }
    return sha256 && SHA256.test(sha256)
      ? { size: Number(size), sha256 }
      : { why: 'the machine did not say what it is' }
  })
}

/** A file read there again, as it is now. */
async function readFile(link: MachineLink, cwd: string, path: string) {
  const [read] = await readFiles(link, cwd, [path])
  if (!read || 'why' in read) throw new Error(read?.why ?? 'it could not be read')
  return read
}

/**
 * The machine PUTs the file at the bucket's signed URL: through a link of a safe name (curl reads
 * braces and brackets in a file name as a pattern), the URL and headers on stdin as curl's config.
 * Tried again from the start on any error, stopped when it stalls.
 */
export function putScript(input: { cwd: string; from: string }) {
  return [
    'umask 077',
    `cd -- ${shellQuote(input.cwd)} || exit 1`,
    `t="$HOME/${UPLOADS_DIR}/${randomBytes(8).toString('hex')}"`,
    `mkdir -p "$HOME/${UPLOADS_DIR}" && ln -sfn -- "$PWD"/${shellQuote(input.from)} "$t" || exit 1`,
    `trap 'rm -f -- "$t"' EXIT`,
    'curl -fsS --proto =http,https --retry 3 --retry-all-errors --connect-timeout 30 -Y 1024 -y 120 ' +
      '-o /dev/null -T "$t" -K - || exit 2',
  ].join('\n')
}

/** The bucket's signed URL a ticket gives, or null when it is the API's own stand-in (no bucket). */
function bucketUrl(api: FilesApi, ticket: Ticket) {
  let url: URL
  try {
    url = new URL(ticket.url, api.apiUrl)
  } catch {
    throw new Error('the API gave no address to send it to')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('the API gave no address to send it to')
  return url.origin === new URL(api.apiUrl).origin ? null : url.href
}

/** Without a bucket: the file read there as it streams, PUT to the API's stand-in from here. */
async function putThrough(
  link: MachineLink,
  api: FilesApi,
  ticket: Ticket,
  input: { cwd: string; from: string },
) {
  const child = link.spawn(
    `cd -- ${shellQuote(input.cwd)} && exec cat -- ${shellQuote(input.from)}`,
  )
  child.stdin?.end()
  let said = ''
  child.stderr!.on('data', (d: Buffer) => (said += d.toString('utf8')))
  const read = new Promise<number | null>((done) => {
    child.once('error', () => done(null))
    child.once('close', done)
  })
  try {
    const response = await (api.fetch ?? fetch)(new URL(ticket.url, api.apiUrl), {
      method: 'PUT',
      headers: ticket.headers ?? {},
      body: Readable.toWeb(child.stdout!) as unknown as RequestInit['body'],
      duplex: 'half',
    } as RequestInit)
    await response.body?.cancel().catch(() => undefined)
    if ((await read) !== 0)
      throw new Error(said.trim().split('\n').slice(-2).join(' ') || 'it could not be read there')
    if (!response.ok) throw new Refused(`the API refused the upload (${response.status})`, 0)
  } finally {
    child.kill()
  }
}

/**
 * Start, PUT, complete: the file checked by the API, once there. What arrived not matching (the
 * file changed after it was read: another command of the thread, say) is read again and sent again,
 * once.
 */
async function upload(
  link: MachineLink,
  api: FilesApi,
  seat: { sessionId: string; teammateId: string; name: string },
  input: { cwd: string; from: string },
  first: { size: number; sha256: string },
) {
  let read = first
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) read = await readFile(link, input.cwd, input.from)
    const ticket = await post<Ticket>(api, '/runner/uploads', {
      purpose: 'library',
      ...seat,
      size: read.size,
      sha256: read.sha256,
    })
    const url = bucketUrl(api, ticket)
    if (url) {
      const config = [
        `url = ${curlQuoted(url)}`,
        ...Object.entries(ticket.headers ?? {}).map(
          ([name, value]) => `header = ${curlQuoted(`${name}: ${value}`)}`,
        ),
        // The bucket answers at once; curl would wait a second for it to say go on.
        'header = "Expect:"',
      ].join('\n')
      await link.exec(putScript(input), `${config}\n`, PUT_MS).catch((error: unknown) => {
        throw new Error(`the machine could not send it: ${why(error, url)}`)
      })
    } else await putThrough(link, api, ticket, input)
    try {
      return await post<{ id: string; size: number }>(
        api,
        `/runner/uploads/${encodeURIComponent(ticket.id)}/complete`,
        {},
      )
    } catch (error) {
      // What arrived is not the file the machine read (it changed meanwhile): once more.
      if (attempt === 0 && error instanceof Refused && error.status === 400) continue
      throw error
    }
  }
}

/**
 * Whether a save's call failed with nothing made: the API answered it with a refusal, or it never
 * went (connection.ts marks both `answered`). Any other failure, a connection lost while it was
 * under way, may have been made all the same.
 */
const answered = (error: unknown) =>
  !!error && typeof error === 'object' && (error as { answered?: unknown }).answered === true

/** A save sent whose answer was lost: it may have been made. */
class Unsure extends Error {}

/**
 * Save files a command made to the library, from the machine, one after the other. Each outcome
 * is told as it comes, for the run to keep: `saving` before a save goes (when it throws, the save
 * does not go), then `saved`, or `failed`, `unsure` when it may have been made all the same. One
 * that may have been made is never sent again, nor uploaded anew.
 */
export async function saveFromMachine(input: {
  link: MachineLink
  api: FilesApi
  save: LibrarySaver
  seat: { sessionId: string; teammateId: string }
  /** The command's folder there, relative to the machine's home. */
  cwd: string
  /** Each to save: one with its `upload` was sent before the runner stopped, and is sent again as it was. */
  saves: (LibrarySave | SentSave)[]
  /** Before a save goes, by its upload: kept by the run, or it throws and the save does not go. */
  saving?: (save: SentSave) => void
  saved?: (file: SavedFile) => void
  failed?: (item: LibrarySave, why: string, unsure: boolean) => void
  /** The runner is stopping: the rest is left for the next one. */
  stopped?: () => boolean
}) {
  const failed: (LibrarySave & { why: string; unsure: boolean })[] = []
  const saved: SavedFile[] = []
  if (!input.saves.length) return { saved, failed }
  const fail = (item: LibrarySave, why: string, unsure: boolean) => {
    failed.push({ from: item.from, to: item.to, why, unsure })
    input.failed?.({ from: item.from, to: item.to }, why, unsure)
  }
  // Read there: what is to be uploaded; one sent already is not.
  const fresh = input.saves.filter((item) => !('upload' in item))
  let reads: Read[]
  try {
    reads = await readFiles(
      input.link,
      input.cwd,
      fresh.map((s) => s.from),
    )
  } catch (error) {
    reads = fresh.map(() => ({ why: why(error) }))
  }
  const send = async (item: LibrarySave, id: string, size?: number, again = false) => {
    // Kept before it goes: a save not kept does not go (one sent again was kept already).
    if (!again) input.saving?.({ from: item.from, to: item.to, upload: id })
    let answer: { path?: unknown; size?: unknown; mention?: unknown }
    try {
      answer = ((await input.save(input.seat, {
        name: 'save',
        path: item.to,
        upload: { id },
      })) ?? {}) as typeof answer
    } catch (error) {
      if (answered(error)) throw error
      throw new Unsure(why(error))
    }
    const file: SavedFile = {
      from: item.from,
      to: item.to,
      path: typeof answer.path === 'string' ? answer.path : item.to,
      size: typeof answer.size === 'number' ? answer.size : (size ?? 0),
      ...(typeof answer.mention === 'string' ? { mention: answer.mention } : {}),
    }
    saved.push(file)
    input.saved?.(file)
  }
  for (const item of input.saves) {
    if (input.stopped?.()) break
    if ('upload' in item) {
      // Sent before the runner stopped, its answer never heard: the same save again, which the
      // API refuses when the first was made. Never uploaded and saved anew over what may be newer.
      try {
        await send(item, item.upload, undefined, true)
      } catch (error) {
        if (input.stopped?.()) break
        fail(
          item,
          `the runner stopped as it was being saved, and sending that save again ${
            error instanceof Unsure ? 'got no answer' : 'was refused'
          } (${why(error)}). Check it there before saving it again`,
          true,
        )
      }
      continue
    }
    const read = reads[fresh.indexOf(item)]!
    try {
      if ('why' in read) throw new Error(read.why)
      const { id, size } = await upload(
        input.link,
        input.api,
        { ...input.seat, name: item.to },
        { cwd: input.cwd, from: item.from },
        read,
      )
      await send(item, id, typeof size === 'number' ? size : read.size)
    } catch (error) {
      if (input.stopped?.()) break
      if (error instanceof Unsure)
        fail(
          item,
          `its answer was lost as it was being saved (${error.message}). Check it there before saving it again`,
          true,
        )
      else fail(item, why(error), false)
    }
  }
  return { saved, failed }
}
