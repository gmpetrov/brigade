// Themes (docs/themes.md): a member's own looks for the dashboard, in one workspace, made by
// talking with a teammate or imported. Each change is kept with the look right after it, so
// going back is returning to one of them; their latest is the look the member wears. Files
// (images, fonts) live in the bucket, and the dashboard loads them from its signed addresses:
// never through the API. Every change tells the member's open windows (theme.changed).
import {
  BUILT_IN_LOOKS,
  THEME_FILE_NAME,
  THEME_ID,
  THEME_LIMITS,
  ThemeFile,
  themeCssProblem,
  themeFilesUsed,
  themeFileName,
  themeFileType,
  themeGuide,
  themeSlug,
  type LookChange,
  type LookChangeKind,
  type ScheduleOperation,
  type ThemeList,
  type ThemeSummary,
  type WornTheme,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { deleteObject, directUploads, presignGet, readHead, themeFileKey } from './bucket.js'
import { prisma, Prisma, type Scope, type ScopedDb } from './db.js'
import { featuresOfMember } from './features.js'
import { shownAccounts } from './thread-spec.js'
import { hubs } from './hub.js'
import {
  copyUpload,
  discardUpload,
  readyUpload,
  uploadBytesKey,
  type UploadOwner,
} from './uploads.js'

type ThemeOperation = Extract<
  ScheduleOperation,
  { name: 'theme_read' | 'theme_set' | 'theme_add_file' | 'theme_undo' }
>

export const isThemeOperation = (op: ScheduleOperation): op is ThemeOperation =>
  op.name === 'theme_read' ||
  op.name === 'theme_set' ||
  op.name === 'theme_add_file' ||
  op.name === 'theme_undo'

/** Who made a change: a teammate, or the member themselves (null). */
export type By = { id: string; name: string } | null

/** The look right after a change: the worn theme's id and file, or the dashboard's own. */
type Look = { slug: string | null; file: ThemeFile | null }

/** How long a theme file's signed address works, and the window it is signed in. */
const FILE_URL_SECONDS = 24 * 3600
const FILE_URL_WINDOW_MS = 12 * 3600_000

const fileOf = (json: unknown): ThemeFile | null => {
  const parsed = ThemeFile.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** The member's latest change, as the look they wear now; seq 0 before any. */
export async function currentLook(db: ScopedDb, memberId: string) {
  const latest = await db.themeChange.findFirst({
    where: { memberId },
    orderBy: { seq: 'desc' },
  })
  return {
    seq: latest?.seq ?? 0,
    look: {
      slug: latest?.wornSlug ?? null,
      file: latest?.wornFile ? fileOf(latest.wornFile) : null,
    } satisfies Look,
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

/**
 * Keep one change with the look right after it, as the member's next; only the last
 * THEME_LIMITS.history stay. Two at once: one takes the next number, the other the one after.
 */
async function record(
  db: ScopedDb,
  memberId: string,
  change: { kind: LookChangeKind; name: string | null; count?: number; by: By; look: Look },
) {
  for (let attempt = 0; ; attempt++) {
    const { seq } = await currentLook(db, memberId)
    try {
      const row = await db.themeChange.create({
        data: {
          memberId,
          seq: seq + 1,
          kind: change.kind,
          name: change.name,
          ...(change.count !== undefined ? { count: change.count } : {}),
          byTeammateId: change.by?.id ?? null,
          byName: change.by?.name ?? null,
          wornSlug: change.look.slug,
          wornFile: change.look.file ?? Prisma.DbNull,
        } as never,
      })
      await db.themeChange.deleteMany({
        where: { memberId, seq: { lte: row.seq - THEME_LIMITS.history } },
      })
      return row.seq
    } catch (error) {
      if (attempt < 4 && isUniqueViolation(error)) continue
      throw error
    }
  }
}

/** Tell the member's open windows in this workspace to load their look again. */
export function themeChanged(scope: Scope, memberId: string) {
  void hubs
    .get(scope.workspaceId)
    .sendToMember(memberId, { type: 'theme.changed' })
    .catch(() => undefined)
}

const summary = (row: {
  slug: string
  name: string
  file: unknown
  updatedAt: Date
  files: { name: string }[]
}): ThemeSummary => ({
  id: row.slug,
  name: row.name,
  hasCss: !!fileOf(row.file)?.css,
  files: row.files.map((f) => f.name),
  updatedAt: row.updatedAt.toISOString(),
})

const toChange = (row: {
  seq: number
  kind: string
  name: string | null
  count: number | null
  byName: string | null
  createdAt: Date
}): LookChange => ({
  seq: row.seq,
  kind: row.kind as LookChangeKind,
  name: row.name,
  ...(row.count !== null ? { count: row.count } : {}),
  at: row.createdAt.toISOString(),
  by: row.byName,
})

/** The member's themes here, the one they wear and their last changes, newest first. */
export async function listThemes(db: ScopedDb, memberId: string): Promise<ThemeList> {
  const [themes, history] = await Promise.all([
    db.theme.findMany({
      where: { memberId },
      orderBy: { updatedAt: 'desc' },
      include: { files: { where: { status: 'ready' }, select: { name: true } } },
    }),
    db.themeChange.findMany({ where: { memberId }, orderBy: { seq: 'desc' } }),
  ])
  return {
    active: history[0]?.wornSlug ?? null,
    themes: themes.map(summary),
    history: history.map(toChange),
  }
}

/** One saved theme, with its files; null when there is none by that id. */
export async function readTheme(db: ScopedDb, memberId: string, slug: string) {
  if (!THEME_ID.test(slug)) return null
  const row = await db.theme.findFirst({
    where: { memberId, slug },
    include: { files: { where: { status: 'ready' }, orderBy: { name: 'asc' } } },
  })
  const file = row && fileOf(row.file)
  if (!row || !file) return null
  return {
    row,
    theme: file,
    files: row.files.map((f) => ({ name: f.name, contentType: f.contentType, size: f.size })),
  }
}

/** Why a theme id cannot be used, or null. */
function idProblem(slug: string) {
  if (!THEME_ID.test(slug))
    return `${JSON.stringify(slug)} cannot be a theme's id: use lowercase letters, digits and dashes.`
  if ((BUILT_IN_LOOKS as readonly string[]).includes(slug))
    return `${slug} is the name of a built-in look, not a saved theme's id.`
  return null
}

/** A theme as given (an object, or its JSON as text), or why it does not fit. */
export function parseTheme(raw: unknown): { theme: ThemeFile } | { error: string } {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {
        error:
          'theme must be the theme as JSON: {"name", "canvas", "accent", "colors", "radius", "font", "css"}.',
      }
    }
  }
  const parsed = ThemeFile.safeParse(value)
  if (!parsed.success)
    return {
      error: `The theme does not fit: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.') || 'theme'}: ${issue.message}`)
        .join('; ')}.`,
    }
  const problem = parsed.data.css ? themeCssProblem(parsed.data.css) : null
  if (problem) return { error: problem }
  return { theme: parsed.data }
}

/**
 * Save a theme (as `slug`, or its name's) and wear it: one change, `made` or `edited`. Whether
 * its stylesheet loads nothing from elsewhere is checked here and in each window.
 */
export async function saveAndWear(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  input: { slug?: string; theme: ThemeFile; by: By; made?: boolean },
) {
  const slug = input.slug || themeSlug(input.theme.name)
  const problem = idProblem(slug) ?? (input.theme.css ? themeCssProblem(input.theme.css) : null)
  if (problem) throw new HTTPException(400, { message: problem })
  const existing = await db.theme.findFirst({ where: { memberId, slug } })
  if (!existing && (await db.theme.count({ where: { memberId } })) >= THEME_LIMITS.themesPerMember)
    throw new HTTPException(409, {
      message: `A person keeps up to ${THEME_LIMITS.themesPerMember} themes: delete one first.`,
    })
  const json = input.theme as unknown as Prisma.InputJsonValue
  if (existing)
    await db.theme.update({
      where: { id: existing.id },
      data: { name: input.theme.name, file: json },
    })
  else
    await db.theme
      .create({ data: { memberId, slug, name: input.theme.name, file: json } as never })
      .catch(async (error: unknown) => {
        // Saved at the same moment by another call: this one updates it.
        if (!isUniqueViolation(error)) throw error
        await db.theme.updateMany({
          where: { memberId, slug },
          data: { name: input.theme.name, file: json },
        })
      })
  const seq = await record(db, memberId, {
    kind: existing && !input.made ? 'edited' : 'made',
    name: input.theme.name,
    by: input.by,
    look: { slug, file: input.theme },
  })
  await auditTheme(scope, memberId, input.by, 'theme.saved', slug)
  themeChanged(scope, memberId)
  const missing = await missingFiles(db, memberId, slug, input.theme)
  return { slug, seq, existed: !!existing, missing }
}

/** Wear a saved theme, or `none` to take any off: one change. */
export async function wear(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  slug: string | null,
  by: By,
) {
  if (slug === null || slug === 'none') {
    const seq = await record(db, memberId, {
      kind: 'off',
      name: null,
      by,
      look: { slug: null, file: null },
    })
    themeChanged(scope, memberId)
    return { seq, name: null as string | null }
  }
  const saved = await readTheme(db, memberId, slug)
  if (!saved)
    throw new HTTPException(404, {
      message: `No saved theme is called ${JSON.stringify(slug)}. Read the themes to list them, or save a new one.`,
    })
  const seq = await record(db, memberId, {
    kind: 'wore',
    name: saved.theme.name,
    by,
    look: { slug, file: saved.theme },
  })
  themeChanged(scope, memberId)
  return { seq, name: saved.theme.name }
}

/** Delete a saved theme and its files; worn, the dashboard's own look comes back. */
export async function deleteTheme(db: ScopedDb, scope: Scope, memberId: string, slug: string) {
  const row = await db.theme.findFirst({ where: { memberId, slug }, include: { files: true } })
  if (!row) throw new HTTPException(404, { message: 'Theme not found' })
  await db.theme.delete({ where: { id: row.id } })
  await Promise.all(row.files.map((f) => removeFileBytes(scope, f.id)))
  const { look } = await currentLook(db, memberId)
  if (look.slug === slug)
    await record(db, memberId, {
      kind: 'deleted',
      name: row.name,
      by: null,
      look: { slug: null, file: null },
    })
  await auditTheme(scope, memberId, null, 'theme.deleted', slug)
  themeChanged(scope, memberId)
}

/**
 * Go back: `steps` changes (default 1), or to the look right after change `seq` (0: before
 * any). The theme it wore is saved again as it was then; its files that are gone are named.
 */
export async function undo(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  input: { steps?: number; seq?: number },
  by: By,
) {
  const history = await db.themeChange.findMany({ where: { memberId }, orderBy: { seq: 'desc' } })
  if (!history.length)
    throw new HTTPException(409, { message: 'There are no look changes to go back on.' })
  const oldest = history[history.length - 1]!
  let target: { seq: number; look: Look }
  let count: number
  if (input.seq !== undefined) {
    if (input.seq === history[0]!.seq)
      throw new HTTPException(409, { message: 'That is how it looks now.' })
    if (input.seq === 0 && oldest.seq === 1) target = { seq: 0, look: { slug: null, file: null } }
    else {
      const found = history.find((h) => h.seq === input.seq)
      if (!found)
        throw new HTTPException(404, {
          message: `No change ${input.seq} among the last ${history.length}. Read the themes for their numbers.`,
        })
      target = { seq: found.seq, look: { slug: found.wornSlug, file: fileOf(found.wornFile) } }
    }
    count = history.filter((h) => h.seq > target.seq).length
  } else {
    const steps = input.steps ?? 1
    // Back past the oldest change kept only when it was the very first: before it, the default.
    const reach = oldest.seq === 1 ? history.length : history.length - 1
    if (!Number.isInteger(steps) || steps < 1 || steps > reach)
      throw new HTTPException(400, {
        message: `steps must be a whole number from 1 to ${reach}.`,
      })
    const at = history[steps]
    target = at
      ? { seq: at.seq, look: { slug: at.wornSlug, file: fileOf(at.wornFile) } }
      : { seq: 0, look: { slug: null, file: null } }
    count = steps
  }
  let missing: string[] = []
  if (target.look.slug && target.look.file) {
    // Worn again as it was then: saved again, should it have changed or gone since.
    const json = target.look.file as unknown as Prisma.InputJsonValue
    const existing = await db.theme.findFirst({ where: { memberId, slug: target.look.slug } })
    if (existing)
      await db.theme.update({
        where: { id: existing.id },
        data: { name: target.look.file.name, file: json },
      })
    else if ((await db.theme.count({ where: { memberId } })) < THEME_LIMITS.themesPerMember)
      await db.theme.create({
        data: {
          memberId,
          slug: target.look.slug,
          name: target.look.file.name,
          file: json,
        } as never,
      })
    missing = await missingFiles(db, memberId, target.look.slug, target.look.file)
  }
  const seq = await record(db, memberId, {
    kind: 'undid',
    name: target.look.file?.name ?? null,
    count,
    by,
    look: target.look.slug && target.look.file ? target.look : { slug: null, file: null },
  })
  themeChanged(scope, memberId)
  return { seq, count, name: target.look.file?.name ?? null, missing }
}

/** The files a theme's stylesheet names that it does not have. */
async function missingFiles(db: ScopedDb, memberId: string, slug: string, theme: ThemeFile) {
  const used = theme.css ? themeFilesUsed(theme.css) : []
  if (!used.length) return []
  const row = await db.theme.findFirst({
    where: { memberId, slug },
    include: { files: { where: { status: 'ready' }, select: { name: true } } },
  })
  const have = new Set(row?.files.map((f) => f.name) ?? [])
  return used.filter((name) => !have.has(name))
}

/** Leading bytes of each kind of theme file: a file must be what its name says. */
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => ascii(b, 0, 4) === 'GIF8',
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
  'image/avif': (b) => ascii(b, 4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(b, 8, 12)),
  'font/woff': (b) => ascii(b, 0, 4) === 'wOFF',
  'font/woff2': (b) => ascii(b, 0, 4) === 'wOF2',
  'font/ttf': (b) =>
    (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || ascii(b, 0, 4) === 'true',
  'font/otf': (b) => ascii(b, 0, 4) === 'OTTO',
}
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to))

/** Whether these leading bytes are a file of this type. */
export const themeFileMatches = (contentType: string, head: Uint8Array) =>
  !!MAGIC[contentType]?.(head)

/** Why a name cannot be a theme file's, or its type. */
function fileType(name: string): string {
  const contentType = THEME_FILE_NAME.test(name) ? themeFileType(name) : undefined
  if (!contentType)
    throw new HTTPException(400, {
      message:
        'A theme file is an image (png, jpg, webp, gif, avif) or a font (woff2, woff, ttf, otf), named in lowercase letters, digits, - and _. No SVG.',
    })
  return contentType
}

type CheckedUpload = Awaited<ReturnType<typeof readyUpload>> & { name: string; type: string }

/** A finished upload, checked to be the image or font `name` says: nothing changes yet. */
async function checkUpload(
  db: ScopedDb,
  scope: Scope,
  owner: UploadOwner,
  name: string,
  uploadId: string,
): Promise<CheckedUpload> {
  const type = fileType(name)
  // Only the owner's: an upload of anyone else's is not found, and left alone.
  const upload = await readyUpload(db, owner, uploadId, 'theme_file')
  try {
    if (upload.size > THEME_LIMITS.fileBytes)
      throw new HTTPException(413, {
        message: `A theme file is up to ${THEME_LIMITS.fileBytes / 1024 / 1024} MB.`,
      })
    const head = await readHead(uploadBytesKey(scope, upload), 64)
    if (!head) throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
    if (!themeFileMatches(type, head))
      throw new HTTPException(400, {
        message: `${name} is not a ${name.split('.').pop()} ${type.startsWith('font/') ? 'font' : 'image'}: its bytes say otherwise.`,
      })
  } catch (error) {
    await discardUpload(scope, upload.id)
    throw error
  }
  return { ...upload, name, type }
}

/** Tests only: runs once a store's files are copied, before they are published. */
let beforePublish: (() => Promise<void>) | undefined
export const onThemeFilesPublish = (hook: (() => Promise<void>) | undefined) => {
  beforePublish = hook
}

/**
 * Checked uploads into a theme, all or none: each is copied to a file of its own, pending and
 * so unseen; once all are in, they are ready and the files they replace go. A failure on the
 * way removes what was copied, and the theme's files stay as they were.
 */
async function storeFiles(db: ScopedDb, scope: Scope, themeId: string, uploads: CheckedUpload[]) {
  const staged: { id: string; name: string }[] = []
  try {
    for (const upload of uploads) {
      const row = await db.themeAsset.create({
        data: { themeId, name: upload.name, contentType: upload.type, size: upload.size } as never,
      })
      staged.push({ id: row.id, name: upload.name })
      await copyUpload(scope, upload, themeFileKey(scope, row.id), upload.type)
    }
  } catch (error) {
    for (const row of staged) {
      await db.themeAsset.delete({ where: { id: row.id } }).catch(() => undefined)
      await removeFileBytes(scope, row.id)
    }
    throw error
  }
  const names = staged.map((r) => r.name)
  const stagedIds = staged.map((r) => r.id)
  await beforePublish?.()
  // One publication at a time per theme, under its row's lock: each replaces only the files
  // ready before it, never another's still on its way, so two at once leave the later one's.
  const replaced = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "Theme" WHERE id = ${themeId} AND "workspaceId" = ${scope.workspaceId}
      FOR UPDATE`
    const old = await tx.themeAsset.findMany({
      where: {
        themeId,
        workspaceId: scope.workspaceId,
        name: { in: names },
        status: 'ready',
        id: { notIn: stagedIds },
      },
      select: { id: true, name: true },
    })
    await tx.themeAsset.updateMany({
      where: { id: { in: stagedIds }, workspaceId: scope.workspaceId },
      data: { status: 'ready' },
    })
    if (old.length) await tx.themeAsset.deleteMany({ where: { id: { in: old.map((o) => o.id) } } })
    return old
  })
  // Once nothing refers to them any more.
  for (const old of replaced) await removeFileBytes(scope, old.id)
  return replaced.map((r) => r.name)
}

