// The harness layer. This directory is the only place in Brigade that imports
// the experimental AI SDK harness packages (spec: "keep every import inside
// one module of the runner package").
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { HarnessAgent, type HarnessAgentSession } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createCodex } from '@ai-sdk/harness-codex'
import {
  ATTACHMENT_MAX,
  CODEX_DEFAULT_MODEL,
  LIBRARY_FILE_MAX,
  THEME_LIMITS,
  type AccountRef,
  type AgentEvent,
  type BackgroundWork,
  PROPOSE_TEAM_TOOL,
  type QuestionAnswer,
  ANSWER_MESSAGE_TOOL,
  hasVisibleText,
  SHOW_WIDGET_TOOL,
  type ThreadSpec,
  type TicketAnswer,
  type UsageRunKind,
  antigravityModelId,
  harnessName,
  loginOf,
  runModel,
  WIDGET_GUIDE_TOOL,
} from '@brigade/contracts'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ShotResult } from '../design-shot.js'
import { accountDir, accountEnv, accountToken } from '../accounts.js'
import { readCodexLimits } from '../codex-usage.js'
import {
  browserMcpServer,
  browserPort,
  ensureBrowser,
  isBrowserTool,
  threadTabsFile,
  touchBrowser,
} from '../browsers.js'
import { ensureAgentDesktop } from '../agent-desktop.js'
import { ComputerUseError, computerUseApp, computerUseClient } from '../computer-use.js'
import { CLOUD } from '../config.js'
import { teammateDesktopExec, teammateKeyboard } from '../desktop.js'
import { ThreadCredentials, type CredentialRequester } from '../credentials.js'
import {
  builtinSkills,
  instructions,
  startedByPerson,
  wakesInChild,
  writeInstructions,
  writeMemoryFiles,
} from '../instructions.js'
import {
  memoryKeys,
  threadMemory,
  threadTopicFiles,
  type MemorySnapshot,
} from '../memory-layers.js'
import { backup, checkout, gitEnv, type BundleStore, type CheckoutInput } from '../repos.js'
import { writeSkills } from '../skills.js'
import { copyIncluded } from '../repo-settings.js'
import {
  composeProject,
  containerEnv,
  ensureUser,
  linkAccount,
  teammateHome,
} from '../teammates.js'
import { answerLater, asideAfterRestart, asideResult } from './aside.js'
import {
  answerAfterRestart,
  answerInNewSession,
  approvalAfterRestart,
  approvalInNewSession,
  attachablePort,
  closeTurn,
  readableByOlderRunners,
  sameCall,
  waitingOn,
  withoutBridge,
  withTools,
  type WaitingApproval,
  type WaitingCall,
} from './closed-turn.js'
import { asksWithoutWaiting } from './codex-asks.js'
import { lostWhy } from './codex-restart.js'
import {
  changedTools,
  toolChangesNote,
  toolDigests,
  toolSpecs,
  toolsOfUnknownAge,
  type ToolSpec,
} from './tool-changes.js'
import { claudeSettingsEnv } from './claude-settings.js'
import { CODEX_SETTINGS } from './codex-settings.js'
import { harnessEnv } from './env.js'
import { useSharedBridge } from '../shared-bridges.js'
import { reportRunUsage } from '../usage.js'
import {
  answered,
  askUserQuestions,
  askUserResult,
  declaredDone,
  errorMessage,
  EventMapper,
  generatedImage,
  QUESTION_TOOL,
  ticketAsks,
  ticketResult,
} from './events.js'
import { createLocalSandboxSession, freePort, stopGroup } from './local-sandbox.js'
import { toNative, WINDOWS } from '../windows.js'
import { SIDE_REPLY_ENV } from './side-reply-env.js'
import { claimHandOver, type HandedOver } from '../hand-over.js'
import { asTeammate, bridgeBrowser, threadNet } from '../thread-net.js'
import { type PiPackage, loadPi } from '../pi-package.js'
import { createPiHarness, piModel, piSkills } from './pi.js'
import {
  antigravityEnv,
  createAntigravityHarness,
  holdAccount,
  isRemoved,
  refuseRemoved,
} from './antigravity.js'
import { ReplyWatch, terminalTools } from './replies.js'
import { declareDone, Outbox } from './outbox.js'
import { Arrivals } from './arrivals.js'
import { filesFieldsOf, withUploads } from './call-files.js'
import { stageStream, type StagedFile } from '../uploads.js'
import { readCommand, reportWithFiles } from './report-files.js'
import { backgroundTasks, backgroundWait, reportWaitsFor } from './background.js'
import {
  answerMessageTool,
  ASK_USER_TOOL,
  appTools,
  askUserTool,
  computerUseTools,
  CATALOG_TOOL,
  connectorTools,
  credentialTools,
  doneTools,
  goalTools,
  themeTools,
  missionTools,
  createMissionTools,
  imageTools,
  libraryTools,
  machineTools,
  OPEN_TICKET_TOOL,
  openTicketTool,
  previewTools,
  proposeTeamTool,
  repoTools,
  reviewTools,
  listTools,
  scheduleTools,
  wakeupTools,
  childTools,
  chiefTools,
  playbookTools,
  playbookInstallTools,
  showWidgetTool,
  startedThreadTools,
  type ComputerUse,
  type ConnectorCaller,
  type ImageMaker,
  type LibraryCaller,
  type MachineRunTools,
  type PreviewTools,
  type ScheduleCaller,
  widgetGuideTool,
} from './tools.js'
import { desktopTools, macAppInput, macDesktopExec, type Desktop } from './desktop-tools.js'
import { localDesktopExec, windowsComputer } from './windows-computer.js'

export type {
  ConnectorCaller,
  LibraryCaller,
  MachineRunTools,
  PreviewTools,
  ScheduleCaller,
} from './tools.js'

/** What a thread reaches beyond its own directory: the library, memory, git backups and file uploads. */
export type ThreadContext = {
  /** A teammate's own mirror of the library, filled before its first thread here. */
  libraryDir: (teammateId: string) => Promise<string>
  memoryFor: (teammateId: string) => MemorySnapshot
  callLibrary: LibraryCaller
  /** Create, list or change the teammate's schedules. */
  callSchedule: ScheduleCaller
  /** The thread's live preview: an app the teammate runs for people to try. */
  preview: PreviewTools
  /**
   * Commands the teammate runs on the thread's machine of its own (machine-runs.ts): on a cloud
   * computer; offered only in a thread that has one (spec.machine).
   */
  machine?: MachineRunTools
  bundles: BundleStore
  /** A skill's file, by its SHA-256, cached on this computer. */
  skillFile: (sha256: string) => Promise<Buffer>
  /** Send a file of the teammate's to the API, to go with a connector call. Returns its id. */
  uploadFile: (input: {
    sessionId: string
    teammateId: string
    name: string
    bytes: Buffer
  }) => Promise<string>
  /** What was said in a thread before it moved to this computer, as the teammate's conversation. */
  conversation: (sessionId: string, teammateId: string) => Promise<Transcript>
  /** A theme's file, staged on this computer, to the bucket (docs/themes.md). Returns the upload's id. */
  uploadThemeFile?: (input: {
    sessionId: string
    teammateId: string
    name: string
    file: StagedFile
  }) => Promise<string>
}
export type { CredentialRequester } from '../credentials.js'

export { stripApiKeys, usePersonPath } from './env.js'

const execFileAsync = promisify(execFile)

export type ThreadInput =
  /** `retry`: a turn that failed, tried again (threads.ts): told again the message it answered. */
  | { kind: 'prompt'; text: string; retry?: boolean }
  /** The computer stopped during a turn: continue it. `text`: what was said since, if anything. */
  | { kind: 'resume'; text: string }
  | { kind: 'approval'; approvalId: string; approved: boolean; reason?: string }
  | { kind: 'answer'; questionId: string; answer: QuestionAnswer }
  | { kind: 'ticket'; requestId: string; answer: TicketAnswer }

/** A person's answer to a question or a ticket. */
type AnswerInput = Extract<ThreadInput, { kind: 'answer' | 'ticket' }>
const answerId = (input: AnswerInput) =>
  input.kind === 'answer' ? input.questionId : input.requestId

/** A tool call as the thread keeps it: what was called, with what. */
type Call = { toolName: string; input: unknown }

/** How a turn ended: idle (done), waiting (for an approval), paused (no account has usage left), or failed. */
export type TurnOutcome = { status: 'idle' | 'waiting' | 'paused' | 'failed'; error?: string }

export type Transcript = { role: 'user' | 'assistant'; text: string }[]

/** What the runner keeps per thread between processes. Never a credential. */
type SavedState = {
  accountId: string
  resume?: unknown
  /** Recent conversation, for the handoff when the thread moves to another account. */
  transcript: Transcript
  /**
   * The definitions of Brigade's tools the conversation was given, by name (toolDigests): it
   * keeps them when it resumes, so a definition changed since is told in the next message.
   */
  tools?: Record<string, string>
  /** The thread's latest arrival on this computer (ThreadSpec.moved) taken in. */
  movedAt?: string
  /** It arrived from this computer, and no turn has run here since: the next starts from the transcript. */
  arrivedFrom?: string
  /** A turn was running when this was written: found on start, the process stopped without parking. */
  inTurn?: boolean
  /**
   * The latest message a turn started from, but for a failed turn's retries: told again when
   * the turn that answered it comes back in a conversation that may not have it (a retry after
   * its process died, a restart).
   */
  asked?: string
  /** Turns continued after a restart since one last finished, to stop when restarts keep cutting it off. */
  recoveries?: number
  /**
   * The person's message given to the running turn last (steer), by its messageId: what an
   * answer_message call answers, after a restart or a hand-over too. Cleared when a turn starts.
   */
  steered?: string
  /**
   * The calls the last turn stopped on, waiting for a person (a ticket, a question): their
   * answer still reads right if the process stops without parking, which keeps no turn.
   */
  waiting?: WaitingCall[]
  /** The built-in tool calls the last turn stopped on, waiting to be approved, for the same reason. */
  approvals?: WaitingApproval[]
  /**
   * Tickets and questions set aside for a message the person wrote instead of answering them
   * (aside.ts): still open, their answer comes as a message of its own (laterAnswer). With
   * `answer`: answered while messages waited on a decision, it goes in once made (keepsAnswer).
   */
  later?: (WaitingCall & { answer?: AnswerInput })[]
  /**
   * An update handed the running turn over (handOver): it goes on in the harness it ran in,
   * these process groups, which the next session attaches to. With the calls it had under way.
   */
  handedOver?: {
    groups: number[]
    calls: WaitingCall[]
    /** The text and thinking blocks it was writing, so far, by id. */
    texts?: [string, string][]
    reasoning?: [string, string][]
    /**
     * Since when the turn only waited on work in the background, what ran there, since when none
     * did, and whether a message steered into it was still unanswered (staleWait).
     */
    waitingSince?: number
    background?: BackgroundWork[]
    quietSince?: number
    steered?: boolean
  }
}

const TRANSCRIPT_CHARS = 40_000
/** A turn cut off by this many restarts in a row is not continued again: it may be what stops the computer. */
const MAX_RECOVERIES = 3
/** The tools whose turn waits on a person's answer. */
const PERSON_TOOLS = new Set([OPEN_TICKET_TOOL, QUESTION_TOOL, ASK_USER_TOOL])
/** What a teammate is told when the computer stopped without warning during its turn. */
const RESTARTED =
  "Brigade's computer restarted while you were working on this thread, so your last turn stopped partway. " +
  'Before you redo anything, check what is already done (files, commands you ran, messages you sent), then carry on where you left off.'

/** Before the message a cut-off turn answered, told again after a restart. */
const ASKED =
  'In case your conversation came back without it, this is the latest message you were answering:'
/** Before the latest request in a handoff whose conversation so far no longer holds it (handoff). */
const LATEST_REQUEST = 'The latest request, too long to stay in the conversation above:'

/** What Codex may read of a thread's AGENTS.md (its own default is 32 KiB). */
const INSTRUCTIONS_MAX_BYTES = 256 * 1024

/**
 * Brigade's own tools Claude Code always has loaded (the rest it finds through tool search): small,
 * and used in most turns. A name the thread has no tool of is ignored.
 */
const ALWAYS_LOADED = [
  ANSWER_MESSAGE_TOOL,
  OPEN_TICKET_TOOL,
  SHOW_WIDGET_TOOL,
  WIDGET_GUIDE_TOOL,
  'report',
  'search_workspace',
]

/**
 * In a thread with a machine of its own, run_on_machine is always in view, its description with
 * it: found only through tool search, a skill's steps run on the shared computer won (a video
 * render, Nov 6, the tool never searched for).
 */
export const machineToolsInView = (spec: Pick<ThreadSpec, 'machine'>, machine: unknown) =>
  spec.machine && machine ? ['run_on_machine'] : []

/**
 * The teammate's model for the harness; none leaves Claude Code on the account's own. Antigravity
 * takes the thread's effort on the model's id (antigravityModelId).
 */
function withModel(
  teammate: Pick<ThreadSpec['teammate'], 'harness' | 'model'>,
  account?: AccountRef,
  effort: ThreadSpec['effort'] = null,
) {
  if (teammate.harness === 'antigravity')
    return { model: antigravityModelId(teammate.model, effort ?? null) }
  const model = runModel(teammate.harness, teammate.model)
  if (!model) return {}
  // Pi resolves it under the login's own provider (pi.ts), never another one with that model.
  return { model: teammate.harness === 'pi' && account ? piModel(account, model) : model }
}

/**
 * The login's own CLI and the teammate's model, for a run beside its turns (memory, a title, a
 * side reply): Claude Code or Codex. A Pi teammate's runs go to the CLI of the login it runs on.
 */
const cliOf = (
  teammate: Pick<ThreadSpec['teammate'], 'harness' | 'model'>,
): Pick<ThreadSpec['teammate'], 'harness' | 'model'> => ({
  harness: loginOf(teammate.harness, teammate.model),
  model: teammate.model,
})

/**
 * An MCP server on stdio for Pi, whose client starts it from the runner's own process: on a cloud
 * computer, as the teammate's user in the thread's network, where Claude Code and Codex start it
 * themselves (the browser relay reaches only its teammate's browser).
 */
async function piMcpServer(
  server: { command: string; args: string[] },
  runAs: string | undefined,
  sessionId: string,
) {
  if (!runAs) return { type: 'stdio', command: server.command, args: server.args }
  const { file, args } = asTeammate(runAs, await threadNet(sessionId))
  // Pi's client gives it the runner's whole environment, which sudo -E would pass on to the
  // teammate: it starts with none but where to find programs.
  return {
    type: 'stdio',
    command: 'env',
    args: ['-i', `PATH=${process.env.PATH ?? ''}`, file, ...args, server.command, ...server.args],
  }
}

/** What a Pi turn is given beside the spec: its instructions and skills (attach). */
type PiSetup = {
  /** Brigade's instructions, which Pi reads from no file (AGENTS.md, CLAUDE.md). */
  instructions: string
  skills: ReturnType<typeof piSkills>
  /** Pi's package, installed by the runner on first use (pi-package.ts). */
  pi: PiPackage
}

