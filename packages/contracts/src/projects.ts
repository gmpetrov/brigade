// Projects: a line of work inside a workspace. It groups threads, tasks, a
// library folder and repositories, and gives its threads context. Every
// workspace resource stays shared: it organizes, it does not isolate.
import { z } from 'zod'
import { LibraryPath } from './library.js'

const Name = z.string().trim().min(1).max(80)
/** One letter or an emoji. */
const Icon = z.string().trim().min(1).max(8)
const Brief = z.string().trim().max(5000)
/** The site the project is about: https, or http. */
const SiteUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\/\S+$/i, 'A website starts with https://')
/** Most a project logo may weigh. */
export const PROJECT_LOGO_MAX = 256 * 1024
/** Image types a project logo may be. */
export const PROJECT_LOGO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/svg+xml',
] as const
/** A logo as the dashboard sends it: a data URL of one of those types. */
const Logo = z
  .string()
  .max(Math.ceil((PROJECT_LOGO_MAX * 4) / 3) + 64)
  .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/, 'A logo is an image')
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
  url: SiteUrl.nullish(),
  logo: Logo.nullish(),
  /** Unset: "Projects/<name>". */
  folder: Folder.nullish(),
  repositories: z.array(Repository).max(50).default([]),
})

export const UpdateProject = z.object({
  name: Name.optional(),
  icon: Icon.nullable().optional(),
  brief: Brief.optional(),
  url: SiteUrl.nullable().optional(),
  /** A new logo, or null to go back to the icon. */
  logo: Logo.nullable().optional(),
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
  /** Its stored logo's version, shown instead of the icon (projectLogoPath); null: none. */
  logo: string | null
  archivedAt: string | null
}

/** Where the dashboard reads a project's logo, under /api. */
export const projectLogoPath = (project: { id: string; logo: string }) =>
  `/projects/${project.id}/logo?v=${encodeURIComponent(project.logo)}`

/** Most of a website's text a brief run reads. */
export const PROJECT_SITE_TEXT_MAX = 12_000
/** Most logos of a site a brief run chooses among. */
export const PROJECT_LOGO_CANDIDATES_MAX = 8

/** A website as a person types it ("acme.com"), as a URL: https:// when it names none. */
export const siteUrl = (raw: string) => {
  const text = raw.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
}

/** What a project's website says about it, to fill a new project. */
export const ReadSite = z.object({ url: z.string().trim().min(1).max(2000).transform(siteUrl) })

export type SiteInfo = {
  /** The address read, after redirects. */
  url: string
  /** The site's own name for itself, if it gives one. */
  name: string | null
  /** Its meta description: the brief when no model can write one. */
  description: string | null
  /** Its logo as a data URL: the best guess from the HTML, before the model chooses. */
  logo: string | null
}

export type SiteBrief =
  | {
      brief: string
      /** The name the model read on the site; null when it gave none. */
      name: string | null
      /** The logo the model chose, as a data URL; null: keep the first guess. */
      logo: string | null
    }
  /** Why not: no account, no computer online, out of usage, the run failed. */
  | { brief: null; reason: string }

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
