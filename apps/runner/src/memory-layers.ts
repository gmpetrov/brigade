// Memory as a thread loads it: each memory file's core in the instructions file,
// every line dated, and each topic in a file of its own next to it, listed in
// the instructions by name, description and size, for the teammate to read when
// its work touches it. What every thread loads stays the size of the cores,
// however much the team has learned.
import {
  coreLength,
  MEMORY_CORE_BUDGET,
  parseMemoryFile,
  topicSlug,
  type MemoryLineMeta,
  type MemoryScope,
  type ThreadSpec,
  withoutShownDay,
} from '@brigade/contracts'

/** What the runner knows of memory, from the library manifest. */
export type MemorySnapshot = {
  workspace: string
  teammate: string
  /** Projects' memory, by project. */
  projects?: Record<string, string>
  /** Each line's date, by memory file path and line key. */
  lines?: Record<string, Record<string, MemoryLineMeta>>
  /** When each memory file was last tidied, by path. */
  tidied?: Record<string, string>
}

/** A core past its budget by this much before a tidy run fixes it: the rest is put in a file. */
const OVERFLOW = 1.5
export const EARLIER_CORE = 'Earlier core lines'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A day as lines show it: "19 Oct", with the year when it is not this one. */
export function memoryDay(iso: string, now: Date) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`
}

/** When a line was learned or confirmed, and who wrote it when a person did: "(19 Oct, by Ada)". */
export function lineNote(meta: MemoryLineMeta | undefined, now: Date) {
  if (!meta) return ''
  const day = memoryDay(meta.at, now)
  if (!day) return ''
  return ` (${meta.legacy ? `before ${day}` : day}${meta.by ? `, by ${meta.by}` : ''})`
}

export type DatedLine = {
  text: string
  key: string
  /** " (19 Oct)", as the line ends when shown. */
  note: string
  /** When it was learned or confirmed; null when memory has no date for it (older than dated lines). */
  time: number | null
  /** Its place in the file: further down is newer. */
  order: number
}
export type LayeredTopic = {
  name: string
  slug: string
  description: string
  lines: DatedLine[]
  /** The newest line's day. */
  newest: string
}
export type LayeredMemory = { core: DatedLine[]; topics: LayeredTopic[]; coreChars: number }

/**
 * A memory file as its dated core and topics. A core far past its budget (a
 * file no tidy run has laid out yet) keeps its newest lines; the older ones go
 * to a topic of their own, so nothing is hidden.
 */
export function layerMemory(
  text: string,
  scope: MemoryScope,
  meta: Record<string, MemoryLineMeta> = {},
  now = new Date(),
): LayeredMemory {
  const layers = parseMemoryFile(text)
  const dated = (line: { text: string; key: string }, order: number): DatedLine => {
    const m = meta[line.key]
    const time = m && !m.legacy ? Date.parse(m.at) : NaN
    return {
      text: line.text,
      key: line.key,
      note: lineNote(m, now),
      time: Number.isNaN(time) ? null : time,
      order,
    }
  }
  let core = layers.core.map(dated)
  let topics: LayeredTopic[] = layers.topics.map((t) =>
    topic(t.name, t.description, t.lines.map(dated), now),
  )
  const limit = MEMORY_CORE_BUDGET[scope] * OVERFLOW
  if (coreLength(layers) > limit) {
    // Lines with no date are older than dated ones; among them, those further down are newer.
    const newest = [...core].sort((a, b) => (b.time ?? -1) - (a.time ?? -1) || b.order - a.order)
    const keep = new Set<string>()
    let size = 0
    for (const line of newest) {
      if (size + line.text.length + 3 > limit) break
      keep.add(line.key)
      size += line.text.length + 3
    }
    const earlier = core.filter((l) => !keep.has(l.key))
    core = core.filter((l) => keep.has(l.key))
    topics.unshift(
      topic(EARLIER_CORE, 'Older lines of the core, until memory is tidied.', earlier, now),
    )
  }
  // Two names may make the same file name: the second gets a number.
  const used = new Set<string>()
  topics = topics.map((t) => {
    let slug = t.slug
    for (let n = 2; used.has(slug); n++) slug = `${t.slug}-${n}`
    used.add(slug)
    return { ...t, slug }
  })
  return { core, topics, coreChars: core.reduce((n, l) => n + l.text.length + 3, 0) }
}

function topic(name: string, description: string, lines: DatedLine[], now: Date): LayeredTopic {
  const newest = Math.max(0, ...lines.map((l) => l.time ?? 0))
  return {
    name,
    slug: topicSlug(name),
    description,
    lines,
    newest: newest ? memoryDay(new Date(newest).toISOString(), now) : '',
  }
}

/** A line with its day after it; a day a run copied into its text once is not shown again. */
const dated = (text: string, note: string) => `${note ? withoutShownDay(text) : text}${note}`
const bullet = (line: DatedLine) => `- ${dated(line.text, line.note)}`

/** A topic's file: its name, what it holds, and its lines. */
export function topicFile(topic: LayeredTopic, of: string) {
  return [
    `# ${topic.name}`,
    '',
    `${of}${topic.description ? `: ${topic.description}` : '.'}`,
    '',
    ...topic.lines.map(bullet),
    '',
  ].join('\n')
}

/** Where a memory's topic files go in a thread's folder, and the folder they all share. */
export const MEMORY_DIR = '.brigade-memory'
export const topicPath = (folder: string, topic: LayeredTopic) =>
  `${MEMORY_DIR}/${folder}/${topic.slug}.md`

/**
 * A memory's section of the instructions file: its core, dated, then its
 * topics, each a file under `workDir` to read when the work touches it.
 */