function createAgent(
  spec: ThreadSpec,
  callConnector: ConnectorCaller,
  credentials: ThreadCredentials,
  mcpServers: Record<string, unknown>,
  library: Parameters<typeof libraryTools>[0],
  checkoutRepo: (input: CheckoutInput) => Promise<unknown>,
  callSchedule: ScheduleCaller,
  preview: PreviewTools,
  makeImage: ImageMaker | undefined,
  computer: ComputerUse | undefined,
  desktop: Desktop | undefined,
  machine: MachineRunTools | undefined,
  arrivals: Arrivals,
  /** Keeps a ticket or question Codex opened without waiting (codex-asks.ts). */
  openAsk: (call: WaitingCall) => Promise<void>,
  pi?: PiSetup,
  /** The App kinds closed to the starter, from the thread's latest spec (spec.closedApps). */
  closedApps: () => readonly string[] = () => spec.closedApps,
) {
  // auth {}: the adapter adds no credential of its own. The vendor CLI uses the
  // account's token from the environment if it has one, else the login in its
  // config directory.
  const settings = { auth: {}, mcpServers }
  // Connector tools grow with each account connected; Codex loads them on demand.
  const apps = connectorTools(spec.connectors, callConnector, {
    defer: spec.teammate.harness === 'codex',
  })
  const codex = spec.teammate.harness === 'codex'
  const onPi = spec.teammate.harness === 'pi'
  const onAntigravity = spec.teammate.harness === 'antigravity'
  const chief = spec.teammate.kind === 'chief'
  // The thread's effort; none leaves each CLI on its own default.
  const effort = spec.effort ?? undefined
  if (onPi && !pi) throw new Error('A turn on Pi needs its setup (instructions, skills, package)')
  const harness =
    onPi && pi
      ? createPiHarness({
          pi: pi.pi,
          account: spec.account,
          effort,
          mcpServers,
          skills: pi.skills,
        })
      : onAntigravity
        ? createAntigravityHarness({ mcpServers })
        : codex
          ? createCodex({
              ...settings,
              // Codex reads 32 KiB of AGENTS.md by default; Brigade's, with memory last, is longer.
              codexConfig: { ...CODEX_SETTINGS, project_doc_max_bytes: INSTRUCTIONS_MAX_BYTES },
              ...(effort ? { reasoningEffort: effort } : {}),
            })
          : createClaudeCode({
              ...settings,
              ...(effort ? { effort } : {}),
              // Never deferred behind tool search: the tools that end most turns (a ticket, a card, the
              // thread done, a child's report) come right before the answer, with no tool load between.
              // Each load is a model round trip of its own (about 2 s; 538 in 928 turns before these).
              toolHints: Object.fromEntries(
                [
                  ...ALWAYS_LOADED,
                  ...machineToolsInView(spec, machine),
                  ...(chief ? [PROPOSE_TEAM_TOOL] : []),
                  // A pass's ways out, loaded with no tool search before them.
                  ...(spec.pass && chief
                    ? spec.pass.acts === true
                      ? ['chief_answer', 'chief_retry', 'chief_report']
                      : ['chief_report']
                    : []),
                  // A big App's catalog (catalogTools): a few small tools, found then called, without a
                  // tool search before them.
                  ...Object.entries(apps)
                    .filter(([, t]) => (t as unknown as Record<symbol, unknown>)[CATALOG_TOOL])
                    .map(([name]) => name),
                ].map((name) => [name, { alwaysLoad: true }]),
              ),
            })
  // Chief's daily pass for a person (docs/chief-answers.md): it reads its brief's items and reports
  // on them (or, with chief_acts, acts on them), and nothing else; the API gives it no App.
  const passing = !!spec.pass && chief
  const tools = passing
    ? {
        search_workspace: libraryTools({ ...library, access: 'read', folders: [] })
          .search_workspace!,
        list_items: listTools(callSchedule).list_items!,
        ...chiefTools(callSchedule, { pass: true, acts: spec.pass?.acts === true }),
      }
    : {
        ...apps,
        ...credentialTools(credentials),
        ...libraryTools(library),
        ...(spec.git ? repoTools(checkoutRepo) : {}),
        // Threads it starts at the top, and writes in later; a playbook's run starts none outside it
        // and writes only in its children (the API refuses them too).
        ...startedThreadTools(callSchedule, { playbook: !!spec.playbook }),
        // Schedules, triggers and wake-ups: only in a thread a person started (the API refuses them
        // elsewhere), never in a playbook's run, whose schedules' runs would be threads outside it.
        // A child thread a teammate started has wake-ups alone, and reports from the turn one brings.
        ...(startedByPerson(spec)
          ? scheduleTools(callSchedule)
          : wakesInChild(spec)
            ? wakeupTools(callSchedule)
            : {}),
        // Nor the workspace's other Apps: it has only those the playbook declares.
        ...appTools(callSchedule, { playbook: !!spec.playbook }),
        // Lists' items (docs/lists.md): read, attach to this thread, tick, add.
        ...listTools(callSchedule),
        // A playbook's run may wait on another run's child (follow_thread); a dry run waits for nothing.
        ...childTools(callSchedule, {
          child: !!spec.parent,
          follow: !!spec.playbook && !spec.playbook.dryRun,
        }),
        // Reviews of its pull requests, a child thread's too, which reports once its review is done; a
        // playbook decides.
        ...(spec.git && !spec.playbook ? reviewTools(callSchedule) : {}),
        // A playbook run's root thread ends the run; its children report to it instead.
        ...(spec.playbook && !spec.parent ? playbookTools(callSchedule) : {}),
        // Elsewhere, a teammate may install one from the chat.
        ...(!spec.playbook && !spec.parent ? playbookInstallTools(callSchedule) : {}),
        // Goals (docs/goals.md): proposed in a thread a person started, at the top; a sub-thread reads
        // where its parent's stands.
        ...(startedByPerson(spec)
          ? goalTools(callSchedule, { top: true })
          : spec.parent && !spec.playbook
            ? goalTools(callSchedule, { top: false })
            : {}),
        // Themes (docs/themes.md): the starter's own look, in a thread they started.
        ...(spec.themes && startedByPerson(spec) ? themeTools(callSchedule) : {}),
        // Missions (docs/missions.md): in a thread of one, its plan and what went out.
        ...(spec.mission
          ? missionTools(callSchedule, spec.mission)
          : spec.missions && startedByPerson(spec)
            ? createMissionTools(callSchedule)
            : {}),
        // Declaring the thread done, in a thread a person talks to: a child reports, a playbook decides.
        // A schedule's run ends with its turn.
        ...doneTools(callSchedule, {
          child: !!spec.parent,
          playbook: !!spec.playbook,
          scheduled: spec.origin === 'schedule',
        }),
        ...previewTools(preview, credentials),
        // Heavy commands on the thread's machine of its own, where its starter chose one.
        // A message or an update ends their waits; the command goes on there (arrivals.ts).
        ...(spec.machine && machine
          ? machineTools(machine, credentials, arrivals, {
              // As save_to_library: a teammate that may save somewhere in the library.
              library:
                library.access === 'read_write' ||
                !!library.folders?.some((folder) => folder.access === 'read_write'),
            })
          : {}),
        ...(makeImage ? imageTools(makeImage) : {}),
        ...(computer
          ? computerUseTools(
              computer,
              desktop && desktop.where !== 'cloud' ? macAppInput(desktop) : undefined,
              desktop?.where === 'windows'
                ? 'windows'
                : process.platform === 'linux'
                  ? 'linux'
                  : 'mac',
            )
          : {}),
        // Apps read and used by accessibility refs: on a Mac beside the tools above, on a cloud
        // computer in the teammate's own browser window.
        ...(desktop ? desktopTools(desktop) : {}),
        // Claude Code asks with its own question tool; Codex's, Pi's and Antigravity's adapters have none.
        ...(codex || onPi || onAntigravity ? { [ASK_USER_TOOL]: askUserTool } : {}),
        [OPEN_TICKET_TOOL]: openTicketTool,
        // Codex ends its turn whatever a call waits on: its asks open, return at once and are
        // answered by a message (codex-asks.ts). So do Antigravity's: a turn of its frozen on a
        // person cannot go on under a new bridge (the ACP adapter replays it only through the
        // bridge it ran under), so it never waits on one.
        ...(codex || onAntigravity ? asksWithoutWaiting(openAsk, closedApps) : {}),
        [SHOW_WIDGET_TOOL]: showWidgetTool,
        [WIDGET_GUIDE_TOOL]: widgetGuideTool,
        // A person's message given to the running turn, answered at once (steeredText in threads.ts).
        [ANSWER_MESSAGE_TOOL]: answerMessageTool,
        // Replies and choices are blocks in the reply (replyCard); the team, with its long instructions, a tool.
        ...(chief ? { [PROPOSE_TEAM_TOOL]: proposeTeamTool } : {}),
        // Chief writes people's rules with them.
        ...(chief ? chiefTools(callSchedule, { pass: false }) : {}),
      }
  return {
    agent: new HarnessAgent({
      harness,
      tools,
      // The API is the enforcement point for connector calls and credentials; the harness does not ask again.
      toolApproval: Object.fromEntries(
        Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
      ),
      ...withModel(spec.teammate, spec.account, spec.effort),
      ...(onPi
        ? {
            instructions: [pi?.instructions, spec.teammate.instructions]
              .filter(Boolean)
              .join('\n\n'),
          }
        : spec.teammate.instructions
          ? { instructions: spec.teammate.instructions }
          : {}),
      // Codex cannot ask before built-in tool calls (spec, known limits). Antigravity can, but a
      // turn waiting on an approval cannot be continued once parked (asksWithoutWaiting above).
      permissionMode: codex || onAntigravity ? 'allow-all' : spec.permissionMode,
      sandboxConfig: { workDir: '.' },
    }),
    /** Brigade's tools, by name. */
    tools: Object.keys(tools),
    /** Their definitions, as the harness gives them (tool-changes.ts). */
    specs: toolSpecs(tools),
    /** The Apps' among them: the API's, not the runner's. */
    apps: new Set(Object.keys(apps).filter((name) => name in tools)),
  }
}

type Live = {
  agent: ReturnType<typeof createAgent>['agent']
  session: HarnessAgentSession
  sandbox: ReturnType<typeof createLocalSandboxSession>
  account: AccountRef
  credentials: ThreadCredentials
  /** The harness it runs on (TeammateHarness): a teammate moved to another starts anew. */
  harness?: string
  /** The connector tools, effort and suggestions the agent was made with (agentKey). */
  made: string
  /**
   * Its tools' definitions (toolDigests), and those changed since the conversation was given
   * them, which the next message tells it (withToolChanges): emptied once told.
   */
  tools: {
    digests: Record<string, string>
    changed: ToolSpec[]
    /** Which changed is not known: the conversation was saved before its tools were kept. */
    unsure?: boolean
  }
}

/** A saved harness state's harness, as TeammateHarness names it; undefined when it says none. */
export function resumeHarness(resume: unknown): string | undefined {
  const state = resume as
    { harnessId?: unknown; continueFrom?: { harnessId?: unknown } } | undefined
  const id = state?.continueFrom?.harnessId ?? state?.harnessId
  return id === 'claude-code' ? 'claude_code' : typeof id === 'string' ? id : undefined
}

/**
 * The teammate was moved to another harness (Pi to Claude Code, say) since its conversation was
 * saved: that conversation is the other harness's, which this one cannot resume.
 */
export const harnessChanged = (saved: SavedState | undefined, spec: ThreadSpec) => {
  // Read from the saved conversation itself: none, nothing to resume.
  const was = resumeHarness(saved?.resume)
  return was !== undefined && was !== spec.teammate.harness.replace('-', '_')
}

/**
 * The saved conversation a new session resumes: the one kept on its account, and of its own
 * harness only, since another's it cannot resume (newHarness).
 */
export const savedResume = (
  saved: SavedState | undefined,
  spec: ThreadSpec,
  account: Pick<AccountRef, 'id'>,
) => (saved?.accountId === account.id && !harnessChanged(saved, spec) ? saved.resume : undefined)

/** Codex's, Pi's and Antigravity's harness in an agent's key; Claude Code's left out, as before Pi. */
const harnessKey = (spec: ThreadSpec): string[] => {
  const harness: string | undefined = spec.teammate?.harness
  return harness === 'codex' || harness === 'pi' || harness === 'antigravity' ? [harness] : []
}

/**
 * Which connector tools, effort and suggestions a spec gives: an agent made with others is out
 * of date (suggestions are its harness's environment, BRIGADE_PROMPT_SUGGESTIONS). An account
 * the teammate cannot use (ConnectorGrant.unavailable) too, and why: its instructions say so, and
 * are written only as a session starts. Left out of a usable account's key, as before it.
 */
export const agentKey = (spec: ThreadSpec) =>
  JSON.stringify([
    spec.effort ?? null,
    spec.connectors.map((c) => [
      c.connectionId,
      c.scope,
      c.operations.map((o) => o.name),
      ...(c.unavailable ? [c.unavailable] : []),
    ]),
    spec.suggestions,
    // The machine's tools come and go with the starter's choice; left out when off, as before it.
    ...(spec.machine ? ['machine'] : []),
    // Its harness: a teammate moved to another one gets a new agent. Left out for Claude Code.
    ...harnessKey(spec),
  ])

type TurnStream = Awaited<ReturnType<Live['agent']['stream']>>['fullStream']

/**
 * A message to the session, after what changed in its tools since its conversation was given
 * them (tool-changes.ts), told once: the turn that ran with it keeps them as given (run).
 */
function withToolChanges(live: Live, prompt: string) {
  const note = toolChangesNote(live.tools.changed, { unsure: !!live.tools.unsure })
  if (!note) return prompt
  live.tools.changed = []
  return `${note}\n\n${prompt}`
}

/**
 * A session stopped mid-turn saves that turn as `continueFrom`, with what it
 * waits on. Waiting on nothing: it was running when the computer stopped.
 */
function frozenMidRun(resume: unknown) {
  const from = (resume as { continueFrom?: Record<string, unknown> } | undefined)?.continueFrom
  if (!from) return false
  // A result its host gave while the turn froze (a Brigade tool's) goes to the harness on continue.
  const waits = (key: string) =>
    Array.isArray(from[key]) &&
    from[key].some((p) => !(p as { completedResult?: unknown }).completedResult)
  return !waits('pendingToolApprovals') && !waits('pendingToolResults')
}

/**
 * How long the thread's events wait behind Codex's ask being kept (codex-asks.ts): past that,
 * they go on, and the ask shows once it is kept.
 */
const askKeptMs = () => Number(process.env.BRIGADE_ASK_KEPT_MS) || 10_000

/** How long a harness may take to let go of its turn when the runner hands it over. */
const HAND_OVER_MS = 20_000

/** After the teammate acts on the member's Mac, how long until a glance at its screen: the app has redrawn. */
const GLANCE_MS = 600
/** Glances of the member's Mac for the thread's panel, in the working folder; the latest few are kept. */
const GLANCES = '.brigade-screen'
const GLANCES_KEPT = 10

/**
 * How long an answered turn may wait on work in the background, by the bridge's word, with none
 * running as the runner sees it, before the runner ends it (staleWait): counted from the later
 * of the bridge's word and the end of the last work. The bridge waits 60 s at most for a report
 * of work that ended; past this, nothing is coming.
 */
const STALE_WAIT_MS = Number(process.env.BRIGADE_STALE_WAIT_MS) || 5 * 60_000
/** How soon a turn past that wait that could not end then is looked at again. */
const STALE_RETRY_MS = Math.min(STALE_WAIT_MS, 10_000)

/** Whether something answers on the port a handed-over bridge listened on. */
function answers(host: string, port: number) {
  return new Promise<boolean>((done) => {
    const socket = connect({ host, port, timeout: 1000 })
    const end = (ok: boolean) => {
      socket.destroy()
      done(ok)
    }
    socket.once('connect', () => end(true))
    socket.once('error', () => end(false))
    socket.once('timeout', () => end(false))
  })
}

/**
 * After a stop without warning: the harness state that resumes the thread's
 * conversation, without any turn it was in. Claude Code continues the newest
 * conversation in the working directory (the thread's own, the turn that was
 * cut off included; a new one when there is none). Codex needs its thread id.
 */
function resumable(harness: ThreadSpec['teammate']['harness'], resume: unknown): unknown {
  const base = { type: 'resume-session', specificationVersion: 'harness-v1' }
  // Pi keeps its conversation in the state itself (no file of its own): the last one saved, without
  // the tool calls a cut-off turn waited on.
  if (harness === 'pi') {
    const state = resume as
      | { data?: Record<string, unknown>; continueFrom?: { data?: Record<string, unknown> } }
      | undefined
    const data = state?.continueFrom?.data ?? state?.data
    if (!data || !(data.entries || data.leafId)) return undefined
    const { pendingToolBatch: _pending, ...rest } = data
    return { ...base, harnessId: 'pi', data: rest }
  }
  // Antigravity reloads its conversation by the ACP session's id (session/load), without the bridge
  // that ran it.
  if (harness === 'antigravity') {
    const state = resume as
      | { data?: Record<string, unknown>; continueFrom?: { data?: Record<string, unknown> } }
      | undefined
    const data = state?.continueFrom?.data ?? state?.data
    if (typeof data?.acpSessionId !== 'string' || !data.acpSessionId) return undefined
    const { bridge: _bridge, ...rest } = data
    return { ...base, harnessId: 'antigravity', data: rest }
  }
  if (harness !== 'codex') return { ...base, harnessId: 'claude-code', data: {} }
  const state = resume as
    { data?: { threadId?: unknown }; continueFrom?: { data?: { threadId?: unknown } } } | undefined
  const threadId = state?.continueFrom?.data?.threadId ?? state?.data?.threadId
  return typeof threadId === 'string' && threadId
    ? { ...base, harnessId: 'codex', data: { threadId } }
    : undefined
}

