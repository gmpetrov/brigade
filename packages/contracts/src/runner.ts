// Messages on the one WebSocket between a runner and the API.
import { z } from 'zod'
import { ThreadAttachmentRef } from './attachments.js'
import { CredentialUse, TeammateCredentialSave } from './credentials.js'
import { TeammateDesignSystem, ThreadDesignSystem } from './design.js'
import { QuestionAnswer, ReplyTo, SequencedEvent, TicketAnswer } from './events.js'
import {
  FILE_VIEW_MAX,
  LibraryAccess,
  LibraryPath,
  MemoryEdit,
  MemoryFileRef,
  NO_MEMORY_EDIT,
  CODE_FIND_MAX,
  CODE_CHANGES_MAX,
  CODE_LIST_MAX,
  CodeChange,
  CodeEntry,
  SourceMatch,
} from './library.js'
import { MemoryLayout } from './memory.js'
import {
  PROJECT_LOGO_CANDIDATES_MAX,
  PROJECT_SITE_TEXT_MAX,
  ProjectCatalogEntry,
  ThreadProject,
} from './projects.js'
import {
  PREVIEW_PORTS_MAX,
  PreviewAction,
  PreviewOperation,
  PreviewPort,
  PreviewStartOutcome,
} from './previews.js'
import { ThreadPlaybook } from './playbooks.js'
import { ScheduleOperation } from './schedules.js'
import { SkillProposal, ThreadSkill } from './skills.js'
import { TaskOperation } from './tasks.js'
import { TeammateKind } from './chief.js'

/** Longest clipboard text carried between a person's browser and a desktop. */
export const CLIPBOARD_MAX = 1_000_000

export const HarnessId = z.enum(['claude_code', 'codex'])
export type HarnessId = z.infer<typeof HarnessId>

/**
 * How hard the model thinks (Claude Code `effort`, Codex `reasoningEffort`); a
 * thread without one runs at the harness's own default. EFFORTS names them.
 */
export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof Effort>

/** A harness login on the computer. The runner finds its config directory from these; never a credential. */
export const AccountRef = z.object({
  id: z.string(),
  provider: HarnessId,
  /** machine: the login already on this machine. brigade: signed in through Brigade. */
  source: z.enum(['machine', 'brigade']),
})
export type AccountRef = z.infer<typeof AccountRef>

/** A connection the teammate is granted, as tools. Never its credential. */
export const ConnectorGrant = z.object({
  connectionId: z.string(),
  /** gmail, google_calendar, google_drive, google_docs, google_sheets, google_search_console, google_analytics, stripe, github, or an MCP App's kind such as cloudflare (MCP_PROTOCOL). */
  kind: z.string(),
  label: z.string(),
  externalAccount: z.string().nullable(),
  scope: z.enum(['read', 'read_write']),
  operations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      write: z.boolean(),
      inputSchema: z.record(z.string(), z.unknown()),
      /**
       * The input field holding paths of files on the computer to send with the call
       * (e.g. an email's attachments). The runner uploads them and passes their ids.
       */
      filesField: z.string().optional(),
    }),
  ),
})
export type ConnectorGrant = z.infer<typeof ConnectorGrant>

/**
 * Git through the API's proxy (see the API's routes/git.ts). The token is a
 * capability for that proxy, limited to one thread and teammate and checked
 * against its grants on every request; never a GitHub credential.
 */
export const GitAccess = z.object({
  /** The proxy's base URL; a repository is at <url><owner>/<name>.git. */
  url: z.url(),
  token: z.string(),
  /** Who the teammate's commits are by on a cloud computer. */
  author: z.object({ name: z.string(), email: z.string() }),
})
export type GitAccess = z.infer<typeof GitAccess>

