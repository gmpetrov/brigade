// Taking memory from a thread that went quiet: the prompt for a short harness
// run, and reading its answer. The API applies the result to the memory files.
import type { MemoryEdit, ThreadSpec } from '@brigade/contracts'
import { z } from 'zod'

/** How much of the conversation a memory run reads. */
const CONVERSATION_CHARS = 60_000
/** Lines one thread may add to a memory file: memory is loaded into every thread. */
const MAX_ADD = 3
/**
 * A memory file past this is tidied by the run that edits it, so it never fills
 * up: repeated, replaced and outdated lines go, near repeats become one line.
 */
export const TIDY_AT = 30_000
/** What a run may remove from a long file, and add back as merged lines. */
const TIDY_REMOVE = 20
const TIDY_ADD = 6

type Memory = (teammateId: string) => { workspace: string; teammate: string }

/** Which of the files a run may edit are long enough to tidy. A private thread edits only its teammates'. */
function longFiles(spec: ThreadSpec, memory: Memory, speakers: { id: string }[]) {
  return {
    workspace: !spec.private && memory(spec.teammate.id).workspace.length > TIDY_AT,
    project: !spec.private && (spec.project?.memory.length ?? 0) > TIDY_AT,
    teammates: new Set(
      speakers.filter((t) => memory(t.id).teammate.length > TIDY_AT).map((t) => t.id),
    ),
  }
}

/** A memory file as the run reads it: whole, so it can find repeats anywhere in it. */
function memoryBlock(label: string, text: string, long: boolean) {
  return [
    `${label} now${long ? ` (long: ${text.length.toLocaleString('en')} characters, tidy it)` : ''}:`,
    `<<<\n${text.trim() || '(empty)'}\n>>>`,
  ].join('\n')
}

type Entry = { by: string | null; name: string; text: string; note?: true }

