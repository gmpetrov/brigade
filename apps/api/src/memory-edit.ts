// Memory files as lines, without the database, so it can be tested on its own:
// what a thread's edit or a tidy run does to a file's text, and how each line's
// row (MemoryLine: its date, source, and why it left) follows the text.
import { createHash } from 'node:crypto'
import {
  changeMemoryFile,
  layOutMemoryFile,
  MEMORY_MAX,
  memoryEditChanges,
  memoryLineKey,
  parseMemoryFile,
  type MemoryEdit,
  type MemoryLayout,
} from '@brigade/contracts'

/**
 * A line's key as its row keeps it: a hash of the line as compared
 * (memoryLineKey), so a line of any length fits the row's unique index.
 */
export const rowKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** A line's row as the sync needs it. */
export type LineRow = {
  id: string
  /** rowKey of the line. */
  key: string
  text: string
  topic: string | null
  legacy: boolean
  createdByType: 'member' | 'teammate' | 'runner' | 'system' | null
  createdById: string | null
  createdAt: Date
  confirmedAt: Date | null
  archivedAt: Date | null
}

type Actor = { type: 'member' | 'teammate' | 'runner' | 'system'; id: string }

/** Why lines left, which lines a thread found still true, and what merged lines came from. */
export type LineContext = {
  actor: Actor
  sessionId: string | null
  /** Why each line that left did, by key; the default says who removed it. */
  reasons: Map<string, string>
  confirm: Set<string>
  /** A merged line's sources, by the merged line's key: it keeps the newest of their dates. */
  sources: Map<string, string[]>
  now: Date
}

/** A person's line taken out again this soon was a draft: it goes, not to the archive. */
const DRAFT_MS = 10 * 60_000

/**
 * A thread's edit applied to a memory file's text: runners before protocol 35
 * send lines to add to the core and lines to remove; later ones name each new
 * line's topic, the lines they correct, why lines go, and the ones still true.
 */
export function applyMemoryEdit(text: string, edit: MemoryEdit) {
  const reasons = new Map<string, string>()
  for (const { text: line, reason } of edit.archive)
    reasons.set(memoryLineKey(line), reason || 'outdated')
  for (const { from, to } of edit.replace) reasons.set(memoryLineKey(from), `Replaced by: ${to}`)
  const result = changeMemoryFile(text, memoryEditChanges(edit), MEMORY_MAX)
  const confirm = new Set(edit.confirm.map(memoryLineKey))
  return { ...result, reasons, confirm }
}

/** A tidy run's layout applied to a memory file's text, with why each line that left did. */
export function applyMemoryLayout(text: string, layout: MemoryLayout) {
  const result = layOutMemoryFile(text, layout)
  const reasons = new Map<string, string>()
  const sources = new Map<string, string[]>()
  for (const a of result.archived) reasons.set(memoryLineKey(a.text), a.reason)
  for (const m of result.merged) {
    const said = m.from.length > 1 ? 'Merged into' : 'Reworded as'
    for (const from of m.from) reasons.set(memoryLineKey(from.text), `${said}: ${m.to}`)
    sources.set(
      memoryLineKey(m.to),
      m.from.map((f) => memoryLineKey(f.text)),
    )
  }
  // A merged line said in the words of one of its sources stays that line: no reason to archive it.
  for (const key of sources.keys()) reasons.delete(key)
  return { ...result, reasons, sources }
}

/** Each memory line of a file, by key, with the topic it is under. */
export function memoryEntries(text: string) {
  const layers = parseMemoryFile(text)
  const entries = new Map<string, { text: string; topic: string | null }>()
  for (const line of layers.core)
    if (!entries.has(line.key)) entries.set(line.key, { text: line.text, topic: null })
  for (const topic of layers.topics)
    for (const line of topic.lines)
      if (!entries.has(line.key)) entries.set(line.key, { text: line.text, topic: topic.name })
  return entries
}

export type LinePlan = {
  create: {
    key: string
    text: string
    topic: string | null
    legacy: boolean
    createdByType: Actor['type'] | null
    createdById: string | null
    sessionId: string | null
    createdAt: Date
    archivedAt: Date | null
    archivedReason: string | null
    archivedByType: Actor['type'] | null
    archivedById: string | null
    archivedSessionId: string | null
  }[]
  update: { id: string; data: LineUpdate }[]
  delete: string[]
}

