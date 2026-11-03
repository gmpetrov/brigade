import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'

// A repository renamed on GitHub while Brigade tracks its pull requests (src/pull-requests.ts),
// against the API's development database (apps/api/.env), in an organization of its own removed
// at the end, with GitHub faked; skipped when no database answers:
// - a pull request opened, its repository renamed, then merged: GitHub's event under the new name
//   finds it by the repository's id, merges it and moves it to the new name; complete_thread is
//   no longer refused;
// - GitHub's repository event (renamed, transferred) moves what was kept under the old name;
// - one kept from before the id was (no id, no event heard): complete_thread reads it again on
//   GitHub, under the name GitHub answers for the old one, and is not refused; a card reading it
//   (pullState) too.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
const WEBHOOK_SECRET = 'rename-secret'
process.env.GITHUB_APP_WEBHOOK_SECRET = WEBHOOK_SECRET
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
process.env.GITHUB_APP_ID = '1'
process.env.GITHUB_APP_SLUG = 'brigade-test'
process.env.GITHUB_APP_PRIVATE_KEY = privateKey

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

describe('a repository renamed', { skip: !database && 'no database answers' }, () => {
  const suffix = randomUUID().slice(0, 8)
  const installationId = 200_000 + Math.floor(Math.random() * 1_000_000)
  const org = `org-rename-${suffix}`
  const owner = `m-rename-${suffix}`
  const realFetch = globalThis.fetch
  let scope: { organizationId: string; workspaceId: string }
  let db: ReturnType<typeof scoped>
  let riley: string
  let computer: string

  /** GitHub: each repository by its id, its name now and the names it had. */
  const repos = new Map<number, { name: string; before: string[] }>()
  /** Pull requests merged on GitHub, by repository id and number. */
  const merged = new Set<string>()
  let nextId = 7_000_000 + Math.floor(Math.random() * 1_000_000)
  const repoNamed = (name: string) =>
    [...repos.entries()].find(([, r]) => r.name === name || r.before.includes(name))
  function rename(id: number, to: string) {
    const r = repos.get(id)!
    r.before.push(r.name)
    r.name = to
  }
  const ghPull = (id: number, number: number) => {
    const done = merged.has(`${id}#${number}`)
    const name = repos.get(id)!.name
    return {
      number,
      title: `Change ${number}`,
      html_url: `https://github.com/${name}/pull/${number}`,
      state: done ? 'closed' : 'open',
      draft: false,
      merged_at: done ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
      user: { login: 'brigade-test[bot]', type: 'Bot' },
      head: { ref: `brigade/change-${number}`, sha: `sha${number}` },
      base: { ref: 'main', repo: { id, full_name: name } },
    }
  }

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Rename', slug: org } })
    await prisma.user.create({
      data: { id: `u-${owner}`, name: 'Ada', email: `${owner}@test.local` },
    })
    await prisma.member.create({
      data: { id: owner, organizationId: org, userId: `u-${owner}`, role: 'owner' },
    })
    const workspaceId = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Rename' } })
    ).id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    computer = (
      await db.computer.create({
        data: { kind: 'member_machine', memberId: owner, name: 'Ada’s Mac' },
      } as never)
    ).id
    riley = (await db.teammate.create({ data: { name: `Riley ${suffix}` } } as never)).id
    const app = await db.app.create({ data: { key: 'github', createdByMemberId: owner } as never })
    const { sealSecret } = await import('../src/vault.js')
    await db.connection.create({
      data: {
        appId: app.id,
        kind: 'github',
        label: 'GitHub',
        externalUrl: `https://github.com/settings/installations/${installationId}`,
        createdByMemberId: owner,
        vaultSecretId: await sealSecret(db, scope, { installationId }),
      } as never,
    })

    // GitHub as it answers: the repositories under their names now, an old name redirected to
    // the repository (only for the repository itself: a pull request must be asked for under
    // its name now, so that Brigade is seen sending it there).
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(url))
      if (pathname.endsWith('/access_tokens'))
        return Response.json({
          token: 'installation-token',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        })
      if (pathname === '/installation/repositories')
        return Response.json({
          repositories: [...repos.values()].map((r) => ({ full_name: r.name, private: true })),
        })
      const repo = pathname.match(/^\/repos\/([^/]+\/[^/]+)$/)
      if (repo && (init?.method ?? 'GET') === 'GET') {
        const found = repoNamed(decodeURIComponent(repo[1]!))
        if (found) return Response.json({ id: found[0], full_name: found[1].name })
      }
      const pr = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/)
      if (pr) {
        const found = [...repos.entries()].find(([, r]) => r.name === decodeURIComponent(pr[1]!))
        if (found) return Response.json(ghPull(found[0], Number(pr[2])))
      }
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }) as typeof fetch
  })

  after(async () => {
    globalThis.fetch = realFetch
    if (scope) await prisma.workspace.deleteMany({ where: { id: scope.workspaceId } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: `u-${owner}` } })
  })

  /** A repository on GitHub, its id. */
  function repository(name: string) {
    const id = nextId++
    repos.set(id, { name, before: [] })
    return id
  }

  /** A thread of Riley's at rest, as after its turn. */
  async function thread() {
    const session = await db.session.create({
      data: {
        teammateId: riley,
        startedByMemberId: owner,
        askedByMemberId: owner,
        computerId: computer,
        title: 'Screen recording',
        status: 'idle',
        origin: 'member',
      } as never,
    })
    await db.threadTeammate.create({ data: { sessionId: session.id, teammateId: riley } as never })
    return session
  }

  /** Riley opened pull request #number of the repository in the thread, as Brigade notes it. */
  async function opened(sessionId: string, id: number, number: number) {
    const { notePullRequestCall } = await import('../src/pull-requests.js')
    await notePullRequestCall(db, scope, {
      sessionId,
      teammateId: riley,
      operation: 'github_create_pull_request',
      input: { repository: repos.get(id)!.name },
      output: {
        number,
        title: `Change ${number}`,
        head: `brigade/change-${number}`,
        base: 'main',
        repositoryId: id,
      },
    })
  }

  /** GitHub delivers an event, through the webhook's route, and it is processed. */
  async function deliver(event: string, payload: object) {
    const { githubWebhook } = await import('../src/routes/github-webhook.js')
    const body = JSON.stringify({ installation: { id: installationId }, ...payload })
    const delivery = `delivery-${randomUUID()}`
    const response = await githubWebhook.request('/', {
      method: 'POST',
      body,
      headers: {
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`,
      },
    })
    assert.equal(response.status, 202)
    // Processed in the background (src/inbound.ts): once it is through.
    for (let i = 0; i < 250; i++) {
      const kept = await prisma.inboundEvent.findFirst({
        where: { source: 'github', externalId: delivery },
      })
      if (kept?.status === 'done') return
      assert.notEqual(kept?.status, 'failed', kept?.error ?? undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail(`delivery ${delivery} not processed`)
  }
  const mergedEvent = (id: number, number: number) => {
    merged.add(`${id}#${number}`)
    const name = repos.get(id)!.name
    return deliver('pull_request', {
      action: 'closed',
      repository: { id, name: name.split('/')[1], full_name: name },
      pull_request: ghPull(id, number),
    })
  }

  const rows = (sessionId: string) =>
    db.pullRequest.findMany({
      where: { sessionId },
      select: { repository: true, repositoryId: true, number: true, state: true },
      orderBy: { number: 'asc' },
    })
  async function declare(session: Awaited<ReturnType<typeof thread>>) {
    const { completeThread } = await import('../src/thread-done.js')
    return completeThread(db, scope, session, { id: riley }, {
      name: 'complete_thread',
      summary: 'Style editor and npm package merged',
    } as never)
  }

  test('opened, renamed, then merged: the merge under the new name is heard', async () => {
    const id = repository(`acme/screenplay-${suffix}`)
    const session = await thread()
    await opened(session.id, id, 4)
    await opened(session.id, id, 5)
    const refused = (await declare(session)) as { error?: string }
    assert.match(refused.error ?? '', /Pull request #4 in acme\/screenplay-.* is still open/)

    // Renamed, and Brigade not told (no repository event): then both merged.
    rename(id, `acme/agent-screenplay-${suffix}`)
    await mergedEvent(id, 4)
    await mergedEvent(id, 5)
    assert.deepEqual(await rows(session.id), [
      {
        repository: `acme/agent-screenplay-${suffix}`,
        repositoryId: String(id),
        number: 4,
        state: 'merged',
      },
      {
        repository: `acme/agent-screenplay-${suffix}`,
        repositoryId: String(id),
        number: 5,
        state: 'merged',
      },
    ])
    const { needsAttention } = await import('../src/pull-requests.js')
    assert.deepEqual(await needsAttention(db), [], 'no card waits on a person')
    const done = (await declare(session)) as { done?: object; error?: string }
    assert.ok(done.done, done.error)
  })

  test("GitHub's repository event moves what was kept under the old name", async () => {
    const id = repository(`acme/old-${suffix}`)
    const session = await thread()
    // Kept from before the id was: only the name.
    await db.pullRequest.create({
      data: {
        repository: `acme/old-${suffix}`,
        number: 7,
        title: 'Change 7',
        headRef: 'brigade/change-7',
        baseRef: 'main',
        sessionId: session.id,
        authorTeammateId: riley,
      } as never,
    })
    rename(id, `acme/new-${suffix}`)
    await deliver('repository', {
      action: 'renamed',
      changes: { repository: { name: { from: `old-${suffix}` } } },
      repository: { id, name: `new-${suffix}`, full_name: `acme/new-${suffix}` },
    })
    assert.deepEqual(await rows(session.id), [
      { repository: `acme/new-${suffix}`, repositoryId: String(id), number: 7, state: 'open' },
    ])
    // Transferred to another owner: the same.
    rename(id, `beta/new-${suffix}`)
    await deliver('repository', {
      action: 'transferred',
      changes: { owner: { from: { organization: { login: 'acme' } } } },
      repository: { id, name: `new-${suffix}`, full_name: `beta/new-${suffix}` },
    })
    assert.equal((await rows(session.id))[0]!.repository, `beta/new-${suffix}`)
    await mergedEvent(id, 7)
    assert.equal((await rows(session.id))[0]!.state, 'merged')
  })

  test('kept under an old name and no event heard: read again on GitHub', async () => {
    const id = repository(`acme/before-${suffix}`)
    const session = await thread()
    for (const number of [8, 9])
      await db.pullRequest.create({
        data: {
          repository: `acme/before-${suffix}`,
          number,
          title: `Change ${number}`,
          headRef: `brigade/change-${number}`,
          baseRef: 'main',
          sessionId: session.id,
          authorTeammateId: riley,
        } as never,
      })
    rename(id, `acme/after-${suffix}`)
    merged.add(`${id}#8`)
    merged.add(`${id}#9`)
    // Its card, opened: read under the name GitHub answers for the old one.
    const { pullState } = await import('../src/pull-requests.js')
    const card = await pullState(db, scope, `acme/before-${suffix}`, 8)
    assert.equal(card.state, 'merged')
    // complete_thread: the other, read again before refusing.
    const done = (await declare(session)) as { done?: object; error?: string }
    assert.ok(done.done, done.error)
    assert.deepEqual(await rows(session.id), [
      { repository: `acme/after-${suffix}`, repositoryId: String(id), number: 8, state: 'merged' },
      { repository: `acme/after-${suffix}`, repositoryId: String(id), number: 9, state: 'merged' },
    ])
  })
})
