import assert from 'node:assert/strict'
import test from 'node:test'
import { isOutputTool } from '../dist/thread-history.js'

test('recognizes saved deliverables with bare and MCP-prefixed tool names', () => {
  for (const name of ['save_to_library', 'save_design', 'github_create_pull_request']) {
    assert.equal(isOutputTool(name), true, name)
    assert.equal(isOutputTool(`mcp__brigade__${name}`), true, name)
  }
})

test('recognizes sent and drafted email as output', () => {
  for (const name of ['gmail_send', 'mcp__gmail__send_message', 'mcp__mail__create_draft']) {
    assert.equal(isOutputTool(name), true, name)
  }
})

test('excludes email reads, unrelated messaging and code edits from output', () => {
  for (const name of ['gmail_read_message', 'mcp__slack__send_message', 'send', 'apply_patch']) {
    assert.equal(isOutputTool(name), false, name)
  }
})