/** What changes on a line's row. */
export type LineUpdate = {
  text?: string
  topic?: string | null
  legacy?: boolean
  confirmedAt?: Date
  archivedAt?: Date | null
  archivedReason?: string | null
  archivedByType?: Actor['type'] | null
  archivedById?: string | null
  archivedSessionId?: string | null
}

/**
 * How the rows follow a file's text from `before` to `after`: a new line gets a
 * row dated now, by the actor and its thread (a merged line, the newest date of
 * its sources); a line put back leaves the archive; a line that left goes to the
 * archive with why, unless a person takes out a line they wrote moments ago (a
 * draft); a line with no row yet was there before memory kept dates (legacy).
 */
export function planLineSync(
  before: string,
  after: string,
  rows: LineRow[],
  context: LineContext,
): LinePlan {
  const plan: LinePlan = { create: [], update: [], delete: [] }
  const was = memoryEntries(before)
  const is = memoryEntries(after)
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const rowOf = (key: string) => byKey.get(rowKey(key))
  const { actor, now } = context
  const dateOf = (row: LineRow) =>
    Math.max(row.createdAt.getTime(), row.confirmedAt?.getTime() ?? 0)
  for (const [key, line] of is) {
    const row = rowOf(key)
    if (row?.archivedAt) {
      // Put back, by a person or a thread that learned it again.
      plan.update.push({
        id: row.id,
        data: {
          text: line.text,
          topic: line.topic,
          archivedAt: null,
          archivedReason: null,
          archivedByType: null,
          archivedById: null,
          archivedSessionId: null,
          confirmedAt: now,
        },
      })
    } else if (row) {
      const data: LineUpdate = {}
      if (row.topic !== line.topic) data.topic = line.topic
      if (row.text !== line.text) data.text = line.text
      if (context.confirm.has(key)) data.confirmedAt = now
      // A line others were merged into, in its own words, takes the newest of their dates.
      const dated = (context.sources.get(key) ?? []).flatMap((k) => {
        const source = rowOf(k)
        return source && !source.legacy ? [dateOf(source)] : []
      })
      const newest = Math.max(0, ...dated)
      if (newest && (row.legacy || newest > dateOf(row))) {
        data.confirmedAt = new Date(Math.max(newest, data.confirmedAt?.getTime() ?? 0))
        if (row.legacy) data.legacy = false
      }
      if (Object.keys(data).length) plan.update.push({ id: row.id, data })
    } else {
      const there = was.has(key)
      // A merged line keeps the newest date of its lines; merged from lines older than dates, it is too.
      const sources = (context.sources.get(key) ?? []).flatMap((k) => rowOf(k) ?? [])
      const dated = sources.filter((r) => !r.legacy)
      const merged = sources.length > 0
      const legacy = there || (merged && dated.length === 0)
      const newest = Math.max(0, ...(dated.length ? dated : sources).map(dateOf))
      plan.create.push({
        key: rowKey(key),
        text: line.text,
        topic: line.topic,
        legacy,
        createdByType: there ? null : actor.type,
        createdById: there ? null : actor.id,
        sessionId: there ? null : context.sessionId,
        createdAt: newest ? new Date(newest) : now,
        archivedAt: null,
        archivedReason: null,
        archivedByType: null,
        archivedById: null,
        archivedSessionId: null,
      })
    }
  }
  for (const [key, line] of was) {
    if (is.has(key)) continue
    const row = rowOf(key)
    const reason =
      context.reasons.get(key) ?? (actor.type === 'member' ? 'Removed' : 'Removed by a thread')
    const archived = {
      archivedAt: now,
      archivedReason: reason,
      archivedByType: actor.type,
      archivedById: actor.id,
      archivedSessionId: context.sessionId,
    }
    if (!row) {
      plan.create.push({
        key: rowKey(key),
        text: line.text,
        topic: line.topic,
        legacy: true,
        createdByType: null,
        createdById: null,
        sessionId: null,
        createdAt: now,
        ...archived,
      })
    } else if (row.archivedAt) {
      continue
    } else if (
      actor.type === 'member' &&
      row.createdByType === 'member' &&
      row.createdById === actor.id &&
      now.getTime() - row.createdAt.getTime() < DRAFT_MS
    ) {
      plan.delete.push(row.id)
    } else {
      plan.update.push({ id: row.id, data: { ...archived, topic: line.topic } })
    }
  }
  return plan
}
