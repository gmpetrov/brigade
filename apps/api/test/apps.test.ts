import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HTTPException } from 'hono/http-exception'
import { appKey, requireAccountManager, requireAppManager, usableIn } from '../src/apps.js'
import type { WorkspaceScope } from '../src/scope.js'

const as = (memberId: string, role: WorkspaceScope['role']): WorkspaceScope => ({
  organizationId: 'org',
  workspaceId: 'ws',
  userId: `user-${memberId}`,
  memberId,
  role,
})
const forbidden = (fn: () => void) =>
  assert.throws(fn, (e) => e instanceof HTTPException && e.status === 403)

test("a member's own account is used only in the threads they started", () => {
  const carols = { reach: 'mine' as const, createdByMemberId: 'carol' }
  assert.equal(usableIn(carols, { startedByMemberId: 'carol' }), true)
  assert.equal(usableIn(carols, { startedByMemberId: 'bob' }), false)
  const shared = { reach: 'workspace' as const, createdByMemberId: 'carol' }
  assert.equal(usableIn(shared, { startedByMemberId: 'bob' }), true)
})

test('an account is managed by the member who connected it, or an owner or admin', () => {
  const carols = { createdByMemberId: 'carol' }
  requireAccountManager(as('carol', 'member'), carols)
  requireAccountManager(as('ada', 'owner'), carols)
  requireAccountManager(as('bob', 'admin'), carols)
  forbidden(() => requireAccountManager(as('dan', 'member'), carols))
})

test('a member manages an App only while every account in it is theirs', () => {
  const app = { createdByMemberId: 'carol' }
  requireAppManager(as('carol', 'member'), app, [{ createdByMemberId: 'carol' }])
  requireAppManager(as('carol', 'member'), app, [])
  forbidden(() =>
    requireAppManager(as('carol', 'member'), app, [
      { createdByMemberId: 'carol' },
      { createdByMemberId: 'ada' },
    ]),
  )
  forbidden(() => requireAppManager(as('dan', 'member'), app, []))
  requireAppManager(as('bob', 'admin'), app, [{ createdByMemberId: 'ada' }])
})

test('one App per built-in kind, one per custom app', () => {
  assert.equal(appKey('gmail', 'c1'), 'gmail')
  assert.equal(appKey('webhook', 'c1'), 'custom:c1')
})
