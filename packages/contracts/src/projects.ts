// Projects: a line of work inside a workspace. It groups threads, tasks, a
// library folder and repositories, and gives its threads context. Every
// workspace resource stays shared: it organizes, it does not isolate.
import { z } from 'zod'
import { LibraryPath } from './library.js'

const Name = z.string().trim().min(1).max(80)
/** One letter or an emoji. */
const Icon = z.string().trim().min(1).max(8)
const Brief = z.string().trim().max(5000)
/** A library folder. */
const Folder = LibraryPath
/** owner/name; stored lowercase. */
const Repository = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'A repository is owner/name')
  .transform((s) => s.toLowerCase())

export const CreateProject = z.object({
  name: Name,
  icon: Icon.nullish(),
  brief: Brief.default(''),
  /** Unset: "Projects/<name>". */
  folder: Folder.nullish(),
  repositories: z.array(Repository).max(50).default([]),
})

export const UpdateProject = z.object({
  name: Name.optional(),
  icon: Icon.nullable().optional(),
  brief: Brief.optional(),
  folder: Folder.nullable().optional(),
  preferredConnectionIds: z.array(z.string()).max(20).optional(),
})

/** Replaces the project's repositories. */
export const SetProjectRepositories = z.object({
  repositories: z.array(Repository).max(50),
})

/** Moves a thread or task into a project, or out of one (null). */
export const SetProject = z.object({ projectId: z.string().nullable() })

/** A project as lists and pickers show it. */
export type ProjectSummary = {
  id: string
  name: string
  icon: string | null
  archivedAt: string | null
}

/** The project a thread works in, as its spec gives it to the teammate. */
export const ThreadProject = z.object({
  id: z.string(),
  name: z.string(),
  brief: z.string(),
  /** The project's memory file. */
  memory: z.string(),
  /** Its library folder, relative to the library. */
  folder: z.string().nullable(),
  /** owner/name: check these out when the work needs code. */
  repositories: z.array(z.string()),
  /** Connections to use when several could do. */
  connections: z.array(z.object({ connectionId: z.string(), label: z.string() })),
})
export type ThreadProject = z.infer<typeof ThreadProject>

/** A project of the workspace, as every thread's spec lists it: what a mention of it refers to. */
export const ProjectCatalogEntry = z.object({
  id: z.string(),
  name: z.string(),
  /** Its brief, shortened. */
  brief: z.string(),
  folder: z.string().nullable(),
  repositories: z.array(z.string()),
})
export type ProjectCatalogEntry = z.infer<typeof ProjectCatalogEntry>

/** The default library folder of a new project. */
export const projectFolder = (name: string) => `Projects/${name.replace(/[/\\]/g, '-').trim()}`
