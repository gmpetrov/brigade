// The harness layer. This directory is the only place in Brigade that imports
// the experimental AI SDK harness packages (spec: "keep every import inside
// one module of the runner package").
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessAgent, type HarnessAgentSession } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createCodex } from '@ai-sdk/harness-codex'
import {
  ATTACHMENT_MAX,
  CODEX_DEFAULT_MODEL,
  type AccountRef,
  type AgentEvent,
  OFFER_CHOICES_TOOL,
  PROPOSE_TEAM_TOOL,
  type QuestionAnswer,
  SHOW_WIDGET_TOOL,
  SUGGEST_REPLIES_TOOL,
  type ThreadSpec,
  type TicketAnswer,
  runModel,
  WIDGET_GUIDE_TOOL,
} from '@brigade/contracts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ShotResult } from '../design-shot.js'
import { accountEnv, accountToken } from '../accounts.js'
import { browserMcpServer, ensureBrowser } from '../browsers.js'
import { ComputerUseError, computerUseClient } from '../computer-use.js'
import { ThreadCredentials, type CredentialRequester } from '../credentials.js'
import { builtinSkills, instructions, writeInstructions } from '../instructions.js'
import { backup, checkout, gitEnv, type BundleStore, type CheckoutInput } from '../repos.js'
import { writeSkills } from '../skills.js'
import { containerEnv, ensureUser, linkAccount, teammateHome } from '../teammates.js'
import { harnessEnv } from './env.js'
import {
  askUserQuestions,
  askUserResult,
  errorMessage,
  EventMapper,
  generatedImage,
  QUESTION_TOOL,
  ticketAsks,
  ticketResult,
} from './events.js'
import { createLocalSandboxSession, freePort } from './local-sandbox.js'
import {
  ASK_USER_TOOL,
  alwaysLoaded,
  askUserTool,
  computerUseTools,
  connectorTools,
  credentialTools,
  imageTools,
  libraryTools,
  offerChoicesTool,
  OPEN_TICKET_TOOL,
  openTicketTool,
  previewTools,
  proposeTeamTool,
  repoTools,
  scheduleTools,
  showWidgetTool,
  suggestRepliesTool,
  taskTools,
  type ComputerUse,
  type ConnectorCaller,
  type ImageMaker,
  type LibraryCaller,
  type PreviewTools,
  type ScheduleCaller,
  type TaskCaller,
  widgetGuideTool,
} from './tools.js'

export type {
  ConnectorCaller,
  LibraryCaller,
  PreviewTools,
  ScheduleCaller,
  TaskCaller,
} from './tools.js'

/** What a thread reaches beyond its own directory: the library, memory, git backups and file uploads. */
export type ThreadContext = {
  /** A teammate's own mirror of the library, filled before its first thread here. */
  libraryDir: (teammateId: string) => Promise<string>
  memoryFor: (teammateId: string) => { workspace: string; teammate: string }
  callLibrary: LibraryCaller
  /** Create a task from the thread, or complete its task. */
  callTask: TaskCaller
  /** Create, list or change the teammate's schedules. */
  callSchedule: ScheduleCaller
  /** The thread's live preview: an app the teammate runs for people to try. */
  preview: PreviewTools
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
}
export type { CredentialRequester } from '../credentials.js'

export { stripApiKeys, usePersonPath } from './env.js'

const execFileAsync = promisify(execFile)

export type ThreadInput =
  | { kind: 'prompt'; text: string }
  /** The computer stopped during a turn: continue it. `text`: what was said since, if anything. */
  | { kind: 'resume'; text: string }
  | { kind: 'approval'; approvalId: string; approved: boolean; reason?: string }
  | { kind: 'answer'; questionId: string; answer: QuestionAnswer }
  | { kind: 'ticket'; requestId: string; answer: TicketAnswer }

/** How a turn ended: idle (done), waiting (for an approval), paused (no account has usage left), or failed. */
export type TurnOutcome = { status: 'idle' | 'waiting' | 'paused' | 'failed'; error?: string }

/** What the runner keeps per thread between processes. Never a credential. */
type SavedState = {
  accountId: string
  resume?: unknown
  /** Recent conversation, for the handoff when the thread moves to another account. */
  transcript: { role: 'user' | 'assistant'; text: string }[]
  /** A turn was running when this was written: found on start, the process stopped without parking. */
  inTurn?: boolean
  /** Turns continued after a restart since one last finished, to stop when restarts keep cutting it off. */
  recoveries?: number
}

