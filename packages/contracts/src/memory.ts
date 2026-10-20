// Memory in layers. A memory file (the workspace's, a project's or a teammate's)
// is Markdown as people edit it. The lines before its first "## " heading are its
// core, which every thread loads; each "## " section is a topic, which a thread
// reads when its work touches it. A paragraph right under a topic's heading says
// what the topic holds.
//
//   # Brigade memory
//   - A core line.
//   ## Sidebar
//   What the sidebar shows and how it behaves.
//   - A topic line.
//
// A line is known by its text, whatever bullet the editor writes (memoryLineKey):
// that is how edits find it, and how its date and source are kept (MemoryLine
// rows in the API) while people and threads change the file around it.
import { z } from 'zod'

/** The most of a memory's core every thread loads, by memory; tidying keeps the core within it. */
export const MEMORY_CORE_BUDGET = { workspace: 4_000, project: 5_000, teammate: 3_000 } as const
export type MemoryScope = keyof typeof MEMORY_CORE_BUDGET
/** A memory file past this is tidied: what is outdated or repeated goes to the archive. */
export const MEMORY_TIDY_AT = 40_000

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
const TOPIC = /^##\s+(.+?)\s*#*\s*$/
const TITLE = /^#\s+\S/

/** A line's text: no bullet, no surrounding space. */
export const memoryLineText = (raw: string) => raw.replace(BULLET, '').trim()
/** What tells lines apart: the text, any case, any spacing. */
export const memoryLineKey = (raw: string) => memoryLineText(raw).replace(/\s+/g, ' ').toLowerCase()
/** A topic's name as compared. */
const topicKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

export type MemoryEntry = { text: string; key: string }
export type MemoryTopic = { name: string; description: string; lines: MemoryEntry[] }
export type MemoryLayers = { title: string; core: MemoryEntry[]; topics: MemoryTopic[] }

type Role = 'blank' | 'title' | 'topic' | 'description' | 'line'
type Scan = {
  lines: string[]
  roles: Role[]
  /** The topic each line is in; null for the core. */
  topics: (string | null)[]
}

/** Each line of a memory file with what it is: the title, a topic heading, a description or a memory line. */
function scan(text: string): Scan {
  const lines = text.replace(/\s+$/, '').split('\n')
  const roles: Role[] = []
  const topics: (string | null)[] = []
  let topic: string | null = null
  let started = false
  // A topic's description is its first paragraph, before any line.
  let described = true
  for (const line of lines) {
    const trimmed = line.trim()
    const heading = TOPIC.exec(trimmed)
    if (!trimmed) roles.push('blank')
    else if (!started && TITLE.test(trimmed)) roles.push('title')
    else if (heading) {
      topic = heading[1]!.trim()
      described = false
      roles.push('topic')
    } else if (topic !== null && !described && !BULLET.test(line) && !trimmed.startsWith('#')) {
      described = true
      roles.push('description')
    } else {
      described = true
      roles.push('line')
    }
    if (trimmed) started = true
    topics.push(topic)
  }
  return { lines, roles, topics }
}

/** A memory file as its core and topics. Topics of the same name are read as one. */
export function parseMemoryFile(text: string): MemoryLayers {
  const { lines, roles, topics } = scan(text)
  const out: MemoryLayers = { title: '', core: [], topics: [] }
  const byName = new Map<string, MemoryTopic>()
  lines.forEach((line, i) => {
    const role = roles[i]
    const name = topics[i] ?? null
    let topic = name === null ? null : byName.get(topicKey(name))
    if (name !== null && !topic) {
      topic = { name, description: '', lines: [] }
      byName.set(topicKey(name), topic)
      out.topics.push(topic)
    }
    if (role === 'title') out.title = line.trim().replace(/^#\s+/, '')
    else if (role === 'description' && topic && !topic.description) topic.description = line.trim()
    else if (role === 'line') {
      const entry = { text: memoryLineText(line), key: memoryLineKey(line) }
      if (entry.text) (topic ? topic.lines : out.core).push(entry)
    }
  })
  return out
}

/** How long a memory's core is, as a thread loads it. */
export const coreLength = (layers: MemoryLayers) =>
  layers.core.reduce((n, l) => n + l.text.length + 3, 0)

/** A topic's file name. */
export const topicSlug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'topic'

/** Blank lines once between blocks, none at the ends, one newline at the end. */
function tidyBlanks(lines: string[]) {
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim() && (!out.length || !out[out.length - 1]!.trim())) continue
    out.push(line.trimEnd())
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop()
  return `${out.join('\n')}\n`
}

