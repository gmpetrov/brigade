// A preview on a machine of its own (docs/previews.md, the preview_machines feature). The app
// runs on a VM the API made for its thread; its code stays here, in the teammate's checkout,
// where the teammate, the code panel and git change it. The runner holds one SSH connection to
// the machine (OpenSSH's ControlMaster) and over it:
//   - keeps the machine's copy in sync, one way: preview-sync-reader.ts runs here as the
//     teammate and sends each change to preview-sync-receiver.ts on the machine, which writes it
//     there, where the dev server sees it as a local edit and reloads;
//   - runs the app's setup and command there, its output coming back as the preview's log;
//   - forwards the app's ports here, to 127.0.0.1, where the preview's proxy reaches them as it
//     reaches an app on this computer: the gateway, the address and every panel stay the same.
// The runner's key is its own (never the teammate's): the API lets it into each machine, and
// gives the machine's host key from the provider's API, so it is pinned before connecting.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PreviewMachineAccess } from '@brigade/contracts'

const run = promisify(execFile)
const here = fileURLToPath(import.meta.url)

/** The sync's halves, beside this file: the reader runs here, the receiver is copied over. */
export const READER = join(dirname(here), `preview-sync-reader${extname(here)}`)
const RECEIVER = join(dirname(here), `preview-sync-receiver${extname(here)}`)

/** On the machine, in its user's home: Brigade's files, and the copies of the checkouts. */
const REMOTE_DIR = '.brigade'
export const REMOTE_WORK = 'work'

/** How long a machine that just started may refuse SSH (boat: restoring, securing). */
const CONNECT_MS = 90_000
/**
 * How long a flush waits for the machine to say all is written while nothing goes there: it
 * waits as long as bytes go (a file of 2 GB takes tens of seconds between two machines).
 */
const FLUSH_MS = 60_000
/**
 * The same for the first sync (the whole checkout), which may meet files read for the first
 * time since the computer started (restored from its snapshot as they are read); and how long
 * the machine may take to say what it lacks.
 */
const FIRST_SYNC_MS = 5 * 60_000

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Why a flush failed: files that changed while they went, so the machine has no whole copy. */
export function notWhole(paths: string[]) {
  const named =
    paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '')
  const one = paths.length === 1
  return (
    `The thread’s machine has no whole copy of ${named} yet: ${one ? 'it' : 'they'} kept changing ` +
    `while ${one ? 'it was' : 'they were'} sent. Try again once ${one ? 'it stops' : 'they stop'} changing`
  )
}

/** A value for the shell, in single quotes. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

let keyMaking: Promise<{ file: string; publicKey: string }> | undefined

/** The runner's key for preview machines, made the first time: the API lets it into each. */
export function machineKey(home: string) {
  keyMaking ??= (async () => {
    const dir = join(home, 'preview-machines')
    const file = join(dir, 'id_ed25519')
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'brigade-runner', '-f', file])
    }
    return { file, publicKey: readFileSync(`${file}.pub`, 'utf8').trim() }
  })().catch((error: unknown) => {
    keyMaking = undefined
    throw error
  })
  return keyMaking
}

/** A free port on 127.0.0.1, for a forward. */
function freePort() {
  return new Promise<number>((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? done(address.port) : fail(new Error('No port')),
      )
    })
  })
}

/** One SSH connection to a machine, which every command and forward to it shares. */
export class MachineLink {
  private master?: ChildProcess
  private readonly control: string
  private readonly knownHosts: string
  /** Its forwards, by the app's port: made again when the connection is. */
  private readonly forwards = new Map<number, number>()

