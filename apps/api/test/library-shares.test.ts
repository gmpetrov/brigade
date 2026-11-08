import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseEnv } from 'node:util'
import { sessionStub } from './session-stub.js'

// Public links to library files (src/library-shares.ts, docs/public-links.md), through the API's
// own routes: members turn a file's link on and off, and anyone with it reads the file, without a
// session, and nothing else of the workspace. Against the API's development database
// (apps/api/.env), in an organization of its own removed at the end; skipped when none answers.
const envFile = new URL('../.env', import.meta.url)
if (!process.env.DATABASE_URL && existsSync(envFile))
  process.env.DATABASE_URL = parseEnv(readFileSync(envFile, 'utf8')).DATABASE_URL || undefined
process.env.DATABASE_URL ??= 'postgresql://localhost:1/none'
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret'
process.env.VAULT_KEY ??= Buffer.alloc(32).toString('base64')
process.env.BUCKET_DIR = mkdtempSync(join(tmpdir(), 'library-shares-'))

const { prisma, scoped } = await import('../src/db.js')
const database = await Promise.race([
  prisma.$queryRaw`select 1 from "LibraryShare" limit 1`.then(() => true),
  new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
]).catch(() => false)

const { Hono } = await import('hono')
const { HTTPException } = await import('hono/http-exception')
const { auth } = await import('../src/auth.js')
const { env } = await import('../src/config.js')
const { sharedDesignFiles } = await import('../src/designs.js')
const library = await import('../src/library.js')
const { storeAsset } = await import('../src/assets.js')
const { library: libraryRoutes } = await import('../src/routes/library.js')
const { shared: sharedRoutes } = await import('../src/routes/shared.js')

const app = new Hono()
app.route('/api/library', libraryRoutes)
app.route('/api/shared', sharedRoutes)
app.route('/s', sharedDesignFiles)
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : c.json({ error: String(error) }, 500),
)

const designHost = new URL(env.DESIGN_URL).host
const run = randomUUID().slice(0, 8)
const org = `org-links-${run}`
const people = ['ada', 'vic'] as const
type Person = (typeof people)[number]
const roles: Record<Person, string> = { ada: 'member', vic: 'viewer' }
const member = (p: Person) => `m-links-${p}-${run}`
const user = (p: Person) => `u-links-${p}-${run}`
let as: Person = 'ada'
const getSession = auth.api.getSession

const call = (path: string, init: { method?: string; as?: Person; host?: string } = {}) => {
  as = init.as ?? 'ada'
  return app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.host && { host: init.host }),
    },
    ...(init.method === 'POST' && { body: '{}' }),
  })
}
/** A token from a link's address, as it shows: <web>/s/<token>. */
const tokenOf = (url: string) => url.split('/s/')[1]!