/** One thread: one harness session in its own working directory. */
export class HarnessThread {
  private live: Live | undefined
  /** The memory lines the session loaded when it started (memoryKeys). */
  private loaded: Set<string> = new Set()
  /** Tool calls not yet finished, kept across turns (see EventMapper). */
  private readonly toolCalls = new Map<string, { toolName: string; input: unknown }>()
  /** Text and thinking blocks under way, by id (see EventMapper), handed over with the turn. */
  private readonly texts = new Map<string, string>()
  private readonly reasoning = new Map<string, string>()
  /** Built-in tool calls waiting for a person's approval, by approval id. */
  private readonly approvals = new Map<string, { toolName: string; input: unknown }>()
  /** Kept answers handed out to go in (answersToGive), by call id, until their turn takes them. */
  private readonly given = new Set<string>()
  /** The teammate's browser is being started for this thread (browserUsed). */
  private browserStarting = false
  private saved: SavedState | undefined
  /** The live session resumed a turn frozen mid-run (see frozenMidRun). */
  private frozen = false
  /** An update stopped the running turn's harness, which could not hand it over (handOver). */
  private handOverFailed = false
  /** The running turn is being handed over: what its harness still sends goes out (handOver). */
  private handingOver = false
  /** What the person has read of the turn: a turn without a reply is asked for one. */
  private readonly replies = new ReplyWatch()
  /** What the running turn runs in the background now (background.ts): a report waits on its agents. */
  private background: BackgroundWork[] = []
  /** Since when the running turn only waits on work in the background, by the bridge's word. */
  private waitingSince: number | undefined
  /** Since when nothing has run in the background, once something did in the running turn. */
  private quietSince: number | undefined
  /** A person's message steered into the running turn has no reply yet: its answer is coming. */
  private steeredPending = false
  /** What ends its tools' waits: a message given to the turn, a hand-over (arrivals.ts). */
  readonly arrivals = new Arrivals()
  /**
   * The running turn is answered, and completed for everyone: Claude Code only writes its guess
   * at the person's next message before its process ends (the bridge's drain). `done` settles
   * once the turn's stream has ended; aborting `stop` ends it now.
   */
  private drain: { stop: AbortController; done: Promise<void> } | undefined
  private readonly stateFile: string
  /**
   * Names this harness session and its saved state. The thread's id for its
   * starting teammate (as before threads had several); thread and teammate for the others.
   */
  private readonly key: string
  /** Prompts so far: each is its own computer-use session, which the person can stop. */
  private prompts = 0
  /** The computer-use session stopped from the thread's panel. */
  private computerStopped: string | undefined
  /** The next glance at the member's Mac, after the teammate's latest action there. */
  private glanceTimer: NodeJS.Timeout | undefined
  private glancing = false
  /** The display the teammate last looked at: glances show it too. */
  private display = 0
  /** The tool calls of the run under way, and those that failed (turn.completed). */
  private toolStats = { calls: 0, errors: 0 }
  /** Writes of the state file, in order. */
  private saving: Promise<void> = Promise.resolve()
  /**
   * The turn's events on their way out: after a done block's call, what follows waits for
   * Brigade's answer (outbox.ts).
   */
  private readonly outbox: Outbox

  constructor(
    private spec: ThreadSpec,
    private readonly workDir: string,
    stateDir: string,
    private readonly emitEvent: (event: AgentEvent) => void,
    /** Forwards connector tool calls to the API. */
    private readonly callConnector: ConnectorCaller,
    /** Asks the API for the vault's credentials. */
    private readonly requestCredential: CredentialRequester,
    private readonly context: ThreadContext,
    /** On a cloud computer: the teammate's Linux user, which runs the harness. */
    private readonly runAs?: string,
  ) {
    this.key = spec.starter ? spec.sessionId : `${spec.sessionId}-${spec.teammate.id}`
    this.stateFile = join(stateDir, `${this.key}.json`)
    this.outbox = new Outbox((event) => this.out(event))
  }

  async run(input: ThreadInput, spec: ThreadSpec, signal: AbortSignal): Promise<TurnOutcome> {
    this.spec = spec
    this.toolStats = { calls: 0, errors: 0 }
    await this.load()
    // An answer that comes as a message while messages wait on a decision: kept until it is
    // made (Threads asks first, before the turn starts).
    if (await this.keepsAnswer(input)) return { status: 'waiting' }
    // An answer to an ask set aside for a message: no turn waits on it, so it comes as a message.
    const later = this.laterAnswer(input)
    if (later !== undefined) input = { kind: 'prompt', text: later }
    // A failed turn tried again: its process died with it, maybe before the harness kept the
    // conversation (the first turn of a thread, killed by the memory guard), so the next session
    // may start without the message it answered. It is told it again.
    const retry = input.kind === 'prompt' && !!input.retry
    if (retry && input.kind === 'prompt' && this.saved?.asked)
      input = { kind: 'prompt', text: `${ASKED}\n\n${this.saved.asked}\n\n${input.text}` }
    // An approval, an answer or a ticket goes on with the turn it paused.
    if (input.kind === 'prompt') this.replies.start()
    else if (input.kind === 'resume') this.replies.resume()
    if (spec.moved && this.saved?.movedAt !== spec.moved.at) await this.arrive(spec.moved)
    let handoff: string | undefined
    // The first turn here since the thread moved: a new session, told the thread so far.
    const from = this.saved?.arrivedFrom
    if (from !== undefined && (input.kind === 'prompt' || input.kind === 'resume')) {
      handoff = [
        this.handoff(
          `This conversation continues in a new session because the thread moved to this computer from ${from}; the previous session stayed there.`,
          null,
        ),
        input.text,
      ]
        .filter(Boolean)
        .join('\n\n')
      input = { kind: 'prompt', text: input.text }
    } else if (input.kind === 'resume') {
      const resumed = await this.recover(input.text, spec)
      if (!resumed) return { status: 'idle' }
      ;({ input, handoff } = resumed)
    }
    // Moved to another harness: a new session there, told the conversation so far.
    else if (
      input.kind === 'prompt' &&
      (this.live?.harness !== undefined
        ? this.live.harness !== spec.teammate.harness
        : harnessChanged(this.saved, spec))
    ) {
      // The new session is told the message too: its conversation so far has it not yet.
      handoff = [await this.newHarness(spec), input.text].filter(Boolean).join('\n\n')
    }
    // A new prompt runs on the account the API chose; an approval stays on the live session.
    else if (input.kind === 'prompt' && this.saved && this.saved.accountId !== spec.account.id) {
      handoff = await this.switchTo(spec.account, 'unavailable', null)
    }
    if (input.kind === 'prompt') {
      this.remember('user', input.text)
      this.prompts++
      // Blocks a turn cut off left unfinished end with it.
      this.texts.clear()
      this.reasoning.clear()
      // A new turn reads what it is given now.
      this.arrivals.started()
    }
    this.saved ??= { accountId: spec.account.id, transcript: [] }
    // Kept whole, as the transcript keeps its latest message: a request often comes after its context.
    if (input.kind === 'prompt' && !retry) this.saved.asked = input.text
    // A new turn answers no message given to the one before.
    if (input.kind === 'prompt') this.saved.steered = undefined
    // Someone asked for this turn: restarts that cut off earlier ones no longer count.
    if (input.kind !== 'resume') this.saved.recoveries = 0
    // Found on disk after a stop without warning, this says the turn did not finish.
    this.saved.inTurn = true
    await this.persist()

    const fallbacks = [...spec.fallbacks]
    let result: TurnOutcome | undefined
    // The harness no longer had the conversation it was to resume: the turn went on in a new one.
    let anew = false
    // What the person approved in the lost conversation, for the new session's turn.
    let approved: Call | undefined
    try {
      for (;;) {
        const outcome = await this.turn(
          handoff ? { kind: 'prompt', text: handoff } : input,
          signal,
          approved,
        )
        approved = undefined
        if (outcome.kind === 'lost') {
          // A new session resumes nothing: lost again, it is something else, and the turn fails.
          if (anew) {
            this.emit({ type: 'error', message: outcome.error })
            return (result = { status: 'failed', error: outcome.error })
          }
          anew = true
          // The person's message is in the conversation the new session is told; anything else
          // the turn said (a restart, an answer and the call it is for) comes after it.
          const said = outcome.said ?? (input.kind === 'resume' ? input.text : undefined)
          handoff = await this.startAnew(
            input.kind === 'prompt' && said === input.text ? undefined : said,
            outcome.why,
          )
          input = { kind: 'prompt', text: handoff }
          approved = outcome.approved
          continue
        }
        if (outcome.kind !== 'exhausted') return (result = outcome.result)
        // Out of usage: continue on the member's next account, or pause.
        const next = fallbacks.shift()
        const from = this.current.id
        if (!next) {
          this.emit({
            type: 'account.switched',
            fromAccountId: from,
            toAccountId: null,
            reason: 'usage_limit',
            resetsAt: outcome.resetsAt,
          })
          await this.park()
          return (result = { status: 'paused' })
        }
        handoff = await this.switchTo(next, 'usage_limit', outcome.resetsAt)
        input = { kind: 'prompt', text: handoff }
      }
    } finally {
      // Its events out first, its end with them (a done block's answer holds it): the thread
      // hears the turn ended before its next turn can start.
      await this.outbox.flushed()
      if (this.saved) {
        // The new session has the transcript now: later turns resume it. One that failed or
        // never started (no usage) may have kept nothing: the next starts from it again.
        if (result?.status === 'idle' || result?.status === 'waiting') delete this.saved.arrivedFrom
        // Stopped by an update that could not hand it over: found so, it is continued (recover).
        this.saved.inTurn = this.handOverFailed
        if (result?.status === 'waiting') {
          this.saved.waiting = waitingOn(this.toolCalls, PERSON_TOOLS)
          this.saved.approvals = [...this.approvals].map(([approvalId, call]) => ({
            approvalId,
            ...call,
          }))
        } else if (result?.status === 'idle') {
          delete this.saved.waiting
          delete this.saved.approvals
          this.approvals.clear()
        }
        if (result?.status === 'idle') this.saved.recoveries = 0
        // The turn ran: its conversation has its tools as they are now, any change told
        // (withToolChanges). One that failed tells them again in the next session.
        if (
          (result?.status === 'idle' || result?.status === 'waiting') &&
          this.live &&
          this.live.tools.changed.length === 0
        )
          this.saved.tools = this.live.tools.digests
        await this.persist().catch((error) =>
          console.warn(`could not save thread state: ${errorMessage(error)}`),
        )
      }
      // Codex's harness reports no limits (nor Pi's on a Codex login): read once the turn is over,
      // without holding it up.
      if (result && loginOf(spec.teammate.harness, spec.teammate.model) === 'codex') {
        const account = this.current
        void readCodexLimits(account).then((limits) => {
          if (limits?.length) this.emit({ type: 'usage.updated', accountId: account.id, limits })
        })
      }
    }
  }

  /**
   * The computer stopped during this teammate's turn. One frozen on the way
   * down (a stop or update) goes on where it stopped. After a stop without
   * warning, the conversation resumes from what the harness kept, told what
   * happened; with nothing to resume, a new session is told the thread so far.
   * Null when restarts kept cutting the turn off: it is closed instead.
   */
  private async recover(
    unseen: string,
    spec: ThreadSpec,
  ): Promise<{ input: ThreadInput; handoff?: string } | null> {
    this.saved ??= { accountId: spec.account.id, transcript: [] }
    const saved = this.saved
    // Handed over by an update: the turn went on in its harness, which this session attaches
    // to (attach) and takes up where it is, with what it did meanwhile. Nothing to tell anyone.
    if (
      saved.handedOver &&
      !saved.inTurn &&
      frozenMidRun(saved.resume) &&
      saved.accountId === spec.account.id &&
      (await this.bridgeAnswers(saved.resume))
    )
      return { input: { kind: 'resume', text: unseen } }
    // Done again from its last step, the turn writes its blocks anew.
    this.texts.clear()
    this.reasoning.clear()
    const recoveries = (saved.recoveries ?? 0) + 1
    if (recoveries > MAX_RECOVERIES) {
      saved.recoveries = 0
      saved.inTurn = false
      await this.persist()
      this.emit({
        type: 'raw',
        source: 'runner',
        value: `${spec.teammate.name}'s turn was cut off by ${MAX_RECOVERIES} restarts in a row, so it was not continued again. Send a message to continue.`,
      })
      this.completed('interrupted')
      return null
    }
    saved.recoveries = recoveries
    this.emit({
      type: 'raw',
      source: 'runner',
      value: `The computer restarted during this turn. ${spec.teammate.name} carries on.`,
    })
    const told = [RESTARTED, unseen].filter(Boolean).join('\n\n')
    if (harnessChanged(saved, spec)) {
      const handoff = await this.newHarness(spec)
      return { input: { kind: 'resume', text: '' }, handoff: `${handoff}\n\n${told}` }
    }
    if (saved.accountId !== spec.account.id) {
      const handoff = await this.switchTo(spec.account, 'unavailable', null)
      return { input: { kind: 'resume', text: '' }, handoff: `${handoff}\n\n${told}` }
    }
    // Frozen on the way down, the turn goes on in its conversation. A Codex turn frozen before
    // its conversation started (thread/start still under way) has none: continued without its
    // bridge, Codex would start a new one told only "Continue.", so it is told the thread instead.
    // Antigravity's frozen turn goes on only under the bridge it ran under (gone now): it is
    // continued from its conversation instead, below.
    if (
      !saved.inTurn &&
      frozenMidRun(saved.resume) &&
      spec.teammate.harness !== 'antigravity' &&
      (spec.teammate.harness !== 'codex' || resumable('codex', saved.resume))
    )
      return { input: { kind: 'resume', text: unseen } }
    const resume = resumable(spec.teammate.harness, saved.resume)
    if (resume) {
      saved.resume = resume
      // A turn cut off before the harness wrote its conversation comes back without the
      // message it answered (Claude Code then starts a new one): it is told it again.
      const asked = saved.asked ?? saved.transcript.findLast((t) => t.role === 'user')?.text
      const again = asked && `${ASKED}\n\n${asked}`
      return {
        input: { kind: 'resume', text: [RESTARTED, again, unseen].filter(Boolean).join('\n\n') },
      }
    }
    const handoff = this.handoff(
      'This conversation continues in a new session because the computer it ran on restarted and the previous session could not be resumed.',
    )
    saved.resume = undefined
    return { input: { kind: 'resume', text: '' }, handoff: `${handoff}\n\n${told}` }
  }

  /**
   * Back up what the teammate has not pushed in its checkouts, to GitHub. Called
   * when the thread goes quiet: the computer's disk is a cache, GitHub the source.
   */
  async backup() {
    await backup({
      spec: this.spec,
      workDir: this.workDir,
      bundles: this.context.bundles,
      ...(this.runAs ? { runAs: this.runAs } : {}),
    })
  }

  /** A harness session is running, not parked. */
  get active() {
    return this.live !== undefined
  }

  /** The memory lines the running session loaded when it started; none while parked. */
  get memoryLoaded(): ReadonlySet<string> | undefined {
    return this.live ? this.loaded : undefined
  }

  /** The running turn is answered: only Claude Code's guess at the person's next message is left. */
  get answered() {
    return this.drain !== undefined
  }

  /**
   * A turn runs in a live session, whose conversation a side reply can fork (sideReply). Not Pi's:
   * its conversation lives in the runner, where no CLI can fork it.
   */
  get forkable() {
    return (
      this.live !== undefined &&
      this.spec.teammate.harness !== 'pi' &&
      // Antigravity forks no conversation over ACP: a message steers its turn instead.
      this.spec.teammate.harness !== 'antigravity'
    )
  }

  /** The guess no longer matters (a new message, a stop): the answered turn's stream ends now. */
  async stopDrain() {
    const drain = this.drain
    if (!drain) return
    drain.stop.abort()
    await drain.done
  }

  /**
   * The last turn stopped on an approval, a question or a ticket: a new prompt
   * waits until a person answers it. A turn frozen mid-run waits on nobody.
   */
  async awaitingPerson() {
    if (!this.live) await this.load()
    return this.waitsOnPerson()
  }

  /**
   * A ticket or question Codex opened without waiting (codex-asks.ts): open for the person, its
   * answer comes as a message (laterAnswer). Its call returns only once it is kept, so Codex
   * hears it opened only then; one that could not be kept fails, and Codex hears that instead.
   */
  private openAsk(call: WaitingCall) {
    return this.keepAsk(call)
  }

