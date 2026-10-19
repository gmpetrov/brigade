import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isOperation, isOutputTool } from '../dist/thread-history.js'

test('a pull request opened through one of several GitHub connections is an output', () => {
  // Several connections of one kind: each tool name ends in its account.
  const suffixed = 'mcp__harness-tools__github_create_pull_request_gmpetrov_all_repositorie'
  assert.equal(isOutputTool(suffixed), true)
  assert.equal(isOutputTool('mcp__harness-tools__github_create_pull_request'), true)
  assert.equal(isOutputTool('mcp__harness-tools__github_merge_pull_request_acme'), false)
  assert.equal(isOperation('github_create_pull_request_acme', 'github_create_pull_request'), true)
  assert.equal(isOperation('github_create_pull_requests', 'github_create_pull_request'), false)
})

test('an email sent from one of several Gmail accounts is an output', () => {
  assert.equal(isOutputTool('mcp__harness-tools__gmail_send_ada_example_com'), true)
  assert.equal(isOutputTool('mcp__harness-tools__gmail_create_draft'), true)
  assert.equal(isOutputTool('mcp__harness-tools__gmail_search_ada_example_com'), false)
})
