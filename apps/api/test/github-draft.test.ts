import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const { github } = await import('../src/connectors/github.js')

const never = () => {
  throw new Error('not expected')
}

/** github_mark_ready_for_review against pull request #7, a draft or not; records each GraphQL call. */
const marking = (pr: { draft: boolean; state?: string }, draft: boolean, errors?: unknown[]) => {
  const calls: { query: string; variables: { id: string } }[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    const { pathname } = new URL(url)
    if (pathname === '/repos/acme/web/pulls/7' && !init.method)
      return Response.json({
        number: 7,
        node_id: 'PR_7',
        title: 'Fix',
        state: pr.state ?? 'open',
        draft: pr.draft,
        merged_at: null,
        user: { login: 'brigade[bot]' },
        labels: [],
        comments: 0,
        head: { sha: 'abc', ref: 'fix' },
        base: { ref: 'main' },
        html_url: 'https://github.com/acme/web/pull/7',
      })
    if (pathname === '/graphql' && init.method === 'POST') {
      calls.push(JSON.parse(String(init.body)))
      // GraphQL answers 200 even when the mutation fails.
      return Response.json(errors ? { errors } : { data: {} })
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  }
  const run = github.operations.github_mark_ready_for_review!.run(
    { fetch, callId: 'c1', keepFile: never, readFile: never } as never,
    { repository: 'acme/web', number: 7, draft },
  )
  return { run, calls }
}

describe('github_mark_ready_for_review', () => {
  test('a draft: marked ready for review', async () => {
    const { run, calls } = marking({ draft: true }, false)
    const out = (await run) as { draft: boolean; changed: boolean }
    assert.deepEqual([out.draft, out.changed], [false, true])
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.query, /markPullRequestReadyForReview/)
    assert.deepEqual(calls[0]!.variables, { id: 'PR_7' })
  })

  test('back to draft', async () => {
    const { run, calls } = marking({ draft: false }, true)
    assert.equal(((await run) as { draft: boolean }).draft, true)
    assert.match(calls[0]!.query, /convertPullRequestToDraft/)
  })

  test('already as asked: nothing sent', async () => {
    const { run, calls } = marking({ draft: false }, false)
    assert.equal(((await run) as { changed: boolean }).changed, false)
    assert.equal(calls.length, 0)
  })

  test('a closed pull request: refused', async () => {
    const { run, calls } = marking({ draft: true, state: 'closed' }, false)
    await assert.rejects(run, /is closed/)
    assert.equal(calls.length, 0)
  })

  test("GitHub's GraphQL errors are reported", async () => {
    const { run } = marking({ draft: true }, false, [
      { message: 'Resource not accessible by integration' },
    ])
    await assert.rejects(run, /Resource not accessible by integration/)
  })
})