/** Whether `names` would take a theme past its number of files. */
function tooManyFiles(have: { name: string }[], names: string[]) {
  const all = new Set([...have.map((f) => f.name), ...names])
  if (all.size > THEME_LIMITS.filesPerTheme)
    throw new HTTPException(409, {
      message: `A theme has up to ${THEME_LIMITS.filesPerTheme} files: remove one from its css and start a new theme, or replace one by its name.`,
    })
}

/**
 * A finished upload into a saved theme, as `name`: its bytes checked to be the image or font
 * its name says, then copied to the theme's files. One of the same name is replaced.
 */
export async function addFile(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  input: { slug: string; name: string; uploadId: string; owner: UploadOwner },
) {
  const theme = await db.theme.findFirst({
    where: { memberId, slug: input.slug },
    include: { files: { where: { status: 'ready' } } },
  })
  if (!theme)
    throw new HTTPException(404, {
      message: `No saved theme is called ${JSON.stringify(input.slug)}: save it with theme_set first.`,
    })
  fileType(input.name)
  tooManyFiles(theme.files, [input.name])
  const upload = await checkUpload(db, scope, input.owner, input.name, input.uploadId)
  try {
    const replaced = await storeFiles(db, scope, theme.id, [upload])
    // A theme worn with this file shows it now.
    const { look } = await currentLook(db, memberId)
    if (look.slug === input.slug) themeChanged(scope, memberId)
    return {
      name: input.name,
      contentType: upload.type,
      size: upload.size,
      replaced: replaced.length > 0,
    }
  } finally {
    await discardUpload(scope, upload.id)
  }
}