  constructor(
    private access: PreviewMachineAccess,
    private readonly key: string,
    stateDir: string,
  ) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.knownHosts = join(stateDir, 'known_hosts')
    // A socket's path has at most 104 to 108 bytes: a short one, in the runner's own /tmp. Each
    // link its own, even to the same machine: a link that replaces another (a new start) never
    // shares, or takes over, a connection the other may still be closing.
    const id = createHash('sha256')
      .update(`${access.id}:${randomUUID()}`)
      .digest('hex')
      .slice(0, 16)
    this.control = join(tmpdir(), `bpm-${id}`)
  }

  get size() {
    return this.access.size
  }

  /** How it reaches the machine, for a runner after this one (no secret in it: the host key is public). */
  get machine() {
    return this.access
  }

  /** After the machine started again: its new address and host key. */
  update(access: PreviewMachineAccess) {
    this.access = access
  }

  /** ssh's options for this machine; `master`: the connection the others share. */
  options(master = false) {
    return [
      '-F',
      'none',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-i',
      this.key,
      '-o',
      `UserKnownHostsFile=${this.knownHosts}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `HostKeyAlias=${this.access.id}`,
      '-o',
      `ControlPath=${this.control}`,
      '-o',
      `ControlMaster=${master ? 'yes' : 'no'}`,
      '-o',
      'ControlPersist=no',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'LogLevel=ERROR',
      '-p',
      String(this.access.port),
      `${this.access.user}@${this.access.host}`,
    ]
  }

  /**
   * Whether something listens on the app's port on the machine: asked there, as a forward here
   * accepts a connection whatever is behind it. False while not connected.
   */
  async answers(port: number) {
    if (!(await this.alive())) return false
    return this.exec(`exec 3<>/dev/tcp/127.0.0.1/${port}`, '', 10_000).then(
      () => true,
      () => false,
    )
  }

  /** Connected: the shared connection is up. */
  async alive() {
    if (!this.master || this.master.exitCode !== null) return false
    return run('ssh', [...this.options(), '-O', 'check'], { timeout: 10_000 }).then(
      () => true,
      () => false,
    )
  }

  /**
   * Open the shared connection, trying again while the machine is still starting, and make its
   * forwards again.
   */
  async connect() {
    if (await this.alive()) return
    this.master?.kill()
    writeFileSync(this.knownHosts, `${this.access.id} ${this.access.hostKey}\n`, { mode: 0o600 })
    const deadline = Date.now() + CONNECT_MS
    let said = ''
    for (;;) {
      const master = spawn('ssh', [...this.options(true), '-N'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      this.master = master
      master.stderr?.on('data', (data: Buffer) => (said = data.toString('utf8').trim()))
      for (let i = 0; i < 30 && master.exitCode === null; i++) {
        if (await this.alive()) {
          const forwards = [...this.forwards]
          for (const [remote, local] of forwards) await this.addForward(remote, local)
          return
        }
        await sleep(500)
      }
      master.kill()
      if (Date.now() > deadline)
        throw new Error(`Could not reach the thread's machine over SSH${said ? `: ${said}` : ''}`)
      await sleep(2000)
    }
  }

  /** A command on the machine, its output coming here. */
  spawn(command: string, stdio: 'pipe' | 'ignore' = 'pipe') {
    return spawn('ssh', [...this.options(), command], {
      stdio: [stdio === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  }

  /** A command on the machine, with `input` as its stdin; resolves to its output. */
  exec(command: string, input = '', timeoutMs = 60_000) {
    return new Promise<string>((done, fail) => {
      const child = spawn('ssh', [...this.options(), command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
      child.on('error', fail)
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) done(out)
        else
          fail(new Error(err.trim() || `The command on the thread's machine exited with ${code}`))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    })
  }

  /** The app's port on the machine, reached here at 127.0.0.1 on the port this resolves to. */
  async forward(remote: number) {
    const known = this.forwards.get(remote)
    if (known !== undefined) return known
    const local = await freePort()
    await this.addForward(remote, local)
    this.forwards.set(remote, local)
    return local
  }

  private async addForward(remote: number, local: number) {
    await run(
      'ssh',
      [...this.options(), '-O', 'forward', '-L', `127.0.0.1:${local}:127.0.0.1:${remote}`],
      { timeout: 15_000 },
    )
  }

  /** The local port forwarded to the app's port, once forward made it. */
  local(remote: number) {
    return this.forwards.get(remote)
  }

  /** Its own connection ends (not `ssh -O exit`, which would end another link's to the same machine). */
  close() {
    this.master?.kill()
    this.master = undefined
  }
}

/**
 * The machine's copy of a checkout, kept in sync: the reader here (as the teammate), the receiver
 * there, and the runner between them, passing on what the receiver asks for and its
 * acknowledgements.
 */
export class MachineSync {
  private reader?: ChildProcess
  private receiver?: ChildProcess
  private marks = 0
  private readonly acks = new Map<number, { done: () => void; fail: (error: Error) => void }>()
  private needWaiter?: (paths: string[]) => void
  private broken = true
  /** When bytes last went from the reader towards the machine: a flush waits while they do. */
  private moved = 0

  constructor(
    private readonly link: MachineLink,
    /** The reader, started as the teammate, for the checkout. */
    private readonly startReader: () => ChildProcess,
    /** The copy's folder on the machine, relative to its user's home. */
    private readonly remoteRoot: string,
    private readonly log: (line: string) => void,
  ) {}

  /** Up and in sync: the whole checkout the first time, what changed meanwhile after a cut. */
  async start(): Promise<number> {
    this.stop()
    await this.link.exec(
      // Written aside, then moved in place: a sync starting meanwhile (the preview's, a
      // command's) never runs it half written.
      `mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_DIR}/preview-sync-receiver.mjs.$$ && ` +
        `mv -f ${REMOTE_DIR}/preview-sync-receiver.mjs.$$ ${REMOTE_DIR}/preview-sync-receiver.mjs`,
      readFileSync(RECEIVER, 'utf8'),
    )
    const state = `${REMOTE_DIR}/sync/${createHash('sha256').update(this.remoteRoot).digest('hex').slice(0, 16)}.json`
    const receiver = this.link.spawn(
      `node ${REMOTE_DIR}/preview-sync-receiver.mjs ${shellQuote(this.remoteRoot)} ${shellQuote(state)}`,
    )
    const reader = this.startReader()
    this.receiver = receiver
    this.reader = reader
    this.broken = false
    /** What the side that stopped said last, to say why. */
    let said = ''
    let cutBy = ''
    const cut = (who: string) => () => {
      if (this.reader !== reader) return
      cutBy = `${who}${said ? `: ${said}` : ''}`
      this.log(
        `[preview] The sync with the machine stopped (${cutBy}); it starts again with the next change`,
      )
      this.broken = true
      this.stop()
    }
    receiver.on('close', cut('the machine’s side'))
    reader.on('close', cut('this computer’s side'))
    receiver.on('error', cut('the machine’s side'))
    reader.on('error', cut('this computer’s side'))
    reader.stdout!.pipe(receiver.stdin!)
    // Taken only as fast as the machine takes them (the pipe waits): bytes that move are progress.
    reader.stdout!.on('data', () => (this.moved = Date.now()))
    receiver.stdin!.on('error', () => undefined)
    reader.stdin!.on('error', () => undefined)
    reader.stderr!.on('data', (d: Buffer) => {
      said = d.toString('utf8').trim().split('\n').pop() ?? ''
      this.log(d.toString('utf8').trimEnd())
    })
    receiver.stderr!.on('data', (d: Buffer) => {
      said = d.toString('utf8').trim().split('\n').pop() ?? ''
      this.log(`[preview] ${d.toString('utf8').trimEnd()}`)
    })
    createInterface({ input: receiver.stdout! }).on('line', (line) => {
      let message: {
        t?: string
        id?: number
        paths?: string[]
        message?: string
        partial?: unknown[]
      }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        return
      }
      if (message.t === 'need' && Array.isArray(message.paths)) {
        reader.stdin!.write(`${JSON.stringify({ t: 'need', paths: message.paths })}\n`)
        this.needWaiter?.(message.paths)
      } else if (message.t === 'ack' && typeof message.id === 'number') {
        // Files that went cut short and not whole since (they changed while they went): the
        // flush that mark ends does not vouch for them, so a command never runs on that copy.
        const partial = (message.partial ?? []).filter((p): p is string => typeof p === 'string')
        for (const [id, ack] of this.acks)
          if (id < message.id || (id === message.id && !partial.length)) ack.done()
          else if (id === message.id) ack.fail(new Error(notWhole(partial)))
      } else if (message.t === 'error')
        this.log(`[preview] The machine could not write a file: ${message.message ?? ''}`)
    })
    // The reader starts with the manifest; the receiver answers with what it needs, which the
    // reader sends before the mark of the flush below.
    const needed = await new Promise<string[]>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error('The thread’s machine did not answer the sync')),
        FIRST_SYNC_MS,
      )
      this.needWaiter = (paths) => {
        clearTimeout(timer)
        this.needWaiter = undefined
        done(paths)
      }
      // Either side stopping stops both (cut): the sync could not start.
      reader.once('close', () => {
        clearTimeout(timer)
        fail(
          new Error(
            `The sync with the thread’s machine stopped (${cutBy || 'this computer’s side'})`,
          ),
        )
      })
    })
    await this.flush(FIRST_SYNC_MS)
    return needed.length
  }

  /** Whether the next flush starts the sync (again). */
  get stopped() {
    return this.broken
  }

  /**
   * Everything changed so far is on the machine: resolves once it says so. When the sync had to
   * start (the first time, or after it was cut), resolves to the number of files it sent. Fails
   * once `timeoutMs` passed without it and without a byte going to the machine: while bytes go
   * (large files), it waits as long as they take.
   */
  async flush(timeoutMs = FLUSH_MS): Promise<number | undefined> {
    if (this.broken) return this.start()
    const reader = this.reader
    if (!reader?.stdin) throw new Error('The sync with the thread’s machine is not running')
    const id = ++this.marks
    const since = Date.now()
    const acked = new Promise<undefined>((done, fail) => {
      const wait = () => {
        const still = Math.max(since, this.moved) + timeoutMs - Date.now()
        if (still > 0) {
          timer = setTimeout(wait, still)
          return
        }
        this.acks.delete(id)
        fail(new Error('The thread’s machine did not confirm the latest changes in time'))
      }
      let timer = setTimeout(wait, timeoutMs)
      this.acks.set(id, {
        done: () => {
          clearTimeout(timer)
          this.acks.delete(id)
          done(undefined)
        },
        fail: (error) => {
          clearTimeout(timer)
          this.acks.delete(id)
          fail(error)
        },
      })
    })
    reader.stdin.write(`${JSON.stringify({ t: 'flush', id })}\n`)
    return acked
  }

  /** Both halves stop; what waited on them fails, and the next flush starts them again. */
  stop() {
    const { reader, receiver } = this
    this.reader = undefined
    this.receiver = undefined
    this.broken = true
    for (const ack of [...this.acks.values()])
      ack.fail(new Error('The sync with the thread’s machine stopped'))
    reader?.stdin?.end()
    reader?.kill()
    receiver?.stdin?.end()
    receiver?.kill()
  }
}

