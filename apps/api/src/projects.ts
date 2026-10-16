// Projects: a line of work inside a workspace (docs/projects.md). Threads,
// tasks, schedules and triggers carry a projectId; a project owns a library
// folder and links repositories by name. Everything else is reached through
// those. Organizing and context only: no permissions, no caps.
import { randomUUID } from 'node:crypto'
import {
  PreviewRecipe,
  PROJECT_LOGO_MAX,
  PROJECT_LOGO_TYPES,
  projectFolder,
  type ProjectCatalogEntry,
  type ProjectSummary,
  type ThreadProject,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit, type Actor } from './audit.js'
import { deleteObject, getObject, projectLogoKey, putObject } from './bucket.js'
import { projectWorkingSeconds } from './caps.js'
import { prisma, type ScopedDb } from './db.js'
import { workspaceRepositories } from './git.js'
import { broadcastProjects } from './hub.js'
import { createFolder } from './library-folders.js'
import { readMemory } from './library.js'
import { imageType } from './project-sites.js'
import type { WorkspaceScope } from './scope.js'

const SUMMARY = { id: true, name: true, icon: true, logo: true, archivedAt: true } as const

const summary = (p: {
  id: string
  name: string
  icon: string | null
  logo: string | null
  archivedAt: Date | null
}) =>
  ({
    id: p.id,
    name: p.name,
    icon: p.icon,
    logo: p.logo,
    archivedAt: p.archivedAt?.toISOString() ?? null,
  }) satisfies ProjectSummary

// ---------------------------------------------------------------------------
// Logos
// ---------------------------------------------------------------------------

const LOGO_EXTENSIONS: Record<(typeof PROJECT_LOGO_TYPES)[number], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
}

/**
 * Keep a logo the dashboard sent as a data URL: its bytes decide its type,
 * whatever the URL says. Returns what the project's `logo` holds.
 */
async function storeLogo(scope: WorkspaceScope, projectId: string, dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (bytes.byteLength > PROJECT_LOGO_MAX)
    throw new HTTPException(413, { message: 'A logo can be up to 256 KB' })
  const type = imageType(bytes) as keyof typeof LOGO_EXTENSIONS | null
  if (!type || !(type in LOGO_EXTENSIONS))
    throw new HTTPException(400, { message: 'A logo is a PNG, JPEG, GIF, WebP, ICO or SVG image' })
  await putObject(projectLogoKey(scope, projectId), bytes, type)
  return `${randomUUID().slice(0, 8)}.${LOGO_EXTENSIONS[type]}`
}

const removeLogo = (scope: WorkspaceScope, projectId: string) =>
  deleteObject(projectLogoKey(scope, projectId)).catch((error: unknown) =>
    console.warn(`project ${projectId}: logo not deleted: ${String(error)}`),
  )

/** A project's logo, for the dashboard to show. Any member may see it. */
export async function projectLogo(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const project = await db.project.findFirst({ where: { id }, select: { logo: true } })
  if (!project?.logo) throw new HTTPException(404, { message: 'No logo' })
  const extension = project.logo.split('.').pop()
  const type = Object.entries(LOGO_EXTENSIONS).find(([, e]) => e === extension)?.[0]
  const bytes = await getObject(projectLogoKey(scope, id))
  if (!bytes || !type) throw new HTTPException(404, { message: 'No logo' })
  return { bytes, type }
}

const byMember = (scope: WorkspaceScope): Actor => ({ type: 'member', id: scope.memberId })

/**
 * `?project=` on a list: a project's id, or "none" for what is in no project.
 * Unset: everything.
 */
export function projectWhere(value: string | undefined): { projectId?: string | null } {
  if (!value) return {}
  return { projectId: value === 'none' ? null : value }
}

/**
 * A project something new may go in: it must exist and not be archived.
 * Null and undefined pass through (no project, or not given).
 */
