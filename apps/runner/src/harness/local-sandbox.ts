// A sandbox provider that runs on the same machine as the runner and exposes
// the harness bridge on localhost. The computer itself is the sandbox.
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Readable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'

type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession['restricted']>
type ProcessOptions = Parameters<SandboxSession['spawn']>[0]

/** Find a free localhost port for the bridge. */
export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail()))
    })
  })
}

export function createLocalSandboxSession(options: {
  id: string
  workingDirectory: string
  port: number
  env: Record<string, string>
  /** Run every process and file operation as this Linux user (a teammate on a cloud computer). */
  runAs?: string
}): HarnessV1NetworkSandboxSession {
  const children = new Set<ChildProcess>()
  const at = (path: string) => (isAbsolute(path) ? path : resolve(options.workingDirectory, path))
  const runAs = options.runAs

  /** Stop a process group. sudo's group is killed as the teammate user, who owns it. */
  function killGroup(pid: number) {
    if (runAs) {
      spawnChild('sudo', ['-n', '-u', runAs, '--', 'kill', '-TERM', '--', `-${pid}`], {
        stdio: 'ignore',
      }).on('error', () => undefined)
      return
    }
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }

  const spawnAs = (
    command: string,
    cwd: string,
    env: Record<string, string>,
    stdin: 'ignore' | 'pipe' = 'ignore',
  ) =>
    runAs
      ? // sudo -E passes the environment without putting it on the command line.
        spawnChild(
          'sudo',
          [
            '-n',
            '-E',
            '-u',
            runAs,
            '--',
            'sh',
            '-c',
            'cd -- "$0" && exec sh -c "$1"',
            cwd,
            command,
          ],
          {
            cwd: '/',
            env,
            stdio: [stdin, 'pipe', 'pipe'],
            detached: true,
          },
        )
      : spawnChild('sh', ['-c', command], {
          cwd,
          env,
          stdio: [stdin, 'pipe', 'pipe'],
          detached: true,
        })

  const spawn = async ({ command, workingDirectory, env, abortSignal }: ProcessOptions) => {
    const child = spawnAs(
      command,
      workingDirectory ? at(workingDirectory) : options.workingDirectory,
      { ...options.env, ...env },
    )
    children.add(child)
    const exited = new Promise<{ exitCode: number }>((done, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => {
        children.delete(child)
        if (abortSignal?.aborted) fail(abortSignal.reason)
        else done({ exitCode: code ?? (signal ? 128 : 1) })
      })
    })
    const kill = async () => {
      if (child.exitCode !== null || child.pid === undefined) return
      killGroup(child.pid)
    }
    abortSignal?.addEventListener('abort', () => void kill(), { once: true })
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      wait: () => exited,
      kill,
    }
  }

  const collect = async (stream: ReadableStream<Uint8Array>) => {
    let text = ''
    const decoder = new TextDecoder()
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
    return text + decoder.decode()
  }

  /** File operations as the teammate user: the runner itself cannot read its home. */
  const asUser = (command: string, args: string[], input?: Uint8Array) =>
    new Promise<{ code: number; stdout: Buffer }>((done, fail) => {
      const child = spawnChild('sudo', ['-n', '-u', runAs!, '--', 'sh', '-c', command, ...args], {
        cwd: '/',
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      })
      const chunks: Buffer[] = []
      child.stdout!.on('data', (d: Buffer) => chunks.push(d))
      child.once('error', fail)
      child.once('close', (code) => done({ code: code ?? 1, stdout: Buffer.concat(chunks) }))
      if (input) child.stdin!.end(input)
    })
  const readAs = async (path: string) => {
    const r = await asUser('test -f "$0" && cat -- "$0"', [at(path)])
    return r.code === 0 ? new Uint8Array(r.stdout) : null
  }
  const writeAs = async (path: string, content: Uint8Array) => {
    const r = await asUser('mkdir -p -- "$(dirname -- "$0")" && cat > "$0"', [at(path)], content)
    if (r.code !== 0) throw new Error(`Could not write ${path}`)
  }

  const exists = async (path: string) =>
    stat(at(path)).then(
      (s) => s.isFile(),
      () => false,
    )

  const readBytes = async (path: string): Promise<Uint8Array | null> =>
    runAs ? readAs(path) : (await exists(path)) ? new Uint8Array(await readFile(at(path))) : null
  const writeBytes = async (path: string, bytes: Uint8Array) => {
    if (runAs) return writeAs(path, bytes)
    await mkdir(dirname(at(path)), { recursive: true })
    await writeFile(at(path), bytes)
  }

  const restricted: SandboxSession = {
    description: `Local computer. Working directory: ${options.workingDirectory}`,
    readFile: async ({ path }) => {
      if (!runAs)
        return (await exists(path))
          ? (Readable.toWeb(createReadStream(at(path))) as ReadableStream<Uint8Array>)
          : null
      const bytes = await readAs(path)
      return bytes ? new Blob([bytes]).stream() : null
    },
    readBinaryFile: async ({ path }) => readBytes(path),
    readTextFile: async ({ path, encoding, startLine, endLine }) => {
      const bytes = await readBytes(path)
      if (!bytes) return null
      const text = new TextDecoder(encoding ?? 'utf-8').decode(bytes)
      if (startLine === undefined && endLine === undefined) return text
      return text
        .split('\n')
        .slice((startLine ?? 1) - 1, endLine)
        .join('\n')
    },
    writeFile: async ({ path, content }) =>
      writeBytes(path, new Uint8Array(await new Response(content).arrayBuffer())),
    writeBinaryFile: async ({ path, content }) => writeBytes(path, content),
    writeTextFile: async ({ path, content }) => writeBytes(path, new TextEncoder().encode(content)),
    spawn,
    run: async (processOptions) => {
      const child = await spawn(processOptions)
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.wait(),
      ])
      return { exitCode, stdout, stderr }
    },
  }

  const endpoint = (port: number, protocol: 'http' | 'https' | 'ws' = 'http') =>
    `${protocol === 'ws' ? 'ws' : 'http'}://127.0.0.1:${port}`

  const stop = async () => {
    for (const child of children) if (child.pid) killGroup(child.pid)
  }

  return {
    ...restricted,
    id: options.id,
    defaultWorkingDirectory: options.workingDirectory,
    ports: [options.port],
    getPortEndpoint: async ({ port, protocol }) => ({ url: endpoint(port, protocol) }),
    getPortUrl: async ({ port, protocol }) => endpoint(port, protocol),
    stop,
    destroy: stop,
    restricted: () => restricted,
  }
}