/** Changes a thread asks of a memory file. Lines are named by their text. */
export type MemoryChanges = {
  /** New lines: under a topic (made when it does not exist yet), or in the core when null. */
  add?: { text: string; topic: string | null }[]
  /** A line said again, corrected, in its place. */
  replace?: { from: string; to: string }[]
  /** Lines that leave the file. */
  remove?: string[]
}

export type MemoryChangeResult = {
  text: string
  added: { text: string; topic: string | null }[]
  replaced: { from: string; to: string; topic: string | null }[]
  removed: { text: string; topic: string | null }[]
  /** New lines a full file could not take. */
  dropped: number
}

/**
 * Apply a thread's changes to a memory file's text, leaving everything else as
 * people wrote it: removed lines go, a replaced line changes in place, a new
 * line goes at the end of its topic (or of the core). `max` is the most the
 * file may hold; new lines past it are dropped and counted.
 */
export function changeMemoryFile(
  text: string,
  changes: MemoryChanges,
  max: number,
): MemoryChangeResult {
  const { lines, roles, topics } = scan(text)
  const result: MemoryChangeResult = { text, added: [], replaced: [], removed: [], dropped: 0 }
  const at = new Map<string, number>()
  roles.forEach((role, i) => {
    if (role !== 'line') return
    const key = memoryLineKey(lines[i]!)
    if (key && !at.has(key)) at.set(key, i)
  })
  const gone = new Set<number>()
  for (const line of changes.remove ?? []) {
    const i = at.get(memoryLineKey(line))
    if (i === undefined || gone.has(i)) continue
    gone.add(i)
    at.delete(memoryLineKey(line))
    result.removed.push({ text: memoryLineText(lines[i]!), topic: topics[i] ?? null })
  }
  for (const { from, to } of changes.replace ?? []) {
    const i = at.get(memoryLineKey(from))
    const next = memoryLineText(to)
    if (i === undefined || gone.has(i) || !next) continue
    const old = memoryLineText(lines[i]!)
    at.delete(memoryLineKey(from))
    const there = at.get(memoryLineKey(to))
    if (there !== undefined) {
      // Already said elsewhere: the old line just goes.
      gone.add(i)
      result.removed.push({ text: old, topic: topics[i] ?? null })
      continue
    }
    const bullet = BULLET.exec(lines[i]!)?.[0] ?? '- '
    lines[i] = `${bullet}${next.replace(/\s*\n\s*/g, ' ')}`
    at.set(memoryLineKey(to), i)
    result.replaced.push({ from: old, to: next, topic: topics[i] ?? null })
  }
  // Where each section's new lines go: after its last line still there.
  const sections: { topic: string | null; key: string; last: number }[] = []
  const sectionOf = new Map<string, (typeof sections)[number]>()
  const titleAt = roles.indexOf('title')
  const core = { topic: null, key: '', last: titleAt }
  sections.push(core)
  sectionOf.set('', core)
  roles.forEach((role, i) => {
    const topic = topics[i] ?? null
    const key = topic === null ? '' : topicKey(topic)
    let section = sectionOf.get(key)
    if (!section) {
      section = { topic, key, last: i }
      sections.push(section)
      sectionOf.set(key, section)
    }
    if (role !== 'blank' && !gone.has(i) && role !== 'title') section.last = i
  })
  const style = lines.find((l, i) => roles[i] === 'line' && BULLET.test(l))?.trimStart()[0]
  const bullet = style === '*' || style === '+' ? `${style} ` : '- '
  const inserts = new Map<number, string[]>()
  const newTopics: { name: string; lines: string[] }[] = []
  let size = text.length
  for (const { text: raw, topic } of changes.add ?? []) {
    const line = memoryLineText(raw).replace(/\s*\n\s*/g, ' ')
    const key = memoryLineKey(line)
    if (!key || at.has(key)) continue
    const name = topic?.trim() || null
    const section = sectionOf.get(name === null ? '' : topicKey(name))
    let fresh = section ? undefined : newTopics.find((t) => topicKey(t.name) === topicKey(name!))
    const cost = line.length + bullet.length + 1 + (section || fresh ? 0 : name!.length + 6)
    if (size + cost > max) {
      result.dropped++
      continue
    }
    size += cost
    if (section) {
      const list = inserts.get(section.last) ?? []
      list.push(`${bullet}${line}`)
      inserts.set(section.last, list)
    } else {
      if (!fresh) {
        fresh = { name: name!, lines: [] }
        newTopics.push(fresh)
      }
      fresh.lines.push(`${bullet}${line}`)
    }
    at.set(key, -1)
    result.added.push({ text: line, topic: section ? section.topic : name })
  }
  // A topic whose last line goes, goes with it: its heading and description too.
  const parts = new Map<string, { other: number[]; lines: number[] }>()
  roles.forEach((role, i) => {
    const topic = topics[i]
    if (topic == null || role === 'blank') return
    const part = parts.get(topicKey(topic)) ?? { other: [], lines: [] }
    ;(role === 'line' ? part.lines : part.other).push(i)
    parts.set(topicKey(topic), part)
  })
  for (const [key, part] of parts) {
    const kept = part.lines.some((i) => !gone.has(i)) || inserts.has(sectionOf.get(key)!.last)
    if (part.lines.length && !kept) for (const i of part.other) gone.add(i)
  }
  const out: string[] = []
  const place = (after: number) => {
    const list = inserts.get(after)
    if (!list) return
    // A list under a heading or a paragraph needs a blank line before it, and one after it before the next.
    if (after >= 0 && roles[after] !== 'line') out.push('')
    out.push(...list)
    const next = roles[after + 1]
    if (next && next !== 'line' && next !== 'blank') out.push('')
  }
  place(-1)
  lines.forEach((line, i) => {
    if (!gone.has(i)) out.push(line)
    place(i)
  })
  for (const topic of newTopics) out.push('', `## ${topic.name}`, '', ...topic.lines)
  result.text = tidyBlanks(out)
  return result
}

