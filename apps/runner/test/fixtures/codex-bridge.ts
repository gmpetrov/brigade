import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createCodex } from '@ai-sdk/harness-codex'
import { createLocalSandboxSession, freePort } from '../../src/harness/local-sandbox.js'

// Runs of the Codex bridge (patched) with a stand-in for `codex app-server`: what the bridge
// asks Codex, without Codex. The stand-in answers each request, plays one turn that says
// FAKE_CODEX_REPLY, and writes every request it got to FAKE_CODEX_RECORD.

const require = createRequire(import.meta.url)
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`))

/** The stand-in: JSON-RPC over stdio, a line per message, as the bridge's client speaks it. */
const FAKE_APP_SERVER = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const permissions = { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, model: 'fake-model' }
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  appendFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ method: message.method, params: message.params ?? null }) + '\\n')
  const answer = (result) => send({ id: message.id, result })
  switch (message.method) {
    case 'thread/list':
      return answer({ data: process.env.FAKE_CODEX_EMPTY === '1' ? [] : [{ id: 'main-thread' }], nextCursor: null })
    case 'thread/fork':
      return answer({ thread: { id: 'forked-thread' }, ...permissions })
    case 'thread/start':
    case 'thread/resume':
      return answer({ thread: { id: message.params?.threadId ?? 'new-thread' }, ...permissions })
    case 'turn/start': {
      const threadId = message.params.threadId
      answer({ turn: { id: 'turn-1' } })
      const turn = { id: 'turn-1' }
      send({ method: 'turn/started', params: { threadId, turn } })
      const item = { type: 'agentMessage', id: 'message-1', text: process.env.FAKE_CODEX_REPLY ?? 'done' }
      send({ method: 'item/started', params: { threadId, turnId: 'turn-1', item: { ...item, text: '' } } })
      send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item } })
      send({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } })
      return
    }
    default:
      return answer({})
  }
})
`

/** What the bootstrap's pnpm install would put there: the bridge's own ws, and the stand-in. */
async function fakeInstall(dir: string) {
  const modules = join(dir, 'node_modules')
  const codex = join(modules, '@openai', 'codex')
  await mkdir(join(codex, 'bin'), { recursive: true })
  await writeFile(
    join(codex, 'package.json'),
    JSON.stringify({ name: '@openai/codex', type: 'module', bin: { codex: 'bin/codex.js' } }),
  )
  await writeFile(join(codex, 'bin', 'codex.js'), FAKE_APP_SERVER)
  await symlink(packageDir('ws'), join(modules, 'ws'))
}

/** One turn through the Codex bridge: its text, and the requests the stand-in got, in order. */
export async function codexBridgeTurn(options: {
  env: Record<string, string>
  /** The session it resumes, as the harness saved it. */
  resumeFrom?: unknown
}): Promise<{
  text: string
  /** The error the turn ended on, if it did. */
  error?: string
  requests: { method: string; params: any }[]
  work: string
}> {
  const home = await mkdtemp(join(tmpdir(), 'codex-bridge-'))
  const record = join(home, 'record.jsonl')
  const work = join(home, 'work')
  await mkdir(work)
  const sandbox = createLocalSandboxSession({
    id: 'codex-bridge-test',
    workingDirectory: work,
    port: await freePort(),
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      FAKE_CODEX_RECORD: record,
      ...options.env,
    },
  })
  const run = sandbox.run
  const bootstrapRun: typeof run = async (input) => {
    if (input.command.startsWith('pnpm install')) {
      await fakeInstall(resolve(work, input.workingDirectory ?? '.'))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return run(input)
  }
  const restricted = { ...sandbox.restricted(), run: bootstrapRun }
  const session = { ...sandbox, run: bootstrapRun, restricted: () => restricted }
  const agent = new HarnessAgent({
    harness: createCodex({ auth: {} }),
    permissionMode: 'allow-all',
    sandboxConfig: { workDir: '.' },
  })
  try {
    const harnessSession = await agent.createSession({
      sandboxSession: session,
      ...(options.resumeFrom ? { resumeFrom: options.resumeFrom as never } : {}),
    })
    const result = await agent.stream({ session: harnessSession, prompt: 'hello' })
    let text = ''
    let error: string | undefined
    for await (const part of result.fullStream) {
      const { type } = part as { type: string }
      if (type === 'text-delta') text += (part as { text: string }).text
      if (type === 'error') error = JSON.stringify((part as { error: unknown }).error)
    }
    await harnessSession.destroy()
    const lines = (await readFile(record, 'utf8').catch(() => '')).trim().split('\n')
    return {
      text,
      ...(error ? { error } : {}),
      requests: lines.filter(Boolean).map((line) => JSON.parse(line)),
      work: resolve(work),
    }
  } finally {
    await sandbox.destroy()
    await rm(home, { recursive: true, force: true })
  }
}
