// Skills, from the dashboard: any member sees them and uses them as `/name`;
// owners and admins change them, since they shape what every teammate does.
// Imports read an upload or a GitHub repository into skills to review: their
// files go to the bucket then, the skills only once someone adds them.
import {
  ImportSkillsFromUrl,
  SKILL_PACK_MAX,
  SaveSkill,
  SaveSkillPack,
  UpdateSkillPack,
  UploadRef,
} from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { directUploads, streamObject } from '../bucket.js'
import { installationToken } from '../connectors/github-app.js'
import { workspaceGitHub } from '../git.js'
import { parseBody, requireRole, requireUser, requireWorkspace, type AppEnv } from '../scope.js'
import {
  githubSourceKey,
  parseGitHubUrl,
  readGitHubSkills,
  readSkills,
  readSkillsStream,
} from '../skill-import.js'
import {
  deletePack,
  deleteSkill,
  listPacks,
  listSkills,
  previewImport,
  savePack,
  saveSkill,
  skillCommands,
  toPack,
  toSkills,
  updatePack,
} from '../skills.js'
import { discardUpload, readyUpload, uploadBytesKey } from '../uploads.js'

export const skills = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => c.json(await toSkills(c.var.db, await listSkills(c.var.db, c.var.scope))))

  /** The skills that are on, for the composer's `/name` commands: names and descriptions only. */
  .get('/commands', async (c) => c.json(await skillCommands(c.var.db)))

  .get('/packs', async (c) => c.json((await listPacks(c.var.db)).map(toPack)))

  .post('/', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveSkill)
    const row = await saveSkill(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json((await toSkills(db, [row]))[0], 201)
  })

  /**
   * Read a SKILL.md, .skill or .zip (one skill's folder, or a pack of them) uploaded
   * straight to the bucket (POST /api/uploads, purpose skill_pack): unpacked as it
   * streams back. Nothing is saved but the files, in the bucket.
   */
  .post('/import/upload', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const { uploadId } = await parseBody(c.req.raw, UploadRef)
    const upload = await readyUpload(db, { memberId: scope.memberId }, uploadId, 'skill_pack')
    if (upload.size === 0) throw new HTTPException(400, { message: 'The file is empty' })
    const stream = await streamObject(uploadBytesKey(scope, upload))
    if (!stream) throw new HTTPException(409, { message: 'The upload is gone; upload it again' })
    try {
      const name = upload.name.slice(0, 200)
      const label = name.replace(/\.(md|zip|skill)$/i, '') || 'skills'
      const found = await readSkillsStream(name, stream)
      return c.json(await previewImport(db, scope, `file:${name}`, label, found))
    } finally {
      await discardUpload(scope, upload.id)
    }
  })

  /**
   * The same, the file's bytes as the body, its name in `?name=`. Only without R2
   * (development): with it, the file goes straight to the bucket (/import/upload).
   */
  .post('/import', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    if (directUploads) throw new HTTPException(400, { message: 'Upload to the bucket' })
    if (Number(c.req.header('content-length') ?? 0) > SKILL_PACK_MAX)
      throw new HTTPException(413, { message: 'Skills to import can be up to 50 MB' })
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0) throw new HTTPException(400, { message: 'The file is empty' })
    if (bytes.byteLength > SKILL_PACK_MAX)
      throw new HTTPException(413, { message: 'Skills to import can be up to 50 MB' })
    const name = (c.req.query('name') ?? 'skills').replace(/^.*[\\/]/, '').slice(0, 200)
    const label = name.replace(/\.(md|zip|skill)$/i, '') || 'skills'
    const found = readSkills(name, bytes)
    return c.json(await previewImport(db, scope, `file:${name}`, label, found))
  })

  /** Read a GitHub repository, or a folder of one, the same way. */
  .post('/import/github', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const { url } = await parseBody(c.req.raw, ImportSkillsFromUrl)
    const source = parseGitHubUrl(url)
    if (!source)
      throw new HTTPException(400, {
        message: 'Paste a GitHub address: a repository, or a folder in one',
      })
    const reach = await workspaceGitHub(db, scope, `${source.owner}/${source.repo}`.toLowerCase())
    const token = reach ? await installationToken(reach.installationId) : undefined
    const found = await readGitHubSkills(source, token)
    const label = source.path ? `${source.repo}/${source.path}` : `${source.owner}/${source.repo}`
    return c.json(await previewImport(db, scope, githubSourceKey(source), label, found))
  })

  /** Add an import's skills as a pack, or update the pack from the same source. */
  .post('/packs', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, SaveSkillPack)
    const pack = await savePack(db, scope, { type: 'member', id: scope.memberId }, input)
    return c.json(toPack(pack), 201)
  })

  .put('/packs/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    const input = await parseBody(c.req.raw, UpdateSkillPack)
    const pack = await updatePack(
      db,
      scope,
      { type: 'member', id: scope.memberId },
      c.req.param('id'),
      input,
    )
    return c.json(toPack(pack))
  })

  /** The pack and its skills. */
  .delete('/packs/:id', async (c) => {
    requireRole(c.var.scope, 'owner', 'admin')
    const { scope, db } = c.var
    await deletePack(db, scope, { type: 'member', id: scope.memberId }, c.req.param('id'))
    return c.body(null, 204)
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