  /**
   * Keep Codex's ask in the thread's state, once per call: its call (openAsk) and the event that
   * shows it (codexAsk) wait on the same write, whichever starts it. Rejects when it could not be
   * written, the ask dropped again: nothing may answer an ask a runner that stops would forget.
   * One at a time, a failed one written out again first: Codex may open two at once, and a
   * write that went through must not keep, on disk, another whose own write failed (persist
   * takes the state as it is when called).
   */
  private keepAsk(call: WaitingCall) {
    let kept = this.asksKept.get(call.toolCallId)
    if (kept) return kept
    kept = this.askWrites.then(async () => {
      this.saved ??= { accountId: this.current.id, transcript: [] }
      this.saved.later = [
        ...(this.saved.later ?? []).filter((c) => c.toolCallId !== call.toolCallId),
        call,
      ]
      try {
        await this.persist()
      } catch (error) {
        if (this.saved?.later)
          this.saved.later = this.saved.later.filter((c) => c.toolCallId !== call.toolCallId)
        // Another write taken while this one was under way may hold it: the state on disk
        // goes back to what is kept, as best it can.
        await this.persist().catch(() => undefined)
        throw error
      }
    })
    this.askWrites = kept.catch(() => undefined)
    this.asksKept.set(call.toolCallId, kept)
    return kept
  }

  /** The last of Codex's asks being kept: the next waits for it (keepAsk). */
  private askWrites: Promise<unknown> = Promise.resolve()

  /** Codex's asks being kept, by call (keepAsk). */
  private asksKept = new Map<string, Promise<void>>()

  /**
   * What goes out for an event that shows Codex's ask (ticket.opened, question.asked): the
   * event once the ask is kept (keepAsk), never before, so that its answer always finds it. A
   * write slower than askKeptMs() holds the thread's other events no longer: the ask shows once
   * kept, after them. One that could not be kept never shows. Undefined for any other event.
   */
  private codexAsk(event: AgentEvent): Promise<AgentEvent[]> | undefined {
    // Antigravity's asks return at once too (createAgent).
    if (this.spec.teammate.harness !== 'codex' && this.spec.teammate.harness !== 'antigravity')
      return undefined
    const id =
      event.type === 'ticket.opened'
        ? event.requestId
        : event.type === 'question.asked'
          ? event.questionId
          : undefined
    // Seen by the mapper just before it made this event: its call, with its input.
    const call = id === undefined ? undefined : this.toolCalls.get(id)
    if (id === undefined || !call) return undefined
    const shown = this.keepAsk({ toolCallId: id, toolName: call.toolName, input: call.input }).then(
      () => true,
      (error: unknown) => {
        console.warn(
          `thread ${this.spec.sessionId}: could not keep ask ${id}: ${errorMessage(error)}`,
        )
        return false
      },
    )
    let timer: NodeJS.Timeout | undefined
    let late = false
    void shown.then((ok) => {
      clearTimeout(timer)
      if (ok && late) this.outbox.send(event)
    })
    const slow = new Promise<AgentEvent[]>(
      (resolve) =>
        (timer = setTimeout(() => {
          late = true
          resolve([])
        }, askKeptMs())),
    )
    return Promise.race([shown.then((ok) => (ok ? [event] : [])), slow])
  }

  private waitsOnPerson() {
    if (this.live) return this.live.session.hasUnfinishedTurn() && !this.frozen && !this.drain
    const resume = this.saved?.resume as { continueFrom?: unknown } | undefined
    return !!resume?.continueFrom && !frozenMidRun(resume)
  }

  /**
   * A new message waits until a person answers: the last turn waits on an approval, which only
   * a decision goes on from. One waiting only on tickets and questions takes it now (aside.ts).
   */
  async holdsMessages() {
    if (!this.live) await this.load()
    return this.holds()
  }

  private holds() {
    return this.waitsOnPerson() && !this.asksOnly()
  }

  /**
   * Known already, without reading the saved state: this answer comes as a message (laterAnswer)
   * while messages wait on a decision, so it is kept until that is made (keepsAnswer).
   */
  holdsAnswer(input: AnswerInput) {
    return (
      (this.live !== undefined || this.saved !== undefined) &&
      !!this.messageCall(input) &&
      this.holds()
    )
  }

  /**
   * Keep an answer that comes as a message (laterAnswer) while messages wait on a decision: its
   * ask saved with it, it goes in once that is made (answersToGive). True when kept.
   */
  async keepsAnswer(input: ThreadInput) {
    if (input.kind !== 'answer' && input.kind !== 'ticket') return false
    await this.load()
    const call = this.messageCall(input)
    if (!call || !this.holds() || !this.saved) return false
    this.toolCalls.delete(call.toolCallId)
    // Given already, and held again (a turn before it waits on another decision): given anew.
    this.given.delete(call.toolCallId)
    this.saved.later = [
      ...(this.saved.later ?? []).filter((c) => c.toolCallId !== call.toolCallId),
      { ...call, answer: input },
    ]
    await this.persist()
    return true
  }

  /**
   * The answers kept while messages waited on a decision (keepsAnswer), once it is made: each
   * given once in this process, until its turn takes it (laterAnswer).
   */
  async answersToGive(): Promise<ThreadInput[]> {
    if (!this.live) await this.load()
    if (this.holds()) return []
    const kept = (this.saved?.later ?? []).filter((c) => c.answer && !this.given.has(c.toolCallId))
    for (const c of kept) this.given.add(c.toolCallId)
    return kept.map((c) => c.answer!)
  }

  /** The last turn waits on this approval. A decision on any other (made twice) goes nowhere. */
  async awaitsApproval(approvalId: string) {
    await this.load()
    return this.waitsOnApproval(approvalId)
  }

  /**
   * Known already, without reading the saved state: no turn of this teammate waits on this
   * approval. False when it can't tell yet (awaitsApproval tells, once its turn comes).
   */
  decidesNothing(approvalId: string) {
    return (
      (this.live !== undefined || this.saved !== undefined) && !this.waitsOnApproval(approvalId)
    )
  }

  private waitsOnApproval(approvalId: string) {
    if (this.approvals.has(approvalId)) return true
    if (this.live) return false
    return !!closeTurn(this.saved?.resume)?.approvals.some((a) => a.approvalId === approvalId)
  }

  /** The last turn waits on a person only for tickets and questions, which a message sets aside. */
  private asksOnly() {
    if (this.live)
      return (
        this.live.session.hasUnfinishedTurn() &&
        !this.frozen &&
        !this.drain &&
        this.approvals.size === 0 &&
        this.waitingAsks().length > 0
      )
    const closed = closeTurn(this.saved?.resume)
    return (
      !!closed &&
      closed.approvals.length === 0 &&
      closed.waiting.length > 0 &&
      closed.waiting.every((call) => PERSON_TOOLS.has(call.toolName))
    )
  }

  /**
   * The person's tickets and questions the last turn waits on. Live, those its session still
   * waits on (a list the SDK keeps private: without it, the calls seen and not answered);
   * stopped, those its saved turn does.
   */
  private waitingAsks(): WaitingCall[] {
    if (!this.live)
      return (closeTurn(this.saved?.resume)?.waiting ?? []).filter((c) =>
        PERSON_TOOLS.has(c.toolName),
      )
    const calls = waitingOn(this.toolCalls, PERSON_TOOLS)
    const pending = (
      this.live.session as unknown as {
        getPendingToolResults?: () => { toolCallId: string; completedResult?: unknown }[]
      }
    ).getPendingToolResults?.()
    if (!pending) return calls
    const ids = new Set(pending.filter((p) => !p.completedResult).map((p) => p.toolCallId))
    return calls.filter((c) => ids.has(c.toolCallId))
  }

  /**
   * These tickets and questions, set aside: still open, answered later (laterAnswer). Saved
   * before the turn goes on: a process that stops while it answers the message must still
   * find their answer a message, not a result for a turn that waits on them no more.
   */
  private async setAside(calls: WaitingCall[]) {
    for (const call of calls) this.toolCalls.delete(call.toolCallId)
    const ids = new Set(calls.map((c) => c.toolCallId))
    this.saved!.later = [
      ...(this.saved!.later ?? []).filter((c) => !ids.has(c.toolCallId)),
      ...calls,
    ]
    if (this.saved!.waiting)
      this.saved!.waiting = this.saved!.waiting.filter((c) => !ids.has(c.toolCallId))
    await this.persist()
  }

  /**
   * A person's answer as the message it becomes when no turn waits on its call: one set aside
   * earlier, or any the last turn does not wait on while it waits on others (continued with
   * it, the turn would sit on those). Undefined: it goes on with the turn that waits on it.
   */
  private laterAnswer(input: ThreadInput) {
    if (input.kind !== 'answer' && input.kind !== 'ticket') return undefined
    const id = answerId(input)
    const call = this.messageCall(input)
    if (!call) return undefined
    if (this.saved?.later) this.saved.later = this.saved.later.filter((c) => c.toolCallId !== id)
    this.toolCalls.delete(id)
    this.given.delete(id)
    const result =
      input.kind === 'answer'
        ? this.answerResult(input.questionId, input.answer, call)
        : this.ticketResult(input.requestId, input.answer, call)
    return answerLater(
      { toolName: result.toolName, input: call.input },
      // Without its call's input, the answer as given: its asks, by id, are not known here.
      call.input !== undefined ? result.output.value : input.answer,
    )
  }

  /**
   * The call an answer is to, when the answer comes as a message (laterAnswer): set aside, or
   * one the last turn does not wait on while it waits on others. Undefined: it goes on with the
   * turn that waits on it, or with none (closed-turn.ts).
   */
  private messageCall(input: AnswerInput): WaitingCall | undefined {
    const id = answerId(input)
    const later = this.saved?.later?.find((c) => c.toolCallId === id)
    if (later) return { toolCallId: later.toolCallId, toolName: later.toolName, input: later.input }
    if (this.waitsOnCall(id) !== false) return undefined
    const seen = this.toolCalls.get(id)
    return {
      toolCallId: id,
      toolName: seen?.toolName ?? (input.kind === 'answer' ? QUESTION_TOOL : OPEN_TICKET_TOOL),
      input: seen?.input,
    }
  }

  /**
   * Whether the last turn waits on this call, when it waits on something: live, as its
   * session says (a list the SDK keeps private: without it, the calls seen and not answered);
   * stopped, as its saved turn does. Undefined when it waits on nothing.
   */
  private waitsOnCall(toolCallId: string) {
    if (!this.live) {
      const closed = closeTurn(this.saved?.resume)
      return closed && closed.waiting.some((c) => c.toolCallId === toolCallId)
    }
    if (!this.live.session.hasUnfinishedTurn()) return undefined
    const pending = (
      this.live.session as unknown as {
        getPendingToolResults?: () => { toolCallId: string; completedResult?: unknown }[]
      }
    ).getPendingToolResults?.()
    return pending
      ? pending.some((p) => !p.completedResult && p.toolCallId === toolCallId)
      : this.toolCalls.has(toolCallId)
  }

  /**
   * A turn of this teammate's was running here when the runner last stopped:
   * frozen on the way down, or cut off without warning (it never finished).
   */
  async cutOff() {
    if (this.live) return false
    await this.load()
    return !!this.saved && (!!this.saved.inTurn || frozenMidRun(this.saved.resume))
  }

  /**
   * Give a message to the running turn, which reads it at its next step; what
   * it does about it stays in this turn. Throws when no turn runs, or the
   * harness cannot take one mid-turn. `messageId`: a person's message, which an
   * answer_message call answers from now on.
   */
  async steer(text: string, messageId?: string) {
    const live = this.live
    if (!live) throw new Error('No turn is running')
    await live.agent.experimental_steer({ session: live.session, text })
    this.remember('user', text)
    this.replies.steered()
    // Read by Claude Code, which answers it: the turn is not over until it has (staleWait).
    this.steeredPending = true
    // Saved now: the turn may answer it after a restart, or in the runner it is handed over to.
    this.saved!.steered = messageId
    // Taken by Claude Code (queued, as the bridge answers once it is): a wait under way ends, and
    // the message goes in with its result.
    this.arrivals.arrived()
    await this.persist().catch((error) =>
      console.warn(`could not save thread state: ${errorMessage(error)}`),
    )
  }

  /** The person's message an answer_message call answers now, if any (steer). */
  answering() {
    return this.saved?.steered
  }

  /**
   * A side reply (side-replies.ts): a copy of this teammate's conversation, forked while its
   * turn runs, answers `prompt` and may only read. It runs in a process of its own, on the
   * running turn's account and in the thread's folder, and nothing of it reaches the turn:
   * Claude Code forks the newest conversation in the folder (the turn's) and writes none;
   * Codex forks the thread its folder's turn runs in without saving it, and only reads.
   * Resolves to the copy's last message.
   */
  async sideReply(prompt: string, signal: AbortSignal): Promise<string> {
    const live = this.live
    if (!live) throw new Error('No turn is running')
    const spec = this.spec
    const codex = spec.teammate.harness === 'codex'
    const env = {
      ...(await prepare(this.workDir, live.account, spec.sessionId, this.runAs)),
      // Its prompt is read once, and its tools differ from the turn's: no cache to share.
      CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
      // The bridges' patches: fork, write nothing, only read, wherever the turn can.
      ...SIDE_REPLY_ENV,
      ...(codex ? {} : claudeSettingsEnv()),
    }
    const agent = new HarnessAgent({
      harness: codex
        ? createCodex({
            auth: {},
            codexConfig: { ...CODEX_SETTINGS, project_doc_max_bytes: INSTRUCTIONS_MAX_BYTES },
            reasoningEffort: 'low',
          })
        : createClaudeCode({ auth: {}, effort: 'low' }),
      tools: {},
      // Codex reads through its shell, which the bridge keeps read-only.
      ...(codex ? {} : { activeTools: ['read', 'glob', 'grep'] as never }),
      ...withModel(spec.teammate),
      ...(spec.teammate.instructions ? { instructions: spec.teammate.instructions } : {}),
      permissionMode: codex ? 'allow-all' : 'allow-reads',
      sandboxConfig: { workDir: '.' },
    })
    const id = `${this.key}-side-${randomUUID().slice(0, 8)}`
    const sandbox = createLocalSandboxSession({
      id,
      workingDirectory: this.workDir,
      port: await freePort(),
      env,
      ...(this.runAs ? { runAs: this.runAs, thread: spec.sessionId } : {}),
    })
    try {
      const session = await agent.createSession({
        sessionId: id,
        sandboxSession: sandbox,
        // Claude Code continues the newest conversation in the folder; Codex finds its thread.
        ...(codex
          ? {}
          : {
              resumeFrom: {
                type: 'resume-session',
                specificationVersion: 'harness-v1',
                harnessId: 'claude-code',
                data: {},
              } as never,
            }),
      })
      try {
        let text = ''
        const mapper = new EventMapper((event) => {
          if (event.type === 'message.done') text = event.text
          reportRunUsage(event, {
            kind: 'side',
            accountId: live.account.id,
            sessionId: spec.sessionId,
            teammateId: spec.teammate.id,
          })
        })
        const result = await agent.stream({ session, prompt, abortSignal: signal })
        for await (const part of result.fullStream) mapper.map(part)
        if (signal.aborted) throw new Error('The side reply was stopped')
        if (mapper.exhausted) throw new Error('The account is out of usage')
        if (mapper.error) throw new Error(mapper.error)
        return text
      } finally {
        await session.destroy().catch(() => undefined)
      }
    } finally {
      await sandbox.destroy()
    }
  }

  /** Stop the harness and keep its saved state, so the next message resumes it. */
  async park() {
    // An answered turn ends first, rather than freeze where nothing is left to go on with.
    await this.stopDrain()
    const live = this.live
    if (!live) return
    this.live = undefined
    try {
      // Parked, a turn that was running is frozen in `resume`: it goes on from there, under a
      // new bridge (this one stops with the sandbox below).
      const resume = withoutBridge(await live.session.stop())
      this.saved = { ...this.saved!, accountId: live.account.id, resume, inTurn: false }
      await this.persist()
    } finally {
      await live.sandbox.destroy()
      await live.credentials.cleanup()
    }
  }

