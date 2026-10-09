// Build step 1 spike: Claude Code through HarnessAgent, bridge on this machine,
// subscription login, no API key. Pauses a turn mid-stream and resumes it,
// then detaches between turns and resumes the session.
// Run: pnpm --filter @brigade/runner spike [workdir]
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@ai-sdk/harness-claude-code'
import { createLocalSandboxSession, freePort } from './local-sandbox.js'
import { harnessEnv } from './env.js'

const workDir = resolve(process.argv[2] ?? '.brigade-spike')
await mkdir(workDir, { recursive: true })
const env = harnessEnv()
console.log(
  'API key variables present:',
  Object.keys(env).filter((k) => /API_KEY|AUTH_TOKEN|OAUTH/.test(k)),
)

const agent = new HarnessAgent({
  harness: createClaudeCode({ auth: {} }),
  permissionMode: 'allow-all',
})
const sandbox = createLocalSandboxSession({
  id: 'spike',
  workingDirectory: workDir,
  port: await freePort(),
  env,
})

const types = new Map<string, number>()
async function drain(
  stream: AsyncIterable<{ type: string }>,
  onPart?: (part: any) => Promise<boolean>,
) {
  for await (const part of stream) {
    types.set(part.type, (types.get(part.type) ?? 0) + 1)
    if (part.type === 'text-delta') process.stdout.write((part as any).text)
    if (onPart && (await onPart(part))) return 'stopped'
  }
  process.stdout.write('\n')
  return 'done'
}

let t = Date.now()
const session = await agent.createSession({ sandboxSession: sandbox })
console.log(`session ${session.sessionId} started in ${Date.now() - t}ms`)

// 1. A turn paused mid-stream and continued from saved state.
const first = await agent.stream({
  session,
  prompt: 'Count from 1 to 40, one number per line, then say DONE.',
})
let suspended: Awaited<ReturnType<typeof session.suspendTurn>> | undefined
await drain(first.fullStream, async (part) => {
  if (part.type === 'text-delta' && !suspended && /\b5\b/.test(part.text)) {
    console.log('\n--- suspending turn ---')
    suspended = await session.suspendTurn()
    return true
  }
  return false
})
if (suspended) {
  const continued = await agent.createSession({
    sessionId: session.sessionId,
    continueFrom: suspended,
    sandboxSession: sandbox,
  })
  console.log('--- continuing turn ---')
  const rest = await agent.continueStream({ session: continued })
  await drain(rest.fullStream)
  // 2. Detach between turns, then resume the session from its saved state.
  const state = await continued.detach()
  console.log('--- detached, resume state keys:', Object.keys(state))
  t = Date.now()
  const resumed = await agent.createSession({
    sessionId: session.sessionId,
    resumeFrom: state,
    sandboxSession: sandbox,
  })
  console.log(`--- resumed in ${Date.now() - t}ms ---`)
  const second = await agent.stream({
    session: resumed,
    prompt: 'What was the last number you counted to? Reply with the number only.',
  })
  await drain(second.fullStream)
  await resumed.destroy()
} else {
  console.log('turn finished before it could be suspended')
  await session.destroy()
}
await sandbox.destroy()
console.log('stream part types seen:', Object.fromEntries(types))
