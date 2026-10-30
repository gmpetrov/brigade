// Design systems, and designs shown in the dashboard. A design is a library
// folder whose page runs the teammate's script, so it is served only from
// DESIGN_URL, another site than the dashboard and the API, with no cookies:
// under a short-lived signed address, as a sandboxed document.
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  DESIGN_ENTRY,
  DESIGN_KNOBS,
  DESIGN_MANIFEST,
  DESIGN_SYSTEM_README,
  DESIGN_THUMBNAIL,
  Choices,
  designFolderOf,
  DesignKnobs,
  designOptionsOf,
  DesignManifest,
  designName,
  addToHead,
  knobsStyle,
  OFFER_CHOICES_TOOL,
  pickedDesignPath,
  type DesignEdit,
  type DesignEditResult,
  type DesignPersonEdit,
  type DesignSystem,
  type DesignView,
  type DesignOption,
  type DesignWhere,
  type SaveDesignThumbnail,
  type SaveKnobs,
  type SaveDesignSystem,
  type TeammateDesignSystem,
  type ThreadDesignSystem,
} from '@brigade/contracts'
import { zipSync } from 'fflate'
import { Hono, type MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { audit, type Actor } from './audit.js'
import { directUploads, readHead } from './bucket.js'
import { env } from './config.js'
import { scoped, type Scope, type ScopedDb } from './db.js'
import { bridgeScript } from './design-bridge.js'
import { annotate, applyEdits, EditError } from './design-source.js'
import { actorNames, trashLibraryFile } from './library-history.js'
import { fileKey } from './library-objects.js'
import { readLibraryFile, saveLibraryFile } from './library.js'
import { discardUpload, readyUpload, uploadBytesKey } from './uploads.js'

type Row = Awaited<ReturnType<ScopedDb['designSystem']['findFirstOrThrow']>>

export const toDesignSystem = (row: Row): DesignSystem => ({
  id: row.id,
  name: row.name,
  description: row.description,
  path: row.path,
  isDefault: row.isDefault,
  folders: row.folders,
  repositories: row.repositories,
  teammateIds: row.teammateIds,
  projectIds: row.projectIds,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const listDesignSystems = (db: ScopedDb) =>
  db.designSystem.findMany({ orderBy: { name: 'asc' } })

/** Create one, or change the one with `id`. Making it the default unsets the last one. */
export async function saveDesignSystem(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: z.output<typeof SaveDesignSystem>,
  id?: string,
) {
  if (id && !(await db.designSystem.findFirst({ where: { id } })))
    throw new HTTPException(404, { message: 'Design system not found' })
  const clash = await db.designSystem.findFirst({
    where: { name: { equals: input.name, mode: 'insensitive' }, ...(id ? { NOT: { id } } : {}) },
  })
  if (clash) throw new HTTPException(409, { message: 'A design system already has that name' })
  const teammates = await db.teammate.findMany({
    where: { id: { in: input.teammateIds }, archivedAt: null },
    select: { id: true },
  })
  const projects = await db.project.findMany({
    where: { id: { in: input.projectIds } },
    select: { id: true },
  })
  const data = {
    ...input,
    folders: [...new Set(input.folders)],
    repositories: [...new Set(input.repositories)],
    teammateIds: teammates.map((t) => t.id),
    projectIds: projects.map((p) => p.id),
  }
  if (data.isDefault)
    await db.designSystem.updateMany({
      where: { isDefault: true, ...(id ? { NOT: { id } } : {}) },
      data: { isDefault: false },
    })
  const row = id
    ? await db.designSystem.update({ where: { id }, data })
    : await db.designSystem.create({ data: data as never })
  await audit({
    ...scope,
    actor,
    action: id ? 'design_system.updated' : 'design_system.created',
    target: { type: 'design_system', id: row.id },
    data: { name: row.name, path: row.path },
  })
  return row
}

/**
 * A teammate registers the design system it saved, or changes the one with that
 * name: it needs to save to its folder (the old one too, when it moves). What it
 * leaves out keeps its value; a new one is the default when there is none yet.
 */
export async function saveTeammateDesignSystem(
  db: ScopedDb,
  scope: Scope,
  teammateId: string,
  input: TeammateDesignSystem,
  mayWrite: (path: string) => boolean,
) {
  const path = input.path.replace(/\/+$/, '')
  if (designFolderOf(path))
    throw new HTTPException(400, {
      message: `A design system is a plain folder, not a design: put its preview design inside it`,
    })
  if (!mayWrite(path))
    throw new HTTPException(403, { message: `You may not save to ${path} in the library` })
  const readme = await db.document.findFirst({
    where: { kind: 'library', path: `${path}/${DESIGN_SYSTEM_README}`, deletedAt: null },
    select: { id: true },
  })
  if (!readme)
    throw new HTTPException(400, {
      message: `Save the folder first: ${path}/${DESIGN_SYSTEM_README} is not in the library`,
    })
  const existing = await db.designSystem.findFirst({
    where: { name: { equals: input.name, mode: 'insensitive' } },
  })
  if (existing && !mayWrite(existing.path))
    throw new HTTPException(403, {
      message: `The design system ${existing.name} is in ${existing.path}, where you may not save`,
    })
  const first = !existing && (await db.designSystem.count()) === 0
  const row = await saveDesignSystem(
    db,
    scope,
    { type: 'teammate', id: teammateId },
    {
      name: input.name,
      path,
      description: input.description ?? existing?.description ?? '',
      isDefault: input.isDefault ?? existing?.isDefault ?? first,
      folders: input.folders ?? existing?.folders ?? [],
      repositories: input.repositories ?? existing?.repositories ?? [],
      teammateIds: existing?.teammateIds ?? [],
      projectIds: existing?.projectIds ?? [],
    },
    existing?.id,
  )
  return { row, created: !existing }
}

export async function deleteDesignSystem(db: ScopedDb, scope: Scope, actor: Actor, id: string) {
  const row = await db.designSystem.findFirst({ where: { id } })
  if (!row) throw new HTTPException(404, { message: 'Design system not found' })
  await db.designSystem.delete({ where: { id } })
  await audit({
    ...scope,
    actor,
    action: 'design_system.deleted',
    target: { type: 'design_system', id },
    data: { name: row.name, path: row.path },
  })
}

/** The design systems as a thread's teammate sees them. The library folder stays theirs to read. */
export async function threadDesignSystems(
  db: ScopedDb,
  teammateId: string,
  projectId: string | null = null,
): Promise<ThreadDesignSystem[]> {
  const rows = await listDesignSystems(db)
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    path: r.path,
    folders: r.folders,
    repositories: r.repositories,
    teammate: r.teammateIds.includes(teammateId),
    project: !!projectId && r.projectIds.includes(projectId),
    isDefault: r.isDefault,
  }))
}