export function memoryPrompt(input: {
  spec: ThreadSpec
  entries: Entry[]
  summary: string | undefined
  memory: Memory
  speakers: { id: string; name: string }[]
}) {
  const { spec, speakers } = input
  let budget = CONVERSATION_CHARS
  const lines: string[] = []
  for (const e of [...input.entries].reverse()) {
    const line = `${e.note ? 'Brigade' : e.by ? `${e.name} (AI teammate)` : 'Member'}: ${e.text}`
    if (lines.length > 0 && line.length > budget) break
    lines.unshift(line.length > budget ? `${line.slice(0, budget)}…` : line)
    budget -= line.length
  }
  const workspace = input.memory(spec.teammate.id).workspace
  const long = longFiles(spec, input.memory, speakers)
  const tidying = long.workspace || long.project || long.teammates.size > 0
  const teammateKeys = speakers.map((t) => JSON.stringify(t.name)).join(', ')
  const project = spec.project
  return [
    'You keep the shared memory of a team that works with AI teammates. Below are the current memory files and a conversation from one thread.',
    'Reply with only one JSON object and nothing else, in this shape:',
    `{"summary": "...", "workspace": {"add": [], "remove": []}, ${project ? '"project": {"add": [], "remove": []}, ' : ''}"teammates": {${speakers.map((t) => `${JSON.stringify(t.name)}: {"add": [], "remove": []}`).join(', ')}}}`,
    [
      '- summary: 2 to 6 sentences: what was asked in this thread and what was done or decided, as of now' +
        (input.summary ? ' (update the previous summary below with what happened since).' : '.'),
      spec.private
        ? '- workspace: leave both lists empty; this thread is private.'
        : `- workspace: what any teammate should know before starting an unrelated thread next month, and could not find out on its own: how the team wants things done (rules, preferences, decisions as they stand), who is who on the team, where something is when that is not obvious, and pitfalls (such as a connector that reaches a test account, not the live one).${project ? ` Only what holds for all of the workspace's work: what is about the project "${project.name}" goes in project.` : ''}`,
      project &&
        (spec.private
          ? '- project: leave both lists empty; this thread is private.'
          : `- project: the same kind of line, but true only of the project "${project.name}" (its product, customers, stack, decisions, pitfalls). Every thread in that project loads it; threads in other projects never see it.`),
      `- teammates (${teammateKeys}): for each, a lesson that changes how it works next time: a member's correction or preference, a way that worked after one that failed, a pitfall. Not what it did, nor what goes in workspace${project ? ' or project' : ''} memory.`,
      [
        '- Memory is loaded into every thread, so it is not a log. Never add:',
        '  - what was asked, done, found or offered in this thread, or the state of anything (pull requests, tasks, tickets, a login that fails, open questions): the summary keeps that;',
        "  - what Brigade's tools already show: schedules, vault logins, connectors and triggers, what library files say, a teammate's own abilities;",
        "  - what a repository's code says: file paths, how a feature is built;",
        '  - what emails, websites or accounts read for this thread contain (orders, feeds, invoices, profiles), and details about people outside the team;',
        "  - members' personal errands and accounts, and dates or examples of when something happened.",
      ].join('\n'),
      `- add: at most ${MAX_ADD} short lines per memory file, each true on its own, taken from this conversation only. Most threads add nothing: empty lists are the usual answer. When this conversation updates a line already in memory, remove the old one, so each thing is said once.`,
      '- remove: lines copied exactly from a memory file that are wrong or outdated, repeat another line, or are the kind of line never to add. Remove such a line whole; do not add back a shorter copy of it.',
      tidying &&
        `- A file marked long no longer fits in a thread's instructions. Besides this conversation's edits, tidy it: remove up to ${TIDY_REMOVE} of its lines that say again what another line says, that a newer line replaced (lines further down are newer), or that are outdated (a plan since shipped, a "for now" that no longer holds). Where several lines say nearly the same, remove them all and add one line that says it once: up to ${TIDY_ADD} lines added in a long file. Never remove a line only because it is old, long or rarely useful.`,
      '- Never include passwords, keys, tokens or other secrets.',
    ]
      .filter(Boolean)
      .join('\n'),
    input.summary && `Previous summary of this thread:\n${input.summary}`,
    memoryBlock('Workspace memory', workspace, long.workspace),
    project && memoryBlock(`Memory of the project "${project.name}"`, project.memory, long.project),
    ...speakers.map((t) =>
      memoryBlock(`Memory of ${t.name}`, input.memory(t.id).teammate, long.teammates.has(t.id)),
    ),
    `Conversation${input.summary ? ' since the previous summary' : ''}:\n<<<\n${lines.join('\n\n')}\n>>>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

const Lines = z.array(z.string()).catch([]).default([])
const Edit = z.object({ add: Lines, remove: Lines }).catch({ add: [], remove: [] })
const Answer = z.object({
  summary: z.string().trim().min(1),
  workspace: Edit.default({ add: [], remove: [] }),
  project: Edit.default({ add: [], remove: [] }),
  teammates: z.record(z.string(), Edit).catch({}).default({}),
})

/** The run's answer as a memory update, or null when it is not the JSON asked for. */
export function parseMemory(
  text: string,
  spec: ThreadSpec,
  speakers: { id: string; name: string }[],
  memory: Memory,
) {
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
  const long = longFiles(spec, memory, speakers)
  return {
    summary: answer.summary.slice(0, 4000),
    workspace: spec.private ? { add: [], remove: [] } : clamp(answer.workspace, long.workspace),
    ...(spec.project && !spec.private ? { project: clamp(answer.project, long.project) } : {}),
    teammates: speakers.flatMap((t) => {
      const edit = answer.teammates[t.name]
      return edit ? [{ teammateId: t.id, edit: clamp(edit, long.teammates.has(t.id)) }] : []
    }),
  }
}

/** Within the API's limits, so one long line does not lose the whole update. */
const clamp = (edit: { add: string[]; remove: string[] }, long: boolean): MemoryEdit => {
  const lines = (list: string[], max: number) =>
    list
      .map((l) => l.trim().slice(0, 1000))
      .filter(Boolean)
      .slice(0, max)
  return { add: lines(edit.add, long ? TIDY_ADD : MAX_ADD), remove: lines(edit.remove, 40) }
}