/**
 * An exported theme brought back with its files, all or nothing: the theme and every file are
 * checked before anything changes, the files stored before the theme is saved and worn. A theme
 * it would replace keeps its look and files when any of it is refused.
 */
export async function importTheme(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  input: { slug?: string; theme: ThemeFile; files: Record<string, string> },
) {
  const slug = input.slug || themeSlug(input.theme.name)
  const problem = idProblem(slug) ?? (input.theme.css ? themeCssProblem(input.theme.css) : null)
  const owner = { memberId }
  const uploads: CheckedUpload[] = []
  try {
    if (problem) throw new HTTPException(400, { message: problem })
    const existing = await db.theme.findFirst({
      where: { memberId, slug },
      include: { files: { where: { status: 'ready' } } },
    })
    if (
      !existing &&
      (await db.theme.count({ where: { memberId } })) >= THEME_LIMITS.themesPerMember
    )
      throw new HTTPException(409, {
        message: `A person keeps up to ${THEME_LIMITS.themesPerMember} themes: delete one first.`,
      })
    tooManyFiles(existing?.files ?? [], Object.keys(input.files))
    for (const [name, uploadId] of Object.entries(input.files))
      uploads.push(await checkUpload(db, scope, owner, name, uploadId))
    // A new theme's row first, for its files; it goes again if they cannot be stored.
    const theme =
      existing ??
      (await db.theme.create({
        data: {
          memberId,
          slug,
          name: input.theme.name,
          file: input.theme as unknown as Prisma.InputJsonValue,
        } as never,
      }))
    try {
      await storeFiles(db, scope, theme.id, uploads)
    } catch (error) {
      if (!existing) await db.theme.delete({ where: { id: theme.id } }).catch(() => undefined)
      throw error
    }
    return await saveAndWear(db, scope, memberId, {
      slug,
      theme: input.theme,
      by: null,
      made: !existing,
    })
  } finally {
    for (const upload of uploads) await discardUpload(scope, upload.id).catch(() => undefined)
  }
}

