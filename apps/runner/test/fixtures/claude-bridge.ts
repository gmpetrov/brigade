import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createLocalSandboxSession, freePort } from '../../src/harness/local-sandbox.js'

// Runs of the Claude Code bridge (patched) with a stand-in for the Claude Agent SDK, whose
// `query` is the module given: what the bridge gives Claude Code, and what it does with what
// Claude Code sends, without Claude Code. The stand-in writes what it saw to FAKE_SDK_RECORD.

const require = createRequire(import.meta.url)
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`))

/** What the bootstrap's pnpm install would put there: the bridge's own ws and zod, a fake SDK. */
async function fakeInstall(dir: string, sdk: string) {
  const modules = join(dir, 'node_modules')
  await mkdir(join(modules, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true })
  await writeFile(
    join(modules, '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      type: 'module',
      exports: './index.mjs',
    }),
  )
  await writeFile(join(modules, '@anthropic-ai', 'claude-agent-sdk', 'index.mjs'), sdk)
  const mcp = join(modules, '@modelcontextprotocol', 'sdk')
  await mkdir(join(mcp, 'server'), { recursive: true })
  await writeFile(
    join(mcp, 'package.json'),
    JSON.stringify({
      name: '@modelcontextprotocol/sdk',
      type: 'module',
      exports: { './server/mcp.js': './server/mcp.js' },
    }),
  )
  await writeFile(join(mcp, 'server', 'mcp.js'), 'export class McpServer { registerTool() {} }\n')
  await symlink(packageDir('ws'), join(modules, 'ws'))
  await symlink(packageDir('zod'), join(modules, 'zod'))
}

/** One turn through the bridge: the stream's parts, and the stand-in's record, line by line. */
export async function bridgeTurn(
  sdk: string,
  options: { permissionMode: 'allow-all' | 'allow-reads'; env: Record<string, string> },
): Promise<{ parts: { type: string; [key: string]: unknown }[]; record: any[] }> {
  const home = await mkdtemp(join(tmpdir(), 'claude-bridge-'))
  const record = join(home, 'record.jsonl')
  const work = join(home, 'work')
  await mkdir(work)
  const sandbox = createLocalSandboxSession({
    id: 'bridge-test',
    workingDirectory: work,
    port: await freePort(),
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: home,
      FAKE_SDK_RECORD: record,
      ...options.env,
    },
  })
  // The bootstrap installs nothing: the fake SDK takes its place.
  const run = sandbox.run
  const bootstrapRun: typeof run = async (input) => {
    if (input.command.startsWith('pnpm install')) {
      await fakeInstall(resolve(work, input.workingDirectory ?? '.'), sdk)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (input.command.includes('claude --version'))
      return { exitCode: 0, stdout: '2.1.316 (Claude Code)', stderr: '' }
    return run(input)
  }
  const restricted = { ...sandbox.restricted(), run: bootstrapRun }
  const session = { ...sandbox, run: bootstrapRun, restricted: () => restricted }
  const agent = new HarnessAgent({
    harness: createClaudeCode({ auth: {} }),
    permissionMode: options.permissionMode,
    sandboxConfig: { workDir: '.' },
  })
  try {
    const harnessSession = await agent.createSession({ sandboxSession: session })
    const result = await agent.stream({ session: harnessSession, prompt: 'hello' })
    const parts: { type: string; [key: string]: unknown }[] = []
    for await (const part of result.fullStream) parts.push(part as never)
    await harnessSession.destroy()
    const lines = (await readFile(record, 'utf8').catch(() => '')).trim().split('\n')
    return { parts, record: lines.filter(Boolean).map((line) => JSON.parse(line)) }
  } finally {
    await sandbox.destroy()
    await rm(home, { recursive: true, force: true })
  }
}
