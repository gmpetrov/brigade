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
  browser: Browser,
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
    tasks(spec),
    SCHEDULES,
    credentials(browser),
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

/** The Tasks board: this thread's task, or when to make one. */
const tasks = (spec: ThreadSpec) =>
  spec.task
    ? [
        '## Your task',
        `This thread is the task **${spec.task.title}** on the workspace's Tasks board.`,
        spec.task.description,
        'Put what you produce where others can reach it: push your branch or open a pull request, attach files ' +
          'to the thread, or save them to the library. Another teammate may take the task over, and it does not ' +
          'see your working folder. When the work is finished and delivered, call `complete_task` with a short ' +
          'summary and links to what you produced.',
      ]
        .filter(Boolean)
        .join('\n\n')
    : '## Tasks\n\n' +
      "The workspace tracks bigger work as tasks on its Tasks board. Call `create_task` when this thread's work " +
      'has a deliverable someone will review, takes several steps, will wait on approval or someone else, or the ' +
      'person asks to track it; not for questions, explanations or quick actions you finish in one reply. ' +
      'Do not ask first: create it, say so in one line, and do the work.'

/** Schedules: recurring work, set up when the person asks for it. */
const SCHEDULES =
  '## Schedules\n\n' +
  'When the person asks for something to happen repeatedly or at set times, set it up with `create_schedule`: ' +
  'each run prompts you in a fresh thread with no memory of this one, so the instructions must stand alone ' +
  '(inputs by name, steps, where the result goes). `list_schedules` and `update_schedule` show and change yours. ' +
  'A thread that starts with "Scheduled run of" is one of those runs: nobody is watching it live, so do the work ' +
  'and open a ticket when you need a person.'

/**
 * The teammate's own browser, which website logins need: ready, none on this
 * computer (a member's machine), or why it did not start on a cloud computer.
 */
export type Browser = { ready: true } | { ready: false; error?: string }

/** The vault, and getting a login or key it lacks without stopping the work. */
const credentials = (browser: Browser) =>
  [
    '## Credentials',
    "Logins, API keys and other secrets live in the workspace's vault: `list_credentials` shows what it holds. " +
      (browser.ready
        ? 'Sign in to a website with `fill_credential` on its sign-in page in your browser; '
        : browser.error
          ? `Your browser did not start on this computer (${browser.error.replace(/\s+/g, ' ').slice(0, 600)}), so you cannot sign in to websites in this thread; `
          : 'You have no browser on this computer, so you cannot sign in to websites; ') +
      'load any other kind with `use_credential`. You never see a secret, and you never ask for one in a message.',
    'When the work needs a credential the vault does not have, do not stop to explain where to add it: open a ticket ' +
      '(`open_ticket`) with an `access` ask of kind `credential`, and fill in `credential` with what you know ' +
      '(its kind, a name, the sign-in page or API URL, the username if you know it). The person saves it to the vault ' +
      'right in the ticket, and the answer gives you its mention, which lets you use it in this thread at once. ' +
      'Then use it and finish the task.',
    browser.ready &&
      'When a website stops you with a human check (a CAPTCHA, a "verify you are human" box, a bot or firewall ' +
        'block page) or a step only a person can do in the browser, do not try to get around it and do not stop to ' +
        'explain: leave the page open and open a ticket with an `action` ask with `browser: true`, saying what to do ' +
        'there (e.g. "Check Verify you are human on citadium.com"). Ask for any login the vault lacks in the same ticket. ' +
        'The person takes over your browser from the ticket, clears it and hands back; then look at the page again ' +
        'and finish the task.',
    !browser.ready &&
      'When the work needs signing in to a website, tell the person you cannot' +
        (browser.error ? ' because your browser did not start, with the reason above' : '') +
        '. Do not ask for a different kind of credential (such as API keys) to work around it unless they ask for that.',
  ]
    .filter(Boolean)
    .join('\n\n')

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
    'A repository has its own instructions for working on it: read its AGENTS.md, CLAUDE.md or README after ' +
      'checking it out. A message mentions a repository as `@[owner/name](repository:owner/name)`.',
  ]
    .filter(Boolean)
    .join('\n\n')

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
