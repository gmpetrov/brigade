import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CODEX_SETTINGS } from '../src/harness/codex-settings.js'

test("Codex's own memory is off in Brigade, neither used nor written", () => {
  assert.equal(CODEX_SETTINGS.features.memories, false)
  assert.deepEqual(CODEX_SETTINGS.memories, { generate_memories: false, use_memories: false })
})