const TRANSCRIPT_CHARS = 40_000
/** A turn cut off by this many restarts in a row is not continued again: it may be what stops the computer. */
const MAX_RECOVERIES = 3
/** What a teammate is told when the computer stopped without warning during its turn. */
const RESTARTED =
  "Brigade's computer restarted while you were working on this thread, so your last turn stopped partway. " +
  'Before you redo anything, check what is already done (files, commands you ran, messages you sent), then carry on where you left off.'

/** Before the message a cut-off turn answered, told again after a restart. */
const ASKED =
  'In case your conversation came back without it, this is the latest message you were answering:'

/** The teammate's model for the harness; none leaves Claude Code on the account's own. */
function withModel(teammate: Pick<ThreadSpec['teammate'], 'harness' | 'model'>) {
  const model = runModel(teammate.harness, teammate.model)
  return model ? { model } : {}
}

function createAgent(
  spec: ThreadSpec,
  callConnector: ConnectorCaller,
  credentials: ThreadCredentials,
  mcpServers: Record<string, unknown>,
  library: Parameters<typeof libraryTools>[0],
  checkoutRepo: (input: CheckoutInput) => Promise<unknown>,
  callTask: TaskCaller,
  callSchedule: ScheduleCaller,
  preview: PreviewTools,
  makeImage: ImageMaker | undefined,
  computer: ComputerUse | undefined,
) {
  // auth {}: the adapter adds no credential of its own. The vendor CLI uses the
  // account's token from the environment if it has one, else the login in its
  // config directory.
  const settings = { auth: {}, mcpServers }
  const codex = spec.teammate.harness === 'codex'
  const harness = codex ? createCodex(settings) : createClaudeCode(settings)
  const tools = {
    // Connector tools grow with each account connected; Codex loads them on demand.
    ...connectorTools(spec.connectors, callConnector, { defer: codex }),
    ...credentialTools(credentials),
    ...libraryTools(library),
    ...(spec.git ? repoTools(checkoutRepo) : {}),
    ...taskTools(callTask),
    ...scheduleTools(callSchedule),
    ...previewTools(preview, credentials),
    ...(makeImage ? imageTools(makeImage) : {}),
    ...(computer ? computerUseTools(computer) : {}),
    // Claude Code asks with its own question tool; Codex's adapter has none.
    ...(codex ? { [ASK_USER_TOOL]: askUserTool } : {}),
    [OPEN_TICKET_TOOL]: openTicketTool,
    // Closing cards come right after the answer: loaded up front, not through tool search.
    [OFFER_CHOICES_TOOL]: codex ? offerChoicesTool : alwaysLoaded(offerChoicesTool),
    [SUGGEST_REPLIES_TOOL]: codex ? suggestRepliesTool : alwaysLoaded(suggestRepliesTool),
    [SHOW_WIDGET_TOOL]: showWidgetTool,
    [WIDGET_GUIDE_TOOL]: widgetGuideTool,
    ...(spec.teammate.kind === 'chief' ? { [PROPOSE_TEAM_TOOL]: proposeTeamTool } : {}),
  }
  return new HarnessAgent({
    harness,
    tools,
    // The API is the enforcement point for connector calls and credentials; the harness does not ask again.
    toolApproval: Object.fromEntries(
      Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
    ),
    ...withModel(spec.teammate),
    ...(spec.teammate.instructions ? { instructions: spec.teammate.instructions } : {}),
    // Codex cannot ask before built-in tool calls (spec, known limits).
    permissionMode: spec.teammate.harness === 'codex' ? 'allow-all' : spec.permissionMode,
    sandboxConfig: { workDir: '.' },
  })
}

type Live = {
  agent: ReturnType<typeof createAgent>
  session: HarnessAgentSession
  sandbox: ReturnType<typeof createLocalSandboxSession>
  account: AccountRef
  credentials: ThreadCredentials
  /** The connector tools the agent was made with (connectorsKey). */
  connectors: string
}

/** Which connector tools a spec gives: an agent made with others is out of date. */
const connectorsKey = (spec: ThreadSpec) =>
  JSON.stringify(
    spec.connectors.map((c) => [c.connectionId, c.scope, c.operations.map((o) => o.name)]),
  )

