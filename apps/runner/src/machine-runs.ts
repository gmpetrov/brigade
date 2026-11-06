// Commands a teammate runs on its thread's own machine (the preview_machines feature,
// docs/previews.md, "Commands on the thread's machine"): work that takes more CPU or memory than
// its share of the cloud computer, such as a video render, a build or a test suite.
//
// The command's folder goes to the machine first, as a preview's does (preview-machine.ts): the
// whole checkout it is in, into the teammate's own copy there (`commands/<teammate>/…`, apart
// from the preview's, so a build never writes under a running dev server), which stays between
// commands with what they installed; the next command sends only what changed. Before it goes,
// the thread's attached files are put at the same place in that copy as in the teammate's folder,
// fetched by the machine itself from storage (machine-files.ts). The command runs
// detached there (its own session), its output in a file the runner follows: a cut connection,
// or the runner starting again after an update, loses none of it, and a run outlives the tool
// call that started it. Once it ends, the files the teammate named come back into its folder,
// written as the teammate. The machine stays up while a command runs (MachineHolds), then a
// while for the next one, then stops.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PreviewMachineAccess, ThreadAttachmentRef } from '@brigade/contracts'
import { placeAttachments, type FilesApi } from './machine-files.js'
import type { MachineHolds } from './machine-holds.js'
import {
  envFileText,
  MachineLink,
  MachineSync,
  machineKey,
  READER,
  shellQuote,
} from './preview-machine.js'
import { runAsUser } from './run-as.js'
import { asTeammate, threadNet, type ThreadNet } from './thread-net.js'

/** A teammate's seat in a thread: its working directory, and its user on a cloud computer. */
export type RunSeat = { sessionId: string; teammateId: string; workDir: string; runAs?: string }

export type MachineRunStatus =
  'starting' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'timed_out'

export type MachineRunInput = {
  command: string
  /** Where it runs, relative to the working directory. */
  cwd?: string
  /** Files or folders it makes, relative to cwd: they come back here once it ends. */
  outputs?: string[]
  /** Settings it gets, on top of nothing of this computer's environment. */
  env?: Record<string, string>
  /** Released credentials' env files (read as the teammate): their variables, for this run only. */
  envFiles?: string[]
  timeoutMs?: number
}

export type MachineRunView = {
  id: string
  command: string
  /** Relative to the working directory. */
  cwd: string
  status: MachineRunStatus
  exitCode?: number
  startedAt: string
  endedAt?: string
  seconds: number
  /** Its latest output, credentials' values hidden. */
  output?: string
  /** What came back from the machine, relative to the working directory, with sizes. */
  files?: string[]
  notes: string[]
}

/** What a teammate's machine tools reach: its own commands in its thread. */
export type MachineRunControl = {
  /** Start a command, then wait up to `waitMs` for it to end. */
  run(input: MachineRunInput, waitMs: number, signal?: AbortSignal): Promise<MachineRunView>
  /** Wait up to `waitMs` for one to end, with its last `lines` of output. */
  get(id: string, waitMs: number, lines?: number, signal?: AbortSignal): Promise<MachineRunView>
  stop(id: string): Promise<MachineRunView>
  /** The thread's commands, latest first, without their output. */
  list(): MachineRunView[]
}

/** Commands of one thread under way at once, at most. */
const RUNS_AT_ONCE = 3
/** After a thread's last command, its machine stays up this long for the next one. */
const IDLE_MS = Number(process.env.BRIGADE_MACHINE_IDLE_MS) || 10 * 60_000
/** While a command runs, the API is told this often that its machine is in use. */
const TOUCH_MS = 5 * 60_000
export const RUN_TIMEOUT_MS = 60 * 60_000
export const RUN_TIMEOUT_MAX_MS = 6 * 3600_000
/** Lines of output kept per command, and what a view gives by default. */
const OUTPUT_LINES = 2000
export const TAIL_LINES = 60
const TAIL_CHARS = 20_000
/** A line not ended yet keeps its end, past this: a progress bar redrawn for an hour. */
const PARTIAL_MAX = 16_000
/** What may come back of one command, at most. */
const OUTPUTS_MAX = 2 * 1024 ** 3
/** Ended commands remembered, latest first. */
const KEPT = 50
/** After asking a command to stop, how long before it is killed. */
const STOP_GRACE_MS = 10_000
/** A credential's value this short is not hidden in the output: it would hide ordinary words. */
const HIDDEN_MIN = 6
const HIDDEN = '••••••'
/** On the machine, in its user's home: each command's files, and the teammates' copies. */
const RUNS_DIR = '.brigade/runs'
const COPIES = 'commands'
/** A finished command's folder there older than this many days goes at the next command. */
const RUN_DIR_DAYS = 7

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

type Run = {
  id: string
  seat: RunSeat
  command: string
  cwd: string
  outputs: string[]
  /** Here: where it runs, and the folder that goes to the machine (the checkout it is in). */
  localCwd: string
  root: string
  /** There, relative to its user's home. */
  remoteRoot: string
  remoteCwd: string
  status: MachineRunStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  timeoutMs: number
  /** It got credentials: their values are hidden in its output, and it is not shown when they are lost. */
  secret: boolean
  hidden: string[]
  lines: string[]
  partial: string
  decoder: StringDecoder
  /** Bytes of its output file read so far: a follow cut short goes on from there. */
  offset: number
  files?: string[]
  notes: string[]
  /** A stop or its time limit asked it to end: what it ends as. */
  ending?: 'stopped' | 'timed_out'
  follower?: ChildProcess
  timer?: NodeJS.Timeout
  done: Promise<void>
  finished: () => void
  /** Loaded from the state file of the runner before this one. */
  resumed?: boolean
  /**
   * Followed by a runner that does not know its credentials' values (it started after the
   * command): its output, which nothing can hide them in, is not shown.
   */
  blind?: boolean
  /** Its folder's sync is starting: what the sync says goes into its notes. */
  syncing?: boolean
  /** It holds the thread's machine (MachineHolds): released once it is over. */
  held?: boolean
}

