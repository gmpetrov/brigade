import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLAUDE_SETTINGS, claudeSettingsEnv } from '../src/harness/claude-settings.js'

test("Claude Code's own schedules, memory and other sessions are off in Brigade", () => {
  const denied = CLAUDE_SETTINGS.permissions.deny
  for (const tool of ['CronCreate', 'ScheduleWakeup', 'ListAgents', 'Workflow', 'RemoteTrigger'])
    assert.ok(denied.includes(tool), tool)
  assert.equal(CLAUDE_SETTINGS.autoMemoryEnabled, false)
  assert.equal(CLAUDE_SETTINGS.skillOverrides.loop, 'off')
  assert.equal(CLAUDE_SETTINGS.skillOverrides.init, 'off')
})

test('what Brigade relies on in Claude Code stays on', () => {
  const denied = new Set(CLAUDE_SETTINGS.permissions.deny)
  // Sub-agents (and SendMessage to go on with one), questions, background work, skills, search.
  for (const tool of [
    'Agent',
    'SendMessage',
    'AskUserQuestion',
    'Bash',
    'Monitor',
    'TaskStop',
    'Skill',
    'ToolSearch',
  ])
    assert.ok(!denied.has(tool), tool)
  // A whole tool is denied by its bare name: "Bash(rm *)" would only ask before such commands.
  for (const rule of denied) assert.match(rule, /^\w+(\(statusline-setup\))?$/)
})

test('the settings reach the bridge as one JSON value', () => {
  const env = claudeSettingsEnv()
  assert.deepEqual(Object.keys(env), ['BRIGADE_CLAUDE_SETTINGS'])
  assert.deepEqual(JSON.parse(env.BRIGADE_CLAUDE_SETTINGS!), CLAUDE_SETTINGS)
})