export function memorySection(memory: LayeredMemory, workDir: string, folder: string) {
  const lines = memory.core.map(bullet)
  if (memory.topics.length) {
    if (lines.length) lines.push('')
    lines.push(
      'Topics, each in its own file: read one before work it bears on.',
      ...memory.topics.map((t) => {
        const about = t.description ? `: ${t.description.replace(/\.$/, '')}` : ''
        const size = `${t.lines.length} line${t.lines.length === 1 ? '' : 's'}${t.newest ? `, newest ${t.newest}` : ''}`
        return `- ${t.name}${about} (${size}): \`${workDir}/${topicPath(folder, t)}\``
      }),
    )
  }
  return lines.join('\n')
}

/** The memories a thread loads, laid out, and the folder their topic files go in. */
export type ThreadMemory = {
  /** The thread's working directory: topic files go under its MEMORY_DIR. */
  dir: string
  workspace: LayeredMemory
  project: LayeredMemory | null
  teammate: LayeredMemory
}

/** A thread's memories, laid out from the manifest (the project's from the thread's spec, fresher). */
export function threadMemory(
  spec: Pick<ThreadSpec, 'project' | 'teammate'>,
  snapshot: MemorySnapshot,
  dir: string,
  now = new Date(),
): ThreadMemory {
  const meta = snapshot.lines ?? {}
  return {
    dir,
    workspace: layerMemory(snapshot.workspace, 'workspace', meta['workspace.md'], now),
    project: spec.project
      ? layerMemory(spec.project.memory, 'project', meta[`projects/${spec.project.id}.md`], now)
      : null,
    teammate: layerMemory(
      snapshot.teammate,
      'teammate',
      meta[`teammates/${spec.teammate.id}.md`],
      now,
    ),
  }
}

/** Every topic file of a thread's memories, by path under MEMORY_DIR. */
export function threadTopicFiles(
  memory: ThreadMemory,
  spec: Pick<ThreadSpec, 'project' | 'teammate'>,
) {
  const files = (layered: LayeredMemory | null, folder: string, of: string) =>
    (layered?.topics ?? []).map((t) => ({ path: `${folder}/${t.slug}.md`, text: topicFile(t, of) }))
  return [
    ...files(memory.workspace, 'workspace', 'Workspace memory'),
    ...files(memory.project, 'project', `Memory of the project ${spec.project?.name ?? ''}`.trim()),
    ...files(memory.teammate, 'teammate', `What ${spec.teammate.name} has learned`),
  ]
}

/** Every line's key in a thread's memories: what a session loads when it starts. */
export function memoryKeys(memory: ThreadMemory) {
  const keys = new Set<string>()
  for (const layered of [memory.workspace, memory.project, memory.teammate]) {
    for (const line of layered?.core ?? []) keys.add(line.key)
    for (const topic of layered?.topics ?? []) for (const line of topic.lines) keys.add(line.key)
  }
  return keys
}

/** Lines told in one turn, at most. */
const NEWS_LINES = 10
const NEWS_CHARS = 3_000

/**
 * What memory learned since a session started: its instructions and topic files
 * were written then, so a line another thread added since is told at the start
 * of a turn, once (`told` keeps them). Empty when there is nothing new.
 */
export function memoryNews(memory: ThreadMemory, loaded: ReadonlySet<string>, told: Set<string>) {
  const news: string[] = []
  let size = 0
  const scan = (layered: LayeredMemory | null, of: string) => {
    if (!layered) return
    const sections = [
      { where: of, lines: layered.core },
      ...layered.topics.map((t) => ({ where: `${of}, ${t.name}`, lines: t.lines })),
    ]
    for (const { where, lines } of sections)
      for (const line of lines) {
        if (loaded.has(line.key) || told.has(line.key)) continue
        const note = line.note ? line.note.replace(/\)$/, `, ${where})`) : ` (${where})`
        const text = `- ${dated(line.text, note)}`
        if (news.length >= NEWS_LINES || size + text.length > NEWS_CHARS) return
        news.push(text)
        size += text.length
        told.add(line.key)
      }
  }
  scan(memory.workspace, 'workspace memory')
  scan(memory.project, 'project memory')
  scan(memory.teammate, 'your memory')
  if (!news.length) return ''
  return [
    '<memory-news>',
    'Learned since this session started, by threads that went quiet meanwhile. Newer than what your instructions file holds.',
    ...news,
    '</memory-news>',
  ].join('\n')
}

/**
 * A memory file as a memory or tidy run reads it: its core and topics, each
 * line numbered (runs name lines by number) and dated. `fresh`: lines added
 * since the manifest's dates, which are dated today.
 */
export function numberedMemory(
  text: string,
  meta: Record<string, MemoryLineMeta> = {},
  now = new Date(),
  fresh: Set<string> = new Set(),
) {
  const layers = parseMemoryFile(text)
  const lines: string[] = []
  const today = ` (${memoryDay(now.toISOString(), now)})`
  const show = (line: { text: string; key: string }) => {
    lines.push(line.text)
    const note = fresh.has(line.key) ? today : lineNote(meta[line.key], now)
    return `[${lines.length}] ${dated(line.text, note)}`
  }
  const out = ['Core:', ...(layers.core.length ? layers.core.map(show) : ['(nothing yet)'])]
  for (const topic of layers.topics)
    out.push(
      '',
      `Topic "${topic.name}"${topic.description ? `: ${topic.description}` : ''}`,
      ...topic.lines.map(show),
    )
  return {
    text: out.join('\n'),
    /** Each line's text, by its number less one. */
    lines,
    coreChars: coreLength(layers),
    topics: layers.topics.map((t) => t.name),
  }
}
