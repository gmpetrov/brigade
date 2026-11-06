import { spawn } from 'node:child_process'

/** Run a command as the teammate (or the runner's user), with text on its stdin. */
export function runAsUser(args: string[], runAs: string | undefined, input = '') {
  return new Promise<string>((done, fail) => {
    const child = runAs
      ? spawn('sudo', ['-n', '-u', runAs, '--', ...args], { cwd: '/' })
      : spawn(args[0]!, args.slice(1), { cwd: '/' })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', fail)
    child.on('close', (code) =>
      code === 0 ? done(out) : fail(new Error(err.trim() || `${args[0]} exited with ${code}`)),
    )
    // A command that exits without reading its input closes the pipe: not an error.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}
