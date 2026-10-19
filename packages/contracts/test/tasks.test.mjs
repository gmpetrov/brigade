import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskOperation } from '../dist/tasks.js'

test("a teammate's create_task and update_task may name a project, or none", () => {
  const create = TaskOperation.parse({ name: 'create', title: 'Fix', project: 'proj-1' })
  assert.equal(create.project, 'proj-1')
  assert.equal(TaskOperation.parse({ name: 'create', title: 'Fix', project: null }).project, null)
  assert.equal(TaskOperation.parse({ name: 'create', title: 'Fix' }).project, undefined)
  const update = TaskOperation.parse({ name: 'update', taskId: 't1', project: null })
  assert.equal(update.project, null)
  assert.equal(TaskOperation.safeParse({ name: 'update', taskId: 't1', project: 3 }).success, false)
})
