// The large parts of a thread's spec, kept once and named by their SHA-256 (SPEC_PARTS). A
// connector's operations carry their input schemas, a skill its instructions, a project its
// memory: whole, a spec came near a megabyte, and each command for a thread carried one (a
// prompt one per teammate). Kept commands (RunnerCommand) filled the database with copies, and
// the dozens a stopped computer gathered, read at once, took the API past its memory. Named by
// hash, a command stays a few kilobytes, the same catalog in many commands is one row, and a
// runner fetches each part once (GET /runner/spec-parts/<sha256>), then keeps it.
import { createHash } from 'node:crypto'
import {
  SPEC_PARTS,
  SPEC_PARTS_PROTOCOL,
  type ApiToRunner,
  type SpecPart,
  type ThreadSpec,
} from '@brigade/contracts'
import { prisma } from './db.js'

/** A part this small goes inline: a fetch would cost more than it saves. */
const INLINE_BYTES = 2048
/** A part no spec named for this long is deleted (sweepSpecParts); commands give up after a day. */
const KEEP_MS = 14 * 24 * 3600_000
/** A part kept by this process is not written again before this: only its usedAt would change. */
const TOUCH_EVERY_MS = 6 * 3600_000

/** Parts this process kept lately, by workspace and hash: when it last set their usedAt. */
const kept = new Map<string, number>()

/** What a spec's part is once named by its hash. */
const EMPTY: { [K in SpecPart]: ThreadSpec[K] } = {
  connectors: [],
  skills: [],
  project: null,
  designSystems: [],
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Whether a runner of this protocol takes parts by hash. Unknown (offline): it will, by then. */
export const takesParts = (protocol: number | undefined) =>
  (protocol ?? SPEC_PARTS_PROTOCOL) >= SPEC_PARTS_PROTOCOL

async function keep(workspaceId: string, hash: string, content: string) {
  const key = `${workspaceId}:${hash}`
  const now = Date.now()
  if (now - (kept.get(key) ?? 0) < TOUCH_EVERY_MS) return
  await prisma.specPart
    .upsert({
      where: { workspaceId_sha256: { workspaceId, sha256: hash } },
      create: { workspaceId, sha256: hash, content },
      update: { usedAt: new Date(now) },
    })
    .catch((error: unknown) => {
      // Kept at the same moment by another spec: it is there.
      if ((error as { code?: string }).code !== 'P2002') throw error
    })
  if (kept.size > 10_000) kept.clear()
  kept.set(key, now)
}

/** The spec with its large parts kept and named by hash. */
export async function packSpec(workspaceId: string, spec: ThreadSpec): Promise<ThreadSpec> {
  if (spec.parts) return spec
  const packed: Record<string, unknown> = { ...spec }
  const parts: Partial<Record<SpecPart, string>> = {}
  for (const name of SPEC_PARTS) {
    const value = spec[name]
    if (value === null || value === undefined) continue
    const content = JSON.stringify(value)
    if (content.length < INLINE_BYTES) continue
    const hash = sha256(content)
    await keep(workspaceId, hash, content)
    parts[name] = hash
    packed[name] = EMPTY[name]
  }
  return Object.keys(parts).length ? ({ ...packed, parts } as ThreadSpec) : spec
}

/** The spec whole again, for a runner before SPEC_PARTS_PROTOCOL. */
export async function unpackSpec(workspaceId: string, spec: ThreadSpec): Promise<ThreadSpec> {
  if (!spec.parts) return spec
  const { parts, ...whole } = spec
  const rows = await prisma.specPart.findMany({
    where: { workspaceId, sha256: { in: Object.values(parts) } },
    select: { sha256: true, content: true },
  })
  const contents = new Map(rows.map((r) => [r.sha256, r.content]))
  for (const [name, hash] of Object.entries(parts)) {
    const content = contents.get(hash)
    if (content === undefined) throw new Error(`the ${name} of thread ${spec.sessionId} is gone`)
    ;(whole as Record<string, unknown>)[name] = JSON.parse(content)
  }
  return whole
}

/** A command with its specs' large parts kept and named by hash. */
export async function packCommand<T extends ApiToRunner>(
  workspaceId: string,
  message: T,
): Promise<T> {
  if (message.type === 'welcome') {
    const resume =
      message.resume && (await Promise.all(message.resume.map((s) => packSpec(workspaceId, s))))
    const requeue =
      message.requeue &&
      (await Promise.all(message.requeue.map((p) => packCommand(workspaceId, p))))
    return { ...message, ...(resume ? { resume } : {}), ...(requeue ? { requeue } : {}) } as T
  }
  if (!('thread' in message)) return message
  const thread = await packSpec(workspaceId, message.thread)
  if (message.type !== 'thread.prompt') return { ...message, thread } as T
  const then = await Promise.all(message.then.map((spec) => packSpec(workspaceId, spec)))
  return { ...message, thread, then } as T
}

/** A command whole again, its specs unpacked, for a runner before SPEC_PARTS_PROTOCOL. */
export async function unpackCommand<T extends ApiToRunner>(workspaceId: string, message: T) {
  if (!('thread' in message)) return message
  const thread = await unpackSpec(workspaceId, message.thread)
  if (message.type !== 'thread.prompt') return { ...message, thread }
  const then = await Promise.all(message.then.map((spec) => unpackSpec(workspaceId, spec)))
  return { ...message, thread, then }
}

/** A part, for its workspace's runner; none when it is not kept. */
export async function readSpecPart(workspaceId: string, hash: string) {
  const row = await prisma.specPart.findUnique({
    where: { workspaceId_sha256: { workspaceId, sha256: hash } },
    select: { content: true },
  })
  return row?.content ?? null
}

/** Parts no spec named for a while: deleted. */
export const sweepSpecParts = (now = Date.now()) =>
  prisma.specPart.deleteMany({ where: { usedAt: { lt: new Date(now - KEEP_MS) } } })
