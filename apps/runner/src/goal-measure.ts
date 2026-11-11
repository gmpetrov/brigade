// A goal's command measurement (docs/goals.md, goal.measure): the contract's command, run in the
// thread's working folder of its teammate, as that teammate on a cloud computer, at most its
// timeout. Not a turn, and the teammate never sees it: Brigade reads the exit code and the end of
// what it printed (goal.measured). Its whole process group is stopped at the timeout.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ApiToRunner, RunnerToApi } from '@brigade/contracts'
import { workDir } from './files.js'
import { harnessEnv } from './harness/env.js'
import { teammateHome } from './teammates.js'

type Request = Extract<ApiToRunner, { type: 'goal.measure' }>
type Result = Extract<RunnerToApi, { type: 'goal.measured' }>

/** What the API keeps of its output: the end. */
const OUTPUT_MAX = 8_000

/** Moves into the folder, then runs the command with sh: `$1` the folder, `$2` the command. */
const SCRIPT = 'cd "$1" && exec sh -c "$2"'

export function measureGoal(
  message: Request,
  where: { dir: string; user: string | undefined } = workDir(message.teammateId, message.sessionId),
): Promise<Result> {
  const base = {
    type: 'goal.measured' as const,
    measureId: message.measureId,
    sessionId: message.sessionId,
  }
  if (!existsSync(where.dir))
    return Promise.resolve({
      ...base,
      exitCode: null,
      output: '',
      error: 'The thread has no working folder on this computer yet',
    })
  const env = harnessEnv(
    where.user ? { HOME: teammateHome(where.user), USER: where.user, LOGNAME: where.user } : {},
  )
  return new Promise((resolve) => {
    const child = where.user
      ? spawn(
          'sudo',
          [
            '-n',
            '-E',
            '-u',
            where.user,
            '--',
            'sh',
            '-c',
            SCRIPT,
            'sh',
            where.dir,
            message.command,
          ],
          {
            cwd: '/',
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
      : spawn('sh', ['-c', SCRIPT, 'sh', where.dir, message.command], {
          cwd: '/',
          env,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    let output = ''
    const keep = (d: Buffer) => (output = (output + d.toString('utf8')).slice(-OUTPUT_MAX))
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, message.timeoutSeconds * 1_000)
    timer.unref?.()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ...base, exitCode: null, output, error: String(error).slice(0, 2_000) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut)
        return resolve({
          ...base,
          exitCode: null,
          output,
          error: `The command ran past its ${message.timeoutSeconds} seconds and was stopped`,
        })
      resolve({
        ...base,
        exitCode: code ?? null,
        output,
        ...(code === null ? { error: 'The command was stopped' } : {}),
      })
    })
  })
}