export async function usableProject(db: ScopedDb, projectId: string | null | undefined) {
  if (!projectId) return projectId
  const project = await db.project.findFirst({ where: { id: projectId }, select: SUMMARY })
  if (!project) throw new HTTPException(404, { message: 'Project not found' })
  if (project.archivedAt)
    throw new HTTPException(409, { message: `${project.name} is archived. Unarchive it first.` })
  return project.id
}

/** Every project; with `repository`, those that link it. */
export async function listProjects(db: ScopedDb, repository?: string) {
  const rows = await db.project.findMany({
    where: repository ? { repositories: { some: { repository: repository.toLowerCase() } } } : {},
    select: SUMMARY,
    orderBy: { name: 'asc' },
  })
  return rows.map(summary)
}

/** A project with its repositories, each with its saved preview, and what fills its overview. */
export async function getProject(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const project = await db.project.findFirst({
    where: { id },
    include: { repositories: { orderBy: { repository: 'asc' } } },
  })
  if (!project) throw new HTTPException(404, { message: 'Project not found' })
  const names = project.repositories.map((r) => r.repository)
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000)
  const [reachable, recipes, memory, files, connections, threadsThisWeek, merged, seconds] =
    await Promise.all([
      // Null when GitHub could not be asked: then nothing is marked unreachable.
      names.length
        ? workspaceRepositories(db, scope)
            .then((list) => new Set(list.map((r) => r.repository)))
            .catch(() => null)
        : Promise.resolve(null),
      db.previewRecipe.findMany({ where: { repository: { in: names } } }),
      readMemory(db, { kind: 'project_memory', projectId: project.id }),
      project.folder
        ? db.document.count({
            where: { kind: 'library', deletedAt: null, path: { startsWith: `${project.folder}/` } },
          })
        : Promise.resolve(0),
      db.connection.findMany({
        where: { id: { in: project.preferredConnectionIds }, status: { not: 'removed' } },
        select: { id: true, label: true, kind: true },
      }),
      db.session.count({ where: { projectId: project.id, createdAt: { gte: weekAgo } } }),
      db.pullRequest.count({
        where: {
          state: 'merged',
          updatedAt: { gte: weekAgo },
          OR: [{ repository: { in: names } }, { session: { projectId: project.id } }],
        },
      }),
      projectWorkingSeconds(db, project.id, weekAgo),
    ])
  return {
    ...summary(project),
    brief: project.brief,
    url: project.url,
    folder: project.folder,
    preferredConnections: connections,
    repositories: project.repositories.map(({ repository }) => {
      const row = recipes.find((r) => r.repository === repository)
      const recipe = row ? PreviewRecipe.safeParse(row.recipe) : null
      return {
        repository,
        reachable: reachable ? reachable.has(repository) : null,
        preview: recipe?.success
          ? { command: recipe.data.command, cwd: recipe.data.cwd || null, port: recipe.data.port }
          : null,
      }
    }),
    memory: memory
      ? {
          documentId: memory.id,
          lines: memory.text.split('\n').filter((l) => /^\s*[-*+]\s/.test(l)).length,
        }
      : null,
    files,
    week: { threads: threadsThisWeek, merged, workingHours: Math.round(seconds / 360) / 10 },
  }
}

export type ProjectDetail = Awaited<ReturnType<typeof getProject>>

/** Only repositories the workspace's GitHub connections reach may be linked. */
async function checkRepositories(db: ScopedDb, scope: WorkspaceScope, repositories: string[]) {
  if (repositories.length === 0) return []
  const reached = await workspaceRepositories(db, scope).catch(() => {
    throw new HTTPException(502, { message: 'GitHub did not answer. Try again.' })
  })
  const known = new Set(reached.map((r) => r.repository))
  const unknown = repositories.filter((r) => !known.has(r))
  if (unknown.length)
    throw new HTTPException(400, {
      message: `No GitHub connection reaches ${unknown.join(', ')}`,
    })
  return [...new Set(repositories)]
}

const nameTaken = (error: unknown) =>
  (error as { code?: string }).code === 'P2002'
    ? new HTTPException(409, { message: 'A project already has that name' })
    : error