/** A member leaving: their themes here go, with their files in the bucket. */
export async function removeMemberThemes(db: ScopedDb, scope: Scope, memberId: string) {
  const files = await db.themeAsset.findMany({
    where: { theme: { memberId } },
    select: { id: true },
  })
  await db.theme.deleteMany({ where: { memberId } })
  await Promise.all(files.map((f) => removeFileBytes(scope, f.id)))
}

const removeFileBytes = (scope: Scope, id: string) =>
  deleteObject(themeFileKey(scope, id)).catch((error: unknown) =>
    console.warn(`theme file ${id}: bytes not deleted: ${String(error)}`),
  )

/**
 * The look the member wears, with each of its files' signed address in the bucket. Signed
 * from the start of a window of FILE_URL_WINDOW_MS, an address stays the same through it, so
 * the browser keeps the file in its cache; each works at least FILE_URL_WINDOW_MS more.
 * Without R2 (development), the API's own address of each file.
 */
export async function wornTheme(db: ScopedDb, scope: Scope, memberId: string): Promise<WornTheme> {
  const { look } = await currentLook(db, memberId)
  if (!look.slug || !look.file) return null
  const row = await db.theme.findFirst({
    where: { memberId, slug: look.slug },
    include: { files: { where: { status: 'ready' } } },
  })
  const now = Date.now()
  const signedAt = new Date(now - (now % FILE_URL_WINDOW_MS))
  const expires = new Date(signedAt.getTime() + FILE_URL_SECONDS * 1000)
  const files: Record<string, string> = {}
  for (const file of row?.files ?? [])
    files[file.name] = directUploads
      ? (
          await presignGet(
            themeFileKey(scope, file.id),
            { contentType: file.contentType, disposition: 'inline' },
            FILE_URL_SECONDS,
            signedAt,
          )
        ).url
      : `/api/themes/files/${file.id}`
  return { id: look.slug, theme: look.file, files, expires: expires.toISOString() }
}