/**
 * What the state file keeps of a command: enough to follow it again, and the end of an ended
 * one's output, its credentials' values hidden. Never a secret.
 */
type SavedRun = { tail?: string[] } & Pick<
  Run,
  | 'id'
  | 'seat'
  | 'command'
  | 'cwd'
  | 'outputs'
  | 'localCwd'
  | 'root'
  | 'remoteRoot'
  | 'remoteCwd'
  | 'status'
  | 'exitCode'
  | 'startedAt'
  | 'endedAt'
  | 'timeoutMs'
  | 'secret'
  | 'blind'
  | 'files'
  | 'notes'
>

/** A thread's machine as its commands use it: one link, the teammates' copies there. */
type ThreadMachine = {
  link?: MachineLink
  connecting?: Promise<void>
  /** By the folder here that goes there. */
  copies: Map<string, { sync: MachineSync; flushing: Promise<unknown> }>
  /**
   * Attached files being put there: one placing at a time on the machine, each fetching a few at
   * once, so its connection's sessions stay few.
   */
  placing?: Promise<unknown>
  /** Its commands not over yet (their files not back yet included). */
  active: Set<Run>
  touchTimer?: NodeJS.Timeout
}

/** How a command ended, said once its files are back. */
type Outcome = {
  status: Exclude<MachineRunStatus, 'starting' | 'running'>
  exitCode?: number
  /** It ran on the machine: its outputs may be there. */
  ran: boolean
}

/** Lines of an ended command's output its state keeps, and their length at most. */
const KEPT_LINES = 200
const KEPT_CHARS = 20_000

const holderOf = (run: Pick<Run, 'id'>) => `run:${run.id}`
const runDir = (id: string) => `${RUNS_DIR}/${id}`
const ended = (status: MachineRunStatus) => status !== 'starting' && status !== 'running'
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Whether the machine still runs what it ran when the command started (it was not stopped since). */
const SAME_BOOT = '[ "$(cat boot 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id)" ]'
/**
 * Whether anything of the command still runs there: any process of its group, not only its
 * script, which a TERM ends before what it started.
 */
const ALIVE = `${SAME_BOOT} && kill -0 -"$(cat pid 2>/dev/null)" 2>/dev/null`

/**
 * The script the machine runs for a command, from its user's home: its settings and credentials
 * loaded, then removed from the disk, then the command in its folder, its output and exit status
 * in files the runner reads. Started in a session of its own, which it leads: its id stops it all.
 */
export function runScript(input: {
  id: string
  cwd: string
  credentials: number
  command: string
}) {
  return `${[
    `dir="$PWD/${runDir(input.id)}"`,
    'echo $$ > "$dir/pid"',
    'cat /proc/sys/kernel/random/boot_id > "$dir/boot" 2>/dev/null',
    'set -a',
    '. "$dir/env"',
    ...Array.from({ length: input.credentials }, (_, i) => `. "$dir/credentials-${i}"`),
    'set +a',
    'rm -f "$dir/env" "$dir/credentials-"*',
    `mkdir -p -- ${shellQuote(input.cwd)} && cd -- ${shellQuote(input.cwd)} || ` +
      '{ echo 1 > "$dir/exit.tmp"; mv "$dir/exit.tmp" "$dir/exit"; exit 1; }',
    `bash -c ${shellQuote(input.command)} < /dev/null >> "$dir/output.log" 2>&1`,
    'echo $? > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"',
  ].join('\n')}\n`
}

/**
 * The values of an env file's variables, as a shell sourcing it gets them, long enough to hide:
 * ThreadCredentials.env writes `export NAME='…'` with each ' inside as '\''. A value over several
 * lines (a key) is hidden line by line too, as its output shows it.
 */
export function secretValues(text: string) {
  const values: string[] = []
  const assignment = /(^|\n)[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=/g
  for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
    let i = match.index + match[0].length
    let value = ''
    // One shell word: '…' as is, "…" with its escapes, \x, plain characters; up to a blank.
    while (i < text.length && !/[\s;]/.test(text[i]!)) {
      const c = text[i]!
      if (c === "'") {
        const close = text.indexOf("'", i + 1)
        if (close < 0) break
        value += text.slice(i + 1, close)
        i = close + 1
      } else if (c === '"') {
        i++
        while (i < text.length && text[i] !== '"') {
          const next = text[i + 1]
          if (text[i] === '\\' && next !== undefined && '$`"\\\n'.includes(next)) i++
          value += text[i]
          i++
        }
        i++
      } else if (c === '\\') {
        value += text[i + 1] ?? ''
        i += 2
      } else {
        value += c
        i++
      }
    }
    assignment.lastIndex = Math.max(i, assignment.lastIndex)
    if (value.length >= HIDDEN_MIN) values.push(value)
    if (value.includes('\n'))
      for (const line of value.split('\n'))
        if (line.trim().length >= HIDDEN_MIN) values.push(line.replace(/\r$/, ''))
  }
  // Longest first: a value that holds another is hidden whole.
  return [...new Set(values)].sort((a, b) => b.length - a.length)
}