// ---------------------------------------------------------------------------
// Viewing a design
// ---------------------------------------------------------------------------

/** How long a design's address works. Reopening the design gets a new one. */
const VIEW_SECONDS = 4 * 60 * 60

type ViewClaim = { o: string; w: string; p: string; e: number }

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')
const sign = (payload: string) =>
  b64url(createHmac('sha256', `design-view:${env.BETTER_AUTH_SECRET}`).update(payload).digest())

function viewToken(scope: Scope, folder: string) {
  const claim: ViewClaim = {
    o: scope.organizationId,
    w: scope.workspaceId,
    p: folder,
    e: Math.floor(Date.now() / 1000) + VIEW_SECONDS,
  }
  const payload = b64url(JSON.stringify(claim))
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(claim.e * 1000) }
}

function readViewToken(token: string): ViewClaim | null {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(signature)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const claim = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ViewClaim
    return claim.e * 1000 > Date.now() ? claim : null
  } catch {
    return null
  }
}

const libraryRow = (db: ScopedDb, path: string) =>
  db.document.findFirst({ where: { kind: 'library', deletedAt: null, path } })

/** A JSON file of the library, parsed by `schema`; null when missing or unreadable. */
async function readJson<T>(
  scope: Scope,
  row: { id: string; objectKey: string | null } | null,
  schema: { safeParse: (v: unknown) => { data?: T } },
) {
  if (!row) return null
  try {
    const text = new TextDecoder().decode(await readLibraryFile(scope, row))
    return schema.safeParse(JSON.parse(text)).data ?? null
  } catch {
    // Not JSON: the design still shows.
    return null
  }
}