/**
 * On the machine: the app's process group, its environment and its script, its output and how it
 * ended. The app runs detached there (a session of its own), its output in a file the runner
 * follows: a cut connection, or the next runner after an update, goes on reading where it was.
 */
const RUN_DIR = `${REMOTE_DIR}/run`
const PID_FILE = `${RUN_DIR}/app.pid`
/** A run's output, named after it: what is meant for one run never reaches the next one's. */
export const outputFile = (id: string) =>
  `${RUN_DIR}/output-${id.replace(/[^A-Za-z0-9_-]/g, '')}.log`

/** Whether the machine still runs what it ran when the app started (it was not stopped since). */
const SAME_BOOT = `[ "$(cat ${RUN_DIR}/boot 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id)" ]`
/** Whether anything of the app still runs there: any process of its group, not only its script. */
const ALIVE = `${SAME_BOOT} && kill -0 -"$(cat ${PID_FILE} 2>/dev/null)" 2>/dev/null`

/** A dotenv-like file the machine's shell sources: KEY='value' lines. */
export function envFileText(env: Record<string, string>) {
  return Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')
}

/**
 * The script the machine runs for the app: as the local wrapper does, its setup first when asked,
 * then its command, and how it ended in a file. Started in a session of its own, which it leads:
 * noted, its id stops it all.
 */
