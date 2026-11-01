import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { CLAUDE_SETTINGS, claudeSettingsEnv } from '../src/harness/claude-settings.js'
import { createLocalSandboxSession, freePort } from '../src/harness/local-sandbox.js'

// The Claude Code bridge (patched) builds its own settings for Claude Code, which went in
// over Brigade's: these runs go through it, with an Agent SDK that only writes down the
// options each query gets, so what Claude Code would be given is what is checked.

const FAKE_SDK = `import { appendFileSync } from 'node:fs'
const plain = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'function' || ['abortSignal', 'hooks', 'mcpServers'].includes(key) ? undefined : v)))
export function query({ prompt, options }) {
  appendFileSync(process.env.FAKE_SDK_RECORD, JSON.stringify(plain(options)) + '\\n')
  async function* run() {
    await prompt[Symbol.asyncIterator]().next()
    yield { type: 'system', subtype: 'init', session_id: 'fake-session' }
    yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  const messages = run()
  messages.interrupt = async () => {}
  return messages
}
`

const require = createRequire(import.meta.url)
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`))

/** What the bootstrap's pnpm install would put there: the bridge's own ws and zod, a fake SDK. */
async function fakeInstall(dir: string) {
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
  await writeFile(join(modules, '@anthropic-ai', 'claude-agent-sdk', 'index.mjs'), FAKE_SDK)
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

async function queryOptions(
  permissionMode: 'allow-all' | 'allow-reads',
  env: Record<string, string>,
): Promise<Record<string, any>> {
  const home = await mkdtemp(join(tmpdir(), 'claude-bridge-'))
  const record = join(home, 'queries.jsonl')
  const work = join(home, 'work')
  await mkdir(work)
  const sandbox = createLocalSandboxSession({
    id: 'bridge-settings',
    workingDirectory: work,
    port: await freePort(),
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: home,
      FAKE_SDK_RECORD: record,
      ...env,
    },
  })
  // The bootstrap installs nothing: the fake SDK takes its place.
  const run = sandbox.run
  const bootstrapRun: typeof run = async (options) => {
    if (options.command.startsWith('pnpm install')) {
      await fakeInstall(resolve(work, options.workingDirectory ?? '.'))
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (options.command.includes('claude --version'))
      return { exitCode: 0, stdout: '2.1.316 (Claude Code)', stderr: '' }
    return run(options)
  }
  const restricted = { ...sandbox.restricted(), run: bootstrapRun }
  const session = { ...sandbox, run: bootstrapRun, restricted: () => restricted }
  const agent = new HarnessAgent({
    harness: createClaudeCode({ auth: {} }),
    permissionMode,
    sandboxConfig: { workDir: '.' },
  })
  try {
    const harnessSession = await agent.createSession({ sandboxSession: session })
    const result = await agent.stream({ session: harnessSession, prompt: 'hello' })
    for await (const _part of result.fullStream);
    await harnessSession.destroy()
    const lines = (await readFile(record, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    return JSON.parse(lines[0]!)
  } finally {
    await sandbox.destroy()
    await rm(home, { recursive: true, force: true })
  }
}

test("Brigade's settings reach Claude Code in a thread that asks before nothing", async () => {
  const options = await queryOptions('allow-all', claudeSettingsEnv())
  assert.equal(options.settings.autoMemoryEnabled, false)
  assert.deepEqual(options.settings.permissions.deny, CLAUDE_SETTINGS.permissions.deny)
  assert.equal(options.permissionMode, 'bypassPermissions')
  assert.equal(options.promptSuggestions, undefined)
})

test('they join the rules the bridge sets when its permission mode asks before edits', async () => {
  const options = await queryOptions('allow-reads', claudeSettingsEnv())
  assert.equal(options.settings.autoMemoryEnabled, false)
  assert.deepEqual(options.settings.permissions.deny, CLAUDE_SETTINGS.permissions.deny)
  // The bridge's own: asks before edits and commands, and never runs one as sandboxed on its own.
  assert.ok(options.settings.permissions.ask.includes('Bash(*)'))
  assert.ok(options.settings.permissions.ask.includes('Write(*)'))
  assert.equal(options.settings.sandbox.autoAllowBashIfSandboxed, false)
})

test('a run without Brigade settings gets the bridge’s alone', async () => {
  const options = await queryOptions('allow-reads', {})
  assert.equal('autoMemoryEnabled' in options.settings, false)
  assert.equal('deny' in options.settings.permissions, false)
  assert.ok(options.settings.permissions.ask.includes('Bash(*)'))
})

test('Claude Code guesses the next message where the thread wants it', async () => {
  const options = await queryOptions('allow-all', {
    ...claudeSettingsEnv(),
    BRIGADE_PROMPT_SUGGESTIONS: '1',
  })
  assert.equal(options.promptSuggestions, true)
  assert.equal(options.settings.autoMemoryEnabled, false)
})
