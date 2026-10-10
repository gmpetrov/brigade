// Memory loads through the harness's own instruction file (spec: "Brigade
// adds no retrieval step inside the agent loop"): CLAUDE.md for Claude Code,
// AGENTS.md for Codex, in the thread's working directory, written each time
// its harness session starts. A file Brigade did not write is left alone.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ThreadSpec } from '@brigade/contracts'
import { threadBranch } from './repos.js'

const MARK = '<!-- Written by Brigade when this session starts; edits here are replaced. -->'
/** Memory beyond this is left to search, so the file stays a reasonable size. */
const MEMORY_CHARS = 16_000

const clip = (text: string) =>
  text.length > MEMORY_CHARS
    ? `${text.slice(0, MEMORY_CHARS)}\n\n… (longer than shown; search_workspace finds the rest)`
    : text

/** Strip a memory file's own top heading; the section gives one. */
const body = (text: string) => text.replace(/^#\s[^\n]*\n+/, '').trim()

export function instructions(
  spec: ThreadSpec,
  memory: { workspace: string; teammate: string },
  libraryDir: string,
) {
  const workspace = body(memory.workspace)
  const own = body(memory.teammate)
  return [
    MARK,
    '# Brigade',
    `You are ${spec.teammate.name}, an AI teammate in a Brigade workspace.`,
    '## Workspace library',
    `The workspace's shared documents are mirrored read-only at ${libraryDir}. ` +
      'Search them, the memory below and summaries of past threads with `search_workspace`.' +
      (spec.library === 'read_write'
        ? ' To add or update a library file, write it on this computer, then call `save_to_library`.'
        : ''),
    spec.git && code(spec),
    workspace && `## Workspace memory\n\n${clip(workspace)}`,
    own && `## What you have learned\n\n${clip(own)}`,
    '## Memory',
    'When this thread goes quiet, Brigade notes what was decided and learned here into the memory above' +
      (spec.private ? ' (this thread is private: only into your own memory)' : '') +
      '. You do not need to write memory files yourself. Never put secrets in your replies.',
  ]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

/** How a teammate with a GitHub connection works on code. */
const code = (spec: ThreadSpec) =>
  [
    '## Code',
    'You can work on the GitHub repositories of your GitHub connection. Check one out with `checkout_repository`: ' +
      `it goes into your working directory on a branch of your own for this thread (${threadBranch(spec)}).`,
    'Commit as you go and push with `git push -u origin HEAD`. Git reaches GitHub through Brigade: only branches ' +
      'under `brigade/` can be pushed, so propose changes to other branches with a pull request (the GitHub tool; ' +
      'a person may need to approve it). The `gh` command is not signed in; use the GitHub tools instead.',
    'When the thread goes quiet, Brigade backs up commits and changes to tracked files you have not pushed ' +
      '(to `brigade/wip/...`). New files you have not committed are not backed up. A checkout left untouched for ' +
      'two weeks with everything on GitHub is removed to free disk; `checkout_repository` brings it back, with your ' +
      'branch or backup.',
    repositories(spec),
  ]
    .filter(Boolean)
    .join('\n\n')

/** The workspace's repositories: the ones it works on, with what to know about each. */
function repositories(spec: ThreadSpec) {
  const list = spec.git?.repositories ?? []
  if (list.length === 0) return ''
  return [
    '### Repositories',
    "The workspace's repositories, set up by the team. `checkout_repository` runs a repository's setup script in a new checkout. A message mentions one as `@[owner/name](repository:owner/name)`.",
    ...list.map((p) => {
      const notes = p.notes.trim()
      return `- **${p.repository}**${notes ? `\n\n  ${clip(notes).replace(/\n/g, '\n  ')}` : ''}`
    }),
  ].join('\n\n')
}

export const instructionsFileName = (spec: ThreadSpec) =>
  spec.teammate.harness === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'

/** Write the file into the working directory, as the teammate's user on a cloud computer. */
export async function writeInstructions(
  workDir: string,
  spec: ThreadSpec,
  text: string,
  runAs?: string,
) {
  const file = join(workDir, instructionsFileName(spec))
  if (!runAs) {
    const current = await readFile(file, 'utf8').catch(() => null)
    if (current !== null && !current.startsWith(MARK)) return
    return writeFile(file, text)
  }
  // Same check, run as the teammate (its home is private to it).
  const script = `f="$1"; if [ -e "$f" ] && [ "$(head -c ${MARK.length} "$f")" != '${MARK}' ]; then cat >/dev/null; exit 0; fi; cat >"$f"`
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sudo', ['-n', '-u', runAs, 'sh', '-c', script, 'sh', file], {
      cwd: '/',
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `exit ${code}`)),
    )
    child.stdin.end(text)
  })
}