export async function createProject(
  db: ScopedDb,
  scope: WorkspaceScope,
  input: {
    name: string
    icon?: string | null
    brief: string
    url?: string | null
    logo?: string | null
    folder?: string | null
    repositories: string[]
  },
) {
  const repositories = await checkRepositories(db, scope, input.repositories)
  const folder = input.folder ?? projectFolder(input.name)
  const project = await db.project
    .create({
      data: {
        name: input.name,
        icon: input.icon ?? null,
        brief: input.brief,
        url: input.url ?? null,
        folder,
      } as never,
    })
    .catch((error: unknown) => {
      throw nameTaken(error)
    })
  // A logo that will not keep leaves the project with its letter, not unmade.
  if (input.logo) {
    const logo = await storeLogo(scope, project.id, input.logo).catch((error: unknown) => {
      console.warn(`project ${project.id}: logo not kept: ${String(error)}`)
      return null
    })
    if (logo)
      project.logo = (await db.project.update({ where: { id: project.id }, data: { logo } })).logo
  }
  if (repositories.length)
    await db.projectRepository.createMany({
      data: repositories.map((repository) => ({ projectId: project.id, repository })) as never,
    })
  // Its folder shows in the library, empty, until files go in. A file at that path keeps it unmade.
  await createFolder(db, scope, byMember(scope), folder).catch(() => undefined)
  await audit({
    ...scope,
    actor: byMember(scope),
    action: 'project.created',
    target: { type: 'project', id: project.id },
    data: { name: project.name, folder, repositories },
  })
  broadcastProjects(scope.workspaceId)
  return summary(project)
}

export async function updateProject(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: {
    name?: string
    icon?: string | null
    brief?: string
    url?: string | null
    logo?: string | null
    folder?: string | null
    preferredConnectionIds?: string[]
  },
) {
  const project = await db.project.findFirst({ where: { id } })
  if (!project) throw new HTTPException(404, { message: 'Project not found' })
  // A new logo replaces the old one's bytes; null takes it away.
  const logo =
    input.logo === undefined
      ? undefined
      : input.logo === null
        ? null
        : await storeLogo(scope, id, input.logo)
  if (logo === null && project.logo) await removeLogo(scope, id)
  if (input.preferredConnectionIds) {
    const found = await db.connection.count({
      where: { id: { in: input.preferredConnectionIds }, status: { not: 'removed' } },
    })
    if (found !== new Set(input.preferredConnectionIds).size)
      throw new HTTPException(404, { message: 'Connection not found' })
  }
  const updated = await db.project
    .update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.brief !== undefined && { brief: input.brief }),
        ...(input.url !== undefined && { url: input.url }),
        ...(logo !== undefined && { logo }),
        ...(input.folder !== undefined && { folder: input.folder }),
        ...(input.preferredConnectionIds && {
          preferredConnectionIds: [...new Set(input.preferredConnectionIds)],
        }),
      },
    })
    .catch((error: unknown) => {
      throw nameTaken(error)
    })
  if (input.folder)
    await createFolder(db, scope, byMember(scope), input.folder).catch(() => undefined)
  await audit({
    ...scope,
    actor: byMember(scope),
    action: 'project.updated',
    target: { type: 'project', id },
    data: { fields: Object.keys(input) },
  })
  broadcastProjects(scope.workspaceId)
  return summary(updated)
}

export async function setProjectRepositories(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  input: { repositories: string[] },
) {
  const project = await db.project.findFirst({ where: { id }, include: { repositories: true } })
  if (!project) throw new HTTPException(404, { message: 'Project not found' })
  const current = new Set(project.repositories.map((r) => r.repository))
  // Repositories already linked stay, even if no connection reaches them any more.
  const repositories = [
    ...input.repositories.filter((r) => current.has(r)),
    ...(await checkRepositories(
      db,
      scope,
      input.repositories.filter((r) => !current.has(r)),
    )),
  ]
  const next = new Set(repositories)
  await prisma.$transaction([
    prisma.projectRepository.deleteMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: id,
        repository: { notIn: [...next] },
      },
    }),
    prisma.projectRepository.createMany({
      data: [...next]
        .filter((r) => !current.has(r))
        .map((repository) => ({
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          projectId: id,
          repository,
        })),
    }),
  ])
  await audit({
    ...scope,
    actor: byMember(scope),
    action: 'project.repositories_set',
    target: { type: 'project', id },
    data: { repositories: [...next] },
  })
  broadcastProjects(scope.workspaceId)
  return { repositories: [...next].sort() }
}

