// GitHub repositories, as the workspace's GitHub connections reach them.
import { z } from 'zod'

/** owner/name on GitHub. Stored lowercase. */
export const RepositoryName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'owner/name, e.g. acme/web')
  .refine((r) => !r.split('/').some((p) => p === '.' || p === '..'), 'owner/name, e.g. acme/web')
  .transform((r) => r.replace(/\.git$/, '').toLowerCase())

/** A repository the workspace's GitHub connections reach. */
export const RepositoryOption = z.object({
  repository: z.string(),
  private: z.boolean(),
  /** The GitHub account of the connection that reaches it. */
  connection: z.string(),
})
export type RepositoryOption = z.infer<typeof RepositoryOption>
