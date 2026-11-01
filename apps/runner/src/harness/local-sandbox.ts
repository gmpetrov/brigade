// A sandbox provider that runs on the same machine as the runner and exposes
// the harness bridge on localhost (on a cloud computer, the thread's own: see
// thread-net.ts). The computer itself is the sandbox.
import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import { runnerCgroups, type TurnCgroup } from '../preview-cgroup.js'
import { processGroups } from '../process-groups.js'
import { asTeammate, threadNet, type ThreadNet } from '../thread-net.js'

type SandboxSession = ReturnType<HarnessV1NetworkSandboxSession['restricted']>
type ProcessOptions = Parameters<SandboxSession['spawn']>[0]
type FileStat = NonNullable<Awaited<ReturnType<SandboxSession['stat']>>>
type DirectoryEntry = NonNullable<Awaited<ReturnType<SandboxSession['listDirectory']>>>[number]
type SandboxProcess = {
  pid?: number
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  wait: () => Promise<{ exitCode: number }>
  kill: () => Promise<void>
}

/** Node's error code, such as ENOENT. */
const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** Stop a process group. One a teammate's sudo started is killed as that teammate, who owns it. */
export function stopGroup(pid: number, runAs?: string) {
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

/**
 * A harness's bridge outlives this runner when an update hands its turn over (hand-over.ts),
 * but writes to pipes this runner reads, which close with it: a write would then fail in the
 * bridge, and the turn with it. So its output goes through relays that, once the runner is
 * gone, read on and drop it.
 */
export const outliving = (command: string) =>
  `{ { ${command}
} 2>&1 1>&3 3>&- | { cat; cat >/dev/null; } >&2; } 3>&1 | { cat; cat >/dev/null; }`

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
  /** With runAs: the thread, whose own network its processes run in where it has one (thread-net.ts). */
  thread?: string
  /** Process groups the runner before this one started and handed over, stopped with this sandbox. */
  adopt?: number[]
}): HarnessV1NetworkSandboxSession & {
  groups: () => number[]
  dropAdopted: () => boolean
} {
  const children = new Set<ChildProcess>()
  let adopted = options.adopt ?? []
  const at = (path: string) => (isAbsolute(path) ? path : resolve(options.workingDirectory, path))
  const runAs = options.runAs
  const net = runAs && options.thread ? threadNet(options.thread) : Promise.resolve(null)
  // On a cloud computer, a cgroup of its own (preview-cgroup.ts): the harness and all it starts,
  // measured, and stopped as one when the whole computer runs out of memory (memory-guard.ts).
  let turn: Promise<TurnCgroup | undefined> | undefined
  const turnCgroup = () =>
    (turn ??= runAs
      ? runnerCgroups()
          .then((cgroups) => cgroups?.createTurn(options.id, options.thread))
          .catch((error: unknown) => {
            console.warn(`${options.id} runs without a cgroup of its own: ${String(error)}`)
            return undefined
          })
      : Promise.resolve(undefined))

  const killGroup = (pid: number) => stopGroup(pid, runAs)

  const spawnAs = (
    command: string,
    cwd: string,
    env: Record<string, string>,
    thread: ThreadNet | null,
    gated: boolean,
    stdin: boolean,
  ) => {
    const input = stdin ? 'pipe' : 'ignore'
    if (!runAs)
      return spawnChild('sh', ['-c', command], {
        cwd,
        env,
        stdio: [input, 'pipe', 'pipe'],
        detached: true,
      })
    // sudo -E passes the environment without putting it on the command line. On a cloud
    // computer the runner's service gives it a low OOM score (cgroups.conf in the API's
    // setup): a turn takes back the usual one, so when memory runs out, a turn that grows
    // goes before the desktop and the teammates' Docker, and the runner stays.
    const { file, args } = asTeammate(runAs, thread)
    const argv = [
      ...args,
      'sh',
      '-c',
      '{ echo 0 >/proc/self/oom_score_adj; } 2>/dev/null; cd -- "$0" && exec sh -c "$1"',
      cwd,
      command,
    ]
    // Gated: a shell that waits on fd 3 until it is in the turn's cgroup, then becomes sudo, so
    // all that sudo starts is in there from the start. stdout is the harness's, untouched.
    return gated
      ? spawnChild('sh', ['-c', 'read -r _ <&3; exec "$@"', 'sh', file, ...argv], {
          cwd: '/',
          env,
          stdio: [input, 'pipe', 'pipe', 'pipe'],
          detached: true,
        })
      : spawnChild(file, argv, { cwd: '/', env, stdio: [input, 'pipe', 'pipe'], detached: true })
  }

  // With stdin, the process reads what is written to its stdin stream; without, it reads nothing.
  function spawn(
    options: ProcessOptions & { stdin: true },
  ): Promise<SandboxProcess & { stdin: WritableStream<Uint8Array> }>
  function spawn(options: ProcessOptions & { stdin?: false }): Promise<SandboxProcess>
  function spawn(options: ProcessOptions): Promise<SandboxProcess>
  async function spawn({
    command,
    workingDirectory,
    env,
    abortSignal,
    stdin,
  }: ProcessOptions): Promise<SandboxProcess & { stdin?: WritableStream<Uint8Array> }> {
    const cgroup = (await turnCgroup())?.cgroup
    const child = spawnAs(
      env?.BRIDGE_WS_PORT ? outliving(command) : command,
      workingDirectory ? at(workingDirectory) : options.workingDirectory,
      { ...options.env, ...env },
      await net,
      Boolean(cgroup && runAs),
      stdin === true,
    )
    children.add(child)
    processGroups.add(child.pid, `turn ${options.id}`)
    const gate = child.stdio[3] as Writable | undefined
    if (gate) {
      gate.on('error', () => undefined)
      if (child.pid)
        await cgroup!.attach(child.pid).catch((error: unknown) => {
          console.warn(`${options.id}: a process outside its cgroup: ${String(error)}`)
        })
      gate.end('\n')
    }
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
    // A process that exits before reading all its input closes the pipe: its exit code says why.
    child.stdin?.on('error', () => undefined)
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      ...(child.stdin ? { stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array> } : {}),
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
      if (input) {
        // A command that exits without reading its input closes the pipe: its code says why.
        child.stdin!.on('error', () => undefined)
        child.stdin!.end(input)
      }
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

  // As the teammate, a missing path exits 3 and a directory where none goes 4 (a cloud
  // computer's GNU stat and find). Symbolic links are followed by stat, and not in a listing.
  const statAs = async (path: string): Promise<FileStat | null> => {
    const r = await asUser('[ -e "$0" ] || exit 3; stat -L -c "%F/%s" -- "$0"', [at(path)])
    if (r.code === 3) return null
    if (r.code !== 0) throw new Error(`Could not read ${path}`)
    const out = r.stdout.toString().trim()
    const slash = out.lastIndexOf('/')
    const kind = out.slice(0, slash)
    return {
      type: kind.startsWith('regular') ? 'file' : kind === 'directory' ? 'directory' : 'other',
      size: Number(out.slice(slash + 1)),
    }
  }
  const listAs = async (path: string): Promise<DirectoryEntry[] | null> => {
    const r = await asUser(
      '[ -e "$0" ] || exit 3; [ -d "$0" ] || exit 4; find -H "$0" -mindepth 1 -maxdepth 1 -printf "%y%f\\0"',
      [at(path)],
    )
    if (r.code === 3) return null
    if (r.code === 4) throw new Error(`${path} is not a directory`)
    if (r.code !== 0) throw new Error(`Could not list ${path}`)
    const types: Record<string, DirectoryEntry['type']> = {
      f: 'file',
      d: 'directory',
      l: 'symlink',
    }
    return r.stdout
      .toString()
      .split('\0')
      .filter(Boolean)
      .map((entry) => ({ name: entry.slice(1), type: types[entry[0]!] ?? 'other' }))
  }
  const deleteAs = async (path: string) => {
    const r = await asUser(
      'if [ ! -L "$0" ]; then [ -e "$0" ] || exit 3; [ -d "$0" ] && exit 4; fi; rm -f -- "$0"',
      [at(path)],
    )
    if (r.code === 3) return false
    if (r.code === 4) throw new Error(`${path} is a directory`)
    if (r.code !== 0) throw new Error(`Could not delete ${path}`)
    return true
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
    stat: async ({ path }) => {
      if (runAs) return statAs(path)
      const s = await stat(at(path)).catch((error: unknown) => {
        // A file where a folder of the path should be: no such path either.
        if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null
        throw error
      })
      if (!s) return null
      return { type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other', size: s.size }
    },
    listDirectory: async ({ path }) => {
      if (runAs) return listAs(path)
      const entries = await readdir(at(path), { withFileTypes: true }).catch((error: unknown) => {
        if (code(error) === 'ENOENT') return null
        throw error
      })
      return (
        entries?.map((entry) => ({
          name: entry.name,
          type: entry.isSymbolicLink()
            ? ('symlink' as const)
            : entry.isFile()
              ? ('file' as const)
              : entry.isDirectory()
                ? ('directory' as const)
                : ('other' as const),
        })) ?? null
      )
    },
    deleteFile: async ({ path }) => {
      if (runAs) return deleteAs(path)
      const s = await lstat(at(path)).catch((error: unknown) => {
        if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null
        throw error
      })
      if (!s) return false
      if (s.isDirectory()) throw new Error(`${path} is a directory`)
      return unlink(at(path)).then(
        () => true,
        (error: unknown) => {
          if (code(error) === 'ENOENT') return false
          throw error
        },
      )
    },
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

  // In the thread's own network, its loopback is at the thread's address.
  const endpoint = async (port: number, protocol: 'http' | 'https' | 'ws' = 'http') =>
    `${protocol === 'ws' ? 'ws' : 'http'}://${(await net)?.address ?? '127.0.0.1'}:${port}`

  const stop = async () => {
    for (const child of children) if (child.pid) killGroup(child.pid)
    for (const pid of adopted) killGroup(pid)
  }

  // Its cgroup goes with it: what is left a few seconds after the stop is killed.
  const destroy = async () => {
    await stop()
    const cgroup = await turn
    if (!cgroup) return
    void (async () => {
      for (let i = 0; i < 30 && children.size > 0; i++) await new Promise((r) => setTimeout(r, 100))
      await (await runnerCgroups())?.removeTurn(cgroup)
    })()
  }

  return {
    ...restricted,
    id: options.id,
    defaultWorkingDirectory: options.workingDirectory,
    ports: [options.port],
    getPortEndpoint: async ({ port, protocol }) => ({ url: await endpoint(port, protocol) }),
    getPortUrl: async ({ port, protocol }) => endpoint(port, protocol),
    stop,
    destroy,
    restricted: () => restricted,
    /** Its process groups running now (a harness's bridge), to hand over (hand-over.ts). */
    groups: () => [
      ...[...children].flatMap((c) => (c.pid && c.exitCode === null ? [c.pid] : [])),
      ...adopted,
    ],
    /**
     * The harness started a bridge of its own, when attaching to the handed-over one failed:
     * that one is stopped now, rather than go on with its turn beside the new one until this
     * sandbox stops. Whether it did.
     */
    dropAdopted: () => {
      if (adopted.length === 0 || children.size === 0) return false
      for (const pid of adopted) killGroup(pid)
      adopted = []
      return true
    },
  }
}
