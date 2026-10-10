// Projects: GitHub repositories the workspace works on, with what teammates
// should run and know when they check one out.
import { z } from 'zod'

/** owner/name on GitHub. Stored lowercase. */
export const RepositoryName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'owner/name, e.g. acme/web')
  .refine((r) => !r.split('/').some((p) => p === '.' || p === '..'), 'owner/name, e.g. acme/web')
  .transform((r) => r.replace(/\.git$/, '').toLowerCase())

export const Project = z.object({
  id: z.string(),
  repository: z.string(),
  setupScript: z.string().nullable(),
  notes: z.string(),
  updatedAt: z.string(),
})
export type Project = z.infer<typeof Project>

export const SaveProject = z.object({
  repository: RepositoryName,
  setupScript: z
    .string()
    .max(20_000)
    .nullable()
    .optional()
    .transform((s) => (s?.trim() ? s : null)),
  notes: z.string().max(20_000).default(''),
})
export type SaveProject = z.infer<typeof SaveProject>

/** What a teammate's runner gets per project, in the thread spec. */
export const ProjectSpec = z.object({
  repository: z.string(),
  setupScript: z.string().nullable(),
  notes: z.string(),
})
export type ProjectSpec = z.infer<typeof ProjectSpec>