/** A design's files: every library file in its folder. */
const designRows = (db: ScopedDb, folder: string) =>
  db.document.findMany({
    where: { kind: 'library', deletedAt: null, path: { startsWith: `${folder}/` } },
    orderBy: { path: 'asc' },
  })

/**
 * A design's address on the sandbox origin, what it says about itself, and
 * where comments go: the thread that saved it last, when this member may see
 * it. `path` is the folder or a file in it.
 */
export async function openDesignView(
  db: ScopedDb,
  scope: Scope & { memberId: string },
  path: string,
): Promise<DesignView> {
  const folder = designFolderOf(path)
  if (!folder) throw new HTTPException(400, { message: 'That is not in a design folder' })
  const rows = await designRows(db, folder)
  const at = (name: string) => rows.find((r) => r.path === `${folder}/${name}`) ?? null
  const entry = at(DESIGN_ENTRY)
  if (!entry) throw new HTTPException(404, { message: `The design has no ${DESIGN_ENTRY} yet` })
  const [manifest, knobs] = await Promise.all([
    readJson(scope, at(DESIGN_MANIFEST), DesignManifest),
    readJson(scope, at(DESIGN_KNOBS), DesignKnobs),
  ])
  // The latest save from a thread, and the latest by a teammate.
  const latest = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const sessionId = latest.find((r) => r.updatedInSessionId)?.updatedInSessionId
  const teammateId = latest.find((r) => r.updatedByType === 'teammate')?.updatedById
  const [session, teammate] = await Promise.all([
    sessionId
      ? db.session.findFirst({
          where: {
            id: sessionId,
            OR: [{ private: false }, { startedByMemberId: scope.memberId }],
          },
        })
      : null,
    teammateId ? db.teammate.findFirst({ where: { id: teammateId, archivedAt: null } }) : null,
  ])
  const { token, expiresAt } = viewToken(scope, folder)
  return {
    url: `${env.DESIGN_URL}/v/${token}/${DESIGN_ENTRY}`,
    manifest,
    knobs: knobs?.knobs ?? [],
    entryId: entry.id,
    files: Object.fromEntries(
      rows
        .filter((r) => r.contentType === 'text/html')
        .map((r) => [r.path.slice(folder.length + 1), r.sha256]),
    ),
    thread: session
      ? {
          id: session.id,
          title: session.title,
          mayPrompt: session.startedByMemberId === scope.memberId || session.othersMayPrompt,
        }
      : null,
    teammate: teammate ? { id: teammate.id, name: teammate.name } : null,
    expiresAt: expiresAt.toISOString(),
  }
}

