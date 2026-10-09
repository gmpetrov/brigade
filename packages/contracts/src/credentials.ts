// Credentials: secrets members keep in the vault for their teammates to use.
// A teammate never receives a website password: the runner types it into the
// teammate's browser. Other kinds reach the thread's computer as an env file.
import { z } from 'zod'

export const CredentialKind = z.enum(['website', 'database', 'api_key', 'other'])
export type CredentialKind = z.infer<typeof CredentialKind>

export const DatabaseEngine = z.enum(['postgres', 'mysql', 'mongodb', 'other'])

/** What anyone in the workspace, and the teammate, may see. Never a secret. */
export const CredentialDetails = z.object({
  /** website: the sign-in page; its host is the only one the password is typed into. api_key: the API's base URL. */
  url: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .optional(),
  username: z.string().trim().max(500).optional(),
  engine: DatabaseEngine.optional(),
  host: z.string().trim().max(500).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  database: z.string().trim().max(500).optional(),
  notes: z.string().max(2000).optional(),
})
export type CredentialDetails = z.infer<typeof CredentialDetails>

/** Kept in the vault. Written from the dashboard, never shown again. */
export const CredentialSecret = z.object({
  password: z.string().min(1).max(10_000).optional(),
  apiKey: z.string().min(1).max(10_000).optional(),
  value: z.string().min(1).max(50_000).optional(),
})
export type CredentialSecret = z.infer<typeof CredentialSecret>

/** The secret field each kind needs. */
export const SECRET_FIELD = {
  website: 'password',
  database: 'password',
  api_key: 'apiKey',
  other: 'value',
} as const satisfies Record<CredentialKind, keyof CredentialSecret>

const name = z.string().trim().min(1).max(80)

export const CreateCredential = z
  .object({
    kind: CredentialKind,
    name,
    details: CredentialDetails.default({}),
    secret: CredentialSecret,
  })
  .superRefine((c, ctx) => {
    if (!c.secret[SECRET_FIELD[c.kind]])
      ctx.addIssue({ code: 'custom', message: `A ${SECRET_FIELD[c.kind]} is required` })
    if (c.kind === 'website' && !c.details.url)
      ctx.addIssue({ code: 'custom', message: 'A website needs the URL of its sign-in page' })
    if (c.kind === 'database' && !c.details.host)
      ctx.addIssue({ code: 'custom', message: 'A database needs a host' })
  })

/** Unsent fields stay. A secret, when sent, replaces the stored one. */
export const UpdateCredential = z.object({
  name: name.optional(),
  details: CredentialDetails.optional(),
  secret: CredentialSecret.optional(),
})

export const CredentialSummary = z.object({
  id: z.string(),
  kind: CredentialKind,
  name: z.string(),
  details: CredentialDetails,
  createdByMemberId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CredentialSummary = z.infer<typeof CredentialSummary>

/** How a teammate uses a credential: typed into its browser, or written to an env file. */
export const CredentialUse = z.enum(['browser', 'env'])
export type CredentialUse = z.infer<typeof CredentialUse>

/** The one use each kind allows. A website password never reaches the teammate's shell. */
export const useFor = (kind: CredentialKind): CredentialUse =>
  kind === 'website' ? 'browser' : 'env'