/** How a tidy run lays a memory file out again. Lines are named by their text. */
export const MemoryLayout = z.object({
  /** Lines every thread needs, in order. */
  core: z.array(z.string().max(1000)).max(400).default([]),
  topics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        /** When a thread should read it. */
        description: z.string().trim().max(200).default(''),
        lines: z.array(z.string().max(1000)).max(400).default([]),
      }),
    )
    .max(30)
    .default([]),
  /** Lines that say the same thing, said once; or one line said in today's words. */
  merge: z
    .array(
      z.object({
        from: z.array(z.string().max(1000)).min(1).max(20),
        text: z.string().trim().min(1).max(1000),
        topic: z.string().trim().max(60).nullable().default(null),
      }),
    )
    .max(100)
    .default([]),
  /** Lines that leave the file for the archive, with why. */
  archive: z
    .array(z.object({ text: z.string().max(1000), reason: z.string().trim().max(200) }))
    .max(400)
    .default([]),
})
export type MemoryLayout = z.infer<typeof MemoryLayout>

export type MemoryLayoutResult = {
  text: string
  archived: { text: string; reason: string; topic: string | null }[]
  merged: { from: { text: string; topic: string | null }[]; to: string; topic: string | null }[]
  /** Lines that changed topic (null: the core). */
  moved: { text: string; topic: string | null }[]
}

