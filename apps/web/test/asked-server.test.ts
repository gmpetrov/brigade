import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askedServer } from '../lib/asked-server'

// Staging and production, both "Team Notes"; a server added with no name of its own.
const staging = {
  id: 'app-staging',
  name: 'Team Notes',
  mcp: { url: 'https://notes.example.com/staging/mcp' },
}
const production = {
  id: 'app-production',
  name: 'Team Notes',
  mcp: { url: 'https://notes.example.com/production/mcp' },
}
const nameless = { id: 'app-nameless', name: null, mcp: { url: 'https://other.example.com/mcp' } }
const apps = [staging, production, nameless]
const ask = (app: { url?: string; server?: string }, what = 'Team Notes') => ({
  what,
  app: { kind: 'mcp', ...app },
})

test('an MCP server named by its id is that one, whatever its name, and its url is not one to add', () => {
  // Its url is the one the runner gives for older APIs (serverOnlyUrl): none to add.
  const picked = askedServer(
    ask({ server: 'app-production', url: 'https://brigade.invalid/mcp-servers/app-production' }),
    apps,
  )
  assert.equal(picked.server, production)
  assert.equal(picked.serverUrl, undefined)
  assert.equal(askedServer(ask({ server: 'app-nameless' }, 'MCP server'), apps).server, nameless)
  // Gone from the workspace: no server, rather than the first of its name.
  const gone = askedServer(ask({ server: 'app-gone' }), apps)
  assert.equal(gone.server, undefined)
  assert.equal(gone.serverId, 'app-gone')
})

test('without an id, by its URL, else by its name, as before', () => {
  assert.equal(
    askedServer(ask({ url: 'https://notes.example.com/production/mcp/' }), apps).server,
    production,
  )
  assert.equal(askedServer(ask({}), apps).server, staging)
  assert.deepEqual(askedServer({ what: 'Notion', app: { kind: 'notion' } }, apps), {})
})
