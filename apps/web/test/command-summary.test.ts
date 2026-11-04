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

test('only a path is shortened: patterns, packages, short folders and refs stay whole', () => {
  assert.equal(commandSummary('pnpm --filter @brigade/web test'), 'pnpm --filter @brigade/web test')
  assert.equal(commandSummary('rg "foo/bar" apps/web'), 'rg "foo/bar" apps/web')
  assert.equal(
    commandSummary('sed -n 1,20p apps/web/components/thread-view.tsx'),
    'sed -n 1,20p thread-view.tsx',
  )
  assert.equal(
    commandSummary('git show origin/main:apps/runner/src/threads.ts'),
    'git show origin/main:apps/runner/src/threads.ts',
  )
  assert.equal(commandSummary('sed -i s/foo/bar/ notes.md'), 'sed -i s/foo/bar/ notes.md')
})

test('a redirection goes with its target, and quotes keep their separators', () => {
  assert.equal(commandSummary('ls > /tmp/out'), 'ls')
  assert.equal(commandSummary('node scripts/x.mjs 2>&1 | tail -5'), 'node scripts/x.mjs | tail -5')
  assert.equal(commandSummary('grep -n "a;b" /x/y.ts && echo done'), 'grep -n "a;b" y.ts')
  assert.equal(commandSummary("python3 -I - <<'EOF'\nimport json\nEOF"), 'python3 -I -')
})
