import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  markdownTitle,
  namesReference,
  parseStatusLine,
  pullNumbersIn,
  readDesignStatus,
  withPullInDesign,
  withPullOnStatusLine,
} from '../dist/decisions.js'

const spec = (line) => `# Later threads\n\n${line}\n\nWhy we do it.\n`

test('reads the status line, in any language after the word', () => {
  const found = parseStatusLine(
    spec('Spec, 2026-10-19. Status: accepted. Décidée le 2026-10-19 avec le membre.'),
  )
  assert.deepEqual(found, {
    kind: 'Spec',
    date: '2026-10-19',
    status: 'accepted',
    rest: '. Décidée le 2026-10-19 avec le membre.',
    line: 2,
  })
  assert.equal(
    parseStatusLine(spec('Note, 2026-10-20. Status: superseded by `x.md`.'))?.status,
    'superseded',
  )
  assert.equal(markdownTitle(spec('Spec, 2026-10-19. Status: draft.')), 'Later threads')
})

test('reads no status from a line in another form or with another word', () => {
  assert.equal(parseStatusLine(spec('Status: shipped (#89), October 2026.')), null)
  assert.equal(parseStatusLine(spec('Spec, 2026-10-19. Status: done.')), null)
  assert.equal(parseStatusLine(spec('Spec, 19 Oct 2026. Status: draft.')), null)
  assert.equal(parseStatusLine('Spec, 2026-10-19. Status: draft.'), null, 'not the title')
  assert.equal(parseStatusLine(spec('Spec, 2026-10-19. Status: drafted.')), null)
})

test('names the pull requests and the reference a line gives', () => {
  assert.deepEqual(pullNumbersIn(' (#241, #255; see gmpetrov/brigade#12). #241 again'), [241, 255])
  assert.equal(namesReference(' (#241). Reference: `docs/lists.md`.'), true)
  assert.equal(namesReference(' (#241). See [the page](../reference/offer.md).'), true)
  assert.equal(namesReference(' (#105, #114). No page yet, the code is the truth.'), false)
  assert.equal(namesReference(' (#105). The `code` is the truth.'), false)
})

test('a merge that ships a spec sets the word and adds its number, keeping the rest', () => {
  const text = spec('Spec, 2026-10-19. Status: accepted. Décidée le 2026-10-19.')
  const shipped = withPullOnStatusLine(text, 241, true)
  assert.equal(shipped, spec('Spec, 2026-10-19. Status: shipped (#241). Décidée le 2026-10-19.'))
  // A retry changes nothing; a second pull request goes first in the parenthesis.
  assert.equal(withPullOnStatusLine(shipped, 241, true), shipped)
  assert.equal(
    withPullOnStatusLine(shipped, 300, true),
    spec('Spec, 2026-10-19. Status: shipped (#300, #241). Décidée le 2026-10-19.'),
  )
})

test('a merge only part of a spec names it and keeps the status', () => {
  const text = spec('Spec, 2026-10-19. Status: accepted (step 1 of 3). Decided.')
  assert.equal(
    withPullOnStatusLine(text, 12, false),
    spec('Spec, 2026-10-19. Status: accepted (#12, step 1 of 3). Decided.'),
  )
  // Named already, and then shipped by another merge of the same pull request: the word changes.
  const named = withPullOnStatusLine(text, 12, false)
  assert.equal(withPullOnStatusLine(named, 12, false), named)
  assert.equal(
    withPullOnStatusLine(named, 12, true),
    spec('Spec, 2026-10-19. Status: shipped (#12, step 1 of 3). Decided.'),
  )
})

test('keeps line endings and leaves a file without a status line alone', () => {
  const crlf = '# T\r\n\r\nSpec, 2026-10-19. Status: draft.\r\n\r\nBody\r\n'
  assert.equal(
    withPullOnStatusLine(crlf, 7, true),
    '# T\r\n\r\nSpec, 2026-10-19. Status: shipped (#7).\r\n\r\nBody\r\n',
  )
  assert.equal(withPullOnStatusLine('# T\n\nJust notes.\n', 7, true), null)
})

test("a design's status lives in its design.json, its other keys kept", () => {
  const json = JSON.stringify({ title: 'Home', description: 'd', boards: [{ file: 'index.html' }] })
  assert.deepEqual(readDesignStatus(json), { title: 'Home', status: null, pullRequests: [] })
  const shipped = withPullInDesign(json, 206, true)
  assert.deepEqual(JSON.parse(shipped), {
    title: 'Home',
    description: 'd',
    boards: [{ file: 'index.html' }],
    status: 'shipped',
    pullRequests: [206],
  })
  assert.equal(withPullInDesign(shipped, 206, true), shipped)
  assert.deepEqual(readDesignStatus(withPullInDesign(shipped, 230, false)).pullRequests, [206, 230])
  // A bad status reads as none; a file that is not an object is left alone.
  assert.equal(readDesignStatus('{"status": "done"}').status, null)
  assert.equal(withPullInDesign('[1]', 1, true), null)
  assert.equal(withPullInDesign('{not json', 1, true), null)
})

test('the status line is the first line with text after the title, never one further down', () => {
  // A guide whose only status line is an example in a code block is no decision.
  const guide = '# Writing a spec\n\n```markdown\nSpec, 2026-11-05. Status: draft.\n```\n'
  assert.equal(parseStatusLine(guide), null)
  assert.equal(withPullOnStatusLine(guide, 4, true), null)
  assert.equal(parseStatusLine('# T\nSome text first.\n\nSpec, 2026-11-05. Status: draft.\n'), null)
  // Blank lines around it are fine, and so is a smaller heading.
  const spaced = '\n## T\n\n\nSpec, 2026-11-05. Status: draft.\n'
  assert.equal(parseStatusLine(spaced)?.line, 4)
  assert.equal(
    withPullOnStatusLine(spaced, 4, true),
    '\n## T\n\n\nSpec, 2026-11-05. Status: shipped (#4).\n',
  )
})

test('a design.json that is not JSON says no status, even with fields further in', () => {
  // A board's title and status are not the design's.
  assert.deepEqual(
    readDesignStatus('{"boards":[{"title":"Old page","status":"shipped"}],"unfinished":'),
    { title: null, status: null, pullRequests: [] },
  )
  assert.equal(readDesignStatus('{"title": "Home", "status": "accepted", "boards": [').status, null)
})