  /**
   * The runner restarts into an update: the running turn stays in its harness, left running
   * (detach), for the next runner to attach to and take up where it is (recover). Resolves to
   * the harness's process groups, which the next runner keeps (hand-over.ts). A harness that
   * does not let go in time (a call of its host's that goes on) is stopped instead, and its
   * turn continued from its conversation after the restart, as after a stop without warning.
   */
  async handOver(): Promise<HandedOver[]> {
    // Answered, the turn has nothing to hand over: its guess is dropped, and it parks.
    if (this.drain) {
      await this.park()
      return []
    }
    const live = this.live
    if (!live) return []
    this.live = undefined
    const groups = live.sandbox.groups()
    this.handingOver = true
    const detached = live.session.detach().then(
      (resume) => resume,
      () => undefined,
    )
    // A wait of its tools on the thread's machine would hold the turn until its command ends,
    // past HAND_OVER_MS: it ends now, the command going on there (arrivals.ts). Asked once the
    // turn is suspending, its result is kept for the next runner to give the turn.
    this.arrivals.handOver()
    const resume = await Promise.race([detached, sleep(HAND_OVER_MS, undefined, { ref: false })])
    this.handingOver = false
    // Pi runs in this runner, and stops with it: nothing goes on for the next runner to attach
    // to. Its conversation so far is kept, and the next runner continues the turn (recover).
    // So on Windows, where a harness's processes cannot be followed across a restart (no
    // process groups, and the shell that leads them ends with the runner: windows.ts).
    const inRunner = this.spec.teammate.harness === 'pi' || WINDOWS
    if (!resume || groups.length === 0 || inRunner) {
      this.handOverFailed = true
      this.saved = { ...this.saved!, ...(inRunner && resume ? { resume } : {}), inTurn: true }
      await this.persist()
      await live.sandbox.destroy()
      return []
    }
    this.saved = {
      ...this.saved!,
      accountId: live.account.id,
      resume,
      inTurn: false,
      handedOver: {
        groups,
        calls: [...this.toolCalls].map(([toolCallId, call]) => ({ toolCallId, ...call })),
        texts: [...this.texts],
        reasoning: [...this.reasoning],
        // The bridge said so before the update, and says it only once: the next runner keeps it.
        ...(this.waitingSince !== undefined
          ? {
              waitingSince: this.waitingSince,
              background: this.background,
              ...(this.quietSince !== undefined ? { quietSince: this.quietSince } : {}),
              ...(this.steeredPending ? { steered: true } : {}),
            }
          : {}),
      },
    }
    await this.persist()
    // Its credential files stay for the turn: the next session's are the same (ThreadCredentials).
    return groups.map((pgid) => ({ pgid, ...(this.runAs ? { runAs: this.runAs } : {}) }))
  }

  /**
   * The harness the runner before handed over, for the session about to start: still there,
   * the session attaches to it and stops it with its sandbox; gone, or left on another account,
   * the session starts a new one, rather than wait on its port (withoutBridge).
   */
  private async takeHandedOver(account: AccountRef): Promise<number[]> {
    const saved = this.saved
    const handed = saved?.handedOver
    if (!saved || !handed) return []
    delete saved.handedOver
    for (const pgid of handed.groups) claimHandOver(pgid)
    if (saved.accountId === account.id && (await this.bridgeAnswers(saved.resume))) {
      // The turn goes on where it was: waiting on work in the background, if it was.
      this.waitingSince = handed.waitingSince
      this.background = handed.background ?? []
      this.quietSince = handed.quietSince
      this.steeredPending = !!handed.steered
      return handed.groups
    }
    for (const pgid of handed.groups) void stopGroup(pgid, this.runAs)
    saved.resume = withoutBridge(saved.resume)
    return []
  }

  /** The bridge a handed-over session ran under still answers (on the thread's own network, there). */
  private async bridgeAnswers(resume: unknown) {
    const port = attachablePort(resume)
    if (port === undefined) return false
    const host = this.runAs
      ? ((await threadNet(this.spec.sessionId))?.address ?? '127.0.0.1')
      : '127.0.0.1'
    return answers(host, port)
  }

  private get current(): AccountRef {
    return this.live?.account ?? this.spec.account
  }

  /** The account its live session runs on, if one runs. */
  get liveAccountId(): string | undefined {
    return this.live?.account.id
  }

  private async turn(
    input: ThreadInput,
    signal: AbortSignal,
    /** A call the person approved in a conversation the harness lost: made again, it runs. */
    approved?: Call,
  ): Promise<
    | { kind: 'done'; result: TurnOutcome }
    | { kind: 'exhausted'; resetsAt: string | null }
    /**
     * The harness no longer has the conversation it resumed (EventMapper.sessionLost). `said`:
     * what to tell a new session of this turn's input; `approved`: the call it approved.
     */
    | {
        kind: 'lost'
        error: string
        said: string | undefined
        approved: Call | undefined
        /** Why the new session starts, when not that the harness lost the conversation. */
        why?: string
      }
  > {
    let attached: Live | undefined
    // A turn before this one waits on nothing now; a turn handed over goes on waiting (attach).
    this.waitingSince = undefined
    this.quietSince = undefined
    this.steeredPending = false
    // What the turn told the harness as a message (a restart, an aside), for a new session.
    let said: string | undefined
    const say = (prompt: string) => (said = prompt)
    // The call an answer or an approval is for: the transcript has only what was written.
    let asked: Call | undefined
    // Lost, its conversation: what a new session is told of this turn's input.
    const lost = (error: string, why?: string) => ({
      kind: 'lost' as const,
      error,
      ...(why ? { why } : {}),
      said:
        input.kind === 'answer'
          ? answerInNewSession(asked, this.answerResult(input.questionId, input.answer, asked))
          : input.kind === 'ticket'
            ? answerInNewSession(asked, this.ticketResult(input.requestId, input.answer, asked))
            : input.kind === 'approval'
              ? approvalInNewSession(asked, input.approved, input.reason)
              : said,
      approved: input.kind === 'approval' && input.approved ? asked : undefined,
    })
    // Parked during the turn: the runner is stopping, and the turn, frozen, goes on after the restart.
    // How its stream ends then is no failure of the teammate's.
    const frozenUnder = () => attached !== undefined && this.live !== attached
    // A call approved while its turn was lost, made again: approved without asking twice.
    let approvedAgain: Call | undefined = approved
    const autoApproved: string[] = []
    // Ends the stream being read once the turn is answered and only Claude Code's guess is
    // left (drain): each stream gets a signal of its own, with the turn's.
    let tail = new AbortController()
    const streamSignal = () => {
      tail = new AbortController()
      return AbortSignal.any([signal, tail.signal])
    }
    // A stream the turn may end in (consumeLast); the bridge says when it is answered.
    let mayAnswer = false
    let early = false
    let drained: () => void = () => {}
    // Answered, with a reply the person can read: done for everyone now, while Claude Code
    // guesses what they may write next (drain). A turn that owes a reply is asked for it in a
    // stream of its own, which ends the turn instead. False when it cannot end so now.
    const answerNow = (owing = this.replies.owes()) => {
      if (early || !mayAnswer || signal.aborted || owing || mapper.error || mapper.exhausted)
        return false
      early = true
      this.drain = { stop: tail, done: new Promise<void>((resolve) => (drained = resolve)) }
      this.completed('stop')
      return true
    }
    // The bridge says the turn only waits on work in the background. With none running as this
    // runner sees it for STALE_WAIT_MS, nothing is coming (a bridge that took a command run in
    // the foreground for background work kept a turn open for 7 hours, and through each update
    // of the runner): the turn ends, answered, as at a guess no longer wanted (stopDrain). One
    // that owes the person a reply after its last step ends too, rather than never; never one
    // whose steered message is still to be answered: its answer is on its way.
    let staleTimer: NodeJS.Timeout | undefined
    const staleAt = () => Math.max(this.waitingSince ?? 0, this.quietSince ?? 0) + STALE_WAIT_MS
    const again = (ms: number) => {
      clearTimeout(staleTimer)
      staleTimer = setTimeout(staleWait, Math.max(0, ms))
      staleTimer.unref?.()
    }
    // Armed while the turn waits with nothing running; work that runs is watched again once it ends.
    const watchWait = () => {
      clearTimeout(staleTimer)
      staleTimer = undefined
      if (this.waitingSince === undefined || this.background.length > 0) return
      again(staleAt() - Date.now())
    }
    // Told once that the turn cannot end yet (its last stream not started, a stop under way).
    let staleTold = false
    const staleWait = () => {
      staleTimer = undefined
      // Parked or handed over: the turn is the next session's to end, or to go on with.
      if (this.waitingSince === undefined || frozenUnder() || this.background.length > 0) return
      const left = staleAt() - Date.now()
      if (left > 0) return again(left)
      const since = Math.round((Date.now() - this.waitingSince) / 1000)
      if (this.steeredPending || !answerNow(false)) {
        if (!staleTold)
          console.warn(
            `thread ${this.spec.sessionId}: its turn waits on background work that is not running (${since} s), and cannot end yet`,
          )
        staleTold = true
        return again(STALE_RETRY_MS)
      }
      console.warn(
        `thread ${this.spec.sessionId}: its turn waited ${since} s on background work that was not running, so it ended`,
      )
      void this.stopDrain()
    }
    const mapper = new EventMapper(
      (event) => {
        // Parked, what is left is done again; handed over, it is up to where the next runner goes on.
        if (frozenUnder() && !this.handingOver) return
        if (answered(event)) {
          answerNow()
          return
        }
        // A guess counts once the turn is answered: before that, more of the turn comes after it
        // (the reply it is asked for, what it waits on in the background).
        if (event.type === 'message.suggested' && !early) return
        // After that, only the guess and the turn's usage still go out: the rest is a closing process.
        if (early && event.type !== 'message.suggested' && event.type !== 'usage.updated') return
        if (event.type === 'approval.requested') {
          if (approvedAgain && sameCall(approvedAgain, event)) {
            approvedAgain = undefined
            autoApproved.push(event.approvalId)
            return
          }
          this.approvals.set(event.approvalId, { toolName: event.toolName, input: event.input })
        }
        if (event.type === 'tool.started' || event.type === 'tool.finished')
          this.browserUsed(event.toolName)
        if (event.type === 'message.done') this.remember('assistant', event.text)
        this.replies.see(event)
        if (event.type === 'message.done' && hasVisibleText(event.text)) this.steeredPending = false
        this.noteBackground(event)
        if (backgroundWait(event) !== undefined || backgroundTasks(event)) watchWait()
        // A ticket or question Codex opened without waiting (codex-asks.ts) shows once it is kept:
        // answered at once, or after the runner stopped, the answer finds the ask it is to.
        const ask = this.codexAsk(event)
        if (ask) {
          this.outbox.hold(ask)
          return
        }
        // A turn's usage says whose account spent it: the stream's own, which after running out
        // of usage (switchTo) is the next account's, not the one the turn started on.
        this.outbox.send(
          event.type === 'usage.updated' && !event.accountId
            ? { ...event, accountId: (attached ?? this.live)?.account.id ?? this.spec.account.id }
            : event,
        )
        // Declared done at the end of the reply: Brigade is asked now, and the turn's end waits
        // for its answer, as it waited for complete_thread's.
        if (declaredDone(event))
          this.outbox.hold(
            declareDone(this.context.callSchedule, event).then((finished) => [finished]),
          )
      },
      this.toolCalls,
      this.texts,
      this.reasoning,
      () => this.answering(),
      // A child reports, a playbook's run ends with its report, a schedule's run with its turn.
      !this.spec.parent && !this.spec.playbook && this.spec.origin !== 'schedule',
      () => this.spec.closedApps,
    )
    try {
      // Its connector tools changed (an App granted from a ticket the turn waits on, or on the
      // teammate's page between turns), or the thread's effort did: the harness stops and
      // resumes with an agent made anew. A new message while a turn is still unfinished
      // leaves that turn as it is.
      if (
        this.live &&
        this.live.made !== agentKey(this.spec) &&
        ((input.kind !== 'prompt' && input.kind !== 'resume') ||
          !this.live.session.hasUnfinishedTurn())
      )
        await this.park()
      // An answer for a turn whose session stopped since (just above, or with the runner):
      // that turn is closed, and the answer comes as a new message (closed-turn.ts).
      // An approval too: continued, the call it approved comes back interrupted, never run.
      const answer = input.kind === 'answer' || input.kind === 'ticket' || input.kind === 'approval'
      // A message while the turn waits only on the person's tickets and questions: they stay
      // open, and the message goes in now (aside.ts). Closed so too when its session stopped.
      const aside = input.kind === 'prompt' && input.text !== '' && this.asksOnly()
      // Which, read before closing the turn they wait in.
      const calls = aside ? this.waitingAsks() : []
      // An answer to a call of the harness the teammate ran on before (Pi, say): the new one
      // cannot continue that turn. A new session is told the thread so far, then the call and
      // its answer (answerInNewSession), as when a harness lost its conversation.
      if (
        answer &&
        (this.live?.harness !== undefined
          ? this.live.harness !== this.spec.teammate.harness
          : harnessChanged(this.saved, this.spec))
      ) {
        await this.park().catch(() => undefined)
        asked =
          input.kind === 'answer' || input.kind === 'ticket'
            ? this.toolCalls.get(answerId(input))
            : this.approvals.get(input.approvalId)
        return lost(
          'The teammate moved to another harness',
          `This conversation continues in a new session because you now run on ${harnessName(this.spec.teammate.harness)}.`,
        )
      }
      let closed = !this.live && (answer || aside) && this.closeTurn()
      const live = (attached = await this.attach())
      // Handed over while it waited on work in the background, it is watched on from where it was.
      watchWait()
      // Or nothing kept the turn at all (the process stopped without parking): the session has
      // no turn to continue, and the answer comes as a new message just the same.
      if (answer && !live.session.hasUnfinishedTurn()) closed = true
      // Read now: answered, the call is forgotten below.
      asked =
        input.kind === 'answer' || input.kind === 'ticket'
          ? this.toolCalls.get(answerId(input))
          : input.kind === 'approval'
            ? this.approvals.get(input.approvalId)
            : undefined
      const consume = async (stream: TurnStream) => {
        try {
          for await (const part of stream) {
            mapper.map(part)
            // A message given to the turn is read once the step's results went back and the
            // model writes again (arrivals.ts).
            this.arrivals.saw(part)
            const image = generatedImage(part)
            if (image) await this.keepImage(image)
          }
        } finally {
          // A reply's last streamed text, before what ends the turn: a stream may end mid-reply.
          mapper.flush()
        }
      }
      // A stream that may be the turn's last: answered there, the turn completes for everyone
      // while Claude Code guesses the person's next message (drain).
      const consumeLast = async (stream: TurnStream) => {
        mayAnswer = true
        try {
          await consume(stream)
        } finally {
          mayAnswer = false
          this.drain = undefined
          drained()
        }
      }
      // Completed for everyone once answered: Claude Code's guess came, or no longer mattered.
      const answeredEarly = async () => {
        if (this.runAs) await linkAccount(this.runAs, live.account).catch(() => undefined)
        await this.persist()
        return { kind: 'done' as const, result: { status: 'idle' as const } }
      }
      let text = input.kind === 'prompt' || input.kind === 'resume' ? input.text : undefined
      // Nothing frozen came back after all: the teammate is told what happened instead.
      if (input.kind === 'resume' && !text && !live.session.hasUnfinishedTurn()) text = RESTARTED
      // Set aside, the calls the turn waits on take the message as their result; with that
      // turn closed, the message says what became of them.
      let asides: ReturnType<typeof asideResult>[] | undefined
      if (calls.length > 0 && text !== undefined) {
        await this.setAside(calls)
        if (live.session.hasUnfinishedTurn()) {
          asides = calls.map((call) => asideResult(call, text!))
          text = undefined
        } else text = asideAfterRestart(calls, text)
      }
      if (text !== undefined && live.session.hasUnfinishedTurn()) {
        if (!this.frozen) {
          return {
            kind: 'done',
            result: {
              status: 'waiting',
              error: 'Answer the pending approval or question first.',
            },
          }
        }
        // The computer stopped during the last turn, which froze it with nothing
        // waiting on a person: finish that turn, then the new message. With no new message,
        // that turn is this one, and may end early like any.
        this.frozen = false
        const alone = text === ''
        const frozen = await live.agent.continueStream({
          session: live.session,
          abortSignal: alone ? streamSignal() : signal,
        })
        if (alone) {
          await consumeLast(frozen.fullStream)
          if (early) return await answeredEarly()
        } else await consume(frozen.fullStream)
      }
      // The frozen turn stopped again (an approval, a question, no usage left): the message waits.
      const held =
        text !== undefined &&
        (live.session.hasUnfinishedTurn() || signal.aborted || !!mapper.exhausted || !!mapper.error)
      let result = asides
        ? await live.agent.continueStream({
            session: live.session,
            abortSignal: streamSignal(),
            toolResultContinuations: asides,
          })
        : held || text === ''
          ? undefined
          : closed && input.kind === 'approval'
            ? await live.agent.stream({
                session: live.session,
                prompt: (() => {
                  const call = this.approvals.get(input.approvalId)
                  this.approvals.delete(input.approvalId)
                  if (input.approved) approvedAgain = call
                  return withToolChanges(
                    live,
                    approvalAfterRestart(call, input.approved, input.reason),
                  )
                })(),
                abortSignal: streamSignal(),
              })
            : closed && (input.kind === 'answer' || input.kind === 'ticket')
              ? await live.agent.stream({
                  session: live.session,
                  prompt: withToolChanges(
                    live,
                    answerAfterRestart(
                      input.kind === 'answer'
                        ? this.answerResult(input.questionId, input.answer)
                        : this.ticketResult(input.requestId, input.answer),
                    ),
                  ),
                  abortSignal: streamSignal(),
                })
              : input.kind === 'prompt' || input.kind === 'resume'
                ? await live.agent.stream({
                    session: live.session,
                    prompt: withToolChanges(live, say(text!)),
                    abortSignal: streamSignal(),
                  })
                : input.kind === 'answer' || input.kind === 'ticket'
                  ? await live.agent.continueStream({
                      session: live.session,
                      abortSignal: streamSignal(),
                      toolResultContinuations: [
                        input.kind === 'answer'
                          ? this.answerResult(input.questionId, input.answer)
                          : this.ticketResult(input.requestId, input.answer),
                      ],
                    })
                  : await live.agent.continueStream({
                      session: live.session,
                      abortSignal: streamSignal(),
                      toolApprovalContinuations: [
                        {
                          type: 'tool-approval-response',
                          approvalId: input.approvalId,
                          approved: input.approved,
                          ...(input.reason ? { reason: input.reason } : {}),
                        },
                      ],
                    })
      if (input.kind === 'approval' && !closed) this.approvals.delete(input.approvalId)
      // Answered, a call waits no more: kept, it would look asked still (waitingAsks).
      if (input.kind === 'answer') this.toolCalls.delete(input.questionId)
      if (input.kind === 'ticket') this.toolCalls.delete(input.requestId)
      if (result) await consumeLast(result.fullStream)
      if (early) return await answeredEarly()
      // The call approved while its turn was lost, made again: approved as the person did.
      while (autoApproved.length && live.session.hasUnfinishedTurn() && !signal.aborted) {
        const approved = autoApproved.splice(0)
        result = await live.agent.continueStream({
          session: live.session,
          abortSignal: streamSignal(),
          toolApprovalContinuations: approved.map((approvalId) => ({
            type: 'tool-approval-response' as const,
            approvalId,
            approved: true,
          })),
        })
        await consumeLast(result.fullStream)
        if (early) return await answeredEarly()
      }
      // A ticket nobody could answer: the error goes back and the turn carries on.
      while (mapper.rejected.length && live.session.hasUnfinishedTurn() && !signal.aborted) {
        const rejected = mapper.rejected.splice(0)
        for (const r of rejected) this.toolCalls.delete(r.toolCallId)
        result = await live.agent.continueStream({
          session: live.session,
          abortSignal: streamSignal(),
          toolResultContinuations: rejected.map((r) => ({
            type: 'tool-result' as const,
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: { type: 'error-text' as const, value: r.error },
          })),
        })
        await consumeLast(result.fullStream)
        if (early) return await answeredEarly()
      }
      // Over with no reply after its work (only in its thinking, or before its last step): asked for once.
      const over =
        !frozenUnder() &&
        !signal.aborted &&
        !mapper.exhausted &&
        !mapper.error &&
        !live.session.hasUnfinishedTurn()
      const ask = over ? this.replies.ask() : undefined
      if (ask) {
        await consumeLast(
          (
            await live.agent.stream({
              session: live.session,
              prompt: withToolChanges(live, ask),
              abortSignal: streamSignal(),
            })
          ).fullStream,
        )
        if (early) return await answeredEarly()
      }
      if (frozenUnder()) return { kind: 'done', result: { status: 'waiting' } }
      // A login from before tokens, refreshed during the turn, goes back to the shared account directory.
      if (this.runAs) await linkAccount(this.runAs, live.account).catch(() => undefined)
      if (mapper.exhausted) return { kind: 'exhausted', resetsAt: mapper.exhausted.resetsAt }
      if (live.session.hasUnfinishedTurn()) return { kind: 'done', result: { status: 'waiting' } }
      // An error reported inside the stream fails the turn (it was already emitted). The harness
      // reports a fatal one there too, not by throwing (its bridge killed: its channel stays
      // closed), so the session goes as after a throw, and the next message starts clean.
      if (mapper.error && !signal.aborted) {
        await this.drop()
        // Its conversation gone from this computer: the thread goes on in a new session (run).
        if (mapper.lost) return lost(mapper.error, lostWhy(mapper.error))
        return { kind: 'done', result: { status: 'failed', error: mapper.error } }
      }
      if (signal.aborted) await this.endCommands(live)
      this.completed(signal.aborted ? 'interrupted' : mapper.finishReason)
      await this.persist()
      return { kind: 'done', result: { status: 'idle' } }
    } catch (error) {
      // Its stream broke while Claude Code guessed: the turn was completed already, the next starts clean.
      if (early) {
        await this.drop()
        return { kind: 'done', result: { status: 'idle' } }
      }
      if (frozenUnder()) return { kind: 'done', result: { status: 'waiting' } }
      if (signal.aborted) {
        await this.endCommands(attached)
        this.completed('interrupted')
        return { kind: 'done', result: { status: 'idle' } }
      }
      const message = errorMessage(error)
      const exhausted = EventMapper.exhaustedBy(message)
      if (exhausted) return { kind: 'exhausted', resetsAt: exhausted.resetsAt }
      if (EventMapper.sessionLost(message)) {
        await this.drop()
        return lost(message, lostWhy(message))
      }
      this.emit({ type: 'error', message })
      await this.drop()
      return { kind: 'done', result: { status: 'failed', error: message } }
    } finally {
      clearTimeout(staleTimer)
    }
  }

