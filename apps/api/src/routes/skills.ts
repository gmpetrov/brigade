// Skills, from the dashboard: any member sees them and uses them as `/name`;
// owners and admins change them, since they shape what every teammate does.
import { SaveSkill } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import { importSkill } from '../skill-import.js'
import { deleteSkill, listSkills, saveSkill, toSkills } from '../skills.js'

/** The largest upload to import: a skill folder zipped. */
const IMPORT_MAX = 5 * 1024 * 1024

export const skills = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await toSkills(c.var.db, await listSkills(c.var.db))))

  .post('/', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveSkill)
    const row = await saveSkill(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json((await toSkills(db, [row]))[0], 201)
  })

  /**
   * Read an uploaded SKILL.md, .zip or .skill (the file's bytes as the body,
   * its name in `?name=`) into a skill to review. Nothing is saved.
   */
  .post('/import', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0) throw new HTTPException(400, { message: 'The file is empty' })
    if (bytes.byteLength > IMPORT_MAX)
      throw new HTTPException(413, { message: 'Skills to import can be up to 5 MB' })
    return c.json(importSkill(c.req.query('name') ?? '', bytes))
  })

  .put('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveSkill)
    const row = await saveSkill(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      input,
      c.req.param('id'),
    )
    return c.json((await toSkills(db, [row]))[0])
  })

  .delete('/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    await deleteSkill(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
  })
