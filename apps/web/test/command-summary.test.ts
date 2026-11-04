import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandSummary } from '../lib/command-summary'

test('a step reads what its command does, each path by its last part', () => {
  assert.equal(
    commandSummary(
      'cat /var/lib/brigade/library/bt-x/threads/cgtj7t1gnim8xuo8z69t89xbi.md 2>/dev/null || find /var/lib/brigade/library -name "*.md"',
    ),
    'cat cgtj7t1gnim8xuo8z69t89xbi.md',
  )
  assert.equal(commandSummary('cd /home/me/repo && pnpm test 2>&1'), 'pnpm test')
  assert.equal(commandSummary('git status'), 'git status')
  assert.equal(commandSummary('ls -la /opt/brigade/runner/dist/'), 'ls -la dist')
  assert.equal(
    commandSummary('curl -s https://api.example.com/v1/x'),
    'curl -s https://api.example.com/v1/x',
  )
})