/**
 * Lay a memory file out again as a tidy run asks: its core, its topics in
 * order with their descriptions, repeats merged, archived lines out. A line the
 * layout does not name stays in its topic, after the ones it names, so nothing
 * goes by being left out.
 */
export function layOutMemoryFile(text: string, layout: MemoryLayout): MemoryLayoutResult {
  const layers = parseMemoryFile(text)
  const result: MemoryLayoutResult = { text, archived: [], merged: [], moved: [] }
  const where = new Map<string, { text: string; topic: string | null }>()
  for (const line of layers.core)
    if (!where.has(line.key)) where.set(line.key, { text: line.text, topic: null })
  for (const topic of layers.topics)
    for (const line of topic.lines)
      if (!where.has(line.key)) where.set(line.key, { text: line.text, topic: topic.name })
  const taken = new Set<string>()
  for (const { text: line, reason } of layout.archive) {
    const key = memoryLineKey(line)
    const found = where.get(key)
    if (!found || taken.has(key)) continue
    taken.add(key)
    result.archived.push({ text: found.text, reason: reason || 'tidied', topic: found.topic })
  }
  type Section = { name: string | null; description: string; lines: string[] }
  const sections = new Map<string, Section>()
  const section = (name: string | null) => {
    const key = name === null ? '' : topicKey(name)
    let s = sections.get(key)
    if (!s) {
      s = { name, description: '', lines: [] }
      sections.set(key, s)
    }
    return s
  }
  section(null)
  const put = (key: string, topic: string | null) => {
    const found = where.get(key)
    if (!found || taken.has(key)) return
    taken.add(key)
    section(topic).lines.push(found.text)
    if (topicKey(found.topic ?? '') !== topicKey(topic ?? ''))
      result.moved.push({ text: found.text, topic })
  }
  // Merged first, so their lines are not placed one by one too.
  const merged = new Map<string, { text: string; topic: string | null }>()
  for (const merge of layout.merge) {
    const from = [...new Set(merge.from.map(memoryLineKey))].filter(
      (key) => where.has(key) && !taken.has(key),
    )
    if (from.length < 1) continue
    const to = memoryLineText(merge.text)
    for (const key of from) taken.add(key)
    result.merged.push({ from: from.map((key) => where.get(key)!), to, topic: merge.topic })
    // Unless another line still in the file already says it.
    const toKey = memoryLineKey(to)
    if (!merged.has(toKey) && (!where.has(toKey) || from.includes(toKey)))
      merged.set(toKey, { text: to, topic: merge.topic })
  }
  for (const line of layout.core) put(memoryLineKey(line), null)
  for (const topic of layout.topics) {
    const s = section(topic.name)
    if (topic.description) s.description = topic.description
    for (const line of topic.lines) put(memoryLineKey(line), topic.name)
  }
  for (const line of merged.values()) section(line.topic).lines.push(line.text)
  // What the layout left out stays where it was, after what it placed.
  for (const line of layers.core) put(line.key, null)
  for (const topic of layers.topics) {
    const s = section(topic.name)
    if (!s.description) s.description = topic.description
    for (const line of topic.lines) put(line.key, topic.name)
  }
  const out: string[] = []
  if (layers.title) out.push(`# ${layers.title}`, '')
  for (const s of sections.values()) {
    if (s.name === null) {
      out.push(...s.lines.map((l) => `- ${l}`), '')
      continue
    }
    if (!s.lines.length) continue
    out.push(`## ${s.name}`, '')
    if (s.description) out.push(s.description, '')
    out.push(...s.lines.map((l) => `- ${l}`), '')
  }
  result.text = tidyBlanks(out)
  return result
}