/** What a runner needs to start or continue a thread. Never a secret, except git's proxy token. */
export const ThreadSpec = z.object({
  sessionId: z.string(),
  teammate: z.object({
    id: z.string(),
    name: z.string(),
    instructions: z.string(),
    harness: HarnessId,
    model: z.string().nullable(),
    kind: TeammateKind.default('teammate'),
  }),
  /** The thread's effort for every teammate in it; null: the harness's default. */
  effort: Effort.nullable().default(null),
  /**
   * After each turn, the harness guesses what the person may write next (message.suggested).
   * Set on Claude Code, in a thread a member started who keeps suggestions on: the guess
   * counts toward their account's usage.
   */
  suggestions: z.boolean().default(false),
  /** allow-reads: ask before writes and commands. allow-all: never ask. */
  permissionMode: z.enum(['allow-reads', 'allow-edits', 'allow-all']),
  /** The account to run on, then the starter's other accounts with usage left, in order. */
  account: AccountRef,
  fallbacks: z.array(AccountRef),
  /**
   * A teammate not on Codex: the starter's Codex account with usage left, if any,
   * which makes images for it (generate_image). Codex teammates make their own.
   */
  imageAccount: AccountRef.nullable().default(null),
  /** Connector tools; every call goes back to the API, which checks and makes it. */
  connectors: z.array(ConnectorGrant).default([]),
  /**
   * The teammate that started the thread. Others in it get their own harness
   * session and saved state, keyed by thread and teammate.
   */
  starter: z.boolean().default(true),
  /** Everyone in the thread, so each teammate knows who else is in it. */
  teammates: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  /**
   * For the chief: every teammate of the workspace, with its role (the first
   * line of its instructions). Mentioning one brings it into the thread.
   */
  roster: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })).default([]),
  /** The teammate's grant on the workspace library: read it and search, or also save to it. */
  library: LibraryAccess.default('read'),
  /**
   * Folders where the teammate's access differs from `library`: read-only,
   * or open to saving. Folders it may not see are left out.
   */
  libraryFolders: z
    .array(z.object({ path: z.string(), access: z.enum(['read', 'read_write']) }))
    .default([]),
  /** A private thread does not write to workspace memory, and its summary is not searchable. */
  private: z.boolean().default(false),
  /** Set in a playbook's thread (its run's root or a child): the playbook, whose Apps alone it has. */
  playbook: ThreadPlaybook.nullish(),
  /** Set in a child thread: the thread it was started from, which its report goes to. */
  parent: z.object({ id: z.string(), title: z.string() }).nullish(),
  /** Set when the teammate is granted a GitHub connection: its repositories through git. */
  git: GitAccess.optional(),
  /** Every file given to the thread so far: each is put in the teammate's working folder before its turn. */
  attachments: z.array(ThreadAttachmentRef).default([]),
  /** The task this thread works on, if it is one. */
  task: z.object({ id: z.string(), title: z.string(), description: z.string() }).nullish(),
  /** The workspace's design systems, for designs the teammate makes. */
  designSystems: z.array(ThreadDesignSystem).default([]),
  /** The workspace's skills that apply to this thread (enabled, and for its teammate and project). */
  skills: z.array(ThreadSkill).default([]),
  /** The project the thread works in: its brief, memory, folder and repositories. */
  project: ThreadProject.nullish(),
  /** The workspace's projects (not archived), so a mention of one can be followed. */
  projects: z.array(ProjectCatalogEntry).default([]),
  /**
   * The thread came to this computer from another (MOVE_PROTOCOL). Each arrival
   * once: what this computer kept of the thread from before is out of date. Its
   * folders come from their archives, its conversation from the API (the events
   * up to `seq`), and its events go on numbered after `seq`.
   */
  moved: z
    .object({
      /** When it arrived: tells one arrival from the next. */
      at: z.string(),
      /** The computer it came from, by name. */
      from: z.string(),
      /** This computer, by name, as members see it. */
      to: z.string().optional(),
      /** The thread's last event before it moved. */
      seq: z.number().int().nonnegative(),
    })
    .nullish(),
})
export type ThreadSpec = z.infer<typeof ThreadSpec>