describe('public links to library files', { skip: !database && 'no database answers' }, () => {
  let workspaceId: string
  let otherWorkspaceId: string
  let db: ReturnType<typeof scoped>
  let scope: { organizationId: string; workspaceId: string }
  const files = {} as Record<'doc' | 'other' | 'csv' | 'entry' | 'logo' | 'secret', string>
  let asset: string
  let otherAsset: string
  let hiddenAsset: string
  const encode = (text: string) => new TextEncoder().encode(text)

  before(async () => {
    await prisma.organization.create({ data: { id: org, name: 'Links', slug: org } })
    for (const p of people) {
      await prisma.user.create({ data: { id: user(p), name: p, email: `${user(p)}@example.com` } })
      await prisma.member.create({
        data: { id: member(p), organizationId: org, userId: user(p), role: roles[p] },
      })
    }
    workspaceId = (await prisma.workspace.create({ data: { organizationId: org, name: 'Acme' } }))
      .id
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { organizationId: org, name: 'Other' } })
    ).id
    scope = { organizationId: org, workspaceId }
    db = scoped(scope)
    const actor = { type: 'member' as const, id: member('ada') }
    const save = async (path: string, text: string) =>
      (await library.saveLibraryFile(db, scope, actor, { path, bytes: encode(text) })).id
    files.doc = await save('Sales/proposal.md', '# Proposal\n')
    files.other = await save('Sales/private.md', '# Private\n')
    asset = (
      await storeAsset(db, scope, {
        documentId: files.doc,
        file: new File([encode('PNGDATA')], 'chart.png', { type: 'image/png' }),
        memberId: member('ada'),
      })
    ).id
    otherAsset = (
      await storeAsset(db, scope, {
        documentId: files.other,
        file: new File([encode('SECRET')], 'secret.png', { type: 'image/png' }),
        memberId: member('ada'),
      })
    ).id
    hiddenAsset = (
      await storeAsset(db, scope, {
        documentId: files.doc,
        file: new File([encode('MARGINS')], 'margins.png', { type: 'image/png' }),
        memberId: member('ada'),
      })
    ).id
    await library.saveLibraryFile(db, scope, actor, {
      path: 'Sales/proposal.md',
      bytes: encode(
        [
          '# Proposal',
          '',
          'See @[Sales/private.md](document:' + files.other + ') and ask @[Riley](teammate:t1).',
          '',
          `![chart.png](asset:${asset} "Q3")`,
          '',
          '* [ ] Sign it <!-- item:k3f9q2 -->',
          '',
          `<!-- Internal: margins in asset:${hiddenAsset} -->`,
          '',
          `Left open: <!-- the floor price asset:${hiddenAsset}`,
        ].join('\n'),
      ),
    })
    files.csv = await save('Sales/numbers.csv', 'a,b\n1,2\n')
    files.entry = await save(
      'Sales/pitch.design/index.html',
      '<!doctype html><html><head><title>Pitch</title></head><body><img src="logo.svg"></body></html>',
    )
    await save('Sales/pitch.design/design.json', JSON.stringify({ title: 'Pitch deck' }))
    files.logo = await save(
      'Sales/pitch.design/logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    files.secret = (
      await library.saveLibraryFile(
        scoped({ organizationId: org, workspaceId: otherWorkspaceId }),
        { organizationId: org, workspaceId: otherWorkspaceId },
        actor,
        { path: 'secret.md', bytes: encode('# Secret') },
      )
    ).id
    ;(auth.api as { getSession: unknown }).getSession = sessionStub(() => ({
      user: { id: user(as) },
      session: { id: `s-links-${run}`, activeOrganizationId: org, activeWorkspaceId: workspaceId },
    }))
  })

  after(async () => {
    ;(auth.api as { getSession: unknown }).getSession = getSession
    await prisma.workspace.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObjectFolder.deleteMany({ where: { organizationId: org } })
    await prisma.libraryObject.deleteMany({ where: { organizationId: org } })
    await prisma.documentAsset.deleteMany({ where: { organizationId: org } })
    await prisma.auditEntry.deleteMany({ where: { organizationId: org } })
    await prisma.member.deleteMany({ where: { organizationId: org } })
    await prisma.organization.deleteMany({ where: { id: org } })
    await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } })
  })

  test('a document shared: the page reads it, its mentions as names, its own files only', async () => {
    assert.deepEqual(await (await call(`/api/library/${files.doc}/share`)).json(), { share: null })
    const on = await call(`/api/library/${files.doc}/share`, { method: 'POST' })
    assert.equal(on.status, 200)
    const { share } = (await on.json()) as { share: { url: string; createdBy: string } }
    assert.match(share.url, /\/s\/[A-Za-z0-9_-]{22}$/)
    assert.equal(share.createdBy, 'ada')
    // Turned on again: the same link.
    const again = (await (
      await call(`/api/library/${files.doc}/share`, { method: 'POST' })
    ).json()) as {
      share: { url: string }
    }
    assert.equal(again.share.url, share.url)

    const token = tokenOf(share.url)
    const page = await call(`/api/shared/${token}`)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/)
    const view = (await page.json()) as Record<string, string>
    assert.equal(view.kind, 'document')
    assert.equal(view.name, 'proposal.md')
    assert.equal(view.workspace, 'Acme')
    assert.match(view.markdown!, /See Sales\/private\.md and ask Riley\./)
    assert.doesNotMatch(view.markdown!, /document:|teammate:|item:|<!--/)
    assert.ok(
      view.markdown!.includes(`(${env.API_URL}/api/shared/${token}/assets/${asset} "Q3")`),
      view.markdown,
    )

    const image = await call(`/api/shared/${token}/assets/${asset}`)
    assert.equal(image.status, 200)
    assert.equal(await image.text(), 'PNGDATA')
    // Another document's file, though its id is known: not through this link.
    assert.equal((await call(`/api/shared/${token}/assets/${otherAsset}`)).status, 404)
    // Its own file named only in what the link hides (comments, one left open): not either.
    assert.doesNotMatch(view.markdown!, /Internal|floor price/)
    assert.equal((await call(`/api/shared/${token}/assets/${hiddenAsset}`)).status, 404)
    // Only the published text: never the stored one, with its comments and mentions' ids.
    assert.equal((await call(`/api/shared/${token}/content`)).status, 404)
    assert.equal((await call(`/api/shared/${token}/content?download`)).status, 404)
    // A document's link serves no preview.
    assert.equal((await call(`/api/shared/${token}/preview`)).status, 404)

    const listed = await library.libraryFiles(
      db,
      await db.document.findMany({
        where: { id: { in: [files.doc, files.other] } },
        select: library.LIBRARY_FILE_COLUMNS,
      }),
    )
    assert.deepEqual(Object.fromEntries(listed.map((f) => [f.path, f.shared])), {
      'Sales/proposal.md': true,
      'Sales/private.md': false,
    })
  })

  test('turned off, a link stops at once; turned on again, the file has a new one', async () => {
    const { share } = (await (await call(`/api/library/${files.doc}/share`)).json()) as {
      share: { url: string }
    }
    const token = tokenOf(share.url)
    const off = await call(`/api/library/${files.doc}/share`, { method: 'DELETE' })
    assert.deepEqual(await off.json(), { share: null })
    assert.equal((await call(`/api/shared/${token}`)).status, 404)
    assert.equal((await call(`/api/shared/${token}/assets/${asset}`)).status, 404)
    const renewed = (await (
      await call(`/api/library/${files.doc}/share`, { method: 'POST' })
    ).json()) as {
      share: { url: string }
    }
    assert.notEqual(renewed.share.url, share.url)
    assert.equal((await call(`/api/shared/${tokenOf(renewed.share.url)}`)).status, 200)
    const actions = await prisma.auditEntry.findMany({
      where: {
        organizationId: org,
        targetId: files.doc,
        action: { in: ['library.shared', 'library.unshared'] },
      },
      orderBy: { at: 'asc' },
      select: { action: true },
    })
    assert.deepEqual(
      actions.map((a) => a.action),
      ['library.shared', 'library.unshared', 'library.shared'],
    )
  })

  test('a file in the trash is not served, and is again once restored', async () => {
    const { share } = (await (await call(`/api/library/${files.doc}/share`)).json()) as {
      share: { url: string }
    }
    const token = tokenOf(share.url)
    await prisma.document.update({ where: { id: files.doc }, data: { deletedAt: new Date() } })
    assert.equal((await call(`/api/shared/${token}`)).status, 404)
    await prisma.document.update({ where: { id: files.doc }, data: { deletedAt: null } })
    assert.equal((await call(`/api/shared/${token}`)).status, 200)
  })

  test('a design shared: its page and files on the sandbox host, without the canvas', async () => {
    const { share } = (await (
      await call(`/api/library/${files.entry}/share`, { method: 'POST' })
    ).json()) as {
      share: { url: string }
    }
    const token = tokenOf(share.url)
    const view = (await (await call(`/api/shared/${token}`)).json()) as Record<string, string>
    assert.equal(view.kind, 'design')
    assert.equal(view.name, 'Pitch deck')
    assert.equal(view.url, `${env.DESIGN_URL}/s/${token}/index.html`)
    // Its bytes are the sandbox host's to serve, never the API's.
    assert.equal((await call(`/api/shared/${token}/content`)).status, 404)

    const page = await call(`/s/${token}/index.html`, { host: designHost })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<img src="logo.svg">/)
    assert.doesNotMatch(html, /data-brigade-bridge/)
    assert.match(page.headers.get('content-security-policy') ?? '', /^sandbox /)
    assert.equal((await call(`/s/${token}/`, { host: designHost })).status, 200)
    const logo = await call(`/s/${token}/logo.svg`, { host: designHost })
    assert.equal(logo.status, 200)
    // Nothing outside its folder, and nothing on another host.
    assert.equal((await call(`/s/${token}/..%2Fproposal.md`, { host: designHost })).status, 404)
    assert.equal((await call(`/s/${token}/index.html`)).status, 404)

    // A document's link is no design's.
    const doc = (await (await call(`/api/library/${files.doc}/share`)).json()) as {
      share: { url: string }
    }
    assert.equal(
      (await call(`/s/${tokenOf(doc.share.url)}/index.html`, { host: designHost })).status,
      404,
    )
  })

  test('any other file: its bytes, never run as a page on the API', async () => {
    const { share } = (await (
      await call(`/api/library/${files.csv}/share`, { method: 'POST' })
    ).json()) as {
      share: { url: string }
    }
    const token = tokenOf(share.url)
    const view = (await (await call(`/api/shared/${token}`)).json()) as Record<string, string>
    assert.equal(view.kind, 'file')
    assert.equal(view.contentUrl, `${env.API_URL}/api/shared/${token}/content`)
    const bytes = await call(`/api/shared/${token}/content`)
    assert.equal(bytes.status, 200)
    assert.equal(await bytes.text(), 'a,b\n1,2\n')
    assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(bytes.headers.get('content-security-policy'), 'sandbox')
    const download = await call(`/api/shared/${token}/content?download`)
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment/)
  })

  test('only members who may write share, and only their workspace’s library files', async () => {
    const viewer = await call(`/api/library/${files.other}/share`, { method: 'POST', as: 'vic' })
    assert.equal(viewer.status, 403)
    // A viewer sees whether a file is shared.
    assert.equal((await call(`/api/library/${files.doc}/share`, { as: 'vic' })).status, 200)
    assert.equal((await call(`/api/library/${files.secret}/share`, { method: 'POST' })).status, 404)
    const memory = await db.document.create({
      data: {
        kind: 'workspace_memory',
        path: 'workspace.md',
        contentType: 'text/markdown',
        size: 1,
      },
    } as never)
    assert.equal((await call(`/api/library/${memory.id}/share`, { method: 'POST' })).status, 404)
    assert.equal((await call('/api/shared/not-a-token')).status, 404)
    assert.equal((await call(`/api/shared/${'x'.repeat(22)}`)).status, 404)
  })
})
