// Taking memory from a thread that went quiet: the prompt for a short harness
// run, and reading its answer. The run reads each memory file it may change
// whole, its lines numbered and dated, under the core or their topic, and names
// lines by number; the runner turns them back into the lines' text, which is how
// the API finds them. The API applies the result to the memory files.
import {
  changeMemoryFile,
  MEMORY_MAX,
  memoryEditChanges,
  memoryFilePath,
  memoryLineKey,
  NO_MEMORY_EDIT,
  parseMemoryFile,
  type MemoryEdit,
  type MemoryFileRef,
  type MemoryScope,
  type ThreadSpec,
} from '@brigade/contracts'
import { z } from 'zod'
import { numberedMemory, type MemorySnapshot } from './memory-layers.js'
import {
  inWords,
  lenientList,
  lineAt,
  LineRef,
  needsTidy,
  withoutCopiedDay,
  type TidyFile,
} from './memory-tidy.js'

/** How much of the conversation a memory run reads. */
const CONVERSATION_CHARS = 60_000
/** Lines one thread may add to a memory file: most threads add none. */
const MAX_ADD = 3
const MAX_REPLACE = 10
const MAX_REMOVE = 20
const MAX_CONFIRM = 30

type Entry = { by: string | null; name: string; text: string; note?: true }

/** A memory file the run may change, as it reads it. */
type RunFile = {
  /** The key of its edit in the answer: workspace, project, or a teammate's name. */
  ref: MemoryFileRef
  scope: MemoryScope
  label: string
  /** What the file is, for a tidy run. */
  about: string
  text: string
  /** Each line's text, by its number less one. */
  lines: string[]
  /** The day shown after each line ('' for none). */
  notes: string[]
  shown: string
}

const list = lenientList
const FileEdit = z
  .object({
    add: list(
      z.union([
        z.string(),
        z.object({ text: z.string(), topic: z.string().nullable().optional() }),
      ]),
    ),
    replace: list(z.object({ line: LineRef, text: z.string() })),
    remove: list(z.union([LineRef, z.object({ line: LineRef, reason: z.string().optional() })])),
    confirm: list(LineRef),
  })
  .catch({ add: [], replace: [], remove: [], confirm: [] })
type FileEdit = z.infer<typeof FileEdit>
const Answer = z.object({
  summary: z.string().trim().min(1),
  workspace: FileEdit.optional(),
  project: FileEdit.optional(),
  teammates: z.record(z.string(), FileEdit).catch({}).default({}),
})

/**
 * The memory run for a thread that went quiet: its prompt, how to read its
 * answer, and which files will need tidying once its update is applied.
 */