/** Archived: off the sidebar, nothing new goes in. Its schedules and triggers keep firing. */
export async function setArchived(
  db: ScopedDb,
  scope: WorkspaceScope,
  id: string,
  archived: boolean,
) {
  const { count } = await db.project.updateMany({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
  })
  if (!count) throw new HTTPException(404, { message: 'Project not found' })
  await audit({
    ...scope,
    actor: byMember(scope),
    action: archived ? 'project.archived' : 'project.unarchived',
    target: { type: 'project', id },
  })
  broadcastProjects(scope.workspaceId)
}

/**
 * Its threads, tasks, schedules and triggers stay, in no project; its
 * repository links and memory go. The library folder and the repositories stay.
 */
export async function deleteProject(db: ScopedDb, scope: WorkspaceScope, id: string) {
  const project = await db.project.findFirst({ where: { id }, select: SUMMARY })
  if (!project) throw new HTTPException(404, { message: 'Project not found' })
  await db.project.delete({ where: { id } })
  if (project.logo) await removeLogo(scope, id)
  await audit({
    ...scope,
    actor: byMember(scope),
    action: 'project.deleted',
    target: { type: 'project', id },
    data: { name: project.name },
  })
  broadcastProjects(scope.workspaceId)
}

/** Briefs beyond this are cut in the catalog; the thread's own project gets its whole brief. */
const CATALOG_BRIEF = 400

/** Every project not archived, for a thread's spec: what `@[name](project:id)` refers to. */
export async function projectCatalog(db: ScopedDb): Promise<ProjectCatalogEntry[]> {
  const rows = await db.project.findMany({
    where: { archivedAt: null },
    include: { repositories: { orderBy: { repository: 'asc' } } },
    orderBy: { name: 'asc' },
    take: 50,
  })
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    brief: p.brief.length > CATALOG_BRIEF ? `${p.brief.slice(0, CATALOG_BRIEF)}…` : p.brief,
    folder: p.folder,
    repositories: p.repositories.map((r) => r.repository),
  }))
}

/** The project as a thread's spec gives it to the teammate, or null when the thread has none. */
export async function threadProject(
  db: ScopedDb,
  projectId: string | null,
): Promise<ThreadProject | null> {
  if (!projectId) return null
  const project = await db.project.findFirst({
    where: { id: projectId },
    include: { repositories: { orderBy: { repository: 'asc' } } },
  })
  if (!project) return null
  const [memory, connections] = await Promise.all([
    readMemory(db, { kind: 'project_memory', projectId }),
    project.preferredConnectionIds.length
      ? db.connection.findMany({
          where: { id: { in: project.preferredConnectionIds }, status: 'active' },
          select: { id: true, label: true },
        })
      : Promise.resolve([]),
  ])
  return {
    id: project.id,
    name: project.name,
    brief: project.brief,
    memory: memory?.text ?? '',
    folder: project.folder,
    repositories: project.repositories.map((r) => r.repository),
    connections: connections.map((c) => ({ connectionId: c.id, label: c.label })),
  }
}

/**
 * The project a thread about a repository goes in, when nothing else says:
 * the one project that links it, if exactly one (not archived) does.
 */
export async function projectOfRepository(db: ScopedDb, repository: string) {
  const links = await db.projectRepository.findMany({
    where: { repository: repository.toLowerCase(), project: { archivedAt: null } },
    select: { projectId: true },
    take: 2,
  })
  return links.length === 1 ? links[0]!.projectId : null
}
