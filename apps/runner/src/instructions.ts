// Memory loads through the harness's own instruction file (spec: "Brigade
// adds no retrieval step inside the agent loop"): CLAUDE.md for Claude Code,
// AGENTS.md for Codex, in the thread's working directory, written each time
// its harness session starts. A file Brigade did not write is left alone.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DESIGN_ENTRY,
  DESIGN_KNOBS,
  DESIGN_MANIFEST,
  DESIGN_SUFFIX,
  DESIGN_SYSTEM_PREVIEW,
  DESIGN_SYSTEM_README,
  DESIGN_SYSTEM_TOKENS,
  type ThreadSpec,
} from '@brigade/contracts'
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

/** Where the teammate may save to the library: everywhere, nowhere, or some folders. */
function saving(spec: ThreadSpec) {
  const folders = spec.libraryFolders ?? []
  const list = (access: 'read' | 'read_write') =>
    folders
      .filter((f) => f.access === access)
      .map((f) => `${f.path}/`)
      .join(', ')
  const how = 'write it on this computer, then call `save_to_library`'
  if (spec.library === 'read_write') {
    const readOnly = list('read')
    return (
      ` To add or update a library file, ${how}.` +
      (readOnly ? ` These folders are read-only for you: ${readOnly}.` : '')
    )
  }
  const writable = list('read_write')
  return writable
    ? ` To add or update a file in ${writable}, ${how}. The rest is read-only for you.`
    : ''
}

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
      'Search them, the memory below and summaries of past threads with `search_workspace`. ' +
      `A message mentions a library file as \`@[path](document:id)\`: the file at ${libraryDir}/path; ` +
      `and a design as \`@[path](design:path)\`: the folder at ${libraryDir}/path (its \`${DESIGN_ENTRY}\`, ` +
      `\`${DESIGN_MANIFEST}\`, \`${DESIGN_KNOBS}\` and assets); and a design system as \`@[name](design-system:path)\`: ` +
      `the one named, its folder at ${libraryDir}/path. Asked to build a design in a product, match it at ` +
      "each of its viewports with the product's own components and conventions, and use the values in its " +
      `\`${DESIGN_KNOBS}\`.` +
      saving(spec),
    designs(spec, libraryDir),
    spec.git && code(spec),
    PREVIEWS,
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