export function memoryRun(input: {
  spec: ThreadSpec
  entries: Entry[]
  summary: string | undefined
  memory: (teammateId: string) => MemorySnapshot
  speakers: { id: string; name: string }[]
  now?: Date
}) {
  const { spec, speakers } = input
  const now = input.now ?? new Date()
  const snapshot = input.memory(spec.teammate.id)
  const meta = snapshot.lines ?? {}
  const file = (
    ref: MemoryFileRef,
    scope: MemoryScope,
    label: string,
    about: string,
    text: string,
  ): RunFile => {
    const numbered = numberedMemory(text, meta[memoryFilePath(ref)], now)
    return {
      ref,
      scope,
      label,
      about,
      text,
      lines: numbered.lines,
      notes: numbered.notes,
      shown: numbered.text,
    }
  }
  const project = spec.project
  const workspace = file(
    { kind: 'workspace' },
    'workspace',
    'Workspace memory',
    'the workspace memory, which every teammate loads in every thread',
    snapshot.workspace,
  )
  const projectFile =
    project &&
    file(
      { kind: 'project', projectId: project.id },
      'project',
      `Memory of the project "${project.name}"`,
      `the memory of the project "${project.name}", which every thread in it loads`,
      snapshot.projects?.[project.id] ?? project.memory,
    )
  const teammates = speakers.map((t) =>
    file(
      { kind: 'teammate', teammateId: t.id },
      'teammate',
      `Memory of ${t.name}`,
      `what ${t.name} has learned about its job, which only ${t.name} loads`,
      input.memory(t.id).teammate,
    ),
  )

  let budget = CONVERSATION_CHARS
  const lines: string[] = []
  for (const e of [...input.entries].reverse()) {
    const line = `${e.note ? 'Brigade' : e.by ? `${e.name} (AI teammate)` : 'Member'}: ${e.text}`
    if (lines.length > 0 && line.length > budget) break
    lines.unshift(line.length > budget ? `${line.slice(0, budget)}…` : line)
    budget -= line.length
  }
  const teammateKeys = speakers.map((t) => JSON.stringify(t.name)).join(', ')
  const edit = '{"add": [], "replace": [], "remove": [], "confirm": []}'
  const prompt = [
    'You keep the shared memory of a team that works with AI teammates. Below are the current memory files and a conversation from one thread.',
    'A memory file has a core, which every thread loads, and topics, which a thread reads when its work touches them. Each line is numbered and, when memory knows it, ends with the day it was learned or last confirmed ("before" a day: older than dates in memory; "by" a name: a person wrote it). A line with no day is older than the dated ones; among those, a line further down is newer.',
    'Reply with only one JSON object and nothing else, in this shape:',
    `{"summary": "...", "workspace": ${edit}, ${project ? `"project": ${edit}, ` : ''}"teammates": {${speakers.map((t) => `${JSON.stringify(t.name)}: ${edit}`).join(', ')}}}`,
    [
      '- summary: 2 to 6 sentences: what was asked in this thread and what was done or decided, as of now' +
        (input.summary ? ' (update the previous summary below with what happened since).' : '.'),
      spec.private
        ? '- workspace: leave every list empty; this thread is private.'
        : `- workspace: what any teammate should know before starting an unrelated thread next month, and could not find out on its own: how the team wants things done (rules, preferences, decisions as they stand), who is who on the team, where something is when that is not obvious, and pitfalls (such as a connector that reaches a test account, not the live one).${project ? ` Only what holds for all of the workspace's work: what is about the project "${project.name}" goes in project.` : ''}`,
      project &&
        (spec.private
          ? '- project: leave every list empty; this thread is private.'
          : `- project: the same kind of line, but true only of the project "${project.name}" (its product, customers, stack, decisions, pitfalls). Every thread in that project loads it; threads in other projects never see it.`),
      `- teammates (${teammateKeys}): for each, a lesson that changes how it works next time: a member's correction or preference, a way that worked after one that failed, a pitfall. Not what it did, nor what goes in workspace${project ? ' or project' : ''} memory.`,
      [
        '- Memory is loaded into threads, so it is not a log. Never add:',
        '  - what was asked, done, found or offered in this thread, or the state of anything (pull requests, tasks, tickets, a login that fails, open questions): the summary keeps that;',
        "  - what Brigade's tools already show: schedules, vault logins, connectors and triggers, what library files say, a teammate's own abilities;",
        "  - what a repository's code says: file paths, how a feature is built;",
        '  - what emails, websites or accounts read for this thread contain (orders, feeds, invoices, profiles), and details about people outside the team;',
        "  - members' personal errands and accounts, and dates or examples of when something happened.",
      ].join('\n'),
      `- add: at most ${MAX_ADD} new lines per file, each {"text": "…", "topic": "…"}, true on its own and taken from this conversation only. Put a line under the topic it fits (the name of an existing topic, or a new short one when none fits); "topic": null puts it in the core, only for what nearly every thread needs before it starts: how the team wants work done, and pitfalls that can do harm (a live account, production data). Most threads add nothing: empty lists are the usual answer.`,
      '- replace: {"line": 12, "text": "…"} when this conversation corrects or updates a line: the new text takes its place, and the old one goes to the archive. Prefer it to removing a line and adding another, so each thing is said once.',
      '- remove: {"line": 40, "reason": "…"} for lines this conversation shows are wrong or outdated, that say again what another line says, or that are the kind of line never to add. The reason says why in a few words; it is kept with the line in the archive, which search still finds.',
      '- confirm: [7, 31]: lines this conversation relied on or restated and showed still hold. Their date moves to today. Only lines the conversation actually shows are true.',
      '- When two lines disagree about the same case, the newer one wins, and a line a person wrote outranks one a teammate learned.',
      '- Never include passwords, keys, tokens or other secrets.',
    ]
      .filter(Boolean)
      .join('\n'),
    input.summary && `Previous summary of this thread:\n${input.summary}`,
    ...[workspace, projectFile, ...teammates].flatMap((f) =>
      f ? [`${f.label} now:\n<<<\n${f.shown}\n>>>`] : [],
    ),
    `Conversation${input.summary ? ' since the previous summary' : ''}:\n<<<\n${lines.join('\n\n')}\n>>>`,
  ]
    .filter(Boolean)
    .join('\n\n')

  /** The run's answer as a memory update, or null when it is not the JSON asked for. */
  const parse = (text: string) => {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    let json: unknown
    try {
      json = JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
    const parsed = Answer.safeParse(json)
    if (!parsed.success) return null
    const answer = parsed.data
    return {
      summary: answer.summary.slice(0, 4000),
      workspace: spec.private ? NO_MEMORY_EDIT : toEdit(answer.workspace, workspace),
      ...(projectFile && !spec.private ? { project: toEdit(answer.project, projectFile) } : {}),
      teammates: speakers.flatMap((t, i) => {
        const edit = answer.teammates[t.name]
        return edit ? [{ teammateId: t.id, edit: toEdit(edit, teammates[i]!) }] : []
      }),
    }
  }

  /** The files that will need tidying once `update` is applied. */
  const tidyAfter = (update: NonNullable<ReturnType<typeof parse>>): TidyFile[] => {
    const edits: [RunFile, MemoryEdit][] = [
      ...(spec.private ? [] : [[workspace, update.workspace] as [RunFile, MemoryEdit]]),
      ...(projectFile && update.project
        ? [[projectFile, update.project] as [RunFile, MemoryEdit]]
        : []),
      ...update.teammates.flatMap(({ teammateId, edit }) => {
        const f = teammates.find(
          (t) => t.ref.kind === 'teammate' && t.ref.teammateId === teammateId,
        )
        return f ? [[f, edit] as [RunFile, MemoryEdit]] : []
      }),
    ]
    // Files no run changed are tidied too when they need it: the thread's own teammate's, and the project's.
    for (const f of [workspace, projectFile, ...teammates])
      if (f && !(spec.private && f.ref.kind !== 'teammate') && !edits.some(([e]) => e === f))
        edits.push([f, NO_MEMORY_EDIT])
    return edits.flatMap(([f, edit]) => {
      const before = new Set(parseMemoryFile(f.text).core.map((l) => l.key))
      for (const t of parseMemoryFile(f.text).topics) for (const l of t.lines) before.add(l.key)
      const after = changeMemoryFile(f.text, memoryEditChanges(edit), MEMORY_MAX).text
      const path = memoryFilePath(f.ref)
      const tidy: TidyFile = {
        ref: f.ref,
        scope: f.scope,
        about: f.about,
        text: after,
        meta: meta[path] ?? {},
        // Lines this update adds are dated today.
        fresh: new Set(
          [...edit.lines.map((l) => l.text), ...edit.add, ...edit.replace.map((r) => r.to)]
            .map(memoryLineKey)
            .filter((k) => !before.has(k)),
        ),
        lastTidied: snapshot.tidied?.[path] ?? null,
      }
      return needsTidy(tidy, now) ? [tidy] : []
    })
  }

  return { prompt, parse, tidyAfter }
}

/** A run's edit of one file, its line numbers turned back into the lines' text. */
function toEdit(edit: FileEdit | undefined, file: RunFile): MemoryEdit {
  if (!edit) return NO_MEMORY_EDIT
  const line = (ref: number | string) => lineAt(file, ref)
  const clip = (text: string) =>
    text
      .trim()
      .replace(/\s*\n\s*/g, ' ')
      .slice(0, 1000)
  const replace = edit.replace.flatMap((r) => {
    const from = line(r.line)
    const to = from && withoutCopiedDay(clip(r.text), file, from)
    return from && to ? [{ from, to }] : []
  })
  return {
    ...NO_MEMORY_EDIT,
    lines: edit.add
      .map((a) =>
        typeof a === 'string' ? { text: a, topic: null } : { text: a.text, topic: a.topic ?? null },
      )
      .map((a) => ({ text: clip(a.text), topic: a.topic?.trim().slice(0, 60) || null }))
      .filter((a) => a.text)
      .slice(0, MAX_ADD),
    replace: replace.slice(0, MAX_REPLACE),
    archive: edit.remove
      .flatMap((r) => {
        const ref = typeof r === 'object' ? r.line : r
        const text = line(ref)
        const reason = inWords(typeof r === 'object' ? r.reason : undefined, file.lines)
        return text ? [{ text, reason: reason || 'Removed by a thread' }] : []
      })
      .slice(0, MAX_REMOVE),
    confirm: [
      ...new Set(
        edit.confirm.flatMap((r) => {
          const text = line(r)
          return text ? [text] : []
        }),
      ),
    ].slice(0, MAX_CONFIRM),
  }
}
