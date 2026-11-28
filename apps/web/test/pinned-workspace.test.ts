import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinnedWorkspace } from '../lib/api'

// An installed app's window makes every call in its app's workspace (lib/api.ts): only on its page.
test("only an installed app's window pins its calls to a workspace", () => {
  const at = (pathname: string, search: string) => pinnedWorkspace({ pathname, search })
  assert.equal(at('/app/apps/window', '?path=a.webapp&id=d1&workspace=ws_1'), 'ws_1')
  assert.equal(at('/app/apps/window', '?path=a.webapp&id=d1'), undefined)
  assert.equal(at('/app/apps/window', '?workspace='), undefined)
  // A notification's ?workspace= on any other page switches the session as before, unpinned.
  assert.equal(at('/app/threads/t1', '?workspace=ws_1'), undefined)
  assert.equal(at('/app/apps/window/x', '?workspace=ws_1'), undefined)
})
