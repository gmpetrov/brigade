// Taking memory from a thread that went quiet: the prompt for a short harness
// run, and reading its answer. The API applies the result to the memory files.
import type { MemoryEdit, ThreadSpec } from '@brigade/contracts'
import { z } from 'zod'

/** How much of the conversation a memory run reads. */
const CONVERSATION_CHARS = 60_000
const MEMORY_CHARS = 20_000

type Entry = { by: string | null; name: string; text: string }

export function memoryPrompt(input: {
  spec: ThreadSpec
  entries: Entry[]
  summary: string | undefined
  memory: (teammateId: string) => { workspace: string; teammate: string }
  speakers: { id: string; name: string }[]
}) {
  const { spec, speakers } = input
  let budget = CONVERSATION_CHARS
  const lines: string[] = []
  for (const e of [...input.entries].reverse()) {
    const line = `${e.by ? `${e.name} (AI teammate)` : 'Member'}: ${e.text}`
    if (lines.length > 0 && line.length > budget) break
    lines.unshift(line.length > budget ? `${line.slice(0, budget)}…` : line)
    budget -= line.length
  }
  const workspace = input.memory(spec.teammate.id).workspace.slice(0, MEMORY_CHARS)
  const teammateKeys = speakers.map((t) => JSON.stringify(t.name)).join(', ')
  return [
    'You keep the shared memory of a team that works with AI teammates. Below are the current memory files and a conversation from one thread.',
    'Reply with only one JSON object and nothing else, in this shape:',
    `{"summary": "...", "workspace": {"add": [], "remove": []}, "teammates": {${speakers.map((t) => `${JSON.stringify(t.name)}: {"add": [], "remove": []}`).join(', ')}}}`,
    [
      '- summary: 2 to 6 sentences: what was asked in this thread and what was done or decided, as of now' +
        (input.summary ? ' (update the previous summary below with what happened since).' : '.'),
      spec.private
        ? '- workspace: leave both lists empty; this thread is private.'
        : '- workspace: lasting facts anyone in this workspace will need later: people (names, roles, contacts), terms, decisions, and where things live (URLs, files, accounts). Not the progress of this task.',
      `- teammates (${teammateKeys}): for each, what it learned about doing its job: preferences, procedures, pitfalls.`,
      '- add: short one-line statements, each true on its own. Skip anything the memory already says.',
      '- remove: lines copied exactly from a memory file that this conversation shows are wrong or outdated.',
      '- Most threads add little or nothing to memory: empty lists are fine. Never include passwords, keys, tokens or other secrets.',
    ].join('\n'),
    input.summary && `Previous summary of this thread:\n${input.summary}`,
    `Workspace memory now:\n<<<\n${workspace.trim() || '(empty)'}\n>>>`,
    ...speakers.map(
      (t) =>
        `Memory of ${t.name} now:\n<<<\n${input.memory(t.id).teammate.slice(0, MEMORY_CHARS).trim() || '(empty)'}\n>>>`,
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
  teammates: z.record(z.string(), Edit).catch({}).default({}),
})

/** The run's answer as a memory update, or null when it is not the JSON asked for. */
export function parseMemory(
  text: string,
  spec: ThreadSpec,
  speakers: { id: string; name: string }[],
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
  return {
    summary: answer.summary.slice(0, 4000),
    workspace: spec.private ? { add: [], remove: [] } : clamp(answer.workspace),
    teammates: speakers.flatMap((t) => {
      const edit = answer.teammates[t.name]
      return edit ? [{ teammateId: t.id, edit: clamp(edit) }] : []
    }),
  }
}

/** Within the API's limits, so one long line does not lose the whole update. */
const clamp = (edit: { add: string[]; remove: string[] }): MemoryEdit => {
  const lines = (list: string[]) =>
    list
      .map((l) => l.trim().slice(0, 1000))
      .filter(Boolean)
      .slice(0, 40)
  return { add: lines(edit.add), remove: lines(edit.remove) }
}