/** A theme file's row, for the API's own address of it (development, without R2). */
export async function themeFileRow(db: ScopedDb, memberId: string, id: string) {
  return db.themeAsset.findFirst({ where: { id, status: 'ready', theme: { memberId } } })
}

/** Every saved theme's files, for an export: their signed addresses, by name. */
export async function themeFileUrls(db: ScopedDb, scope: Scope, memberId: string, slug: string) {
  const saved = await readTheme(db, memberId, slug)
  if (!saved) throw new HTTPException(404, { message: 'Theme not found' })
  const files: Record<string, string> = {}
  for (const file of saved.row.files)
    files[file.name] = directUploads
      ? (
          await presignGet(themeFileKey(scope, file.id), {
            contentType: file.contentType,
            disposition: 'inline',
          })
        ).url
      : `/api/themes/files/${file.id}`
  return { id: slug, theme: saved.theme, files }
}

const auditTheme = (scope: Scope, memberId: string, by: By, action: string, slug: string) =>
  audit({
    ...scope,
    actor: (by ? { type: 'teammate', id: by.id } : { type: 'member', id: memberId }) as Actor,
    action,
    target: { type: 'member', id: memberId },
    data: { theme: slug },
  })

// --- A teammate's theme tools -----------------------------------------------------------------

type Session = {
  id: string
  origin: string
  startedByMemberId: string
  computerId: string
  playbookRunId?: string | null
}