/** A path the teammate names for an output: inside the command's folder, said plainly. */
export function outputPath(path: string) {
  const clean = posix.normalize(path.trim().replace(/\/+$/, ''))
  if (!clean || clean === '.' || isAbsolute(clean) || clean.startsWith('../') || clean === '..')
    return null
  if (clean.includes('\0') || clean.includes('\\')) return null
  return clean
}

/** The last lines of an output, as many as fit in KEPT_CHARS. */
function keptTail(lines: string[]) {
  const kept: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < KEPT_LINES; i--) {
    chars += lines[i]!.length + 1
    if (chars > KEPT_CHARS) break
    kept.unshift(lines[i]!)
  }
  return kept
}

/** "34.2 MB". */
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(2)} GB`

export class MachineRuns {
  private readonly runs = new Map<string, Run>()
  private readonly threads = new Map<string, ThreadMachine>()
  /** Commands the runner before this one was following, followed again once connected. */
  private unfollowed: Run[] = []
  private detached = false

  constructor(
    private readonly options: {
      holds: Pick<MachineHolds, 'up' | 'release' | 'touch'>
      /** The runner's folder: its key for machines and their SSH files. */
      home: string
      stateFile: string
      /** Tests: how to reach a machine. */
      link?: (access: PreviewMachineAccess, key: string, stateDir: string) => MachineLink
      /**
       * The thread's attached files: put in the teammate's copy on the machine before each
       * command, at the same place as in its folder, fetched there from storage (machine-files.ts).
       */
      files?: {
        /** Those given to the seat's folder so far (its turns' files, its calls'). */
        of: (seat: RunSeat) => ThreadAttachmentRef[]
        /** Where the API has them: its redirect to the bucket gives each one's signed URL. */
        api: FilesApi
      }
      /** Tests: the sync's reader for a folder, as the teammate. */
      reader?: (seat: RunSeat, net: ThreadNet | null, root: string) => ChildProcess
      /** Tests: after a thread's last command, how long its machine stays up. */
      idleMs?: number
      /** Tests: how often the API is told a command runs, and how long a stop waits to KILL. */
      touchMs?: number
      stopGraceMs?: number
    },
  ) {
    let saved: SavedRun[] = []
    try {
      saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) as SavedRun[]
    } catch {
      // None yet.
    }
    for (const entry of saved) {
      const run = this.fromSaved(entry)
      this.runs.set(run.id, run)
      if (!ended(run.status)) this.unfollowed.push(run)
    }
  }

  /** A seat's machine tools: its own commands in its thread. */
  forSeat(seat: RunSeat): MachineRunControl {
    const mine = (id: string) => {
      const run = this.runs.get(id)
      if (!run || run.seat.sessionId !== seat.sessionId)
        throw new Error(`No command ${id} in this thread: machine_run without an id lists them`)
      return run
    }
    return {
      run: async (input, waitMs, signal) => {
        const run = await this.start(seat, input)
        await this.wait(run, waitMs, signal)
        return this.view(run)
      },
      get: async (id, waitMs, lines, signal) => {
        const run = mine(id)
        await this.wait(run, waitMs, signal)
        return this.view(run, lines)
      },
      stop: async (id) => {
        const run = mine(id)
        await this.end(run, 'stopped')
        await this.wait(run, (this.options.stopGraceMs ?? STOP_GRACE_MS) + 20_000)
        return this.view(run)
      },
      list: () =>
        [...this.runs.values()]
          .filter((run) => run.seat.sessionId === seat.sessionId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .map((run) => {
            const { output: _output, ...rest } = this.view(run)
            return rest
          }),
    }
  }

  /** The thread has commands under way, or files on their way back: its folder stays. */
  active(sessionId: string) {
    return (this.threads.get(sessionId)?.active.size ?? 0) > 0
  }

  /**
   * Once connected: follow again the commands the runner before this one followed. Resolves
   * once each holds its machine again (it asked for it: MachineHolds), or could not.
   */
  resume() {
    const runs = this.unfollowed
    this.unfollowed = []
    return Promise.all(
      runs.map((run) => new Promise<void>((held) => void this.follow(run, held).finally(held))),
    ).then(() => undefined)
  }

  /** The thread was deleted: its commands stop, and nothing comes back. */
  async forgetThread(sessionId: string) {
    const thread = this.threads.get(sessionId)
    for (const run of [...(thread?.active ?? [])]) {
      run.outputs = []
      await this.end(run, 'stopped')
    }
    for (const run of [...this.runs.values()])
      if (run.seat.sessionId === sessionId && ended(run.status)) this.runs.delete(run.id)
    this.save()
  }

  /**
   * The runner stops (an update, the computer stopping): the commands go on on their machines,
   * and the next runner follows them from its state file.
   */
  detach() {
    this.detached = true
    for (const thread of this.threads.values()) {
      clearInterval(thread.touchTimer)
      for (const run of thread.active) {
        clearTimeout(run.timer)
        run.follower?.kill()
      }
      for (const copy of thread.copies.values()) copy.sync.stop()
      thread.link?.close()
    }
    this.save()
  }

  /** Checked and registered, then started without waiting: it outlives the call. */
  private async start(seat: RunSeat, input: MachineRunInput) {
    const command = input.command?.trim()
    if (!command) throw new Error('Give the command to run')
    const thread = this.thread(seat.sessionId)
    if (thread.active.size >= RUNS_AT_ONCE)
      throw new Error(
        `${thread.active.size} commands already run on this thread's machine: wait for one (machine_run)`,
      )
    const localCwd = resolve(seat.workDir, input.cwd ?? '.')
    if (localCwd !== seat.workDir && !localCwd.startsWith(`${seat.workDir}${sep}`))
      throw new Error('cwd must be inside your working directory')
    const isDir = await runAsUser(['test', '-d', localCwd], seat.runAs).then(
      () => true,
      () => false,
    )
    if (!isDir) throw new Error(`No folder ${input.cwd ?? '.'} in your working directory`)
    const top = (
      await runAsUser(['git', '-C', localCwd, 'rev-parse', '--show-toplevel'], seat.runAs).catch(
        () => '',
      )
    ).trim()
    // The checkout it is in goes whole (a command in a folder of a monorepo reads the rest); a
    // folder outside a checkout of the teammate's goes alone.
    const inCheckout = !!top && (top === seat.workDir || top.startsWith(`${seat.workDir}${sep}`))
    const root = inCheckout ? top : localCwd
    if (root === seat.workDir && !inCheckout)
      throw new Error(
        'Give in cwd the folder the command needs (a checkout, or a project’s folder): it goes to the ' +
          'machine with all it holds, and your whole working directory would',
      )
    const outputs: string[] = []
    for (const path of input.outputs ?? []) {
      const clean = outputPath(path)
      if (!clean) throw new Error(`${path}: outputs are paths inside cwd`)
      outputs.push(clean)
    }
    const there = (path: string) =>
      posix.join(
        COPIES,
        seat.teammateId,
        ...relative(seat.workDir, path).split(sep).filter(Boolean),
      )
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? RUN_TIMEOUT_MS, 1000),
      RUN_TIMEOUT_MAX_MS,
    )
    const credentials = await Promise.all(
      (input.envFiles ?? []).map((file) => runAsUser(['cat', '--', file], seat.runAs)),
    ).catch((error: unknown) => {
      throw new Error(`Its credentials could not be read: ${errorText(error)}`)
    })
    const run = this.newRun({
      id: randomUUID().replace(/-/g, '').slice(0, 10),
      seat,
      command,
      cwd: relative(seat.workDir, localCwd).split(sep).join('/') || '.',
      outputs,
      localCwd,
      root,
      remoteRoot: there(root),
      remoteCwd: there(localCwd),
      status: 'starting',
      startedAt: Date.now(),
      timeoutMs,
      secret: credentials.length > 0,
      files: undefined,
      notes: [],
    })
    run.hidden = credentials.flatMap(secretValues)
    // Counted again now: another call may have started one while this one read its folder.
    if (thread.active.size >= RUNS_AT_ONCE)
      throw new Error(
        `${thread.active.size} commands already run on this thread's machine: wait for one (machine_run)`,
      )
    this.runs.set(run.id, run)
    thread.active.add(run)
    this.save()
    void this.launch(run, thread, input.env ?? {}, credentials)
    return run
  }

  private newRun(saved: SavedRun): Run {
    let finished!: () => void
    const done = new Promise<void>((resolve) => (finished = resolve))
    return {
      ...saved,
      hidden: [],
      lines: [],
      partial: '',
      decoder: new StringDecoder('utf8'),
      offset: 0,
      done,
      finished,
    }
  }

  private fromSaved({ tail, ...saved }: SavedRun) {
    const run = this.newRun(saved)
    run.resumed = true
    if (ended(run.status)) {
      run.lines = tail ?? []
      run.finished()
    }
    return run
  }

  private thread(sessionId: string) {
    let thread = this.threads.get(sessionId)
    if (!thread) {
      thread = { copies: new Map(), active: new Set() }
      this.threads.set(sessionId, thread)
    }
    return thread
  }

  /**
   * The machine up for the run, connected: its link, made the first time, else told where it is.
   * `held`: called once the run holds it, as soon as it asked for it.
   */
  private async machine(run: Run, thread: ThreadMachine, held?: () => void) {
    const key = await machineKey(this.options.home)
    const up = this.options.holds.up(run.seat.sessionId, holderOf(run), key.publicKey)
    held?.()
    const answer = await up
    if (!answer.machine)
      throw new Error(
        `This thread has no machine of its own${answer.reason ? ` now: ${answer.reason}` : ''}. Run it here instead`,
      )
    run.held = true
    // Its own SSH files, apart from the preview's link to the same machine.
    const stateDir = join(this.options.home, 'machine-runs', answer.machine.id)
    if (thread.link) thread.link.update(answer.machine)
    else
      thread.link = this.options.link
        ? this.options.link(answer.machine, key.file, stateDir)
        : new MachineLink(answer.machine, key.file, stateDir)
    const link = thread.link
    // One connection for all the thread's commands: two starting at once open it once.
    thread.connecting ??= link.connect().finally(() => {
      thread.connecting = undefined
    })
    await thread.connecting
    this.keepTouching(run.seat.sessionId, thread)
    return link
  }

  private keepTouching(sessionId: string, thread: ThreadMachine) {
    if (thread.touchTimer) return
    // Busy: the runner's computer stays up too, to follow the command and bring its files back.
    thread.touchTimer = setInterval(() => {
      void this.options.holds.touch(sessionId, true).catch((error: unknown) => {
        console.warn(
          `commands of ${sessionId}: could not say the machine is in use: ${String(error)}`,
        )
      })
    }, this.options.touchMs ?? TOUCH_MS)
    thread.touchTimer.unref()
  }

  /** The machine's copy of the run's folder, up to date: the files it sent, when it had to start. */
  private async sendFolder(run: Run, thread: ThreadMachine, link: MachineLink) {
    let copy = thread.copies.get(run.root)
    if (!copy) {
      const net = run.seat.runAs ? await threadNet(run.seat.sessionId) : null
      const sync = new MachineSync(
        link,
        () =>
          this.options.reader
            ? this.options.reader(run.seat, net, run.root)
            : this.startReader(run.seat, net, run.root),
        run.remoteRoot,
        (line) => {
          // What the sync says while a command's folder goes: a file it leaves out, say.
          const said = line.replace(/^\[preview\]\s*/, '').trim()
          for (const other of thread.active) if (other.syncing && said) other.notes.push(said)
          console.log(`commands of ${run.seat.sessionId}: ${line}`)
        },
      )
      copy = { sync, flushing: Promise.resolve() }
      thread.copies.set(run.root, copy)
    }
    // One flush of a folder at a time: a sync that must start again starts once.
    const flushing = copy.flushing.then(() => copy.sync.flush())
    copy.flushing = flushing.catch(() => undefined)
    run.syncing = true
    try {
      return await flushing
    } finally {
      run.syncing = false
    }
  }

  /**
   * The thread's attached files in the teammate's copy there, at the same place as in its folder:
   * those the machine lacks fetched there from storage. What could not be is said in the run's
   * notes; the command runs anyway.
   */
  private async placeFiles(run: Run, thread: ThreadMachine, link: MachineLink) {
    const files = this.options.files
    const refs = files?.of(run.seat) ?? []
    if (!files || !refs.some((ref) => ref.status === 'ready')) return
    const { teammateId } = run.seat
    // One placing at a time: two commands starting at once fetch each file once.
    const placing = (thread.placing ?? Promise.resolve()).then(() =>
      placeAttachments({
        link,
        api: files.api,
        refs,
        workDir: run.seat.workDir,
        ...(run.seat.runAs ? { runAs: run.seat.runAs } : {}),
        teammateId,
        copy: posix.join(COPIES, teammateId),
        // What a sync sends as it is, this command's folder and those of its others under way.
        syncRoots: [run.root, ...thread.copies.keys()],
      }),
    )
    thread.placing = placing.catch(() => undefined)
    try {
      const { fetched, failed, unchecked } = await placing
      if (fetched.length) {
        const bytes = fetched.reduce((sum, file) => sum + file.size, 0)
        const names = fetched.map((file) => file.path)
        const shown =
          names.length > 5
            ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`
            : names.join(', ')
        run.notes.push(
          `Fetched ${fetched.length} attached file${fetched.length === 1 ? '' : 's'} ` +
            `(${size(bytes)}) from storage: ${shown}`,
        )
      }
      for (const file of failed) run.notes.push(`${file.path} is not on the machine: ${file.why}`)
      for (const file of unchecked)
        run.notes.push(
          `${file.path} was not placed from storage: its copy here could not be checked (${file.why})`,
        )
    } catch (error) {
      run.notes.push(
        `The thread's attached files could not be put on the machine: ${errorText(error)}`,
      )
    }
  }

  /** The sync's reader, as the teammate in its thread's namespaces: it reads what the command would. */
  private startReader(seat: RunSeat, net: ThreadNet | null, root: string) {
    const args = [READER, root]
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe']
    if (!seat.runAs) return spawn(process.execPath, args, { cwd: '/', stdio })
    const as = asTeammate(seat.runAs, net)
    return spawn(as.file, [...as.args, 'node', ...args], { cwd: '/', stdio })
  }

  /**
   * On the machine: its folder up to date, its files written, the command started detached; then
   * followed to its end, and its outputs brought back.
   */
  private async launch(
    run: Run,
    thread: ThreadMachine,
    env: Record<string, string>,
    credentials: string[],
  ) {
    let link: MachineLink
    try {
      link = await this.machine(run, thread)
      if (run.ending)
        return await this.finish(run, thread, link, { status: run.ending, ran: false })
      // Before its folder goes: a sync that sends the attachments folder finds them there already.
      await this.placeFiles(run, thread, link)
      if (run.ending)
        return await this.finish(run, thread, link, { status: run.ending, ran: false })
      const sent = await this.sendFolder(run, thread, link)
      if (sent)
        run.notes.push(
          `Sent ${sent} file${sent === 1 ? '' : 's'} of ${relative(run.seat.workDir, run.root) || '.'} to the machine; ` +
            'they stay there for the next commands, which send only what changed',
        )
      if (run.ending)
        return await this.finish(run, thread, link, { status: run.ending, ran: false })
      const dir = runDir(run.id)
      await link.exec(
        `mkdir -p ${RUNS_DIR} && find ${RUNS_DIR} -mindepth 1 -maxdepth 1 -mtime +${RUN_DIR_DAYS} ` +
          `-exec rm -rf {} + 2>/dev/null; rm -rf ${dir} && mkdir -m 700 ${dir} && : > ${dir}/output.log`,
      )
      // By stdin, never on a command line; removed by its script once loaded.
      const write = (file: string, text: string) =>
        link.exec(`umask 077 && cat > ${dir}/${file}`, text)
      await write('env', envFileText(env))
      for (const [i, text] of credentials.entries()) await write(`credentials-${i}`, text)
      await write(
        'run.sh',
        runScript({
          id: run.id,
          cwd: run.remoteCwd,
          credentials: credentials.length,
          command: run.command,
        }),
      )
      if (run.ending) {
        await link.exec(`rm -rf ${dir}`).catch(() => undefined)
        return await this.finish(run, thread, link, { status: run.ending, ran: false })
      }
      await link.exec(
        `(setsid nohup bash ${dir}/run.sh > /dev/null 2>&1 < /dev/null &); i=0; ` +
          `while [ ! -s ${dir}/pid ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -s ${dir}/pid ]`,
      )
    } catch (error) {
      // The runner is stopping: the next one finds whether it started there, and follows it.
      if (this.detached) return
      run.notes.push(errorText(error))
      return this.finish(run, thread, undefined, { status: 'failed', ran: false })
    }
    run.status = 'running'
    this.save()
    this.limit(run)
    // A stop asked meanwhile reaches the command now.
    if (run.ending) this.kill(run, link)
    await this.followOn(run, thread, link)
  }

  /** Stopped once its time is up. */
  private limit(run: Run) {
    clearTimeout(run.timer)
    const left = run.startedAt + run.timeoutMs - Date.now()
    run.timer = setTimeout(() => void this.end(run, 'timed_out'), Math.max(left, 0))
    run.timer.unref()
  }

  /** A command the runner before this one started: followed again where it is. */
  private async follow(run: Run, held: () => void) {
    const thread = this.thread(run.seat.sessionId)
    thread.active.add(run)
    // Its credentials' values went with the runner before: nothing to hide them with.
    if (run.secret) run.blind = true
    let link: MachineLink
    try {
      link = await this.machine(run, thread, held)
    } catch (error) {
      run.notes.push(`Its machine could not be reached again: ${errorText(error)}`)
      return this.finish(run, thread, undefined, { status: 'failed', ran: false })
    }
    run.status = 'running'
    this.limit(run)
    await this.followOn(run, thread, link)
  }

  /** Its output as it comes, until it ends; a connection cut meanwhile is made again. */
  private async followOn(run: Run, thread: ThreadMachine, link: MachineLink) {
    const dir = runDir(run.id)
    for (let cuts = 0; ;) {
      if (this.detached) return
      const code = await this.readLog(run, link, true)
      if (this.detached) return
      const state = await link
        .exec(
          `cd ${dir} 2>/dev/null || { echo gone; exit 0; }; if [ -s exit ]; then echo "exit $(cat exit)"; ` +
            `elif ${ALIVE}; then echo running; else echo ended; fi`,
          '',
          30_000,
        )
        .then((out) => out.trim())
        .catch(() => null)
      if (this.detached) return
      if (state?.startsWith('exit ') || state === 'ended') {
        // What it wrote after the follow was cut (the connection lost as it ended), to its end.
        const read = await this.drain(run, thread, link)
        if (this.detached) return
        if (!read)
          run.notes.push(
            `Its last output could not be read here: it is on the machine, in ${runDir(run.id)}/output.log`,
          )
        if (state.startsWith('exit ')) {
          const exitCode = Number(state.slice(5))
          return this.finish(run, thread, link, {
            status: run.ending ?? (exitCode === 0 ? 'succeeded' : 'failed'),
            exitCode,
            ran: true,
          })
        }
        if (!run.ending)
          run.notes.push(
            'It ended without an exit status: its machine stopped while it ran, or it was killed',
          )
        return this.finish(run, thread, link, { status: run.ending ?? 'failed', ran: true })
      }
      if (state === 'gone') {
        if (!run.ending)
          run.notes.push(
            'Its files are not on the machine: it never started there, or the machine was made again',
          )
        return this.finish(run, thread, link, { status: run.ending ?? 'failed', ran: false })
      }
      if (state === 'running' && code !== 255) {
        // Its script is gone but not what it started (being stopped), or its follow failed: again,
        // a second later.
        await new Promise((done) => setTimeout(done, 1000))
        continue
      }
      // The connection was cut (ssh says 255): made again, then followed on from where it was.
      if (++cuts > 5) {
        run.notes.push('Lost its connection to the machine too many times: it may still run there')
        return this.finish(run, thread, undefined, { status: 'failed', ran: false })
      }
      try {
        thread.connecting ??= link.connect().finally(() => {
          thread.connecting = undefined
        })
        await thread.connecting
      } catch (error) {
        run.notes.push(`Lost its machine: ${errorText(error)}`)
        return this.finish(run, thread, undefined, { status: 'failed', ran: false })
      }
    }
  }

  /**
   * Its output file read to its end, from the byte read so far: tried again, the connection made
   * again, when a read fails (each goes on from where the last stopped). Whether it got there.
   */
  private async drain(run: Run, thread: ThreadMachine, link: MachineLink) {
    for (let tries = 0; tries < 5; tries++) {
      if (this.detached) return false
      if ((await this.readLog(run, link, false)) === 0) return true
      await new Promise((done) => setTimeout(done, 1000))
      thread.connecting ??= link.connect().finally(() => {
        thread.connecting = undefined
      })
      await thread.connecting.catch(() => undefined)
    }
    return false
  }

  /**
   * Its output file from the byte read so far: followed while anything of it runs (`follow`),
   * else read to its end. Resolves to ssh's exit code.
   */
  private readLog(run: Run, link: MachineLink, follow: boolean) {
    const dir = runDir(run.id)
    const from = run.offset + 1
    const command = follow
      ? `cd ${dir} && if ${ALIVE}; then exec tail -c +${from} -f --pid="$(cat pid)" output.log; ` +
        `else exec tail -c +${from} output.log; fi`
      : `cd ${dir} && exec tail -c +${from} output.log`
    return new Promise<number | null>((done) => {
      const child = link.spawn(command, 'ignore')
      if (follow) run.follower = child
      child.stdout!.on('data', (data: Buffer) => {
        run.offset += data.length
        this.append(run, run.decoder.write(data))
      })
      child.stderr!.resume()
      child.once('error', () => done(null))
      child.once('close', (exit) => {
        if (run.follower === child) run.follower = undefined
        done(exit)
      })
    })
  }

  /** Ask it to end: stopped by the teammate, or past its time limit. */
  private async end(run: Run, how: 'stopped' | 'timed_out') {
    if (ended(run.status) || run.ending) return
    run.ending = how
    if (how === 'timed_out')
      run.notes.push(`Stopped after ${Math.round(run.timeoutMs / 60_000)} minutes, its time limit`)
    const link = this.threads.get(run.seat.sessionId)?.link
    // Still starting: it gives up at its next step, or is stopped as soon as it runs.
    if (run.status !== 'running' || !link) return
    this.kill(run, link)
  }

  /**
   * TERM to all it runs there, then KILL what is left a while later, whatever its status says by
   * then: a TERM ends its script before what it started, and what ignores TERM outlives both.
   */
  private kill(run: Run, link: MachineLink) {
    void this.signal(run, link, 'TERM')
    setTimeout(
      () => void this.signal(run, link, 'KILL'),
      this.options.stopGraceMs ?? STOP_GRACE_MS,
    ).unref()
  }

  private signal(run: Run, link: MachineLink, signal: 'TERM' | 'KILL') {
    return link
      .exec(
        `cd ${runDir(run.id)} 2>/dev/null && ${SAME_BOOT} && pg=$(cat pid) && [ -n "$pg" ] && ` +
          `kill -${signal} -"$pg" 2>/dev/null; true`,
        '',
        15_000,
      )
      .catch(() => undefined)
  }

  /**
   * It ended: its outputs come back (when it ran there), then it says how it ended, the machine
   * is released, kept up a while for the next command, and the thread's sync stops with its last.
   */
  private async finish(
    run: Run,
    thread: ThreadMachine,
    link: MachineLink | undefined,
    outcome: Outcome,
  ) {
    // The runner is stopping: left unfinished in the state file, for the next one to finish.
    if (this.detached) return
    clearTimeout(run.timer)
    if (outcome.exitCode !== undefined) run.exitCode = outcome.exitCode
    const tail = run.decoder.end()
    if (tail) this.append(run, tail)
    if (outcome.ran && link && run.outputs.length) {
      await this.bringBack(run, link).catch((error: unknown) => {
        run.notes.push(`Its outputs could not come back: ${errorText(error)}`)
      })
      // Its files are not all back: the next runner brings them back, then says it ended.
      if (this.detached) return
    }
    run.status = outcome.status
    run.endedAt = Date.now()
    thread.active.delete(run)
    this.save()
    run.finished()
    if (!thread.active.size) {
      clearInterval(thread.touchTimer)
      thread.touchTimer = undefined
      for (const copy of thread.copies.values()) copy.sync.stop()
      thread.copies.clear()
      thread.placing = undefined
      thread.link?.close()
    }
    if (!run.held) return
    run.held = false
    await this.options.holds.release(
      run.seat.sessionId,
      holderOf(run),
      this.options.idleMs ?? IDLE_MS,
    )
  }

  /** The outputs it made, from its folder there into the same place here, as the teammate. */
  private async bringBack(run: Run, link: MachineLink) {
    const there = shellQuote(run.remoteCwd)
    const listed = await link.exec(
      `cd -- ${there} 2>/dev/null || exit 0; for p in ${run.outputs.map(shellQuote).join(' ')}; do ` +
        '[ -e "$p" ] && du -sb -- "$p"; done; true',
      '',
      60_000,
    )
    const present = new Map<string, number>()
    for (const line of listed.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab > 0) present.set(line.slice(tab + 1), Number(line.slice(0, tab)))
    }
    const missing = run.outputs.filter((path) => !present.has(path))
    if (missing.length) run.notes.push(`Not made: ${missing.join(', ')}`)
    if (!present.size) return
    const total = [...present.values()].reduce((sum, bytes) => sum + bytes, 0)
    if (total > OUTPUTS_MAX) {
      run.notes.push(
        `Its outputs (${size(total)}) are more than ${size(OUTPUTS_MAX)}: they stay on the machine. Name fewer files`,
      )
      return
    }
    const paths = [...present.keys()]
    // With their times to the nanosecond (pax) and their modes as they are: what comes back is
    // what the machine has, so the next command's sync does not send it there again.
    const source = link.spawn(
      `cd -- ${there} && exec tar --format=posix -c -f - -- ${paths.map(shellQuote).join(' ')}`,
      'ignore',
    )
    const tarArgs = ['tar', '-x', '-p', '-f', '-', '-C', run.localCwd]
    const sink = run.seat.runAs
      ? spawn('sudo', ['-n', '-u', run.seat.runAs, '--', ...tarArgs], {
          cwd: '/',
          stdio: ['pipe', 'ignore', 'pipe'],
        })
      : spawn(tarArgs[0]!, tarArgs.slice(1), { cwd: '/', stdio: ['pipe', 'ignore', 'pipe'] })
    let said = ''
    sink.stderr!.on('data', (d: Buffer) => (said += d.toString('utf8')))
    source.stderr!.on('data', (d: Buffer) => (said += d.toString('utf8')))
    source.stdout!.pipe(sink.stdin!)
    sink.stdin!.on('error', () => undefined)
    const [sent, written] = await Promise.all([
      new Promise<number | null>((done) => {
        source.once('error', () => done(null))
        source.once('close', done)
      }),
      new Promise<number | null>((done) => {
        sink.once('error', () => done(null))
        sink.once('close', done)
      }),
    ])
    if (sent !== 0 || written !== 0)
      throw new Error(said.trim().split('\n').slice(-3).join(' ') || 'the copy failed')
    run.files = paths.map((path) => {
      const here = run.cwd === '.' ? path : `${run.cwd}/${path}`
      return `${here} (${size(present.get(path)!)})`
    })
  }

  /** Output as it comes: whole lines kept, a progress bar's last state, credentials hidden. */
  private append(run: Run, text: string) {
    const parts = (run.partial + text).split('\n')
    run.partial = parts.pop() ?? ''
    // A line redrawn (\r) keeps its last state; its end is kept when it never ends.
    const cut = run.partial.lastIndexOf('\r', run.partial.length - 2)
    if (cut >= 0) run.partial = run.partial.slice(cut + 1)
    // Its credentials' values hidden before it is cut: a cut never leaves part of one.
    if (run.partial.length > PARTIAL_MAX)
      run.partial = this.hide(run, run.partial).slice(-PARTIAL_MAX)
    for (const part of parts) run.lines.push(this.clean(run, part))
    if (run.lines.length > OUTPUT_LINES) run.lines.splice(0, run.lines.length - OUTPUT_LINES)
  }

  private clean(run: Run, line: string) {
    const last = line.replace(/\r+$/, '').split('\r').pop() ?? ''
    return this.hide(run, last.replace(ANSI, ''))
  }

  private hide(run: Run, text: string) {
    return run.hidden.reduce((shown, value) => shown.split(value).join(HIDDEN), text)
  }

  /**
   * The line it is writing, not ended yet: its end may be the start of a credential's value whose
   * rest is still to come, hidden too.
   */
  private unfinished(run: Run, text: string) {
    let shown = this.clean(run, text)
    for (const value of run.hidden)
      for (let n = Math.min(value.length - 1, shown.length); n > 0; n--)
        if (shown.endsWith(value.slice(0, n))) {
          shown = `${shown.slice(0, shown.length - n)}${HIDDEN}`
          break
        }
    return shown
  }

  private view(run: Run, lines = TAIL_LINES): MachineRunView {
    const end = run.endedAt ?? Date.now()
    const notes = [...run.notes]
    // Its credentials' values are not known to a runner that started after it: nothing to hide them with.
    const withheld = !!run.blind
    if (withheld)
      notes.push(
        'Its output is not shown: it had credentials, whose values this runner cannot hide',
      )
    let output: string | undefined
    if (!withheld) {
      const all = run.partial ? [...run.lines, this.unfinished(run, run.partial)] : run.lines
      output = all.slice(-Math.min(Math.max(lines, 1), OUTPUT_LINES)).join('\n')
      if (output.length > TAIL_CHARS) output = `…${output.slice(-TAIL_CHARS)}`
      if (run.resumed && !output)
        notes.push(
          `Its output was not kept here: the runner started again since. It is on the machine, in ${runDir(run.id)}/output.log`,
        )
    }
    return {
      id: run.id,
      command: run.command,
      cwd: run.cwd,
      status: run.status,
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      startedAt: new Date(run.startedAt).toISOString(),
      ...(run.endedAt ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
      seconds: Math.round((end - run.startedAt) / 1000),
      ...(output !== undefined ? { output } : {}),
      ...(run.files ? { files: run.files } : {}),
      notes,
    }
  }

  /** Until it ended (its outputs back), `ms` passed, or the call was cut. */
  private async wait(run: Run, ms: number, signal?: AbortSignal) {
    if (ended(run.status) && !this.threads.get(run.seat.sessionId)?.active.has(run)) return
    let timer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    await Promise.race([
      run.done,
      new Promise<void>((done) => {
        timer = setTimeout(done, Math.max(ms, 0))
        onAbort = () => done()
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }

  /** What a runner after this one needs to follow its commands, and to say how the last ones went. */
  private save() {
    const all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
    const keep = all.filter((run) => !ended(run.status))
    keep.push(...all.filter((run) => ended(run.status)).slice(0, KEPT))
    for (const run of all) if (!keep.includes(run)) this.runs.delete(run.id)
    const saved: SavedRun[] = keep.map((run) => ({
      id: run.id,
      seat: run.seat,
      command: run.command,
      cwd: run.cwd,
      outputs: run.outputs,
      localCwd: run.localCwd,
      root: run.root,
      remoteRoot: run.remoteRoot,
      remoteCwd: run.remoteCwd,
      status: run.status,
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      timeoutMs: run.timeoutMs,
      secret: run.secret,
      ...(run.blind ? { blind: true } : {}),
      ...(run.files ? { files: run.files } : {}),
      notes: run.notes,
      // The end of an ended one's output, for machine_run after a restart (a wake-up's turn).
      ...(ended(run.status) && !run.blind ? { tail: keptTail(run.lines) } : {}),
    }))
    try {
      mkdirSync(dirname(this.options.stateFile), { recursive: true })
      const temp = `${this.options.stateFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(saved))
      renameSync(temp, this.options.stateFile)
    } catch (error) {
      console.warn(`could not save the machine commands: ${String(error)}`)
    }
  }
}
