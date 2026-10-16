import assert from 'node:assert/strict'
import { test } from 'node:test'
import { onDefaultBranch, pushRule, refLabel } from '../src/git-refs.js'

const ZERO = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('branches under brigade/ are pushed, created or updated', () => {
  assert.deepEqual(pushRule({ old: ZERO, new: A, ref: 'refs/heads/brigade/riley-x' }), {
    kind: 'branch',
  })
  assert.deepEqual(pushRule({ old: A, new: B, ref: 'refs/heads/brigade/wip/riley-x' }), {
    kind: 'branch',
  })
})

test('other branches are refused', () => {
  for (const ref of [
    'refs/heads/main',
    'refs/heads/feature',
    'refs/heads/brigade/../main',
    'refs/notes/x',
  ]) {
    assert.equal(pushRule({ old: A, new: B, ref }).kind, 'refused', ref)
  }
})

test('a new tag is allowed', () => {
  assert.deepEqual(pushRule({ old: ZERO, new: A, ref: 'refs/tags/desktop-v0.2.0' }), {
    kind: 'tag',
    name: 'desktop-v0.2.0',
  })
  // SHA-256 repositories send 64 zeros.
  assert.equal(pushRule({ old: '0'.repeat(64), new: A, ref: 'refs/tags/v1' }).kind, 'tag')
})

test('an existing tag is never moved or deleted', () => {
  const moved = pushRule({ old: A, new: B, ref: 'refs/tags/desktop-v0.2.0' })
  assert.equal(moved.kind, 'refused')
  const deleted = pushRule({ old: A, new: ZERO, ref: 'refs/tags/desktop-v0.2.0' })
  assert.equal(deleted.kind, 'refused')
})

test('odd tag names are refused', () => {
  for (const ref of [
    'refs/tags/',
    'refs/tags/-x',
    'refs/tags/a..b',
    'refs/tags/a b',
    `refs/tags/${'x'.repeat(101)}`,
  ]) {
    assert.equal(pushRule({ old: ZERO, new: A, ref }).kind, 'refused', ref)
  }
})

test('a tag goes on a commit already on the default branch', () => {
  assert.equal(onDefaultBranch('identical'), true)
  assert.equal(onDefaultBranch('behind'), true)
  assert.equal(onDefaultBranch('ahead'), false)
  assert.equal(onDefaultBranch('diverged'), false)
  assert.equal(onDefaultBranch(undefined), false)
})

test('the log names branches and tags', () => {
  assert.equal(refLabel('refs/heads/brigade/riley-x'), 'brigade/riley-x')
  assert.equal(refLabel('refs/tags/desktop-v0.2.0'), 'tag desktop-v0.2.0')
})