const SEVERAL_PEOPLE =
  "Several people ask in this thread, and a theme is the starter's own look: a person restyles their dashboard with you in a thread of their own."

const ONLY_A_PERSON =
  'Themes are changed only in a thread a person started: the theme is theirs. Here, just do the work.'

/** What happened, in a few words, as the card and the teammate read it. */
function said(change: { kind: string; name: string | null; count?: number | null }) {
  switch (change.kind) {
    case 'made':
      return `made ${change.name} and wore it`
    case 'edited':
      return `edited ${change.name}`
    case 'wore':
      return `wore ${change.name}`
    case 'off':
      return 'took the theme off'
    case 'deleted':
      return `deleted ${change.name} while wearing it`
    case 'undid':
      return `went back ${change.count === 1 ? '1 change' : `${change.count} changes`}`
    default:
      return change.kind
  }
}

/**
 * A teammate's theme tools (docs/themes.md), for the person who started the thread: only in a
 * thread a person started, never a playbook's, and only while they have the themes feature.
 */
export async function handleThemeCall(
  db: ScopedDb,
  scope: Scope,
  session: Session,
  teammate: { id: string; name: string },
  op: ThemeOperation,
): Promise<object | { error: string }> {
  if (session.origin !== 'member' || session.playbookRunId) return { error: ONLY_A_PERSON }
  // The starter's look, changed only while they alone ask here: once another member asks in the
  // thread, their words could otherwise restyle (or hide controls in) the starter's dashboard.
  const { person } = await shownAccounts(db, session)
  if (person !== session.startedByMemberId) return { error: SEVERAL_PEOPLE }
  const memberId = session.startedByMemberId
  if (!(await featuresOfMember(memberId, scope.workspaceId)).has('themes'))
    return { error: 'Themes are not open to this person yet.' }
  const by = { id: teammate.id, name: teammate.name }
  try {
    if (op.name === 'theme_read') {
      const list = await listThemes(db, memberId)
      const { look } = await currentLook(db, memberId)
      const asked = op.id ? await readTheme(db, memberId, op.id) : null
      if (op.id && !asked) return { error: `No saved theme is called ${JSON.stringify(op.id)}.` }
      return {
        current: look.slug ? { id: look.slug, theme: look.file } : "none: the dashboard's own look",
        saved: list.themes.map((t) => ({ id: t.id, name: t.name, files: t.files })),
        history: list.history.map((h) => ({
          seq: h.seq,
          what: said(h),
          at: h.at,
          by: h.by ?? 'the person',
        })),
        ...(asked ? { theme: { id: op.id, ...asked.theme, files: asked.files } } : {}),
        guide: themeGuide(),
      }
    }

    if (op.name === 'theme_set') {
      const id = op.id?.trim() || undefined
      if (op.theme !== undefined && op.theme !== null) {
        const parsed = parseTheme(op.theme)
        if ('error' in parsed) return { error: `Nothing changed. ${parsed.error}` }
        const saved = await saveAndWear(db, scope, memberId, {
          ...(id ? { slug: id } : {}),
          theme: parsed.theme,
          by,
        })
        return {
          seq: saved.seq,
          member: memberId,
          id: saved.slug,
          text:
            `${saved.existed ? 'Updated' : 'Saved'} the theme ${parsed.theme.name} (${saved.slug}): the person's windows wear it now. Ask them how it looks.` +
            (saved.missing.length
              ? ` Its css names files it does not have yet: ${saved.missing.join(', ')}. Add them with theme_add_file.`
              : ''),
        }
      }
      if (!id)
        return { error: 'Give theme (to save and wear it), or id (a saved theme, or "none").' }
      const worn = await wear(db, scope, memberId, id === 'none' ? null : id, by)
      return {
        seq: worn.seq,
        member: memberId,
        text: worn.name
          ? `The person's windows wear ${worn.name} now.`
          : "The theme is off: the person's windows show the dashboard's own look.",
      }
    }

    if (op.name === 'theme_add_file') {
      if (!op.upload) return { error: 'The file did not reach Brigade: try again.' }
      const base = op.path.split(/[\\/]/).pop() ?? op.path
      const name = themeFileName(base)
      if (!name)
        return {
          error:
            'A theme file is an image (png, jpg, webp, gif, avif) or a font (woff2, woff, ttf, otf). No SVG: inline one as a data: address.',
        }
      const added = await addFile(db, scope, memberId, {
        slug: op.id,
        name,
        uploadId: op.upload.id,
        owner: { computerId: session.computerId, sessionId: session.id },
      })
      return {
        text: `${added.replaced ? 'Replaced' : 'Added'} ${added.name}. In the theme's css write url("theme:${added.name}"), then call theme_set with the theme to use it.`,
      }
    }

    // theme_undo
    const back = await undo(
      db,
      scope,
      memberId,
      {
        ...(op.steps !== undefined ? { steps: op.steps } : {}),
        ...(op.seq !== undefined ? { seq: op.seq } : {}),
      },
      by,
    )
    return {
      seq: back.seq,
      member: memberId,
      text:
        `Went back ${back.count === 1 ? '1 change' : `${back.count} changes`}: the person's windows ` +
        (back.name ? `wear ${back.name} as it was then.` : "show the dashboard's own look.") +
        (back.missing.length ? ` Files no longer there: ${back.missing.join(', ')}.` : ''),
    }
  } catch (error) {
    if (error instanceof HTTPException) return { error: error.message }
    throw error
  }
}
