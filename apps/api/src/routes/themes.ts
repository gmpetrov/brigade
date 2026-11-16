// Themes (docs/themes.md), from the dashboard, behind the `themes` feature: the member's own
// looks in this workspace. A teammate makes them (src/themes.ts); here the member wears one,
// takes it off, goes back, deletes, exports and imports.
//   GET    /api/themes              their themes, the one they wear, their last changes
//   GET    /api/themes/active       the worn theme, with its files' signed addresses
//   PUT    /api/themes/active       { id | null }  wear one, or the dashboard's own look
//   POST   /api/themes/undo         { steps } | { seq }
//   POST   /api/themes/import       { id?, theme, files?: { name: uploadId } }
//   GET    /api/themes/:id          one theme with its files' signed addresses, to export it
//   DELETE /api/themes/:id
//   GET    /api/themes/files/:file  a file through the API, only without R2 (development)
import { ImportTheme, THEME_ID, UndoLook, WearTheme } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { directUploads, presignGet, themeFileKey } from '../bucket.js'
import { featuresOfUser, requireFeature } from '../features.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { serveObject } from '../serve-object.js'
import {
  addFile,
  deleteTheme,
  listThemes,
  parseTheme,
  saveAndWear,
  themeChanged,
  themeFileRow,
  themeFileUrls,
  undo,
  wear,
  wornTheme,
} from '../themes.js'

const themeId = (value: string) => {
  if (!THEME_ID.test(value)) throw new HTTPException(404, { message: 'Theme not found' })
  return value
}

export const themeRoutes = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)
  .use(async (c, next) => {
    requireFeature(await featuresOfUser(c.var.scope.userId, c.var.scope.workspaceId), 'themes')
    await next()
  })

  .get('/', async (c) => c.json(await listThemes(c.var.db, c.var.scope.memberId)))

  .get('/active', async (c) => {
    c.header('cache-control', 'private, no-store')
    return c.json(await wornTheme(c.var.db, c.var.scope, c.var.scope.memberId))
  })

  .put('/active', async (c) => {
    const { id } = await parseBody(c.req.raw, WearTheme)
    const worn = await wear(c.var.db, c.var.scope, c.var.scope.memberId, id, null)
    return c.json(worn)
  })

  .post('/undo', async (c) => {
    const input = await parseBody(c.req.raw, UndoLook)
    const back = await undo(
      c.var.db,
      c.var.scope,
      c.var.scope.memberId,
      {
        ...(input.steps !== undefined ? { steps: input.steps } : {}),
        ...(input.seq !== undefined ? { seq: input.seq } : {}),
      },
      null,
    )
    return c.json(back)
  })

  // An exported theme brought back: its stylesheet checked as a teammate's is, its files each
  // checked to be the image or font its name says. Saved, then worn.
  .post('/import', async (c) => {
    const { db, scope } = c.var
    const input = await parseBody(c.req.raw, ImportTheme)
    const parsed = parseTheme(input.theme)
    if ('error' in parsed) throw new HTTPException(400, { message: parsed.error })
    const saved = await saveAndWear(db, scope, scope.memberId, {
      ...(input.id ? { slug: input.id } : {}),
      theme: parsed.theme,
      by: null,
    })
    for (const [name, uploadId] of Object.entries(input.files ?? {}))
      await addFile(db, scope, scope.memberId, {
        slug: saved.slug,
        name,
        uploadId,
        owner: { memberId: scope.memberId },
      })
    themeChanged(scope, scope.memberId)
    return c.json({ id: saved.slug, seq: saved.seq }, 201)
  })

  // Without R2 (development) the API serves a theme's files itself; with it, the bucket does.
  .get('/files/:file', async (c) => {
    const row = await themeFileRow(c.var.db, c.var.scope.memberId, c.req.param('file'))
    if (!row) throw new HTTPException(404, { message: 'File not found' })
    const key = themeFileKey(c.var.scope, row.id)
    if (directUploads) {
      const signed = await presignGet(key, { contentType: row.contentType, disposition: 'inline' })
      c.header('cache-control', `private, max-age=${signed.seconds - 60}`)
      return c.redirect(signed.url, 302)
    }
    return serveObject(c, key, {
      'content-type': row.contentType,
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
      'access-control-allow-origin': '*',
      'cache-control': 'private, max-age=3600',
    })
  })

  .get('/:id', async (c) =>
    c.json(
      await themeFileUrls(c.var.db, c.var.scope, c.var.scope.memberId, themeId(c.req.param('id'))),
    ),
  )

  .delete('/:id', async (c) => {
    await deleteTheme(c.var.db, c.var.scope, c.var.scope.memberId, themeId(c.req.param('id')))
    return c.body(null, 204)
  })
