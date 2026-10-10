// The harness layer. This directory is the only place in Brigade that imports
// the experimental AI SDK harness packages (spec: "keep every import inside
// one module of the runner package").
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HarnessAgent, type HarnessAgentSession } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createCodex } from '@ai-sdk/harness-codex'
import type { AccountRef, AgentEvent, QuestionAnswer, ThreadSpec } from '@brigade/contracts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { accountEnv } from '../accounts.js'
import { browserMcpServer, ensureBrowser } from '../browsers.js'
import { ThreadCredentials, type CredentialRequester } from '../credentials.js'
import { instructions, writeInstructions } from '../instructions.js'
import { backup, checkout, gitEnv, type BundleStore, type CheckoutInput } from '../repos.js'
import { ensureUser, linkAccount, teammateHome } from '../teammates.js'
import { harnessEnv } from './env.js'
import {
  askUserQuestions,
  askUserResult,
  errorMessage,
  EventMapper,
  QUESTION_TOOL,
} from './events.js'
import { createLocalSandboxSession, freePort } from './local-sandbox.js'
import {
  ASK_USER_TOOL,
  askUserTool,
  connectorTools,
  credentialTools,
  libraryTools,
  repoTools,
  type ConnectorCaller,
  type LibraryCaller,
} from './tools.js'

export type { ConnectorCaller, LibraryCaller } from './tools.js'

/** What a thread reaches beyond its own directory: the library, memory and git backups. */
export type ThreadContext = {
  libraryDir: string
  memoryFor: (teammateId: string) => { workspace: string; teammate: string }
  callLibrary: LibraryCaller
  bundles: BundleStore
}
export type { CredentialRequester } from '../credentials.js'

export { stripApiKeys } from './env.js'

const execFileAsync = promisify(execFile)

export type ThreadInput =
  | { kind: 'prompt'; text: string }
  | { kind: 'approval'; approvalId: string; approved: boolean; reason?: string }
  | { kind: 'answer'; questionId: string; answer: QuestionAnswer }

/** How a turn ended: idle (done), waiting (for an approval), paused (no account has usage left), or failed. */
export type TurnOutcome = { status: 'idle' | 'waiting' | 'paused' | 'failed'; error?: string }

/** What the runner keeps per thread between processes. Never a credential. */
type SavedState = {
  accountId: string
  resume?: unknown
  /** Recent conversation, for the handoff when the thread moves to another account. */
  transcript: { role: 'user' | 'assistant'; text: string }[]
}

const TRANSCRIPT_CHARS = 40_000

