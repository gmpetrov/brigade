import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeSettings, claudeSettingsEnv } from '../src/harness/claude-settings.js'

test("Claude Code's own schedules, memory and other sessions are off in Brigade", () => {
  const settings = claudeSettings()
  for (const tool of ['CronCreate', 'ScheduleWakeup', 'ListAgents', 'Workflow', 'RemoteTrigger'])
    assert.ok(settings.permissions.deny.includes(tool), tool)
  assert.equal(settings.autoMemoryEnabled, false)
  assert.equal(settings.skillOverrides.loop, 'off')
  assert.equal(settings.skillOverrides.init, 'off')
})

test('what Brigade relies on in Claude Code stays on', () => {
  const settings = claudeSettings()
  const denied = new Set(settings.permissions.deny)
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
  // Its review skills stay, for reviewers.
  for (const skill of ['code-review', 'security-review', 'simplify'])
    assert.equal(settings.skillOverrides[skill], undefined)
})

test('a workspace skill named like a bundled one is not turned off with it', () => {
  // Claude Code turns a skill off by name, whatever it comes from.
  const settings = claudeSettings(['run', 'impeccable'])
  assert.equal(settings.skillOverrides.run, undefined)
  assert.equal(settings.skillOverrides.loop, 'off')
})

test('the settings reach the bridge as one JSON value', () => {
  const env = claudeSettingsEnv(['run'])
  assert.deepEqual(Object.keys(env), ['BRIGADE_CLAUDE_SETTINGS'])
  assert.deepEqual(JSON.parse(env.BRIGADE_CLAUDE_SETTINGS!), claudeSettings(['run']))
})