  /**
   * A picture the harness saved in its own folder, copied into the thread's
   * working folder: people see it in the thread, and it stays with the work.
   */
  private async keepImage(image: {
    toolCallId: string
    savedPath: string
    prompt?: string
  }): Promise<string | undefined> {
    const path = `images/${basename(image.savedPath)}`
    const target = join(this.workDir, path)
    try {
      if (this.runAs) {
        const sudo = ['-n', '-u', this.runAs]
        await execFileAsync('sudo', [...sudo, 'mkdir', '-p', dirname(target)], { cwd: '/' })
        await execFileAsync('sudo', [...sudo, 'cp', '--', image.savedPath, target], { cwd: '/' })
      } else {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(image.savedPath, target)
      }
    } catch (error) {
      console.warn(`could not keep image ${image.savedPath}: ${errorMessage(error)}`)
      return
    }
    this.emit({
      type: 'image.generated',
      path,
      toolCallId: image.toolCallId,
      ...(image.prompt ? { prompt: image.prompt } : {}),
    })
    return path
  }

  /**
   * On a member's Mac: the teammate sees and uses its apps through Brigade Computer Use. On a
   * member's Linux computer, through Brigade.app, which serves the same requests: offered once
   * Brigade.app is installed there or the runner runs in a desktop session, so that a server linked
   * with the terminal command gets none. Not on the workspace computer (teammates there have a
   * browser). The tools stay without the helper, answering that it's missing: a thread that used
   * them can't resume without them.
   */
  private computerUse(): ComputerUse | undefined {
    if (this.runAs || CLOUD) return
    if (WINDOWS) return windowsComputer(this.windowsDesktop().exec, this.computerBase())
    const linux = process.platform === 'linux'
    if (!linux && process.platform !== 'darwin') return
    if (linux && !computerUseApp() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return
    const client = computerUseClient()
    /** On Linux, the helper reads apps through the runner's agent-desktop: its path goes along. */
    const withAgentDesktop = async (method: string, signal?: AbortSignal) => {
      if (!linux || ['status', 'cancel', 'stop', 'run', 'capture'].includes(method)) return {}
      const binary = await ensureAgentDesktop(signal ? { signal } : {}).catch(() => undefined)
      return binary ? { agentDesktop: binary.path } : {}
    }
    return {
      request: async (method, params, signal, options) => {
        const session = this.computerSession()
        if (this.computerStopped === session.id)
          throw new ComputerUseError(
            'stopped',
            "The person pressed Stop in the thread's panel. Don't use the computer again in this turn: " +
              'say so, and wait for their next message.',
          )
        if (!client)
          throw new ComputerUseError(
            'not_installed',
            linux
              ? 'Brigade.app is not installed on this computer, or has never been opened. Ask the ' +
                  'person to install Brigade.app for Linux and open it, then try again.'
              : 'Brigade Computer Use is not installed on this Mac. Ask the person to install Brigade.app ' +
                  '(it includes it), then try again.',
          )
        return client.request(
          method,
          { ...params, ...(await withAgentDesktop(method, signal)), session },
          signal,
          options,
        )
      },
      ...this.computerBase(),
    }
  }

  /** What computer use on a member's computer needs beside its requests. */
  private computerBase(): Omit<ComputerUse, 'request'> {
    return {
      workDir: this.workDir,
      env: () => harnessEnv(),
      screenshotPath: () => {
        const path = `images/screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
        return { path, absolute: join(this.workDir, path) }
      },
      share: (path, toolCallId) =>
        this.emit({
          type: 'image.generated',
          path,
          toolCallId,
          prompt: 'Screenshot of the screen',
        }),
      seen: (path, display) => {
        clearTimeout(this.glanceTimer)
        this.display = display
        this.emit({ type: 'computer.screen', path })
      },
      acted: () => {
        if (!computerUseClient()) return
        clearTimeout(this.glanceTimer)
        this.glanceTimer = setTimeout(() => void this.glance(), GLANCE_MS)
      },
    }
  }

  /** Who acts on the member's Mac: this turn, by the teammate's name (the pill shows it). */
  private computerSession() {
    return { id: `${this.key}:${this.prompts}`, label: this.spec.teammate.name }
  }

  /**
   * The member's Mac just after the teammate acted on it, for the thread's panel: smaller than
   * a screenshot it takes, and the teammate never sees it.
   */
  private async glance() {
    const client = computerUseClient()
    const session = this.computerSession()
    if (!client || this.computerStopped === session.id) return
    // One at a time: the action after it gets its own.
    if (this.glancing) {
      this.glanceTimer = setTimeout(() => void this.glance(), GLANCE_MS)
      return
    }
    this.glancing = true
    try {
      const dir = join(this.workDir, GLANCES)
      const name = new Date().toISOString().replace(/[:.]/g, '-')
      let path = `${GLANCES}/${name}.jpg`
      const shot = (await client.request('screenshot', {
        path: join(this.workDir, path),
        display: this.display,
        format: 'jpeg',
        maxWidth: 1440,
        session,
      })) as { format?: string }
      // A helper from before JPEG wrote a PNG.
      if (shot.format !== 'jpeg') {
        const png = `${GLANCES}/${name}.png`
        await rename(join(this.workDir, path), join(this.workDir, png))
        path = png
      }
      this.emit({ type: 'computer.screen', path, glance: true })
      const old = (await readdir(dir)).sort().slice(0, -GLANCES_KEPT)
      await Promise.all(old.map((file) => rm(join(dir, file), { force: true })))
    } catch {
      // Stopped, busy with another thread, or no permission: the teammate's own calls say so.
    } finally {
      this.glancing = false
    }
  }

  /** Stop from the thread's panel: no more computer use in this turn, as with the pill's Stop. */
  async stopComputer() {
    const session = this.computerSession()
    this.computerStopped = session.id
    clearTimeout(this.glanceTimer)
    // Hides the pill. A helper from before this has no stop: its pill hides by itself.
    await computerUseClient()
      ?.request('stop', { session })
      .catch(() => {})
  }

  /**
   * On a member's Windows PC: agent-desktop run by the runner, which runs in the person's session
   * (windows-computer.ts), beside the screen tools.
   */
  private windowsDesktop(): Desktop {
    return {
      exec: localDesktopExec(
        async (signal) => (await ensureAgentDesktop(signal ? { signal } : {})).path,
      ),
      where: 'windows',
    }
  }

  /**
   * An interrupted turn's commands end with it. Codex on Windows ends the turn but not the
   * command it runs (a write it was about to make would land after Stop, or in the next turn).
   */
  private async endCommands(live: Live | undefined) {
    if (!WINDOWS || !live) return
    await live.sandbox
      .stopCommands()
      .catch((error: unknown) =>
        console.warn(
          `${this.key}: could not end the interrupted turn's commands: ${errorMessage(error)}`,
        ),
      )
  }

  /** On a member's Mac: agent-desktop through Brigade Computer Use, beside the other computer tools. */
  private macDesktop(computer: ComputerUse): Desktop {
    return {
      exec: macDesktopExec(computer, (signal) => ensureAgentDesktop(signal ? { signal } : {})),
      where: 'mac',
    }
  }

  /**
   * On a cloud computer: agent-desktop as the teammate's own user on the desktop, where its
   * browser's windows are, and the desktop's keyboard into them. Its browser is started first, as
   * a browser tool call starts it: the helper starts the teammate's own accessibility bus with it.
   */
  private cloudDesktop(): Desktop | undefined {
    const user = this.runAs
    if (!user || process.platform !== 'linux') return
    return {
      exec: teammateDesktopExec(
        user,
        async (signal) => (await ensureAgentDesktop(signal ? { signal } : {})).path,
      ),
      where: 'cloud',
      ready: async () => {
        touchBrowser(this.spec.teammate.id)
        await ensureBrowser(this.spec.teammate)
      },
      keyboard: teammateKeyboard(user),
    }
  }

  /** generate_image: an image by Codex, on the starter's Codex account, kept like Codex's own. */
  private async makeImage(input: Parameters<ImageMaker>[0], signal?: AbortSignal) {
    const account = this.spec.imageAccount
    if (!account)
      throw new Error('The person who started this thread has no Codex account with usage left')
    const image = await generateImage({
      account,
      sessionId: this.spec.sessionId,
      teammateId: this.spec.teammate.id,
      workDir: this.workDir,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      prompt: input.prompt,
      references: input.references.map((file) => resolvePath(this.workDir, file)),
      ...(signal ? { signal } : {}),
    })
    const path = await this.keepImage({ toolCallId: input.toolCallId, ...image })
    if (!path)
      throw new Error('Codex made the image, but it could not be copied into the working directory')
    return { path, ...(image.prompt ? { prompt: image.prompt } : {}) }
  }

  /** A person's answer as the result of the question tool that asked it. */
  private answerResult(
    questionId: string,
    answer: QuestionAnswer,
    call = this.toolCalls.get(questionId),
  ) {
    const questions = call?.toolName === ASK_USER_TOOL ? askUserQuestions(call.input) : undefined
    return {
      type: 'tool-result' as const,
      toolCallId: questionId,
      toolName: call?.toolName ?? QUESTION_TOOL,
      output: {
        type: 'json' as const,
        value: (questions ? askUserResult(questions, answer) : answer) as never,
      },
    }
  }

  /**
   * Close the saved turn that waits on a person (closed-turn.ts), keeping the calls it
   * waited on: after a restart, this process has not seen them. False when it can't be
   * closed so, or on Codex, which keeps continuing it.
   */
  private closeTurn() {
    if (
      this.spec.teammate.harness === 'codex' ||
      this.spec.teammate.harness === 'pi' ||
      this.spec.teammate.harness === 'antigravity' ||
      !this.saved
    )
      return false
    const closed = closeTurn(this.saved.resume)
    if (!closed) return false
    for (const { toolCallId, ...call } of closed.waiting)
      if (!this.toolCalls.has(toolCallId)) this.toolCalls.set(toolCallId, call)
    for (const { approvalId, ...call } of closed.approvals)
      if (!this.approvals.has(approvalId)) this.approvals.set(approvalId, call)
    this.saved = { ...this.saved, resume: closed.resume }
    return true
  }

  /** A person's answer as the result of the open_ticket call that opened the ticket. */
  private ticketResult(
    requestId: string,
    answer: TicketAnswer,
    call = this.toolCalls.get(requestId),
  ) {
    const asks = ticketAsks(call?.input)?.asks ?? []
    return {
      type: 'tool-result' as const,
      toolCallId: requestId,
      toolName: OPEN_TICKET_TOOL,
      output: { type: 'json' as const, value: ticketResult(asks, answer) as never },
    }
  }

  /**
   * The harness no longer has the conversation it was to resume (EventMapper.sessionLost):
   * the thread goes on in a new session on this computer, whose first message is what was said
   * so far, then `said`, what the turn had to tell the lost one besides.
   */
  private async startAnew(said: string | undefined, why?: string) {
    const saved = (this.saved ??= { accountId: this.current.id, transcript: [] })
    // Gone with that conversation: the turn it was in, and any harness it was handed over in.
    delete saved.resume
    delete saved.handedOver
    // Still in this turn (parking said otherwise): a stop without warning continues it.
    saved.inTurn = true
    await this.persist()
    const name = this.spec.teammate.name
    if (!why)
      this.emit({
        type: 'raw',
        source: 'runner',
        value: `${name}'s previous session was no longer on this computer, so ${name} carries on in a new one, from the thread's conversation.`,
      })
    const handoff = this.handoff(
      why ??
        'This conversation continues in a new session because the previous one was no longer on this computer (Claude Code deletes old conversations).',
    )
    return said ? `${handoff}\n\n${said}` : handoff
  }

  /**
   * Move the thread to another account: a new harness session in the same
   * working directory, whose first message is a handoff summary.
   */
  private async switchTo(
    account: AccountRef,
    reason: 'usage_limit' | 'unavailable',
    resetsAt: string | null,
  ) {
    const from = this.saved?.accountId ?? this.current.id
    await this.drop()
    // The new session signs in with the spec's account (attach): without this, a switch
    // mid-turn started it on the account that had just run out.
    this.spec = { ...this.spec, account }
    this.emit({
      type: 'account.switched',
      fromAccountId: from,
      toAccountId: account.id,
      reason,
      resetsAt,
    })
    this.saved = {
      ...(this.saved?.recoveries ? { recoveries: this.saved.recoveries } : {}),
      // Still open for the person: their answer comes to the new session as a message.
      ...(this.saved?.later?.length ? { later: this.saved.later } : {}),
      // The turn goes on there: its answer to the message steered in last still answers it.
      ...(this.saved?.steered ? { steered: this.saved.steered } : {}),
      accountId: account.id,
      transcript: this.saved?.transcript ?? [],
    }
    await this.persist()
    return this.handoff(
      'This conversation continues in a new session because the previous one could not go on (its account ran out of usage).',
    )
  }

  /**
   * The teammate moved to another harness: its conversation is the old one's, which this one
   * cannot resume. A new session, on the spec's account, is told the conversation so far.
   */
  private async newHarness(spec: ThreadSpec) {
    await this.drop()
    this.saved = {
      ...(this.saved?.recoveries ? { recoveries: this.saved.recoveries } : {}),
      ...(this.saved?.later?.length ? { later: this.saved.later } : {}),
      ...(this.saved?.steered ? { steered: this.saved.steered } : {}),
      accountId: spec.account.id,
      transcript: this.saved?.transcript ?? [],
    }
    await this.persist()
    return this.handoff(
      `This conversation continues in a new session because you now run on ${harnessName(spec.teammate.harness)}.`,
    )
  }

  /**
   * The thread moved to this computer: what this computer kept of it from
   * before is out of date. Its session starts again from the thread's
   * conversation so far, on the account chosen here.
   */
  private async arrive(moved: NonNullable<ThreadSpec['moved']>) {
    await this.drop()
    const transcript = await this.context
      .conversation(this.spec.sessionId, this.spec.teammate.id)
      .catch((error: unknown) => {
        console.warn(`could not fetch the conversation of ${this.key}: ${errorMessage(error)}`)
        return [] as Transcript
      })
    this.saved = {
      accountId: this.spec.account.id,
      transcript,
      movedAt: moved.at,
      arrivedFrom: moved.from,
    }
    await this.persist()
  }

  /**
   * The first message of a new session that carries on the conversation: what
   * was said so far. `where`: what to say of the working directory, if anything.
   */
  private handoff(
    why: string,
    where: string | null = 'The working directory is exactly as the previous session left it.',
  ) {
    const transcript = this.saved?.transcript ?? []
    const lines = transcript
      .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`)
      .join('\n\n')
    const last = transcript.findLast((t) => t.role === 'user')
    // The latest request, kept whole (asked), may have left a transcript cut to its last
    // TRANSCRIPT_CHARS: a long message (pasted logs, say) followed by a few replies.
    const asked = this.saved?.asked
    const lost = asked && !transcript.some((t) => t.role === 'user' && t.text === asked)
    return [
      why,
      where,
      lines && `Conversation so far:\n\n${lines}`,
      lost && `${LATEST_REQUEST}\n\n${asked}`,
      (last || lost) && `Continue with the latest request if it is not finished yet.`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  /**
   * A browser tool call starts the teammate's browser when it is not running: the browser relay
   * waits for it. Each call keeps it from being stopped as unused.
   */
  private browserUsed(toolName: string) {
    if (!this.runAs || !isBrowserTool(toolName)) return
    if (this.browserStarting) return touchBrowser(this.spec.teammate.id)
    this.browserStarting = true
    void ensureBrowser(this.spec.teammate)
      .catch((error) => console.warn(`no browser for ${this.runAs}: ${errorMessage(error)}`))
      .finally(() => (this.browserStarting = false))
  }

  private async attach(): Promise<Live> {
    if (this.live) return this.live
    const account = this.spec.account
    if (account.provider !== 'antigravity') return this.attachHolding(account)
    // A Google account's session holds it from its preparation to its sandbox's end: a removal
    // waits for it, and refuses one that starts after it (holdAccount, cleanRemoved).
    const hold = holdAccount(account.id)
    try {
      refuseRemoved(account)
      return await this.attachHolding(account, hold.release)
    } catch (error) {
      hold.release()
      throw error
    }
  }

  private async attachHolding(account: AccountRef, release?: () => void): Promise<Live> {
    const env = {
      ...(await prepare(this.workDir, account, this.spec.sessionId, this.runAs)),
      ...gitEnv(this.spec.git),
    }
    // On a cloud computer the teammate has its own browser, signed in where a person signed it in.
    // It starts at the first browser tool call (browserUsed), not with every turn.
    let browserError: string | undefined
    const browser = this.runAs
      ? await browserPort(this.spec.teammate.id)
          .then(async (port) => {
            // In the thread's own network, its loopback is its own: the browser's port is bridged in.
            const net = await threadNet(this.spec.sessionId)
            if (net) await bridgeBrowser(net, this.runAs!)
            return port
          })
          .catch((error) => {
            browserError = errorMessage(error)
            console.warn(`no browser for ${this.runAs}: ${browserError}`)
            return null
          })
      : null
    const tabsFile =
      browser && this.runAs ? threadTabsFile(this.runAs, this.spec.sessionId) : undefined
    const libraryDir = await this.context.libraryDir(this.spec.teammate.id)
    // Memory loads through the harness's own instruction file: each memory's core, and its
    // topics as files beside it, read when the work touches them.
    const memory = threadMemory(
      this.spec,
      this.context.memoryFor(this.spec.teammate.id),
      this.workDir,
    )
    this.loaded = memoryKeys(memory)
    await writeMemoryFiles(this.workDir, threadTopicFiles(memory, this.spec), this.runAs).catch(
      (error) => console.warn(`could not write memory topics: ${errorMessage(error)}`),
    )
    const text = instructions(
      this.spec,
      memory,
      libraryDir,
      tabsFile
        ? { ready: true }
        : { ready: false, ...(browserError ? { error: browserError } : {}) },
    )
    await writeInstructions(this.workDir, this.spec, text, this.runAs).catch((error) =>
      console.warn(`could not write instructions: ${errorMessage(error)}`),
    )
    // Skills through the harness's own skills folder: Brigade's, then the workspace's.
    const skills = [...builtinSkills(this.spec, libraryDir), ...(this.spec.skills ?? [])]
    await writeSkills(this.workDir, this.spec, skills, this.context.skillFile, this.runAs).catch(
      (error) => console.warn(`could not write skills: ${errorMessage(error)}`),
    )
    const onPi = this.spec.teammate.harness === 'pi'
    const credentials = new ThreadCredentials({
      sessionId: this.spec.sessionId,
      request: this.requestCredential,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      ...(browser && tabsFile ? { browser: { port: browser, tabsFile } } : {}),
      readFile: (file) => this.readFile(file, 1024 * 1024, 'A secret file'),
    })
    const computer = this.computerUse()
    const { agent, tools, specs, apps } = createAgent(
      this.spec,
      (call) => this.callWithFiles(call),
      credentials,
      browser && tabsFile
        ? {
            browser: onPi
              ? await piMcpServer(
                  browserMcpServer(browser, tabsFile),
                  this.runAs,
                  this.spec.sessionId,
                )
              : browserMcpServer(browser, tabsFile, {
                  lazy:
                    this.spec.teammate.harness !== 'codex' &&
                    this.spec.teammate.harness !== 'antigravity',
                }),
          }
        : {},
      {
        access: this.spec.library,
        folders: this.spec.libraryFolders,
        libraryDir,
        call: this.context.callLibrary,
        readFile: (file) => this.readFile(file),
        stageFile: (file) => this.stageFile(file, LIBRARY_FILE_MAX, 'Files saved to the library'),
        listFiles: (folder) => listAs(resolvePath(this.workDir, folder), this.runAs),
        renderDesign: (folder, options) =>
          renderDesign(resolvePath(this.workDir, folder), this.runAs, options),
        tools: this.spec.tools,
      },
      async (request) => {
        const result = await checkout({
          // The latest spec: its git token is the freshest.
          spec: this.spec,
          workDir: this.workDir,
          request,
          bundles: this.context.bundles,
          ...(this.runAs ? { runAs: this.runAs } : {}),
        })
        // On a member's machine, the member's .env and the like, from their own clone.
        const copied = this.runAs
          ? []
          : await copyIncluded(result.directory, request.repository).catch(() => [])
        return copied.length
          ? {
              ...result,
              copied,
              copiedNote: `From the member's own clone, as the repository's .worktreeinclude says: ${copied.join(', ')}. They are theirs: keep them out of commits.`,
            }
          : result
      },
      async (call) =>
        reportWithFiles(this.reportsWhenDone(await this.themeFileCall(call)), {
          read: (file, max) => this.readFile(file, max, 'Files sent with a report'),
          upload: (name, bytes) =>
            this.context.uploadFile({
              sessionId: this.spec.sessionId,
              teammateId: this.spec.teammate.id,
              name,
              bytes,
            }),
          send: this.context.callSchedule,
        }),
      this.context.preview,
      this.spec.imageAccount ? (input, signal) => this.makeImage(input, signal) : undefined,
      computer,
      computer
        ? WINDOWS
          ? this.windowsDesktop()
          : this.macDesktop(computer)
        : this.cloudDesktop(),
      this.context.machine,
      this.arrivals,
      (call) => this.openAsk(call),
      onPi
        ? { instructions: text, skills: piSkills(this.workDir, skills), pi: await loadPi() }
        : undefined,
      // Its latest spec's: an agent kept across turns sees a flag changed since it was made.
      () => this.spec.closedApps,
    )
    const adopt = await this.takeHandedOver(account)
    const sandbox = createLocalSandboxSession({
      id: this.key,
      workingDirectory: this.workDir,
      port: await freePort(),
      // The runner, not Claude Code, asks for a reply the turn did not give (ReplyWatch). After
      // each turn, Claude Code guesses the person's next message where the thread wants it.
      env:
        this.spec.teammate.harness === 'codex' ||
        this.spec.teammate.harness === 'pi' ||
        this.spec.teammate.harness === 'antigravity'
          ? env
          : {
              ...env,
              ...terminalTools(tools),
              // Claude Code's own schedules, memory and the like are off (claude-settings.ts).
              ...claudeSettingsEnv(),
              ...(this.spec.suggestions ? { BRIGADE_PROMPT_SUGGESTIONS: '1' } : {}),
            },
      ...(this.runAs ? { runAs: this.runAs, thread: this.spec.sessionId } : {}),
      // Pi's adapter runs bash in it (its file tools): dash, Ubuntu's sh, refuses that.
      ...(this.spec.teammate.harness === 'pi' ? { shell: 'bash' as const } : {}),
      // The harness the runner before handed over, which this session attaches to: stopped with it.
      ...(adopt.length ? { adopt } : {}),
    })
    if (release) {
      const destroy = sandbox.destroy.bind(sandbox)
      // Its own object (createLocalSandboxSession), whose type says its methods are read-only.
      ;(sandbox as unknown as { destroy: () => Promise<void> }).destroy = async () => {
        try {
          return await destroy()
        } finally {
          release()
        }
      }
    }
    const saved = savedResume(this.saved, this.spec, account)
    const resume = saved ? withTools(saved, tools) : undefined
    const session = await agent.createSession({
      sessionId: this.key,
      sandboxSession: sandbox,
      ...(resume ? { resumeFrom: resume as never } : {}),
    })
    // A Google account removed while the session started (account.remove): it does not go on.
    if (account.provider === 'antigravity' && isRemoved(account.id)) {
      await session.destroy().catch(() => undefined)
      await sandbox.destroy()
      refuseRemoved(account)
    }
    sandbox.dropAdopted()
    return this.begin(
      {
        agent,
        session,
        sandbox,
        account,
        credentials,
        harness: this.spec.teammate.harness,
        made: agentKey(this.spec),
      },
      specs,
      resume,
      apps,
    )
  }

  /** The session started, resuming `resume` if any, with tools as `specs` defines them. */
  private begin(
    live: Omit<Live, 'tools'>,
    specs: ToolSpec[],
    resume: unknown,
    apps: ReadonlySet<string> = new Set(),
  ): Live {
    this.frozen = frozenMidRun(resume)
    // A resumed conversation keeps the tool definitions it was given (tool-changes.ts): those
    // changed since go in the next message. One saved before Brigade kept them is given Brigade's
    // own as they are now, once. A new one is given them all as they are now, and told nothing.
    const known = resume ? this.saved?.tools : undefined
    const unsure = !!resume && !known
    const digests = toolDigests(specs)
    this.live = {
      ...live,
      tools: {
        digests,
        changed: unsure ? toolsOfUnknownAge(specs, apps) : changedTools(known, specs),
        ...(unsure ? { unsure } : {}),
      },
    }
    this.saved = {
      transcript: [],
      ...this.saved,
      accountId: live.account.id,
      // Recorded once the turn that tells them ran (run), for a conversation that may not have them.
      ...(resume ? {} : { tools: digests }),
    }
    return this.live
  }

  /**
   * A connector call that sends files (an email's attachments, a Drive upload, a file an MCP
   * App gets a link to): the teammate names them by path, a list or a single one; they go to
   * the bucket first, and the call carries their ids in the same shape.
   */
  private async callWithFiles(call: Parameters<ConnectorCaller>[0]) {
    const operation = this.spec.connectors
      .find((c) => c.connectionId === call.connectionId)
      ?.operations.find((o) => o.name === call.operation)
    const input = call.input as Record<string, unknown> | null
    const sent = await withUploads(input, filesFieldsOf(operation), async (file) =>
      this.context.uploadFile({
        sessionId: this.spec.sessionId,
        teammateId: this.spec.teammate.id,
        name: basename(file),
        bytes: await this.readFile(file, ATTACHMENT_MAX, 'Files sent with a call'),
      }),
    )
    return this.callConnector(sent === input ? call : { ...call, input: sent })
  }

  /**
   * A file the teammate names, read as it sees it: as its user, and from its thread's own
   * /tmp in the thread's namespaces (thread-net.ts, readCommand). Relative to its folder.
   */
  private async readFile(file: string, max?: number, what?: string) {
    const net = this.runAs ? await threadNet(this.spec.sessionId) : null
    return readAs(
      resolvePath(this.workDir, file),
      this.runAs,
      max,
      what,
      net?.isolated ? net.thread : undefined,
    )
  }

  /**
   * A file the teammate names, read as readFile reads it but staged on this computer as it
   * comes, never held whole: sent from there as it streams (uploads.ts).
   */
  private async stageFile(file: string, max: number, what: string) {
    const net = this.runAs ? await threadNet(this.spec.sessionId) : null
    const [command, args] = readCommand(
      resolvePath(this.workDir, file),
      max,
      this.runAs,
      net?.isolated ? net.thread : undefined,
    )
    const child = spawn(command, args, { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString()
    })
    const exited = new Promise<number | null>((done) => {
      child.on('close', done)
      child.on('error', (error) => {
        stderr ||= error.message
        done(null)
      })
    })
    try {
      const staged = await stageStream(child.stdout, max, what)
      const code = await exited
      if (code !== 0) {
        await rm(staged.path, { force: true })
        throw new Error(`Could not read ${file}: ${stderr.trim() || `it ended with ${code}`}`)
      }
      return staged
    } catch (error) {
      child.kill()
      throw error
    }
  }

  /** After a failure: save what can be saved, so the next message starts clean. */
  private async drop() {
    const live = this.live
    await this.park().catch(async () => {
      await live?.session.destroy().catch(() => undefined)
      await live?.sandbox.destroy()
      // Its process gone without a stop (the memory guard killed it, it crashed) before any
      // stop kept the conversation: the next session continues what the harness wrote of it,
      // as after a restart (recover), rather than start a new one without it.
      const resume = this.saved?.resume ?? resumable(this.spec.teammate.harness, undefined)
      if (this.saved && resume && this.saved.resume !== resume) {
        this.saved.resume = resume
        await this.persist()
      }
    })
  }

  private async load() {
    if (this.saved) return
    this.saved = await readFile(this.stateFile, 'utf8').then(
      (text) => {
        const parsed = JSON.parse(text) as SavedState & { type?: string }
        // State written before accounts existed held only the resume payload.
        return parsed.accountId
          ? parsed
          : { accountId: this.spec.account.id, resume: parsed, transcript: [] }
      },
      () => undefined,
    )
    for (const { toolCallId, ...call } of [
      ...(this.saved?.waiting ?? []),
      ...(this.saved?.handedOver?.calls ?? []),
    ])
      if (!this.toolCalls.has(toolCallId)) this.toolCalls.set(toolCallId, call)
    for (const [id, text] of this.saved?.handedOver?.texts ?? []) this.texts.set(id, text)
    for (const [id, text] of this.saved?.handedOver?.reasoning ?? []) this.reasoning.set(id, text)
    for (const { approvalId, ...call } of this.saved?.approvals ?? [])
      if (!this.approvals.has(approvalId)) this.approvals.set(approvalId, call)
  }

  /**
   * Save the state as it is now. Writes go in order, each whole: a stop
   * without warning leaves the previous state or this one, never half of each.
   */
  private persist() {
    if (!this.saved) return Promise.resolve()
    // Readable by a runner from before this one too, should it be rolled back (closed-turn.ts).
    const text = JSON.stringify({
      ...this.saved,
      resume: readableByOlderRunners(this.saved.resume),
    })
    const write = async () => {
      await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 })
      const temp = `${this.stateFile}.${randomUUID()}.tmp`
      await writeFile(temp, text, { mode: 0o600 })
      await rename(temp, this.stateFile)
    }
    const saved = this.saving.then(write, write)
    this.saving = saved.catch(() => undefined)
    return saved
  }

  private remember(role: 'user' | 'assistant', text: string) {
    if (!this.saved) this.saved = { accountId: this.spec.account.id, transcript: [] }
    const transcript = [...this.saved.transcript, { role, text }]
    while (transcript.length > 1 && JSON.stringify(transcript).length > TRANSCRIPT_CHARS)
      transcript.shift()
    this.saved.transcript = transcript
  }

  private emit(event: DistributiveOmit<AgentEvent, 'at'>) {
    const stamped = { ...event, at: new Date().toISOString() } as AgentEvent
    this.noteBackground(stamped)
    this.outbox.send(stamped)
  }

  /**
   * An event as it goes out, with the turn's tool stats (for the harness benchmark): each finished
   * tool call counts, the harness's own as much as the runner's, and the turn's end says how many
   * went out before it, held ones (a done block's call) included.
   */
  private out(event: AgentEvent) {
    if (event.type === 'tool.finished') {
      this.toolStats.calls++
      if (event.isError) this.toolStats.errors++
    }
    this.emitEvent(
      event.type === 'turn.completed'
        ? { ...event, toolCalls: this.toolStats.calls, toolErrors: this.toolStats.errors }
        : event,
    )
  }

  /** What the turn runs in the background now, from its events (background.ts). */
  private noteBackground(event: AgentEvent) {
    const background = backgroundTasks(event)
    if (background) {
      // The last of its work ended: what it reports may take a while to come (staleWait).
      if (background.length === 0 && this.background.length > 0) this.quietSince = Date.now()
      this.background = background
    }
    const waiting = backgroundWait(event)
    if (waiting !== undefined)
      this.waitingSince = waiting ? (this.waitingSince ?? Date.now()) : undefined
    if (event.type === 'turn.completed' || event.type === 'error') {
      this.background = []
      this.waitingSince = undefined
      this.quietSince = undefined
      this.steeredPending = false
    }
  }

  /** A child's report waits for the teammate's own sub-agents (reportWaitsFor). */
  /**
   * theme_add_file names a file of the teammate's: read as the teammate sees it, it goes to the
   * bucket first, and the call names the upload (docs/themes.md).
   */
  private async themeFileCall(
    call: Parameters<ScheduleCaller>[0],
  ): Promise<Parameters<ScheduleCaller>[0]> {
    const { operation } = call
    if (operation.name !== 'theme_add_file' || operation.upload) return call
    const upload = this.context.uploadThemeFile
    if (!upload) throw new Error("This computer's Brigade cannot send theme files yet.")
    const staged = await this.stageFile(operation.path, THEME_LIMITS.fileBytes, 'Theme files')
    try {
      const id = await upload({
        sessionId: this.spec.sessionId,
        teammateId: this.spec.teammate.id,
        name: basename(operation.path),
        file: staged,
      })
      return { ...call, operation: { ...operation, upload: { id } } }
    } finally {
      await rm(staged.path, { force: true })
    }
  }

  private reportsWhenDone(call: Parameters<ScheduleCaller>[0]) {
    const waits = call.operation.name === 'report' ? reportWaitsFor(this.background) : undefined
    if (waits) throw new Error(waits)
    return call
  }

  /**
   * The turn is over. With an ask set aside still open, the teammate still waits on the person.
   * An answer kept for a decision and not given yet counts too: a runner that stops before
   * giving it finds the thread in progress, and gives it then (Threads.pickUp).
   */
  private completed(finishReason: string) {
    this.emit({
      type: 'turn.completed',
      finishReason,
      ...(this.saved?.later?.length ? { waiting: true } : {}),
      // Its tool stats are set as it goes out (out), after the calls sent before it.
    })
  }
}

/**
 * The working directory and harness environment for an account: on a cloud
 * computer the teammate's own Linux user, home and private config directory.
 */
async function prepare(workDir: string, account: AccountRef, sessionId: string, runAs?: string) {
  if (!runAs) {
    await mkdir(workDir, { recursive: true })
    return harnessEnv({
      ...accountEnv(account),
      ...(account.provider === 'antigravity'
        ? await antigravityEnv({ account, accountDir: accountDir(account), home: homedir() })
        : {}),
      COMPOSE_PROJECT_NAME: composeProject(sessionId),
    })
  }
  await ensureUser(runAs)
  await execFileAsync('sudo', ['-n', '-u', runAs, 'mkdir', '-p', workDir], { cwd: '/' })
  if (account.provider === 'antigravity') {
    // No shared bridge nor linked config folder: its login is copied into the teammate's own.
    if (account.source !== 'brigade')
      throw new Error('Only accounts signed in through Brigade can run on a cloud computer')
    const home = teammateHome(runAs)
    return harnessEnv({
      ...(await antigravityEnv({ account, accountDir: accountDir(account), home, runAs })),
      ...(await containerEnv(runAs, sessionId)),
      HOME: home,
      USER: runAs,
      LOGNAME: runAs,
    })
  }
  // Its bridge from the copy all teammates share, else installed in its home as before.
  await useSharedBridge(runAs, account.provider === 'codex' ? 'codex' : 'claude-code')
  const home = teammateHome(runAs)
  return harnessEnv({
    ...(await linkAccount(runAs, account)),
    ...accountToken(account),
    ...(await containerEnv(runAs, sessionId)),
    HOME: home,
    USER: runAs,
    LOGNAME: runAs,
  })
}

/** Most a teammate saves to the library in one call. */
const READ_MAX = 10 * 1024 * 1024

/** Read a file as the teammate's user (or as this user on a member's machine), up to `max` bytes. */
async function readAs(
  file: string,
  runAs?: string,
  max = READ_MAX,
  what = 'Files saved to the library',
  /** Its thread, when it has namespaces of its own: its /tmp is read in them (readCommand). */
  thread?: string,
): Promise<Buffer> {
  const [command, args] = readCommand(file, max, runAs, thread)
  const { stdout } = await execFileAsync(command, args, {
    cwd: '/',
    encoding: 'buffer',
    maxBuffer: max + 1024,
  }).catch((error: unknown) => {
    throw new Error(`Could not read ${file}: ${errorMessage(error)}`)
  })
  if (stdout.byteLength > max)
    throw new Error(`${what} can be up to ${Math.round(max / (1024 * 1024))} MB`)
  return stdout
}

const SHOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  `design-shot${extname(fileURLToPath(import.meta.url))}`,
)

/**
 * Render a design with the computer's Chrome, as the teammate: screenshots
 * next to its folder (in `.design-shots/<name>`), and the errors its page logged.
 */
async function renderDesign(
  folder: string,
  runAs: string | undefined,
  options: { viewports?: string[]; shots?: boolean; thumbnail?: boolean },
): Promise<ShotResult> {
  const dir = folder.replace(WINDOWS ? /[\\/]+$/ : /\/+$/, '')
  const input = JSON.stringify({
    folder: dir,
    out: join(dirname(dir), '.design-shots', basename(dir)),
    ...options,
  })
  const args = [SHOT, input]
  const { stdout } = await execFileAsync(
    runAs ? 'sudo' : process.execPath,
    runAs ? ['-n', '-u', runAs, process.execPath, ...args] : args,
    { cwd: '/', timeout: 180_000, maxBuffer: 1024 * 1024 },
  ).catch((error: { stderr?: string } & Error) => {
    throw new Error(
      `Could not render the design: ${(error.stderr || errorMessage(error)).trim().slice(0, 1000)}`,
    )
  })
  return JSON.parse(stdout) as ShotResult
}

/** The files under a folder, as the teammate on a cloud computer: paths relative to it. */
async function listAs(folder: string, runAs?: string): Promise<string[]> {
  const dir = folder.replace(WINDOWS ? /[\\/]+$/ : /\/+$/, '')
  const args = [dir, '-type', 'f', '-print0']
  const { stdout } = await execFileAsync(
    runAs ? 'sudo' : 'find',
    runAs ? ['-n', '-u', runAs, 'find', ...args] : args,
    { cwd: '/', maxBuffer: 4 * 1024 * 1024 },
  ).catch((error: unknown) => {
    throw new Error(`Could not read the folder ${folder}: ${errorMessage(error)}`)
  })
  return stdout
    .split('\0')
    .filter((p) => p.startsWith(`${dir}/`))
    .map((p) => p.slice(dir.length + 1))
    .sort()
}

/** A path a teammate names, from its folder. On Windows, C:\…, Git Bash's /c/… or relative. */
const resolvePath = (workDir: string, file: string) =>
  WINDOWS ? toNative(file, workDir) : file.startsWith('/') ? file : join(workDir, file)

/**
 * One short harness run outside any thread, with no tools: a prompt in, its
 * final text out. Used to take memory from a thread that went quiet, to name a
 * new one, and to write a new project's brief from its website.
 */
export async function runOnce(input: {
  /** A thread's spec, or for a run of no thread an id to name it by, the account and harness. */
  spec: Pick<ThreadSpec, 'sessionId' | 'account'> & {
    teammate: Pick<ThreadSpec['teammate'], 'harness' | 'model'>
  }
  /**
   * Not even the harness's built-in tools (reading files, search): for a prompt
   * that holds text from outside, such as a website, which could ask for them.
   */
  noTools?: boolean
  workDir: string
  runAs?: string
  prompt: string
  signal: AbortSignal
  /** Instead of the teammate's model. */
  model?: string
  /** Names the run's session and sandbox, after the thread's id. */
  purpose?: string
  /** What the run is for, and the thread, when it is one's: its usage is reported (usage.ts). */
  usage: { kind: UsageRunKind; sessionId?: string; teammateId?: string }
}): Promise<string> {
  const { spec, workDir, runAs, purpose = 'memory' } = input
  // A Google account is held for the run (a removal waits for it, and stops it).
  if (spec.account.provider !== 'antigravity') return runHolding(input, input.signal)
  const hold = holdAccount(spec.account.id)
  try {
    refuseRemoved(spec.account)
    return await runHolding(input, AbortSignal.any([input.signal, hold.signal]))
  } finally {
    hold.release()
  }
}

async function runHolding(input: Parameters<typeof runOnce>[0], signal: AbortSignal) {
  const { spec, workDir, runAs, purpose = 'memory' } = input
  const env = {
    ...(await prepare(workDir, spec.account, spec.sessionId, runAs)),
    // Its prompt is read once: a one-hour cache write costs twice the input, a five-minute one 1.25 times.
    CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
  }
  // A Pi teammate's runs go to its login's own CLI (cliOf), as before Pi.
  const teammate = cliOf(spec.teammate)
  const codex = teammate.harness === 'codex'
  const settings = { auth: {} }
  const agent = new HarnessAgent({
    harness:
      teammate.harness === 'antigravity'
        ? createAntigravityHarness({ mcpServers: {} })
        : codex
          ? createCodex({ ...settings, codexConfig: CODEX_SETTINGS })
          : createClaudeCode(settings),
    tools: {},
    ...(input.noTools ? { activeTools: [] } : {}),
    ...(input.model ? { model: input.model } : withModel(teammate)),
    // Nothing to do but answer; Codex cannot ask, so it gets an empty directory.
    permissionMode: codex ? 'allow-all' : 'allow-reads',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: `${spec.sessionId}-${purpose}`,
    workingDirectory: workDir,
    port: await freePort(),
    env,
    ...(runAs ? { runAs, thread: spec.sessionId } : {}),
  })
  const session = await agent.createSession({
    sessionId: `${spec.sessionId}-${purpose}-${Date.now()}`,
    sandboxSession: sandbox,
  })
  try {
    // A Google account removed while the run started (account.remove): it does not go on.
    if (spec.account.provider === 'antigravity') refuseRemoved(spec.account)
    let text = ''
    const mapper = new EventMapper((event) => {
      if (event.type === 'message.done') text = event.text
      reportRunUsage(event, { ...input.usage, accountId: spec.account.id })
    })
    const result = await agent.stream({ session, prompt: input.prompt, abortSignal: signal })
    for await (const part of result.fullStream) mapper.map(part)
    if (mapper.exhausted) throw new Error('The account is out of usage')
    if (mapper.error) throw new Error(mapper.error)
    return text
  } finally {
    await session.destroy().catch(() => undefined)
    await sandbox.destroy()
  }
}

/** Longest a generate_image call waits for Codex. */
const IMAGE_TIMEOUT_MS = 5 * 60_000

/**
 * One image by Codex, for a teammate on another harness: a short Codex run on
 * the given account, in a folder of its own, told to use its image tool and
 * nothing else. Returns where Codex saved the image (in its own folder).
 */
export async function generateImage(input: {
  account: AccountRef
  sessionId: string
  workDir: string
  runAs?: string
  prompt: string
  /** Absolute paths of images to start from or match. */
  references: string[]
  signal?: AbortSignal
  /** The teammate whose generate_image call it is: its usage is reported (usage.ts). */
  teammateId?: string
}): Promise<{ savedPath: string; prompt?: string }> {
  const { account, runAs } = input
  // Its own empty folder: Codex runs without asking, and has nothing of the thread's to change.
  const dir = join(input.workDir, '.codex-image')
  const env = await prepare(dir, account, input.sessionId, runAs)
  const agent = new HarnessAgent({
    harness: createCodex({ auth: {}, codexConfig: CODEX_SETTINGS }),
    model: CODEX_DEFAULT_MODEL,
    tools: {},
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: `${input.sessionId}-image`,
    workingDirectory: dir,
    port: await freePort(),
    env,
    ...(runAs ? { runAs, thread: input.sessionId } : {}),
  })
  const session = await agent.createSession({
    sessionId: `${input.sessionId}-image-${Date.now()}`,
    sandboxSession: sandbox,
  })
  const prompt = [
    'Generate exactly one image with your image generation tool, as described below. ' +
      'Do nothing else: no other tools, no files, no commands, no questions.',
    input.references.length &&
      `First look at these images with your image viewer, and start from them or match them as the description says:\n${input.references.join('\n')}`,
    `Description:\n${input.prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const timeout = AbortSignal.timeout(IMAGE_TIMEOUT_MS)
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  try {
    let image: { savedPath: string; prompt?: string } | undefined
    let text = ''
    const mapper = new EventMapper((event) => {
      if (event.type === 'message.done') text = event.text
      reportRunUsage(event, {
        kind: 'image',
        accountId: account.id,
        sessionId: input.sessionId,
        ...(input.teammateId ? { teammateId: input.teammateId } : {}),
      })
    })
    const result = await agent.stream({ session, prompt, abortSignal: signal })
    for await (const part of result.fullStream) {
      mapper.map(part)
      const made = generatedImage(part)
      if (made)
        image = { savedPath: made.savedPath, ...(made.prompt ? { prompt: made.prompt } : {}) }
    }
    if (timeout.aborted) throw new Error('Codex took too long to make the image')
    if (mapper.exhausted) throw new Error('The Codex account is out of usage')
    if (mapper.error) throw new Error(mapper.error)
    if (!image) throw new Error(`Codex made no image${text ? `: ${text.slice(0, 500)}` : ''}`)
    return image
  } finally {
    await session.destroy().catch(() => undefined)
    await sandbox.destroy()
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
