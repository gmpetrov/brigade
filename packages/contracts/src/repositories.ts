// GitHub repositories, named the way Brigade stores them.
import { z } from 'zod'

/** owner/name on GitHub. Stored lowercase. */
export const RepositoryName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'owner/name, e.g. acme/web')
  .refine((r) => !r.split('/').some((p) => p === '.' || p === '..'), 'owner/name, e.g. acme/web')
  .transform((r) => r.replace(/\.git$/, '').toLowerCase())