export function remoteScript(input: {
  dir: string
  envFiles: number
  setup?: string
  command: string
  appStarts: string
}) {
  // Its files are named from the home folder sshd starts in: the run's folder kept before the cd.
  const lines = [
    `run="$PWD/${RUN_DIR}"`,
    'echo $$ > "$run/app.pid"',
    'cat /proc/sys/kernel/random/boot_id > "$run/boot" 2>/dev/null',
    'ended() { echo "$1" > "$run/exit.tmp" && mv -f "$run/exit.tmp" "$run/exit"; exit "$1"; }',
    'set -a',
    '. "$run/env"',
    ...Array.from({ length: input.envFiles }, (_, i) => `. "$run/credentials-${i}"`),
    'set +a',
    `cd -- ${shellQuote(input.dir)} || ended 1`,
  ]
  if (input.setup?.trim())
    lines.push(
      'echo "[preview] Running the setup"',
      `sh -ec ${shellQuote(input.setup)} || { echo "[preview] The setup failed" >&2; ended 1; }`,
      `echo ${shellQuote(input.appStarts)}`,
    )
  lines.push(`sh -c ${shellQuote(input.command)} </dev/null`, 'ended $?')
  return `${lines.join('\n')}\n`
}

/**
 * Write the app's environment and script on the machine: by stdin, never on a command line, in
 * a folder made again for each run, so nothing of an earlier run (its credentials, which a later
 * run may not have been given, its output) is left for this one.
 */