/** Save the values chosen in the viewer into `knobs.json`, as a new version of it. */
export async function saveKnobs(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: z.output<typeof SaveKnobs>,
) {
  const folder = designFolderOf(input.path)
  if (!folder) throw new HTTPException(400, { message: 'That is not in a design folder' })
  const row = await libraryRow(db, `${folder}/${DESIGN_KNOBS}`)
  const knobs = await readJson(scope, row, DesignKnobs)
  if (!row || !knobs)
    throw new HTTPException(404, { message: `The design has no readable ${DESIGN_KNOBS}` })
  const unknown = Object.keys(input.values).filter((v) => !knobs.knobs.some((k) => k.var === v))
  if (unknown.length)
    throw new HTTPException(400, { message: `${DESIGN_KNOBS} has no knob ${unknown.join(', ')}` })
  const next = {
    knobs: knobs.knobs.map((k) =>
      k.var in input.values ? { ...k, value: input.values[k.var]! } : k,
    ),
  }
  await saveLibraryFile(db, scope, actor, {
    path: row.path,
    bytes: new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`),
    contentType: 'application/json',
  })
  return next.knobs
}

/**
 * The page as people see it: the knobs' values on top of the design's own. On
 * the canvas (`page`), also its elements numbered and the bridge, first in its
 * head so it sees the page before the page's own scripts run.
 */
async function withKnobs(
  scope: Scope,
  db: ScopedDb,
  folder: string,
  html: string,
  page?: { file: string; sha256: string },
) {
  const knobs = await readJson(
    scope,
    await libraryRow(db, `${folder}/${DESIGN_KNOBS}`),
    DesignKnobs,
  )
  const style = knobs ? knobsStyle(knobs.knobs) : ''
  // The knobs' selector outranks the design's own :root wherever it stands.
  const knobbed = addToHead(html, style ? `<style data-brigade-knobs>${style}</style>` : '')
  return page ? addToHead(annotate(knobbed), bridgeScript(page), { first: true }) : knobbed
}

/** The design's folder as a zip, its page with the knobs' values: to open anywhere. */
export async function designZip(db: ScopedDb, scope: Scope, path: string) {
  const folder = designFolderOf(path)
  if (!folder) throw new HTTPException(400, { message: 'That is not in a design folder' })
  const rows = await designRows(db, folder)
  if (rows.length === 0) throw new HTTPException(404, { message: 'Design not found' })
  const name = designName(folder)
  const files: Record<string, Uint8Array> = {}
  let total = 0
  for (const row of rows) {
    total += row.size
    if (total > ZIP_MAX) throw new HTTPException(413, { message: 'The design is too large to zip' })
    let bytes = await readLibraryFile(scope, row)
    if (row.contentType === 'text/html')
      bytes = new TextEncoder().encode(
        await withKnobs(scope, db, folder, new TextDecoder().decode(bytes)),
      )
    files[`${name}/${row.path.slice(folder.length + 1)}`] = bytes
  }
  return { name: `${name}.zip`, bytes: zipSync(files, { level: 6 }) }
}

/** Largest design the API zips. */
const ZIP_MAX = 100 * 1024 * 1024

const designHost = new URL(env.DESIGN_URL).host
/** The sandbox origin is its own host only when it differs from the API's. */
const separateHost = designHost !== new URL(env.API_URL).host
if (!separateHost)
  console.warn(
    `Designs are served from the API's own host (${designHost}). Set DESIGN_URL to another host that points at this API, ideally on another domain.`,
  )

/** On the sandbox host, only designs answer: nothing else of the API is reachable there. */
export const sandboxHostOnlyDesigns: MiddlewareHandler = async (c, next) => {
  if (separateHost && c.req.header('host') === designHost && !c.req.path.startsWith('/v/'))
    return c.text('Not found', 404)
  await next()
}

/**
 * Public CDNs of static files a design's script may fetch from: to inline fonts
 * and images when the viewer captures the page. Nothing there acts for anyone.
 */
const STATIC_HOSTS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://esm.sh',
  'https://images.unsplash.com',
  'https://picsum.photos',
  'https://fastly.picsum.photos',
]

/**
 * What a design page may do: run its script and load scripts, styles, fonts and
 * images from anywhere, as a sandboxed document. It may not call other sites
 * (fetch, sockets), beyond public CDNs, or submit forms, so its script cannot
 * act on the API with a member's session, wherever the sandbox host is.
 */
const DESIGN_CSP = [
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads',
  "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  `connect-src 'self' data: blob: ${STATIC_HOSTS.join(' ')}`,
  "form-action 'none'",
  `frame-ancestors ${env.WEB_URL.join(' ')}`,
].join('; ')

/** A design's files, under `/v/<token>/`: relative links resolve inside its folder. */
export const designFiles = new Hono().get('/:token/*', async (c) => {
  if (separateHost && c.req.header('host') !== designHost) return c.text('Not found', 404)
  const claim = readViewToken(c.req.param('token'))
  if (!claim) return c.text('This link has expired. Open the design again.', 410)
  const prefix = `/v/${c.req.param('token')}/`
  let rest: string[]
  try {
    rest = c.req.path.slice(prefix.length).split('/').map(decodeURIComponent)
  } catch {
    return c.text('Not found', 404)
  }
  if (rest.some((part) => part === '..' || part === '.' || part.startsWith('.')))
    return c.text('Not found', 404)
  if (rest.at(-1) === '') rest[rest.length - 1] = DESIGN_ENTRY
  const scope: Scope = { organizationId: claim.o, workspaceId: claim.w }
  const db = scoped(scope)
  const row = await libraryRow(db, [claim.p, ...rest].join('/'))
  if (!row) return c.text('Not found', 404)
  let bytes = await readLibraryFile(scope, row)
  const html = row.contentType === 'text/html'
  if (html)
    bytes = new TextEncoder().encode(
      await withKnobs(scope, db, claim.p, new TextDecoder().decode(bytes), {
        file: rest.join('/'),
        sha256: row.sha256,
      }),
    )
  return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
    'content-type': row.contentType.startsWith('text/')
      ? `${row.contentType}; charset=utf-8`
      : row.contentType,
    'content-security-policy': DESIGN_CSP,
    'x-content-type-options': 'nosniff',
    // The address carries the token: never sent on to the sites a design loads from.
    'referrer-policy': 'no-referrer',
    // A sandboxed page's origin is opaque: its module scripts and fonts are cross-origin requests.
    'access-control-allow-origin': '*',
    // A page is numbered from its bytes of now: a cached one would number another version.
    'cache-control': html ? 'no-store' : 'private, max-age=60',
  })
})