type TurnStream = Awaited<ReturnType<Live['agent']['stream']>>['fullStream']

/**
 * A session stopped mid-turn saves that turn as `continueFrom`, with what it
 * waits on. Waiting on nothing: it was running when the computer stopped.
 */
function frozenMidRun(resume: unknown) {
  const from = (resume as { continueFrom?: Record<string, unknown> } | undefined)?.continueFrom
  if (!from) return false
  const pending = (key: string) => Array.isArray(from[key]) && from[key].length > 0
  return !pending('pendingToolApprovals') && !pending('pendingToolResults')
}

/**
 * After a stop without warning: the harness state that resumes the thread's
 * conversation, without any turn it was in. Claude Code continues the newest
 * conversation in the working directory (the thread's own, the turn that was
 * cut off included; a new one when there is none). Codex needs its thread id.
 */
function resumable(harness: ThreadSpec['teammate']['harness'], resume: unknown): unknown {
  const base = { type: 'resume-session', specificationVersion: 'harness-v1' }
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
  /** Tool calls not yet finished, kept across turns (see EventMapper). */
  private readonly toolCalls = new Map<string, { toolName: string; input: unknown }>()
  private saved: SavedState | undefined
  /** The live session resumed a turn frozen mid-run (see frozenMidRun). */
  private frozen = false
  private readonly stateFile: string
  /**
   * Names this harness session and its saved state. The thread's id for its
   * starting teammate (as before threads had several); thread and teammate for the others.
   */
  private readonly key: string
  /** Prompts so far: each is its own computer-use session, which the person can stop. */
  private prompts = 0
  /** Writes of the state file, in order. */
  private saving: Promise<void> = Promise.resolve()

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
  }

  async run(input: ThreadInput, spec: ThreadSpec, signal: AbortSignal): Promise<TurnOutcome> {
    this.spec = spec
    await this.load()
    let handoff: string | undefined
    if (input.kind === 'resume') {
      const resumed = await this.recover(input.text, spec)
      if (!resumed) return { status: 'idle' }
      ;({ input, handoff } = resumed)
    }
    // A new prompt runs on the account the API chose; an approval stays on the live session.
    else if (input.kind === 'prompt' && this.saved && this.saved.accountId !== spec.account.id) {
      handoff = await this.switchTo(spec.account, 'unavailable', null)
    }
    if (input.kind === 'prompt') {
      this.remember('user', input.text)
      this.prompts++
    }
    this.saved ??= { accountId: spec.account.id, transcript: [] }
    // Someone asked for this turn: restarts that cut off earlier ones no longer count.
    if (input.kind !== 'resume') this.saved.recoveries = 0
    // Found on disk after a stop without warning, this says the turn did not finish.
    this.saved.inTurn = true
    await this.persist()

    const fallbacks = [...spec.fallbacks]
    let result: TurnOutcome | undefined
    try {
      for (;;) {
        const outcome = await this.turn(handoff ? { kind: 'prompt', text: handoff } : input, signal)
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
      if (this.saved) {
        this.saved.inTurn = false
        if (result?.status === 'idle') this.saved.recoveries = 0
        await this.persist().catch((error) =>
          console.warn(`could not save thread state: ${errorMessage(error)}`),
        )
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
      this.emit({ type: 'turn.completed', finishReason: 'interrupted' })
      return null
    }
    saved.recoveries = recoveries
    this.emit({
      type: 'raw',
      source: 'runner',
      value: `The computer restarted during this turn. ${spec.teammate.name} carries on.`,
    })
    const told = [RESTARTED, unseen].filter(Boolean).join('\n\n')
    if (saved.accountId !== spec.account.id) {
      const handoff = await this.switchTo(spec.account, 'unavailable', null)
      return { input: { kind: 'resume', text: '' }, handoff: `${handoff}\n\n${told}` }
    }
    if (!saved.inTurn && frozenMidRun(saved.resume))
      return { input: { kind: 'resume', text: unseen } }
    const resume = resumable(spec.teammate.harness, saved.resume)
    if (resume) {
      saved.resume = resume
      // A turn cut off before the harness wrote its conversation comes back without the
      // message it answered (Claude Code then starts a new one): it is told it again.
      const asked = saved.transcript.findLast((t) => t.role === 'user')
      const again = asked && `${ASKED}\n\n${asked.text}`
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

  /**
   * The last turn stopped on an approval, a question or a ticket: a new prompt
   * waits until a person answers it. A turn frozen mid-run waits on nobody.
   */
  async awaitingPerson() {
    if (this.live) return this.live.session.hasUnfinishedTurn() && !this.frozen
    await this.load()
    const resume = this.saved?.resume as { continueFrom?: unknown } | undefined
    return !!resume?.continueFrom && !frozenMidRun(resume)
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
   * harness cannot take one mid-turn.
   */
  async steer(text: string) {
    const live = this.live
    if (!live) throw new Error('No turn is running')
    await live.agent.experimental_steer({ session: live.session, text })
    this.remember('user', text)
  }

  /** Stop the harness and keep its saved state, so the next message resumes it. */
  async park() {
    const live = this.live
    if (!live) return
    this.live = undefined
    try {
      const resume = await live.session.stop()
      // Parked, a turn that was running is frozen in `resume`: it goes on from there.
      this.saved = { ...this.saved!, accountId: live.account.id, resume, inTurn: false }
      await this.persist()
    } finally {
      await live.sandbox.destroy()
      await live.credentials.cleanup()
    }
  }

  private get current(): AccountRef {
    return this.live?.account ?? this.spec.account
  }

  private async turn(
    input: ThreadInput,
    signal: AbortSignal,
  ): Promise<
    { kind: 'done'; result: TurnOutcome } | { kind: 'exhausted'; resetsAt: string | null }
  > {
    let attached: Live | undefined
    // Parked during the turn: the runner is stopping, and the turn, frozen, goes on after the restart.
    // How its stream ends then is no failure of the teammate's.
    const frozenUnder = () => attached !== undefined && this.live !== attached
    const mapper = new EventMapper((event) => {
      if (frozenUnder()) return
      if (event.type === 'message.done') this.remember('assistant', event.text)
      this.emitEvent(event)
    }, this.toolCalls)
    try {
      // Its connector tools changed (an App granted from a ticket the turn waits on, or on the
      // teammate's page between turns): the harness stops and resumes with an agent that has
      // them. A new message while a turn is still unfinished leaves that turn as it is.
      if (
        this.live &&
        this.live.connectors !== connectorsKey(this.spec) &&
        ((input.kind !== 'prompt' && input.kind !== 'resume') ||
          !this.live.session.hasUnfinishedTurn())
      )
        await this.park()
      const live = (attached = await this.attach())
      const consume = async (stream: TurnStream) => {
        for await (const part of stream) {
          mapper.map(part)
          const image = generatedImage(part)
          if (image) await this.keepImage(image)
        }
      }
      let text = input.kind === 'prompt' || input.kind === 'resume' ? input.text : undefined
      // Nothing frozen came back after all: the teammate is told what happened instead.
      if (input.kind === 'resume' && !text && !live.session.hasUnfinishedTurn()) text = RESTARTED
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
        // waiting on a person: finish that turn, then the new message.
        this.frozen = false
        await consume(
          (await live.agent.continueStream({ session: live.session, abortSignal: signal }))
            .fullStream,
        )
      }
      // The frozen turn stopped again (an approval, a question, no usage left): the message waits.
      const held =
        text !== undefined &&
        (live.session.hasUnfinishedTurn() || signal.aborted || !!mapper.exhausted || !!mapper.error)
      let result =
        held || text === ''
          ? undefined
          : input.kind === 'prompt' || input.kind === 'resume'
            ? await live.agent.stream({
                session: live.session,
                prompt: text!,
                abortSignal: signal,
              })
            : input.kind === 'answer' || input.kind === 'ticket'
              ? await live.agent.continueStream({
                  session: live.session,
                  abortSignal: signal,
                  toolResultContinuations: [
                    input.kind === 'answer'
                      ? this.answerResult(input.questionId, input.answer)
                      : this.ticketResult(input.requestId, input.answer),
                  ],
                })
              : await live.agent.continueStream({
                  session: live.session,
                  abortSignal: signal,
                  toolApprovalContinuations: [
                    {
                      type: 'tool-approval-response',
                      approvalId: input.approvalId,
                      approved: input.approved,
                      ...(input.reason ? { reason: input.reason } : {}),
                    },
                  ],
                })
      if (result) await consume(result.fullStream)
      // A ticket nobody could answer: the error goes back and the turn carries on.
      while (mapper.rejected.length && live.session.hasUnfinishedTurn() && !signal.aborted) {
        const rejected = mapper.rejected.splice(0)
        result = await live.agent.continueStream({
          session: live.session,
          abortSignal: signal,
          toolResultContinuations: rejected.map((r) => ({
            type: 'tool-result' as const,
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            output: { type: 'error-text' as const, value: r.error },
          })),
        })
        await consume(result.fullStream)
      }
      if (frozenUnder()) return { kind: 'done', result: { status: 'waiting' } }
      // A login from before tokens, refreshed during the turn, goes back to the shared account directory.
      if (this.runAs) await linkAccount(this.runAs, live.account).catch(() => undefined)
      if (mapper.exhausted) return { kind: 'exhausted', resetsAt: mapper.exhausted.resetsAt }
      if (live.session.hasUnfinishedTurn()) return { kind: 'done', result: { status: 'waiting' } }
      // An error reported inside the stream fails the turn (it was already emitted).
      if (mapper.error && !signal.aborted)
        return { kind: 'done', result: { status: 'failed', error: mapper.error } }
      this.emit({
        type: 'turn.completed',
        finishReason: signal.aborted ? 'interrupted' : mapper.finishReason,
      })
      await this.persist()
      return { kind: 'done', result: { status: 'idle' } }
    } catch (error) {
      if (frozenUnder()) return { kind: 'done', result: { status: 'waiting' } }
      if (signal.aborted) {
        this.emit({ type: 'turn.completed', finishReason: 'interrupted' })
        return { kind: 'done', result: { status: 'idle' } }
      }
      const message = errorMessage(error)
      const exhausted = EventMapper.exhaustedBy(message)
      if (exhausted) return { kind: 'exhausted', resetsAt: exhausted.resetsAt }
      this.emit({ type: 'error', message })
      await this.drop()
      return { kind: 'done', result: { status: 'failed', error: message } }
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
   * On a member's Mac: the teammate sees and uses its apps through Brigade Computer Use. Not on
   * the workspace computer (teammates there have a browser). The tools stay on a Mac without the
   * helper, answering that it's missing: a thread that used them can't resume without them.
   */
  private computerUse(): ComputerUse | undefined {
    if (this.runAs || process.platform !== 'darwin') return
    const client = computerUseClient()
    return {
      request: (method, params, signal) =>
        client
          ? client.request(
              method,
              {
                ...params,
                session: { id: `${this.key}:${this.prompts}`, label: this.spec.teammate.name },
              },
              signal,
            )
          : Promise.reject(
              new ComputerUseError(
                'not_installed',
                'Brigade Computer Use is not installed on this Mac. Ask the person to install Brigade.app ' +
                  '(it includes it), then try again.',
              ),
            ),
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
  private answerResult(questionId: string, answer: QuestionAnswer) {
    const call = this.toolCalls.get(questionId)
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

  /** A person's answer as the result of the open_ticket call that opened the ticket. */
  private ticketResult(requestId: string, answer: TicketAnswer) {
    const call = this.toolCalls.get(requestId)
    const asks = ticketAsks(call?.input)?.asks ?? []
    return {
      type: 'tool-result' as const,
      toolCallId: requestId,
      toolName: OPEN_TICKET_TOOL,
      output: { type: 'json' as const, value: ticketResult(asks, answer) as never },
    }
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
    this.emit({
      type: 'account.switched',
      fromAccountId: from,
      toAccountId: account.id,
      reason,
      resetsAt,
    })
    this.saved = {
      ...(this.saved?.recoveries ? { recoveries: this.saved.recoveries } : {}),
      accountId: account.id,
      transcript: this.saved?.transcript ?? [],
    }
    await this.persist()
    return this.handoff(
      'This conversation continues in a new session because the previous one could not go on (its account ran out of usage).',
    )
  }

  /** The first message of a new session that carries on the conversation: what was said so far. */
  private handoff(why: string) {
    const transcript = this.saved?.transcript ?? []
    const lines = transcript
      .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`)
      .join('\n\n')
    const last = transcript.findLast((t) => t.role === 'user')
    return [
      why,
      'The working directory is exactly as the previous session left it.',
      lines && `Conversation so far:\n\n${lines}`,
      last && `Continue with the latest request if it is not finished yet.`,
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private async attach(): Promise<Live> {
    if (this.live) return this.live
    const account = this.spec.account
    const env = {
      ...(await prepare(this.workDir, account, this.spec.sessionId, this.runAs)),
      ...gitEnv(this.spec.git),
    }
    // On a cloud computer the teammate has its own browser, signed in where a person signed it in.
    // Why it did not start goes to the teammate too, which tells the person.
    let browserError: string | undefined
    const browser = this.runAs
      ? await ensureBrowser(this.spec.teammate).catch((error) => {
          browserError = errorMessage(error)
          console.warn(`no browser for ${this.runAs}: ${browserError}`)
          return null
        })
      : null
    const tabsFile =
      browser && this.runAs
        ? `${teammateHome(this.runAs)}/.browser-tabs/${this.spec.sessionId}.json`
        : undefined
    const libraryDir = await this.context.libraryDir(this.spec.teammate.id)
    // Memory loads through the harness's own instruction file.
    await writeInstructions(
      this.workDir,
      this.spec,
      instructions(
        this.spec,
        this.context.memoryFor(this.spec.teammate.id),
        libraryDir,
        tabsFile
          ? { ready: true }
          : { ready: false, ...(browserError ? { error: browserError } : {}) },
      ),
      this.runAs,
    ).catch((error) => console.warn(`could not write instructions: ${errorMessage(error)}`))
    // Skills through the harness's own skills folder: Brigade's, then the workspace's.
    await writeSkills(
      this.workDir,
      this.spec,
      [...builtinSkills(this.spec, libraryDir), ...(this.spec.skills ?? [])],
      this.context.skillFile,
      this.runAs,
    ).catch((error) => console.warn(`could not write skills: ${errorMessage(error)}`))
    const credentials = new ThreadCredentials({
      sessionId: this.spec.sessionId,
      request: this.requestCredential,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      ...(browser && tabsFile ? { browser: { port: browser, tabsFile } } : {}),
      readFile: (file) =>
        readAs(resolvePath(this.workDir, file), this.runAs, 1024 * 1024, 'A secret file'),
    })
    const agent = createAgent(
      this.spec,
      (call) => this.callWithFiles(call),
      credentials,
      browser && tabsFile ? { browser: browserMcpServer(browser, tabsFile) } : {},
      {
        access: this.spec.library,
        folders: this.spec.libraryFolders,
        libraryDir,
        call: this.context.callLibrary,
        readFile: (file) => readAs(resolvePath(this.workDir, file), this.runAs),
        listFiles: (folder) => listAs(resolvePath(this.workDir, folder), this.runAs),
        renderDesign: (folder, options) =>
          renderDesign(resolvePath(this.workDir, folder), this.runAs, options),
      },
      (request) =>
        checkout({
          // The latest spec: its git token is the freshest.
          spec: this.spec,
          workDir: this.workDir,
          request,
          bundles: this.context.bundles,
          ...(this.runAs ? { runAs: this.runAs } : {}),
        }),
      this.context.callTask,
      this.context.callSchedule,
      this.context.preview,
      this.spec.imageAccount ? (input, signal) => this.makeImage(input, signal) : undefined,
      this.computerUse(),
    )
    const sandbox = createLocalSandboxSession({
      id: this.key,
      workingDirectory: this.workDir,
      port: await freePort(),
      env,
      ...(this.runAs ? { runAs: this.runAs } : {}),
    })
    const resume = this.saved?.accountId === account.id ? this.saved.resume : undefined
    const session = await agent.createSession({
      sessionId: this.key,
      sandboxSession: sandbox,
      ...(resume ? { resumeFrom: resume as never } : {}),
    })
    this.frozen = frozenMidRun(resume)
    this.live = {
      agent,
      session,
      sandbox,
      account,
      credentials,
      connectors: connectorsKey(this.spec),
    }
    this.saved = { transcript: [], ...this.saved, accountId: account.id }
    return this.live
  }

  /**
   * A connector call that sends files (an email's attachments): the teammate
   * names them by path; they go to the API first, and the call carries their ids.
   */
  private async callWithFiles(call: Parameters<ConnectorCaller>[0]) {
    const field = this.spec.connectors
      .find((c) => c.connectionId === call.connectionId)
      ?.operations.find((o) => o.name === call.operation)?.filesField
    const input = call.input as Record<string, unknown> | null
    const files = field && input && Array.isArray(input[field]) ? (input[field] as unknown[]) : []
    if (!field || files.length === 0) return this.callConnector(call)
    const ids = []
    for (const file of files) {
      if (typeof file !== 'string') throw new Error(`${field} lists file paths`)
      const bytes = await readAs(
        resolvePath(this.workDir, file),
        this.runAs,
        ATTACHMENT_MAX,
        'Files sent with a call',
      )
      ids.push(
        await this.context.uploadFile({
          sessionId: this.spec.sessionId,
          teammateId: this.spec.teammate.id,
          name: basename(file),
          bytes,
        }),
      )
    }
    return this.callConnector({ ...call, input: { ...input, [field]: ids } })
  }

  /** After a failure: save what can be saved, so the next message starts clean. */
  private async drop() {
    const live = this.live
    await this.park().catch(async () => {
      await live?.session.destroy().catch(() => undefined)
      await live?.sandbox.destroy()
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
  }

  /**
   * Save the state as it is now. Writes go in order, each whole: a stop
   * without warning leaves the previous state or this one, never half of each.
   */
  private persist() {
    if (!this.saved) return Promise.resolve()
    const text = JSON.stringify(this.saved)
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
    this.emitEvent({ ...event, at: new Date().toISOString() } as AgentEvent)
  }
}

/**
 * The working directory and harness environment for an account: on a cloud
 * computer the teammate's own Linux user, home and private config directory.
 */
async function prepare(workDir: string, account: AccountRef, sessionId: string, runAs?: string) {
  if (!runAs) {
    await mkdir(workDir, { recursive: true })
    return harnessEnv(accountEnv(account))
  }
  await ensureUser(runAs)
  await execFileAsync('sudo', ['-n', '-u', runAs, 'mkdir', '-p', workDir], { cwd: '/' })
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
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    runAs ? 'sudo' : 'head',
    runAs
      ? ['-n', '-u', runAs, 'head', '-c', String(max + 1), '--', file]
      : ['-c', String(max + 1), '--', file],
    { cwd: '/', encoding: 'buffer', maxBuffer: max + 1024 },
  ).catch((error: unknown) => {
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
  const dir = folder.replace(/\/+$/, '')
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
  const dir = folder.replace(/\/+$/, '')
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

const resolvePath = (workDir: string, file: string) =>
  file.startsWith('/') ? file : join(workDir, file)

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
}): Promise<string> {
  const { spec, workDir, runAs, purpose = 'memory' } = input
  const env = await prepare(workDir, spec.account, spec.sessionId, runAs)
  const codex = spec.teammate.harness === 'codex'
  const settings = { auth: {} }
  const agent = new HarnessAgent({
    harness: codex ? createCodex(settings) : createClaudeCode(settings),
    tools: {},
    ...(input.noTools ? { activeTools: [] } : {}),
    ...(input.model ? { model: input.model } : withModel(spec.teammate)),
    // Nothing to do but answer; Codex cannot ask, so it gets an empty directory.
    permissionMode: codex ? 'allow-all' : 'allow-reads',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: `${spec.sessionId}-${purpose}`,
    workingDirectory: workDir,
    port: await freePort(),
    env,
    ...(runAs ? { runAs } : {}),
  })
  const session = await agent.createSession({
    sessionId: `${spec.sessionId}-${purpose}-${Date.now()}`,
    sandboxSession: sandbox,
  })
  try {
    let text = ''
    const mapper = new EventMapper((event) => {
      if (event.type === 'message.done') text = event.text
    })
    const result = await agent.stream({ session, prompt: input.prompt, abortSignal: input.signal })
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
}): Promise<{ savedPath: string; prompt?: string }> {
  const { account, runAs } = input
  // Its own empty folder: Codex runs without asking, and has nothing of the thread's to change.
  const dir = join(input.workDir, '.codex-image')
  const env = await prepare(dir, account, input.sessionId, runAs)
  const agent = new HarnessAgent({
    harness: createCodex({ auth: {} }),
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
    ...(runAs ? { runAs } : {}),
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
