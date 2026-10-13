// Design systems, from the dashboard: any member sees them, owners and admins
// change them (they shape what every teammate makes). And a design's address
// on the sandbox origin, for the viewer.
import {
  DesignEdit,
  LibraryPath,
  OpenDesignView,
  SaveDesignSystem,
  SaveDesignThumbnail,
  SaveKnobs,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  deleteDesignSystem,
  designZip,
  editDesign,
  listDesignSystems,
  openDesignView,
  saveDesignSystem,
  saveDesignThumbnail,
  saveKnobs,
  toDesignSystem,
} from '../designs.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const designSystems = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json((await listDesignSystems(c.var.db)).map(toDesignSystem)))

  .post('/', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveDesignSystem)
    const row = await saveDesignSystem(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json(toDesignSystem(row), 201)
  })

  .put('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveDesignSystem)
    const row = await saveDesignSystem(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      input,
      c.req.param('id'),
    )
    return c.json(toDesignSystem(row))
  })

  /** Forgets the row; its library folder stays. */
  .delete('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    await deleteDesignSystem(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
  })

export const designs = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  /** A design's page on the sandbox origin, good for a few hours. */
  .post('/view', async (c) => {
    const { scope, db } = c.var
    const { path } = await parseBody(c.req.raw, OpenDesignView)
    return c.json(await openDesignView(db, scope, path))
  })

  /** The values chosen in the viewer, saved into the design's knobs.json. */
  .put('/knobs', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveKnobs)
    const knobs = await saveKnobs(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json({ knobs })
  })

  /** A person's changes to a page, made on the canvas: a new version of it. */
  .patch('/edit', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, DesignEdit)
    return c.json(await editDesign(db, scope, { type: 'member', id: scope.memberId }, input))
  })

  /** The canvas's picture of the design after a person's edits, for the gallery. */
  .put('/thumbnail', async (c) => {
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveDesignThumbnail)
    await saveDesignThumbnail(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.body(null, 204)
  })

  /** The design as a zip, to open without Brigade. `?path=` its folder. */
  .get('/zip', async (c) => {
    const path = LibraryPath.safeParse(c.req.query('path') ?? '')
    if (!path.success) throw new HTTPException(400, { message: 'Name a design' })
    const { name, bytes } = await designZip(c.var.db, c.var.scope, path.data)
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-cache',
    })
  })