// ---------------------------------------------------------------------------
// Editing a design on the canvas
// ---------------------------------------------------------------------------

/** One edit of a file at a time in this process: each checks the version the last one made. */
const editing = new Map<string, Promise<unknown>>()
async function oneAtATime<T>(key: string, work: () => Promise<T>) {
  const before = editing.get(key) ?? Promise.resolve()
  const run = before.then(work, work)
  const settled = run.catch(() => undefined)
  editing.set(key, settled)
  try {
    return await run
  } finally {
    if (editing.get(key) === settled) editing.delete(key)
  }
}

/**
 * A person's changes to a page of a design, made on the canvas: spliced into
 * its HTML and saved as a new version by them. Refused when the page was saved
 * since they loaded it, since its elements may be numbered differently now.
 */
export async function editDesign(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: DesignEdit,
): Promise<DesignEditResult> {
  const folder = input.path.replace(/\/+$/, '')
  if (designFolderOf(folder) !== folder)
    throw new HTTPException(400, { message: 'That is not a design folder' })
  const path = `${folder}/${input.file}`
  const first = await libraryRow(db, path)
  if (!first || first.contentType !== 'text/html')
    throw new HTTPException(404, { message: `The design has no page ${input.file}` })
  return oneAtATime(first.id, async () => {
    const row = await libraryRow(db, path)
    if (!row) throw new HTTPException(404, { message: `The design has no page ${input.file}` })
    if (row.sha256 !== input.sha256)
      throw new HTTPException(409, {
        message: `Someone saved ${input.file} meanwhile: it was reloaded, make the change again`,
      })
    const html = new TextDecoder().decode(await readLibraryFile(scope, row))
    let next: string
    try {
      next = applyEdits(html, input.ops)
    } catch (error) {
      if (error instanceof EditError) throw new HTTPException(400, { message: error.message })
      throw error
    }
    const saved = await saveLibraryFile(db, scope, actor, {
      path,
      bytes: new TextEncoder().encode(next),
      contentType: 'text/html',
    })
    await audit({
      ...scope,
      actor,
      action: 'design.edited',
      target: { type: 'document', id: saved.id },
      data: {
        folder,
        file: input.file,
        ops: [
          ...new Set(
            input.ops.map((o) => ('style' in o ? 'style' : 'text' in o ? 'text' : 'attrs')),
          ),
        ],
      },
    })
    return { sha256: saved.sha256, updatedAt: saved.updatedAt.toISOString() }
  })
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Largest picture the canvas saves for the gallery. */
const THUMBNAIL_MAX = 2 * 1024 * 1024

/** The canvas's picture of a design's first board after a person's edits: the gallery's. */
export async function saveDesignThumbnail(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  input: z.output<typeof SaveDesignThumbnail>,
) {
  const folder = input.path.replace(/\/+$/, '')
  if (designFolderOf(folder) !== folder || !(await libraryRow(db, `${folder}/${DESIGN_ENTRY}`)))
    throw new HTTPException(400, { message: 'That is not a design folder' })
  const path = `${folder}/${DESIGN_THUMBNAIL}`
  const isPng = (head: Uint8Array | null) =>
    head !== null && PNG_SIGNATURE.every((b, i) => head[i] === b)
  if (input.uploadId) {
    // Uploaded straight to the bucket by the canvas, and checked (uploads.ts).
    const upload = await readyUpload(db, { memberId: actor.id }, input.uploadId, 'library')
    const key = uploadBytesKey(scope, upload)
    if (upload.size > THUMBNAIL_MAX || !isPng(await readHead(key, PNG_SIGNATURE.length))) {
      await discardUpload(scope, upload.id)
      throw new HTTPException(400, { message: 'A PNG picture up to 2 MB' })
    }
    await saveLibraryFile(db, scope, actor, {
      path,
      contentType: 'image/png',
      upload: { key, size: upload.size, sha256: upload.sha256, text: '' },
    })
    await discardUpload(scope, upload.id)
    return
  }
  // The picture in the body: only without R2, in development.
  if (directUploads) throw new HTTPException(400, { message: 'Upload to the bucket' })
  const bytes = Buffer.from(input.png ?? '', 'base64')
  if (bytes.byteLength > THUMBNAIL_MAX || !isPng(bytes))
    throw new HTTPException(400, { message: 'A PNG picture up to 2 MB' })
  await saveLibraryFile(db, scope, actor, { path, bytes, contentType: 'image/png' })
}

/**
 * Files of a design a person changed since this thread last saved them (or,
 * never having saved them, since it started): a teammate asks before saving the
 * design, so it does not save over their edits unawares. The picture is the
 * canvas's to keep up to date, not an edit.
 */
export async function personEdits(
  db: ScopedDb,
  session: { id: string; createdAt: Date },
  path: string,
): Promise<DesignPersonEdit[]> {
  const folder = path.replace(/\/+$/, '')
  if (designFolderOf(folder) !== folder) return []
  const rows = (await designRows(db, folder)).filter(
    (r) => r.updatedByType === 'member' && r.path !== `${folder}/${DESIGN_THUMBNAIL}`,
  )
  if (rows.length === 0) return []
  const ours = await db.documentVersion.findMany({
    where: { documentId: { in: rows.map((r) => r.id) }, sessionId: session.id },
    select: { documentId: true, updatedAt: true },
  })
  // A version's last change: saves moments apart fold into one version (recordVersion).
  const lastSaved = (id: string) =>
    Math.max(
      session.createdAt.getTime(),
      ...ours.filter((v) => v.documentId === id).map((v) => v.updatedAt.getTime()),
    )
  const edited = rows.filter((r) => r.updatedAt.getTime() > lastSaved(r.id))
  const name = await actorNames(
    db,
    edited.map((r) => ({ type: 'member', id: r.updatedById! })),
  )
  return edited.map((r) => ({
    file: r.path.slice(folder.length + 1),
    by: name('member', r.updatedById)?.name ?? 'A person',
    at: r.updatedAt.toISOString(),
  }))
}

/**
 * A design a thread offered as one of the options in an options folder
 * (`a/x.options/b.design`), checked before the message that picks it is sent:
 * where it goes, and whether a design is there to replace.
 */
export async function checkPick(db: ScopedDb, threadId: string, path: string) {
  const folder = path.replace(/\/+$/, '')
  const options = designOptionsOf(folder)
  if (designFolderOf(folder) !== folder || !options)
    throw new HTTPException(400, { message: `"${folder}" is not one of a design's options` })
  const offers = await db.sessionEvent.findMany({
    where: {
      sessionId: threadId,
      type: 'tool.started',
      data: { path: ['toolName'], string_ends_with: OFFER_CHOICES_TOOL },
    },
    select: { data: true },
  })
  const offered = offers.some((e) =>
    Choices.safeParse((e.data as { input?: unknown }).input).data?.options.some(
      (o) => o.design?.replace(/\/+$/, '') === folder,
    ),
  )
  if (!offered) throw new HTTPException(400, { message: 'This thread did not offer that design' })
  const live = { kind: 'library' as const, deletedAt: null }
  if (!(await db.document.findFirst({ where: { ...live, path: `${folder}/${DESIGN_ENTRY}` } })))
    throw new HTTPException(409, { message: 'That option is no longer in the library' })
  const to = pickedDesignPath(options)
  if (await db.document.findFirst({ where: { ...live, path: to } }))
    throw new HTTPException(409, { message: `A file is already at ${to}` })
  const replaces = !!(await db.document.findFirst({
    where: { ...live, path: { startsWith: `${to}/` } },
  }))
  return { threadId, folder, options, to, replaces }
}

/**
 * Where a design is now: itself while it is there; for an option of an options
 * folder that has been picked from, the design it became, or the trash. Options
 * a teammate cleared by saving the design itself (no pick) lead to that design.
 */
export async function findDesign(db: ScopedDb, path: string): Promise<DesignWhere> {
  const folder = path.replace(/\/+$/, '')
  const here = { path: folder, trashed: false }
  const options = designOptionsOf(folder)
  if (!options) return here
  const live = { kind: 'library' as const, deletedAt: null }
  if (await db.document.findFirst({ where: { ...live, path: `${folder}/${DESIGN_ENTRY}` } }))
    return here
  const to = pickedDesignPath(options)
  const last = await db.auditEntry.findFirst({
    where: { action: 'design.picked', targetId: to },
    orderBy: { at: 'desc' },
  })
  const pick = last?.data as { from?: string; to?: string } | undefined
  // The options folder trashed after the last pick (a pick trashes it before it
  // is recorded): a later round, settled by saving the design itself. The audit
  // outlives the trash.
  const cleared =
    last &&
    (await db.auditEntry.findFirst({
      where: { action: 'library.folder_trashed', targetId: options, at: { gt: last.at } },
      select: { at: true },
    }))
  if (!last || !pick?.to || cleared) {
    const settled = await db.document.findFirst({
      where: { ...live, path: `${to}/${DESIGN_ENTRY}` },
    })
    return settled ? { path: to, trashed: false } : here
  }
  return pick.from === folder ? { path: pick.to, trashed: false } : { ...here, trashed: true }
}

/**
 * The options offered with a design, it included, in the order offered (a, b,
 * c…), each with its title: none when it is not an option. Only those that
 * have a page.
 */
export async function listDesignOptions(
  db: ScopedDb,
  scope: Scope,
  path: string,
): Promise<DesignOption[]> {
  const folder = designFolderOf(path)
  const options = folder && designOptionsOf(folder)
  if (!options) return []
  const rows = await db.document.findMany({
    where: { kind: 'library', deletedAt: null, path: { startsWith: `${options}/` } },
    orderBy: { path: 'asc' },
  })
  const designs = new Map<string, (typeof rows)[number] | null>()
  for (const row of rows) {
    const design = designFolderOf(row.path)
    if (!design || designOptionsOf(design) !== options) continue
    if (row.path === `${design}/${DESIGN_ENTRY}` && !designs.has(design)) designs.set(design, null)
  }
  for (const row of rows) {
    const design = designFolderOf(row.path)
    if (design && designs.has(design) && row.path === `${design}/${DESIGN_MANIFEST}`)
      designs.set(design, row)
  }
  return Promise.all(
    [...designs].map(async ([design, manifest]) => ({
      path: design,
      title: (await readJson(scope, manifest, DesignManifest))?.title ?? null,
    })),
  )
}

/**
 * Make the picked option the design: its files are copied there, over the
 * design it replaces, if any (whose earlier versions the library keeps, and
 * whose files the option lacks go to the trash). The options stay, so the
 * thread still shows each of them and the person can change their mind.
 */
export async function applyPick(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  pick: Awaited<ReturnType<typeof checkPick>>,
) {
  const live = { kind: 'library' as const, deletedAt: null }
  const files = await db.document.findMany({
    where: { ...live, path: { startsWith: `${pick.folder}/` } },
    select: {
      id: true,
      path: true,
      objectKey: true,
      contentType: true,
      size: true,
      sha256: true,
      text: true,
    },
  })
  const copied = new Set<string>()
  for (const file of files) {
    const path = pick.to + file.path.slice(pick.folder.length)
    // Copied inside the bucket, never read here: a design's assets can be large. Saved from the
    // thread, as its teammate's own saves are: the design is not a person's edit that its next
    // save_design would stop at (personEdits).
    const upload = {
      key: fileKey(scope, file),
      size: file.size,
      sha256: file.sha256,
      text: file.text,
    }
    await saveLibraryFile(
      db,
      scope,
      actor,
      { path, upload, contentType: file.contentType },
      { sessionId: pick.threadId },
    )
    copied.add(path)
  }
  if (pick.replaces) {
    const stale = await db.document.findMany({
      where: { ...live, path: { startsWith: `${pick.to}/` } },
      select: { id: true, path: true },
    })
    for (const file of stale.filter((f) => !copied.has(f.path)))
      await trashLibraryFile(db, scope, actor, file.id)
  }
  await audit({
    ...scope,
    actor,
    action: 'design.picked',
    target: { type: 'library_folder', id: pick.to },
    data: { from: pick.folder, to: pick.to, replaced: pick.replaces },
  })
}
