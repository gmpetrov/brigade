// Uploads straight to the bucket: the browser or the runner PUTs a file's bytes
// to a short-lived signed URL, never through the API, which only signs, then
// checks and records the result. A file for the library, a skill or a logo is
// held as an upload until it is used (`uploadId`); see apps/api/src/uploads.ts.
import { z } from 'zod'
import { LIBRARY_FILE_MAX } from './library.js'
import { PROJECT_LOGO_MAX } from './projects.js'
import { SKILL_FILE_MAX, SKILL_PACK_MAX } from './skills.js'

/**
 * What an upload is for: a library file (from the dashboard, the design canvas or a
 * teammate), a skill pack to import, one file of a teammate's skill proposal, a logo.
 */
export const UPLOAD_PURPOSES = ['library', 'skill_pack', 'skill_file', 'logo'] as const
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number]

/** Largest file of each purpose. */
export const UPLOAD_MAX: Record<UploadPurpose, number> = {
  library: LIBRARY_FILE_MAX,
  skill_pack: SKILL_PACK_MAX,
  skill_file: SKILL_FILE_MAX,
  logo: PROJECT_LOGO_MAX,
}

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, in lowercase hex')

/** A member starts an upload: POST /api/uploads. */
export const StartFileUpload = z
  .object({
    purpose: z.enum(UPLOAD_PURPOSES),
    name: z.string().trim().min(1).max(500),
    size: z.number().int().min(0),
    contentType: z.string().max(200).default(''),
    /** Checked against the bytes once they are in, when given. */
    sha256: Sha256.optional(),
  })
  .refine((u) => u.size <= UPLOAD_MAX[u.purpose], { message: 'The file is too large' })
export type StartFileUpload = z.input<typeof StartFileUpload>

/** A runner starts an upload for a teammate of a thread on its computer: POST /runner/uploads. */
export const StartRunnerUpload = z
  .object({
    purpose: z.enum(['library', 'skill_file']),
    sessionId: z.string().min(1).max(64),
    teammateId: z.string().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(500),
    size: z.number().int().min(0),
    contentType: z.string().max(200).default(''),
    /** The runner hashed it: the bytes in the bucket must match. */
    sha256: Sha256,
  })
  .refine((u) => u.size <= UPLOAD_MAX[u.purpose], { message: 'The file is too large' })
export type StartRunnerUpload = z.input<typeof StartRunnerUpload>

/**
 * Where to PUT the bytes: a signed URL of the bucket, taking exactly the size and
 * type it was started with. Without R2 (development) a signed URL of the API's own
 * stand-in, a path to resolve against the API's address. Then POST its complete route.
 */
export const FileUploadTicket = z.object({
  id: z.string(),
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
})
export type FileUploadTicket = z.infer<typeof FileUploadTicket>

/** An upload once its bytes are checked: ready to be used by its id. */
export const FileUploadInfo = z.object({
  id: z.string(),
  purpose: z.enum(UPLOAD_PURPOSES),
  name: z.string(),
  contentType: z.string(),
  size: z.number(),
  sha256: z.string(),
})
export type FileUploadInfo = z.infer<typeof FileUploadInfo>

/** Size and hash of what a runner uploaded to a key of its own (a backup, an image). */
export const UploadedObject = z.object({
  size: z.number().int().min(0),
  sha256: Sha256.optional(),
})

/** The upload's id, in a body. */
export const UploadRef = z.object({ uploadId: z.string().min(1).max(64) })

/** Largest image or PDF a teammate's event carries, put in its thread's bucket folder. */
export const THREAD_FILE_MAX = 32 * 1024 * 1024