// Runner -> API
export const RunnerToApi = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    version: z.string(),
    platform: z.string(),
    /** SHA-256 of the bundle it was installed from. Unset: running from source, never updated. */
    bundle: z.string().optional(),
    /** On a cloud computer: SHA-256 of the root setup last applied (see cloud-bootstrap). */
    setup: z.string().optional(),
    /** On a member's machine: this machine and runner home, hashed (see RunnerLink). */
    machineId: z.string().max(128).optional(),
    /**
     * When this runner process started, by its clock. Previews do not outlive their runner,
     * so one its events said was running before then stopped with the previous process.
     */
    startedAt: z.iso.datetime().optional(),
    /** On a member's machine: which harnesses are already signed in there. Never a credential. */
    machineLogins: z
      .array(
        z.object({
          provider: HarnessId,
          loggedIn: z.boolean(),
          email: z.string().optional(),
          plan: z.string().optional(),
        }),
      )
      .optional(),
  }),
  z.object({ type: z.literal('events'), events: z.array(SequencedEvent) }),
  /**
   * The threads whose events the API has not acknowledged for minutes, with since when (the
   * oldest one's time), sent when that list changes: their pages say so. From protocol 26.
   */
  z.object({
    type: z.literal('events.waiting'),
    threads: z.array(z.object({ sessionId: z.string(), since: z.iso.datetime() })).max(1000),
  }),
  /** Still here, every 30 s: the API forgets a runner it stops hearing from (HEARTBEAT_PROTOCOL). */
  z.object({ type: z.literal('heartbeat') }),
  /**
   * A cloud computer's disk after the runner freed what it could (DISK_PROTOCOL): still
   * full, and how full (0 to 1). Said when that changes and every 10 minutes.
   */
  z.object({ type: z.literal('disk'), full: z.boolean(), used: z.number().min(0).max(1) }),
  /**
   * The runner restarts into an update and hands its turns over to the next one (protocol 29):
   * until that one connects, the API holds the computer's commands, and it stays online.
   */
  z.object({ type: z.literal('runner.restarting') }),
  z.object({ type: z.literal('command.failed'), commandId: z.string(), error: z.string() }),
  z.object({ type: z.literal('terminal.output'), terminalId: z.string(), data: z.string() }),
  z.object({
    type: z.literal('terminal.exit'),
    terminalId: z.string(),
    code: z.number().int().nullable(),
  }),
  /** The vendor's sign-in page to open, and for device flows the code to enter there. */
  z.object({
    type: z.literal('account.login.prompt'),
    loginId: z.string(),
    url: z.url(),
    userCode: z.string().optional(),
    /** paste: the vendor shows a code to paste back. device: the user enters userCode at url. */
    flow: z.enum(['paste', 'device']),
  }),
  z.object({
    type: z.literal('account.login.done'),
    loginId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    email: z.string().optional(),
    plan: z.string().optional(),
  }),
  /** A file read for thread.file.read, or why not. */
  z.object({
    type: z.literal('thread.file.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    path: z.string().optional(),
    teammateId: z.string().optional(),
    size: z.number().int().optional(),
    /** Unset for a binary file. */
    text: z.string().optional(),
    /** An image's bytes, base64, when asked for one. */
    data: z.string().optional(),
    truncated: z.boolean().optional(),
    /** A whole text file's SHA-256 (CODE_EDIT_PROTOCOL), for a save to name. */
    hash: z.string().optional(),
  }),
  /** A file written for thread.file.write, or why not: `conflict` when it changed since `base`. */
  z.object({
    type: z.literal('thread.file.written'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    conflict: z.boolean().optional(),
    hash: z.string().optional(),
  }),
  /** Where thread.source.find found the text, best first. */
  z.object({
    type: z.literal('thread.source.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    matches: z.array(SourceMatch).max(20).optional(),
  }),
  /** What thread.code found, or why not. */
  z.object({
    type: z.literal('thread.code.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    /** list: the folder's entries, folders first; `more` when cut at CODE_LIST_MAX. */
    entries: z.array(CodeEntry).max(CODE_LIST_MAX).optional(),
    more: z.boolean().optional(),
    /** find: files whose path holds the query, best first. */
    files: z.array(z.string()).max(CODE_FIND_MAX).optional(),
    /** grep: lines holding the query. */
    matches: z.array(SourceMatch).max(CODE_FIND_MAX).optional(),
    /** hashes: each path's SHA-256, null when it is gone or no longer a text file to edit. */
    hashes: z.record(z.string(), z.string().nullable()).optional(),
    /**
     * changes: files that differ from where their repository's branch left its default
     * branch (`base`), else from its last commit; `more` when cut at CODE_CHANGES_MAX.
     */
    changes: z.array(CodeChange).max(CODE_CHANGES_MAX).optional(),
    /** changes: the last commits of the folder's repositories (and their bases), to see when one is made. */
    head: z.string().optional(),
    /** changes, revert: the default branch they compare to, or were put back as ("main"); unset: their last commits. */
    base: z.string().optional(),
    /** original: the file as changes compares it to; null when it is in none. */
    original: z.string().nullable().optional(),
  }),
  /** A thread handed over after thread.release: its folders archived and gone from here, or why not. */
  z.object({
    type: z.literal('thread.release.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  /** The desktop's clipboard text after a desktop.clipboard command, or why it failed. */
  z.object({
    type: z.literal('desktop.clipboard.result'),
    requestId: z.string(),
    text: z.string().max(CLIPBOARD_MAX).optional(),
    error: z.string().optional(),
  }),
  /** A harness called a connector tool. The API checks grant, scope, approval and caps, then calls. */
  z.object({
    type: z.literal('connector.call'),
    callId: z.string(),
    sessionId: z.string(),
    /** The teammate making the call. Unset: the thread's starting teammate. */
    teammateId: z.string().optional(),
    connectionId: z.string(),
    operation: z.string(),
    input: z.unknown(),
  }),
  /**
   * A teammate lists the credentials it may use (never their secrets), asks for
   * one to use, or saves one. The API releases a credential the teammate is
   * granted once a member mentioned it in the thread, a person approved, or its
   * grant lets it use it without asking; it keeps a saved one once a person
   * approves. Answered like a connector call.
   */
  z.object({
    type: z.literal('credential.request'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    action: z.enum(['list', 'release', 'save']),
    credentialId: z.string().optional(),
    use: CredentialUse.optional(),
    /** save: the credential to keep, its secret read from the file the teammate named. */
    save: TeammateCredentialSave.optional(),
    /** Shown to the person approving, e.g. the page the password goes into. */
    purpose: z.string().max(500).optional(),
  }),
  /**
   * A teammate searches the library, memory and past thread summaries,
   * saves, moves or deletes library files, registers a design system it saved
   * there, or proposes a skill.
   * The API checks its grant. Answered like a connector call.
   */
  z.object({
    type: z.literal('library.call'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    operation: z.discriminatedUnion('name', [
      z.object({
        name: z.literal('search'),
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(20).default(8),
      }),
      z.object({
        name: z.literal('save'),
        path: LibraryPath,
        /** The file's bytes, base64. */
        content: z.string(),
        contentType: z.string().max(200).optional(),
      }),
      /** Move or rename a file, or a folder with everything in it. */
      z.object({ name: z.literal('move'), path: LibraryPath, to: LibraryPath }),
      /** Put a file, or a folder with everything in it, in the trash. */
      z.object({ name: z.literal('delete'), path: LibraryPath }),
      /** Register a design system whose folder is saved, or change one. */
      z.object({ name: z.literal('design_system'), designSystem: TeammateDesignSystem }),
      /** Files of a design a person changed since this thread last saved them: asked before saving it. */
      z.object({ name: z.literal('design_edits'), path: LibraryPath }),
      /** Propose a skill, or a change to one: it waits for a person's approval in a ticket. */
      z.object({ name: z.literal('skill_proposal'), proposal: SkillProposal }),
    ]),
  }),
  /**
   * A teammate creates a task from its thread, or marks the thread's task
   * done. The API checks the thread and teammate. Answered like a connector call.
   */
  z.object({
    type: z.literal('task.call'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    operation: TaskOperation,
  }),
  /**
   * A teammate creates, lists or changes schedules from a member's thread.
   * The API checks the thread and teammate. Answered like a connector call.
   */
  z.object({
    type: z.literal('schedule.call'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    operation: ScheduleOperation,
  }),
  /**
   * A teammate starts a preview on a cloud computer: the public addresses of
   * its ports, to give the app before it starts (an app calling its own API
   * needs that API's address). Answered like a connector call, with
   * { origins: { [port]: origin } }; origins carry no token. With `token`,
   * also { urls: { [port]: url } }: what a person opens, for the runner to
   * check the preview as one before anyone is told it is ready. Never logged.
   */
  z.object({
    type: z.literal('preview.expose'),
    callId: z.string(),
    sessionId: z.string(),
    ports: z.array(PreviewPort).min(1).max(PREVIEW_PORTS_MAX),
    token: z.boolean().optional(),
  }),
  /**
   * A teammate reads the saved preview recipe of a repository, or saves the
   * one its thread's preview runs. Answered like a connector call: get with
   * { recipe } (null when none), save with { saved: true }.
   */
  z.object({
    type: z.literal('preview.call'),
    callId: z.string(),
    sessionId: z.string(),
    teammateId: z.string().optional(),
    operation: PreviewOperation,
  }),
  /** What came of preview.start, or why it could not. */
  z.object({
    type: z.literal('preview.start.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    result: PreviewStartOutcome.optional(),
  }),
  /** A preview's recent output, for preview.logs, or why not. */
  z.object({
    type: z.literal('preview.logs.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    text: z.string().optional(),
  }),
  /** The brief, name and logo project.describe asked for, or why not. */
  z.object({
    type: z.literal('project.describe.result'),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    brief: z.string().max(5000).optional(),
    /** The project's name, as the site calls itself. */
    name: z.string().max(80).optional(),
    /** Which of the logos asked about is the site's own, by its place in the list. */
    logo: z.number().int().min(0).max(PROJECT_LOGO_CANDIDATES_MAX).optional(),
  }),
  /**
   * A thread went quiet: what a short harness run took from it. The summary
   * replaces the thread's; the edits apply to the memory files.
   */
  z.object({
    type: z.literal('memory.update'),
    sessionId: z.string(),
    summary: z.string().trim().min(1).max(4000),
    workspace: MemoryEdit.default(NO_MEMORY_EDIT),
    /** For the thread's project's memory; unset when it has none. */
    project: MemoryEdit.optional(),
    teammates: z
      .array(z.object({ teammateId: z.string(), edit: MemoryEdit }))
      .max(10)
      .default([]),
  }),
  /**
   * A memory file laid out again by a tidy run, on the account of a thread that
   * went quiet: its core within budget, the rest in topics, repeats merged, what
   * is outdated archived. `lastTidied` is when the file was last tidied as the
   * run saw it: the API drops the layout if it was tidied again since.
   */
  z.object({
    type: z.literal('memory.tidy'),
    sessionId: z.string(),
    file: MemoryFileRef,
    lastTidied: z.string().nullable(),
    layout: MemoryLayout,
  }),
  /**
   * A teammate's reply mentioned others in the thread: they answer next, in
   * order. The API checks they are in the thread, the caps and the chain limit.
   * The chief may also mention teammates not in it yet: they join it first.
   */
  z.object({
    type: z.literal('thread.handoff'),
    sessionId: z.string(),
    fromTeammateId: z.string(),
    teammateIds: z.array(z.string()).min(1).max(5),
  }),
  /**
   * A title for a new thread, from a short harness run on its first message.
   * The API keeps it only while the thread still has the title `from`: a
   * person's rename always wins.
   */
  z.object({
    type: z.literal('thread.title'),
    sessionId: z.string(),
    from: z.string(),
    title: z.string().trim().min(1).max(120),
  }),
])
export type RunnerToApi = z.infer<typeof RunnerToApi>

// API -> runner
/** A message for a thread, or a teammate handing it on. */
export const ThreadPrompt = z.object({
  type: z.literal('thread.prompt'),
  commandId: z.string(),
  /** The teammate that answers first. */
  thread: ThreadSpec,
  text: z.string(),
  memberId: z.string().nullable(),
  /** Teammates that answer after it, in order, each told what was said before its turn. */
  then: z.array(ThreadSpec).default([]),
  /** Set when a teammate handed the thread on: nobody wrote `text`, so it is not shown as a message. */
  handoff: z.boolean().optional(),
  /** The files that came with this message (all the thread's are in each spec). */
  attachments: z.array(ThreadAttachmentRef).default([]),
  /** The sender's id for the message: it names it while queued, and in message.user. */
  messageId: z.string().max(64).optional(),
  /** Give it to the first teammate during its running turn, if it is running one; else queue it. */
  steer: z.boolean().optional(),
  /** The earlier message it replies to: quoted to the teammate, shown above it. */
  replyTo: ReplyTo.optional(),
  /**
   * A new thread's first message: the title it has now (its first line). The
   * runner suggests a better one with a short harness run (thread.title).
   */
  nameThread: z.string().optional(),
})
export type ThreadPrompt = z.infer<typeof ThreadPrompt>

/** A raw event's source for a thread.note: settles what was asked before it, as a reply does. */
export const THREAD_NOTE_SOURCE = 'note'

export const ApiToRunner = z.discriminatedUnion('type', [
  /** bundle: the SHA-256 of the runner bundle the API serves; a runner with another one updates. */
  z.object({
    type: z.literal('welcome'),
    runnerId: z.string(),
    computerId: z.string(),
    bundle: z.string().optional(),
    /** Threads the API has as running here. One with no turn here was lost to a restart. */
    runningThreads: z.array(z.string()).optional(),
    /** Messages the API has as queued here. One the runner does not hold was lost to a restart. */
    queuedMessages: z.array(z.object({ sessionId: z.string(), messageId: z.string() })).optional(),
    /**
     * Protocol 16: threads in progress here (running, or waiting on a person),
     * each as the teammate whose turn it is, to continue a turn the runner lost.
     * Running ones left out are closed as before.
     */
    resume: z.array(ThreadSpec).optional(),
    /** Protocol 16: of the queued messages, those to queue again when lost, in order. The others are cancelled. */
    requeue: z.array(ThreadPrompt).optional(),
  }),
  /** The library or memory changed: fetch the manifest again. */
  z.object({ type: z.literal('library.changed') }),
  /**
   * Something happened in the thread outside a turn (NOTE_PROTOCOL), shown as a raw
   * event from THREAD_NOTE_SOURCE, e.g. its pull
   * request was merged from its card: a line in the thread, and what each teammate
   * is told at the start of its next turn.
   */
  z.object({
    type: z.literal('thread.note'),
    sessionId: z.string(),
    text: z.string().min(1).max(2000),
  }),
  /**
   * The thread moves to another computer (MOVE_PROTOCOL): park its teammates,
   * archive their folders to the API's bucket, then forget it here. Answered
   * with thread.release.result once every event of it is acknowledged.
   */
  z.object({
    type: z.literal('thread.release'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateIds: z.array(z.string()).min(1).max(20),
  }),
  /**
   * The thread was deleted (DELETE_PROTOCOL): its preview stops, and on a cloud
   * computer the folders and containers its teammates had there go.
   */
  z.object({ type: z.literal('thread.deleted'), sessionId: z.string() }),
  /**
   * A repository got a push on GitHub: bring the teammates' caches of it up to
   * date, if this computer has any. Each token is fetch-only, for a few minutes.
   */
  z.object({
    type: z.literal('repos.changed'),
    repository: z.string(),
    fetch: z.array(z.object({ teammateId: z.string(), url: z.url(), token: z.string() })).max(50),
  }),
  /**
   * Read a file a thread mentions, for a person viewing it: relative to a
   * teammate's working folder for the thread (tried in order), or an absolute
   * path inside one of them or the library mirror. Text up to FILE_VIEW_MAX;
   * with `image`, an image's or PDF's bytes (VIEWABLE_FILE) up to IMAGE_VIEW_MAX instead.
   */
  z.object({
    type: z.literal('thread.file.read'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateIds: z.array(z.string()).min(1).max(10),
    path: z.string().min(1).max(1000),
    image: z.boolean().optional(),
  }),
  /**
   * A person saves a text file of a teammate's working folder for the thread
   * (CODE_EDIT_PROTOCOL): relative to it, or an absolute path inside it, never the
   * library mirror. With `base`, only while the file's SHA-256 is still that.
   */
  z.object({
    type: z.literal('thread.file.write'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateId: z.string(),
    path: z.string().min(1).max(1000),
    text: z.string().max(FILE_VIEW_MAX),
    base: z.string().optional(),
  }),
  /**
   * Find where an element of the thread's preview is written (CODE_EDIT_PROTOCOL):
   * its text, searched in the preview's folder of the teammate's working folder.
   */
  z.object({
    type: z.literal('thread.source.find'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateId: z.string(),
    cwd: z.string().max(500),
    text: z.string().min(1).max(500),
    components: z.array(z.string().max(100)).max(8).optional(),
  }),
  /**
   * The code panel's view of a teammate's working folder for the thread
   * (CODE_TREE_PROTOCOL): a folder's entries (list, `path` relative to it, '' for
   * itself), files by name (find), lines by text (grep), or open files' hashes, to
   * see when one changed (hashes). From CODE_CHANGES_PROTOCOL on, the files that
   * differ from the last commit of their repository (changes), a file as in that
   * commit (original), and files put back as they are in it (revert); newer runners
   * compare to where the branch left its default branch instead, and say so (base). Never
   * outside the working folder.
   */
  z.object({
    type: z.literal('thread.code'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateId: z.string(),
    op: z.enum(['list', 'find', 'grep', 'hashes', 'changes', 'original', 'revert']),
    path: z.string().max(1000).optional(),
    query: z.string().max(200).optional(),
    paths: z.array(z.string().max(1000)).max(CODE_CHANGES_MAX).optional(),
  }),
  /**
   * A person restarts or stops a thread's preview; touch: someone has it open,
   * which keeps it from expiring.
   */
  z.object({
    type: z.literal('preview.control'),
    sessionId: z.string(),
    action: z.union([PreviewAction, z.literal('touch')]),
    /** Why it stops, for a person (a pull request merged); else "Stopped by a person". */
    reason: z.string().max(200).optional(),
  }),
  /**
   * A person starts a thread's preview without a turn: again as it last
   * started, or from the saved setup of a repository one of these teammates
   * (first the one to try first) has checked out in it. Answered with
   * preview.start.result once it is starting; its events tell the rest.
   */
  z.object({
    type: z.literal('preview.start'),
    requestId: z.string(),
    sessionId: z.string(),
    teammateIds: z.array(z.string()).min(1).max(10),
    repository: z.string().max(200).optional(),
  }),
  /** A thread's preview output, for a person viewing it. */
  z.object({ type: z.literal('preview.logs'), requestId: z.string(), sessionId: z.string() }),
  /**
   * Write a new project's brief from its website's text: a short run on a
   * member's account with the harness's small model, and no tools at all.
   */
  z.object({
    type: z.literal('project.describe'),
    requestId: z.string(),
    account: AccountRef,
    url: z.string().max(2000),
    /** The site's pages as text, already cut to size by the API. */
    text: z.string().max(PROJECT_SITE_TEXT_MAX),
    /** The images the site offers as its logo, each said in words: where it is, its alt, its file. */
    logos: z.array(z.string().max(300)).max(PROJECT_LOGO_CANDIDATES_MAX).default([]),
  }),
  /** The API now serves another runner bundle (sent to every connected runner). */
  z.object({ type: z.literal('update.available'), bundle: z.string() }),
  z.object({
    type: z.literal('update.required'),
    minProtocolVersion: z.number().int(),
    bundle: z.string().optional(),
  }),
  /** Highest contiguous seq stored per thread. The runner drops buffered events up to it. */
  z.object({ type: z.literal('ack'), sessionId: z.string(), seq: z.number().int() }),
  ThreadPrompt,
  z.object({
    type: z.literal('thread.approval'),
    commandId: z.string(),
    thread: ThreadSpec,
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
    memberId: z.string(),
  }),
  /** A person's answer to the harness's question. */
  z.object({
    type: z.literal('thread.answer'),
    commandId: z.string(),
    thread: ThreadSpec,
    questionId: z.string(),
    answer: QuestionAnswer,
    memberId: z.string(),
  }),
  /** A person's answer to a ticket the teammate opened (open_ticket). */
  z.object({
    type: z.literal('thread.ticket'),
    commandId: z.string(),
    thread: ThreadSpec,
    requestId: z.string(),
    answer: TicketAnswer,
    memberId: z.string(),
  }),
  /** A person asks the teammate whose turn failed to try it again (RETRY_PROTOCOL). */
  z.object({
    type: z.literal('thread.retry'),
    commandId: z.string(),
    thread: ThreadSpec,
    /** The error the turn stopped on, as the thread shows it: the teammate is told it. */
    error: z.string().max(10_000).optional(),
    memberId: z.string(),
  }),
  z.object({
    type: z.literal('thread.interrupt'),
    commandId: z.string(),
    sessionId: z.string(),
    /** Stop only this turn (turn.started's turnId). Unset: whichever runs. */
    turnId: z.string().optional(),
  }),
  /**
   * A queued message: cancel it, change its text, or steer it into the
   * teammate's running turn (it stays queued if that cannot be done).
   */
  z.object({
    type: z.literal('thread.queued'),
    commandId: z.string(),
    sessionId: z.string(),
    messageId: z.string(),
    action: z.enum(['cancel', 'edit', 'steer']),
    /** The new text, for edit. */
    text: z.string().max(100_000).optional(),
    memberId: z.string(),
  }),
  /**
   * Open a window of the teammate's browser on the computer's desktop, e.g. for
   * a person to sign it in to a site. Cloud computers only.
   */
  z.object({
    type: z.literal('browser.open'),
    commandId: z.string(),
    teammateId: z.string(),
    teammateName: z.string(),
    url: z.url({ protocol: /^https?$/ }).optional(),
  }),
  /**
   * Bring the thread's own tab to the front of its teammate's browser, for
   * people watching the thread's desktop (FOCUS_PROTOCOL). Cloud computers only.
   */
  z.object({
    type: z.literal('browser.focus'),
    teammateId: z.string(),
    sessionId: z.string(),
  }),
  /**
   * The cloud computer's desktop clipboard, for a person in control copying
   * and pasting through the desktop view: set it to `text`, or read it.
   */
  z.object({
    type: z.literal('desktop.clipboard'),
    requestId: z.string(),
    text: z.string().max(CLIPBOARD_MAX).optional(),
  }),
  /** A person takes control of a thread: the teammate stops, now or after its current turn. */
  z.object({
    type: z.literal('thread.takeover'),
    commandId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    interrupt: z.boolean(),
  }),
  /** Control returns to the teammate, with the person's note and the files changed meanwhile. */
  z.object({
    type: z.literal('thread.handback'),
    commandId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    note: z.string(),
  }),
  /** A terminal in the thread's directory, as the teammate's user. Output streams back. */
  z.object({
    type: z.literal('terminal.open'),
    terminalId: z.string(),
    thread: ThreadSpec,
    memberId: z.string(),
    cols: z.number().int().min(20).max(400),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({
    type: z.literal('terminal.input'),
    terminalId: z.string(),
    data: z.string().max(65_536),
  }),
  z.object({ type: z.literal('terminal.close'), terminalId: z.string() }),
  /** The connector call (or credential request) waits for a person's approval (ticket). */
  z.object({
    type: z.literal('connector.pending'),
    callId: z.string(),
    ticketId: z.string(),
    target: z.string(),
    /** Why a person must decide, when it is not the usual approval, e.g. a reached cap. */
    reason: z.string().optional(),
    /** The person may also allow it for good: a credential's grant, without asking. */
    always: z.boolean().optional(),
  }),
  /** Answers a connector call or a credential request. A released credential's secret is in output. */
  z.object({
    type: z.literal('connector.result'),
    callId: z.string(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    /** Set when a person decided on the call. */
    decision: z
      .object({ ticketId: z.string(), approved: z.boolean(), memberId: z.string() })
      .optional(),
    /** Files the call brought into the thread (e.g. an email's attachment): put in the caller's folder first. */
    attachments: z.array(ThreadAttachmentRef).optional(),
  }),
  /** Run the vendor's own login command into this account's config directory. */
  z.object({ type: z.literal('account.login.start'), loginId: z.string(), account: AccountRef }),
  /** The one-time code from the vendor's page. Relayed, never stored or logged. */
  z.object({
    type: z.literal('account.login.code'),
    loginId: z.string(),
    code: z.string().max(4000),
  }),
  z.object({ type: z.literal('account.login.cancel'), loginId: z.string() }),
  /** Sign the account out and delete its config directory. */
  z.object({ type: z.literal('account.remove'), account: AccountRef }),
])
export type ApiToRunner = z.infer<typeof ApiToRunner>