function createAgent(
  spec: ThreadSpec,
  callConnector: ConnectorCaller,
  credentials: ThreadCredentials,
  mcpServers: Record<string, unknown>,
  library: Parameters<typeof libraryTools>[0],
  checkoutRepo: (input: CheckoutInput) => Promise<unknown>,
) {
  // auth {}: the adapter forwards no credential. The vendor CLI uses its own
  // login in the account's config directory; the runner never reads it.
  const settings = { auth: {}, mcpServers }
  const codex = spec.teammate.harness === 'codex'
  const harness = codex ? createCodex(settings) : createClaudeCode(settings)
  const tools = {
    ...connectorTools(spec.connectors, callConnector),
    ...credentialTools(credentials),
    ...libraryTools(library),
    ...(spec.git ? repoTools(checkoutRepo) : {}),
    // Claude Code asks with its own question tool; Codex's adapter has none.
    ...(codex ? { [ASK_USER_TOOL]: askUserTool } : {}),
  }
  return new HarnessAgent({
    harness,
    tools,
    // The API is the enforcement point for connector calls and credentials; the harness does not ask again.
    toolApproval: Object.fromEntries(
      Object.keys(tools).map((name) => [name, 'not-applicable' as const]),
    ),
    ...(spec.teammate.model ? { model: spec.teammate.model } : {}),
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
}

/** One thread: one harness session in its own working directory. */
export class HarnessThread {
  private live: Live | undefined
  /** Tool calls not yet finished, kept across turns (see EventMapper). */
  private readonly toolCalls = new Map<string, { toolName: string; input: unknown }>()
  private saved: SavedState | undefined
  private readonly stateFile: string
  /**
   * Names this harness session and its saved state. The thread's id for its
   * starting teammate (as before threads had several); thread and teammate for the others.
   */
  private readonly key: string

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
    // A new prompt runs on the account the API chose; an approval stays on the live session.
    if (input.kind === 'prompt' && this.saved && this.saved.accountId !== spec.account.id) {
      handoff = await this.switchTo(spec.account, 'unavailable', null)
    }
    if (input.kind === 'prompt') this.remember('user', input.text)

    const fallbacks = [...spec.fallbacks]
    for (;;) {
      const outcome = await this.turn(handoff ? { kind: 'prompt', text: handoff } : input, signal)
      if (outcome.kind !== 'exhausted') return outcome.result
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
        return { status: 'paused' }
      }
      handoff = await this.switchTo(next, 'usage_limit', outcome.resetsAt)
      input = { kind: 'prompt', text: handoff }
    }
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

  /** Stop the harness and keep its saved state, so the next message resumes it. */
  async park() {
    const live = this.live
    if (!live) return
    this.live = undefined
    try {
      const resume = await live.session.stop()
      this.saved = { ...this.saved!, accountId: live.account.id, resume }
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
    const mapper = new EventMapper((event) => {
      if (event.type === 'message.done') this.remember('assistant', event.text)
      this.emitEvent(event)
    }, this.toolCalls)
    try {
      const live = await this.attach()
      if (input.kind === 'prompt' && live.session.hasUnfinishedTurn()) {
        return {
          kind: 'done',
          result: {
            status: 'waiting',
            error: 'Answer the pending approval or question first.',
          },
        }
      }
      const result =
        input.kind === 'prompt'
          ? await live.agent.stream({
              session: live.session,
              prompt: input.text,
              abortSignal: signal,
            })
          : input.kind === 'answer'
            ? await live.agent.continueStream({
                session: live.session,
                abortSignal: signal,
                toolResultContinuations: [this.answerResult(input.questionId, input.answer)],
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
      for await (const part of result.fullStream) mapper.map(part)
      // A login refreshed during the turn goes back to the shared account directory.
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
    this.saved = { accountId: account.id, transcript: this.saved?.transcript ?? [] }
    await this.persist()
    const lines = this.saved.transcript
      .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`)
      .join('\n\n')
    const last = this.saved.transcript.findLast((t) => t.role === 'user')
    return [
      'This conversation continues in a new session because the previous one could not go on (its account ran out of usage).',
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
    const env = { ...(await prepare(this.workDir, account, this.runAs)), ...gitEnv(this.spec.git) }
    // Memory loads through the harness's own instruction file.
    await writeInstructions(
      this.workDir,
      this.spec,
      instructions(
        this.spec,
        this.context.memoryFor(this.spec.teammate.id),
        this.context.libraryDir,
      ),
      this.runAs,
    ).catch((error) => console.warn(`could not write instructions: ${errorMessage(error)}`))
    // On a cloud computer the teammate has its own browser, signed in where a person signed it in.
    const browser = this.runAs
      ? await ensureBrowser(this.spec.teammate).catch((error) => {
          console.warn(`no browser for ${this.runAs}: ${errorMessage(error)}`)
          return null
        })
      : null
    const tabsFile =
      browser && this.runAs
        ? `${teammateHome(this.runAs)}/.browser-tabs/${this.spec.sessionId}.json`
        : undefined
    const credentials = new ThreadCredentials({
      sessionId: this.spec.sessionId,
      request: this.requestCredential,
      ...(this.runAs ? { runAs: this.runAs } : {}),
      ...(browser && tabsFile ? { browser: { port: browser, tabsFile } } : {}),
    })
    const agent = createAgent(
      this.spec,
      this.callConnector,
      credentials,
      browser && tabsFile ? { browser: browserMcpServer(browser, tabsFile) } : {},
      {
        access: this.spec.library,
        libraryDir: this.context.libraryDir,
        call: this.context.callLibrary,
        readFile: (file) => readAs(resolvePath(this.workDir, file), this.runAs),
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
    this.live = { agent, session, sandbox, account, credentials }
    this.saved = { transcript: [], ...this.saved, accountId: account.id }
    return this.live
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

  private async persist() {
    if (!this.saved) return
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 })
    await writeFile(this.stateFile, JSON.stringify(this.saved), { mode: 0o600 })
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
 * computer the teammate's own Linux user, home and private link to the login.
 */
async function prepare(workDir: string, account: AccountRef, runAs?: string) {
  if (!runAs) {
    await mkdir(workDir, { recursive: true })
    return harnessEnv(accountEnv(account))
  }
  await ensureUser(runAs)
  await execFileAsync('sudo', ['-n', '-u', runAs, 'mkdir', '-p', workDir], { cwd: '/' })
  const home = teammateHome(runAs)
  return harnessEnv({
    ...(await linkAccount(runAs, account)),
    HOME: home,
    USER: runAs,
    LOGNAME: runAs,
  })
}

/** Most a teammate saves to the library in one call. */
const READ_MAX = 10 * 1024 * 1024

/** Read a file as the teammate's user (or as this user on a member's machine). */
async function readAs(file: string, runAs?: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    runAs ? 'sudo' : 'cat',
    runAs ? ['-n', '-u', runAs, 'head', '-c', String(READ_MAX + 1), '--', file] : ['--', file],
    { cwd: '/', encoding: 'buffer', maxBuffer: READ_MAX + 1024 },
  ).catch((error: unknown) => {
    throw new Error(`Could not read ${file}: ${errorMessage(error)}`)
  })
  if (stdout.byteLength > READ_MAX) throw new Error('Files saved to the library can be up to 10 MB')
  return stdout
}

const resolvePath = (workDir: string, file: string) =>
  file.startsWith('/') ? file : join(workDir, file)

/**
 * One short harness run outside any thread, with no tools: a prompt in, its
 * final text out. Used to take memory from a thread that went quiet.
 */
export async function runOnce(input: {
  spec: ThreadSpec
  workDir: string
  runAs?: string
  prompt: string
  signal: AbortSignal
}): Promise<string> {
  const { spec, workDir, runAs } = input
  const env = await prepare(workDir, spec.account, runAs)
  const codex = spec.teammate.harness === 'codex'
  const settings = { auth: {} }
  const agent = new HarnessAgent({
    harness: codex ? createCodex(settings) : createClaudeCode(settings),
    tools: {},
    ...(spec.teammate.model ? { model: spec.teammate.model } : {}),
    // Nothing to do but answer; Codex cannot ask, so it gets an empty directory.
    permissionMode: codex ? 'allow-all' : 'allow-reads',
    sandboxConfig: { workDir: '.' },
  })
  const sandbox = createLocalSandboxSession({
    id: `${spec.sessionId}-memory`,
    workingDirectory: workDir,
    port: await freePort(),
    env,
    ...(runAs ? { runAs } : {}),
  })
  const session = await agent.createSession({
    sessionId: `${spec.sessionId}-memory-${Date.now()}`,
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

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