export async function writeRun(
  link: MachineLink,
  env: Record<string, string>,
  credentials: string[],
  script: string,
) {
  await link.exec(`rm -rf ${RUN_DIR} && mkdir -p -m 700 ${RUN_DIR}`)
  const write = (file: string, text: string) =>
    link.exec(`umask 077 && cat > ${RUN_DIR}/${file}`, text)
  await write('env', envFileText(env))
  for (const [i, text] of credentials.entries()) await write(`credentials-${i}`, text)
  await write('app.sh', script)
}

/** The app stopped: its settings and credentials leave the machine. As far as it can: best effort. */
export function clearRun(link: MachineLink) {
  return link
    .exec(`rm -f ${RUN_DIR}/env ${RUN_DIR}/credentials-*`, '', 15_000)
    .then(() => undefined)
    .catch(() => undefined)
}

/**
 * Start the app on the machine, detached: it outlives the connection that started it and the
 * runner. Resolves once it noted its process group.
 */
export async function startApp(link: MachineLink, id: string) {
  await link.exec(
    `(setsid nohup bash ${RUN_DIR}/app.sh > ${outputFile(id)} 2>&1 < /dev/null &); i=0; ` +
      `while [ ! -s ${PID_FILE} ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; [ -s ${PID_FILE} ]`,
  )
}

/**
 * The app's output from byte `offset` (0 for the start): followed while anything of it runs
 * (`follow`), else read to its end. Its stdout carries the output.
 */
export function readOutput(link: MachineLink, id: string, offset: number, follow: boolean) {
  const from = offset + 1
  const file = outputFile(id)
  return link.spawn(
    follow
      ? `if ${ALIVE}; then exec tail -c +${from} -f --pid="$(cat ${PID_FILE})" ${file}; ` +
          `else exec tail -c +${from} ${file}; fi`
      : `exec tail -c +${from} ${file}`,
    'ignore',
  )
}

/**
 * Give back the disk the first `length` bytes of the app's output hold there, once read: they
 * become a hole, so the file's size and every offset stay, and what the app writes goes on.
 */
export function freeOutput(link: MachineLink, id: string, length: number) {
  const file = outputFile(id)
  // Only that run's file: another run's (a restart's) is never touched, and none is made.
  return link.exec(
    `[ ! -f ${file} ] || fallocate --punch-hole --offset 0 --length ${length} ${file}`,
    '',
    15_000,
  )
}

/**
 * How the app stands on the machine: running, ended with its exit status, ended without one (its
 * machine stopped, or it was killed), or gone (no run there: the machine was made again).
 * Null when the machine could not be asked.
 */
export type AppState = { state: 'running' | 'gone' } | { state: 'ended'; code: number | null }

export async function appState(link: MachineLink): Promise<AppState | null> {
  const said = await link
    .exec(
      `[ -s ${PID_FILE} ] || { echo gone; exit 0; }; ` +
        `if [ -s ${RUN_DIR}/exit ]; then echo "exit $(cat ${RUN_DIR}/exit)"; ` +
        `elif ${ALIVE}; then echo running; else echo ended; fi`,
      '',
      30_000,
    )
    .then((out) => out.trim())
    .catch(() => null)
  if (said === null) return null
  if (said.startsWith('exit ')) return { state: 'ended', code: Number(said.slice(5)) }
  if (said === 'running' || said === 'gone') return { state: said }
  return { state: 'ended', code: null }
}

/**
 * Signal the app's whole process group on the machine (what its last run left too). Not a group
 * noted before the machine last started, whose number is someone else's by now.
 */
export function signalApp(link: MachineLink, signal: 'TERM' | 'KILL') {
  return link
    .exec(
      // Not `kill -SIG -- -pg`: dash, the shell commands may run in, refuses its `--`.
      `{ [ ! -e ${RUN_DIR}/boot ] || ${SAME_BOOT}; } && pg=$(cat ${PID_FILE} 2>/dev/null) && ` +
        `[ -n "$pg" ] && kill -${signal} -"$pg" 2>/dev/null; true`,
      '',
      15_000,
    )
    .catch(() => undefined)
}
