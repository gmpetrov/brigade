// Takeover terminals on a cloud computer: a shell in the thread's directory, as
// the teammate's Linux user. Output streams to the API over the runner's own
// socket; nothing connects in. Each command run is recorded for the run log.
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentEvent, ThreadSpec } from '@brigade/contracts'
import { CLOUD } from './config.js'
import { harnessEnv } from './harness/env.js'
import { gitEnv } from './repos.js'
import { ensureUser, teammateHome, teammateUser } from './teammates.js'

const execFileAsync = promisify(execFile)
/** Commands as a teammate run from /, since the runner's own directory is not theirs to enter. */
const run = (file: string, args: string[]) => execFileAsync(file, args, { cwd: '/' })
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export const threadDir = (spec: ThreadSpec) =>
  `${teammateHome(teammateUser(spec.teammate.id))}/threads/${spec.sessionId}`

type Terminal = {
  child: ChildProcess
  user: string
  history: string
  sessionId: string
  memberId: string
}

export class Terminals {
  private open = new Map<string, Terminal>()

  constructor(
    private readonly send: {
      output: (terminalId: string, data: string) => void
      exit: (terminalId: string, code: number | null) => void
      event: (sessionId: string, event: AgentEvent) => void
    },
  ) {}

  async start(terminalId: string, spec: ThreadSpec, memberId: string, cols: number, rows: number) {
    if (!CLOUD) throw new Error('Takeover is only available on the workspace computer')
    if (!/^[0-9a-f-]{36}$/.test(terminalId)) throw new Error('Invalid terminal id')
    const user = teammateUser(spec.teammate.id)
    await ensureUser(user)
    const dir = threadDir(spec)
    await run('sudo', [
      '-n',
      '-u',
      user,
      'mkdir',
      '-p',
      dir,
      `${teammateHome(user)}/.brigade-history`,
    ])
    const history = `${teammateHome(user)}/.brigade-history/${terminalId}`
    const env = harnessEnv({
      HOME: teammateHome(user),
      USER: user,
      LOGNAME: user,
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      HISTFILE: history,
      PROMPT_COMMAND: 'history -a',
      // A person in control pushes as the teammate would: through Brigade, to brigade/ branches.
      ...gitEnv(spec.git),
    })
    // `script` gives the shell a real terminal without a native module.
    const shell = `stty cols ${cols} rows ${rows} 2>/dev/null; cd ${quote(dir)} && exec bash --login`
    const child = spawn(
      'sudo',
      ['-n', '-E', '-u', user, '--', 'script', '-qfc', shell, '/dev/null'],
      {
        cwd: '/',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const terminal: Terminal = { child, user, history, sessionId: spec.sessionId, memberId }
    this.open.set(terminalId, terminal)
    child.stdout!.on('data', (d: Buffer) => this.send.output(terminalId, d.toString('utf8')))
    child.stderr!.on('data', (d: Buffer) => this.send.output(terminalId, d.toString('utf8')))
    child.on('close', (code) => {
      this.open.delete(terminalId)
      this.send.exit(terminalId, code)
      void this.recordCommands(terminal)
    })
  }

  input(terminalId: string, data: string) {
    this.open.get(terminalId)?.child.stdin?.write(data)
  }

  close(terminalId: string) {
    const terminal = this.open.get(terminalId)
    if (!terminal) return
    // The shell runs as the teammate: end it as the teammate.
    void run('sudo', ['-n', '-u', terminal.user, 'pkill', '-HUP', '-f', terminal.history]).catch(
      () => undefined,
    )
    terminal.child.stdin?.end('exit\n')
  }

  get count() {
    return this.open.size
  }

  closeAll() {
    for (const id of this.open.keys()) this.close(id)
  }

  /** Put each command run in the terminal into the thread's run log, under the member's name. */
  private async recordCommands(terminal: Terminal) {
    try {
      const { stdout } = await run('sudo', ['-n', '-u', terminal.user, 'cat', terminal.history])
      for (const command of stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)) {
        this.send.event(terminal.sessionId, {
          at: new Date().toISOString(),
          type: 'terminal.command',
          command,
          memberId: terminal.memberId,
        })
      }
      await run('sudo', ['-n', '-u', terminal.user, 'rm', '-f', terminal.history])
    } catch {
      // no commands were run
    }
  }
}

/** Files in the thread's directory modified since a time, as the teammate's user. */
export async function changedFilesSince(spec: ThreadSpec, since: number): Promise<string[]> {
  const user = teammateUser(spec.teammate.id)
  const dir = threadDir(spec)
  const seconds = Math.floor(since / 1000)
  const { stdout } = await run('sudo', [
    '-n',
    '-u',
    user,
    'find',
    dir,
    '-type',
    'f',
    '-newermt',
    `@${seconds}`,
    '-not',
    '-path',
    '*/.git/*',
  ])
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((f) => f.slice(dir.length + 1))
    .slice(0, 200)
}