/** Making designs as HTML, and the design systems they follow. Only for teammates who can save them. */
function designs(spec: ThreadSpec, libraryDir: string) {
  const canSave =
    spec.library === 'read_write' ||
    (spec.libraryFolders ?? []).some((f) => f.access === 'read_write')
  if (!canSave) return ''
  const systems = spec.designSystems ?? []
  const appliesTo = (s: ThreadSpec['designSystems'][number]) =>
    [
      ...s.folders.map((f) => `designs in ${f}/`),
      ...s.repositories.map((r) => `work in ${r}`),
      s.teammate && 'you',
      s.isDefault && 'the default',
    ]
      .filter(Boolean)
      .join(', ')
  return [
    '## Designs',
    'When asked for a visual design (a page, a screen, a prototype, slides, a one-pager), make it as a web page: ' +
      `a folder with \`${DESIGN_ENTRY}\` and \`${DESIGN_MANIFEST}\` at its top, and its assets beside them. ` +
      'Link everything in it by relative paths; libraries and fonts from public CDNs are fine, but the page may ' +
      'not fetch data from other sites (it is shown in a sandbox), so put sample data in the page. ' +
      `\`${DESIGN_MANIFEST}\` holds \`{"title": "…", "description": "…", "designSystem": "<name>", "viewports": ["desktop", "mobile"]}\`.`,
    'Give every element someone may talk about a stable `data-id` (`hero`, `plan-pro`, `signup-form`) and keep ' +
      'it when you change the design: people point at elements by it.',
    'Slides: set `"kind": "slides"` in the manifest and make each slide an element with `data-slide`, 1280×720 ' +
      '(16:9), its speaker notes in `data-notes`. Add print CSS (`@page { size: 1280px 720px; margin: 0 }`, a page ' +
      'break after each slide) so it exports to PDF one slide per page; it also exports to PowerPoint.',
    `Knobs: when a few values are worth tuning by eye (brand color, corner radius, spacing, type scale), write ` +
      `\`${DESIGN_KNOBS}\`: \`{"knobs": [{"var": "--radius", "label": "Corner radius", "type": "range", "min": 0, ` +
      `"max": 32, "step": 1, "unit": "px", "value": "12px"}]}\` (types: color, range, select with \`options\` ` +
      `[{label, value}], text). Use those CSS custom properties in the design; the viewer lets people try values ` +
      `and save them into \`${DESIGN_KNOBS}\`, whose values win over the design's own. Read it again before ` +
      'you change a design: people may have changed them.',
    `Before you hand a design over, call \`check_design\` on its folder, open the screenshots it makes and fix ` +
      'what is off or any error it reports. Then save it with `save_design` to a library path ending in ' +
      `\`${DESIGN_SUFFIX}\`, next to the work it belongs to, and mention it in your reply as ` +
      '`@[path](design:path)`: it opens beside the thread. Saving again replaces it; the library keeps earlier versions.',
    'When you offer alternatives (several directions to choose from), make each its own design folder, check and ' +
      'save each one, and describe them in your reply. Then call `offer_choices` last, with one option per design ' +
      'and its library path in `design`: the person picks one by its picture. Their pick arrives as their next message.',
    'People comment on a design from its viewer: such a message starts with "Comment on the design" and names the ' +
      'element by its `data-id` (or a CSS path) and the viewport. Change the design, check it and save it again.',
    [
      '### Making a design system',
      'When asked for a design system (from a repository, a site, an export or a brief), make it in a folder on ' +
        'this computer. It is not a design: do not save it with `save_design`.',
      `- \`${DESIGN_SYSTEM_README}\`: the rules a designer follows. Color use, typography, spacing, radius, shadows, ` +
        'layout, imagery and voice, the main components and when to use each, with do and don’t examples. ' +
        'Point to the files below.',
      `- \`${DESIGN_SYSTEM_TOKENS}\`: every token as a CSS custom property on \`:root\`, and dark mode values if it has them.`,
      '- `assets/`: the logos, fonts and icons designs need.',
      `- \`${DESIGN_SYSTEM_PREVIEW}/\`: a design that shows the palette, type scale and main components. A design ` +
        'only reaches its own folder, so copy the tokens and assets it uses into it.',
      'Take values from the source, not from guesses, and say what you could not find. Check the preview with ' +
        '`check_design`, then call `save_design_system` with the folder, a library folder under ' +
        '`design-systems/` and its name, and say where it applies: the repository it comes from, the library ' +
        'folders or the default, as the person asks. It applies to threads that start after that. Mention its ' +
        'preview in your reply.',
    ].join('\n'),
    systems.length > 0
      ? [
          '### Design systems',
          'A design follows exactly one design system: the one the person names or mentions; else one for the library ' +
            'folder the design goes in; else one for the repository you are working in; else yours; else the ' +
            'default. When none applies and there are several, ask which one. Before designing, read its ' +
            `folder in ${libraryDir}: its README.md first, and what that points to. Use its tokens and ` +
            'components, copy the files the design needs (stylesheets, fonts, logos) into the design folder, ' +
            `and put its name in \`${DESIGN_MANIFEST}\`.`,
          systems
            .map((s) => {
              const about = [s.description, appliesTo(s) && `Applies to ${appliesTo(s)}.`]
              const text = about.filter(Boolean).join(' ')
              return `- **${s.name}** (\`${s.path}\`)${text ? `: ${text}` : ''}`
            })
            .join('\n'),
        ].join('\n\n')
      : 'The workspace has no design system yet. Follow the look of the product the design is for when you can ' +
        'find it (its repository, its site), and say which choices you made.',
  ].join('\n\n')
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
const PREVIEWS =
  '## Previews\n\n' +
  'When you build or change an app people can use in a browser, run it with `start_preview` once it works, so ' +
  'the person tries it from this thread instead of reading the diff. In a checkout, first try ' +
  '`start_preview({ repository })`: a repository set up before starts as it was saved. Otherwise set it up in ' +
  'start_preview itself, not in your shell, so it can be saved: `setup` (install; `docker compose up -d` for its ' +
  'database, cache or mail: you have your own Docker; migrate; seed sample data so pages show something), `env` ' +
  '(${BRIGADE_PREVIEW_URL} for its own address in auth, callback and API URLs; random values for secrets it only ' +
  'needs locally; the always-pass test keys CAPTCHA providers publish), `credentials` for real keys from the vault ' +
  '(open a ticket for one it lacks), and `paths`: the home page, sign-in and the pages you changed. ' +
  'start_preview opens those pages as a person would: fix what it finds and run `check_preview` until they pass ' +
  'before saying it is ready, then `save_preview`. It keeps running between your turns, and reloads as you edit ' +
  'when it is a dev server. If it fails, read `preview_logs`. ' +
  'People reach it at one address: its other ports (an API) are paths on it, at `BRIGADE_PREVIEW_URL_<port>`, and ' +
  "its cookies are adapted so signing in works in the thread's preview pane. Signing in with Google or GitHub, " +
  'and Safari, need it opened in a new tab (a button on the pane). ' +
  'In your reply, say how it started, what its check found, and that it is saved.'

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
    "Logins, API keys and other secrets live in the workspace's vault: `list_credentials` shows those you may use. " +
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
    'When you produce a secret yourself (you create an account, generate an API key, or a site makes you reset a ' +
      'password), save it with `save_credential` so it is not lost: write it alone to a file without printing it, ' +
      'pass the path, and delete the file once saved. A person approves first.',
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
