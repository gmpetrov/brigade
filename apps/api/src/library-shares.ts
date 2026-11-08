// Public links to library files (docs/public-links.md). A member turns one on for a file, and
// anyone with its address, <web>/s/<token>, reads the file as it is now without signing in: a
// Markdown document shown as a page, a design in a frame from the sandbox origin (DESIGN_URL), any
// other file shown or downloaded. A design's link is its index.html's and shows its whole folder.
//
// The token is the only key: random and unguessable, kept in the row, so turning the link off
// (deleting the row) closes it at once, and turning it on again gives a new address. Through it,
// nothing else of the workspace can be reached: a document's mentions of other files and threads
// become their names alone, and only the files uploaded into that document are served beside it.
import { randomBytes } from 'node:crypto'
import {
  DESIGN_ENTRY,
  designFolderOf,
  parseMentions,
  type LibraryShare,
  type SharedFile,
} from '@brigade/contracts'
import { assetIds } from '@brigade/editor'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import { env } from './config.js'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { libraryFile, readLibraryFile } from './library.js'

/** Bytes of randomness in a token: 22 characters in base64url. */
const TOKEN_BYTES = 16
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/

/** The Markdown a public link shows as a page, rather than as a file: what the editor opens. */
const DOCUMENT_MAX = 2 * 1024 * 1024
/** Word documents, spreadsheets and decks: shown from the API's reading of them. */
const OFFICE =
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)$/

export const shareUrl = (token: string) => `${env.WEB_URL[0]}/s/${token}`

/** What a public link shows of its file: a design (its folder), a document or a file. */
export function shareKind(row: { path: string; contentType: string; size: number }) {
  const folder = designFolderOf(row.path)
  if (folder && row.path === `${folder}/${DESIGN_ENTRY}`) return { kind: 'design' as const, folder }
  if (row.contentType === 'text/markdown' && row.size <= DOCUMENT_MAX)
    return { kind: 'document' as const }
  return { kind: 'file' as const }
}

async function memberName(db: ScopedDb, memberId: string | null) {
  if (!memberId) return null
  const member = await db.member.findFirst({ where: { id: memberId }, include: { user: true } })
  return member?.user.name ?? null
}

async function toShare(
  db: ScopedDb,
  row: { token: string; createdAt: Date; createdByMemberId: string | null },
): Promise<LibraryShare> {
  return {
    url: shareUrl(row.token),
    createdAt: row.createdAt.toISOString(),
    createdBy: await memberName(db, row.createdByMemberId),
  }
}

/** A library file's public link, or null when it has none. */
export async function shareOf(db: ScopedDb, documentId: string): Promise<LibraryShare | null> {
  const row = await libraryFile(db, documentId)
  const share = await db.libraryShare.findFirst({ where: { documentId: row.id } })
  return share ? toShare(db, share) : null
}

/** Turns a file's public link on: the one it has, or a new one. */
export async function shareFile(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  documentId: string,
): Promise<LibraryShare> {
  const row = await libraryFile(db, documentId)
  const found = await db.libraryShare.findFirst({ where: { documentId: row.id } })
  if (found) return toShare(db, found)
  let created = true
  const share = await db.libraryShare
    .create({
      data: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        documentId: row.id,
        token: randomBytes(TOKEN_BYTES).toString('base64url'),
        createdByMemberId: memberId,
      },
    })
    .catch(async (error: unknown) => {
      // Turned on by someone else at the same moment: theirs is the file's link.
      const theirs = await db.libraryShare.findFirst({ where: { documentId: row.id } })
      if (!theirs) throw error
      created = false
      return theirs
    })
  if (!created) return toShare(db, share)
  await audit({
    ...scope,
    actor: { type: 'member', id: memberId },
    action: 'library.shared',
    target: { type: 'document', id: row.id },
    data: { path: row.path },
  })
  return toShare(db, share)
}

/** Turns a file's public link off: its address stops working at once. */
export async function unshareFile(
  db: ScopedDb,
  scope: Scope,
  memberId: string,
  documentId: string,
) {
  const row = await libraryFile(db, documentId)
  const { count } = await db.libraryShare.deleteMany({ where: { documentId: row.id } })
  if (count)
    await audit({
      ...scope,
      actor: { type: 'member', id: memberId },
      action: 'library.unshared',
      target: { type: 'document', id: row.id },
      data: { path: row.path },
    })
}

/**
 * The live file behind a token, in its workspace: null when the link is off, or its file is in
 * the trash or gone. Read without a session: the token alone names the workspace.
 */
export async function sharedRow(token: string) {
  if (!TOKEN.test(token)) return null
  const share = await prisma.libraryShare.findUnique({
    where: { token },
    include: { document: true, workspace: { select: { name: true } } },
  })
  if (!share || share.document.kind !== 'library' || share.document.deletedAt) return null
  const scope: Scope = { organizationId: share.organizationId, workspaceId: share.workspaceId }
  return { token, scope, db: scoped(scope), document: share.document, workspace: share.workspace }
}

export type SharedRow = NonNullable<Awaited<ReturnType<typeof sharedRow>>>

/** The live file behind a token, or a 404 that says no more than that. */
export async function sharedOr404(token: string) {
  const shared = await sharedRow(token)
  if (!shared) throw new HTTPException(404, { message: 'This link is off or no longer exists' })
  return shared
}

/** Where a document's uploaded file is served under its link. */
export const sharedAssetUrl = (token: string, id: string) =>
  `${env.API_URL}/api/shared/${encodeURIComponent(token)}/assets/${encodeURIComponent(id)}`

/**
 * What a document's link publishes of its text: no HTML comments (list items' markers, notes
 * hidden in the editor), and mentions of the workspace's files, threads and teammates as their
 * names alone. Everything served under the link is read from this, never from the stored text.
 */
export function publishedText(text: string) {
  // One left open hides the rest of the text, as Markdown viewers read it.
  return parseMentions(text.replace(/<!--[\s\S]*?(?:-->|$)/g, ''))
    .map((part) => (typeof part === 'string' ? part : part.label))
    .join('')
}

/** A document's Markdown as its link shows it: its published text, its uploaded files as addresses under the link. */
export function publicMarkdown(text: string, token: string) {
  return publishedText(text).replace(/\basset:([A-Za-z0-9_-]{1,64})/g, (_, id: string) =>
    sharedAssetUrl(token, id),
  )
}

/** What anyone with the link reads of it: GET /api/shared/:token. */
export async function sharedView(
  shared: SharedRow,
  designTitle: (scope: Scope, db: ScopedDb, folder: string) => Promise<string>,
): Promise<SharedFile> {
  const { document: row, token } = shared
  const kind = shareKind(row)
  const base = {
    workspace: shared.workspace.name,
    contentType: row.contentType,
    size: row.size,
    updatedAt: row.updatedAt.toISOString(),
  }
  if (kind.kind === 'design')
    return {
      ...base,
      kind: 'design',
      name: await designTitle(shared.scope, shared.db, kind.folder),
      url: `${env.DESIGN_URL}/s/${encodeURIComponent(token)}/${DESIGN_ENTRY}`,
    }
  const name = row.path.split('/').pop()!
  if (kind.kind === 'document') {
    const text = new TextDecoder().decode(await readLibraryFile(shared.scope, row))
    return { ...base, kind: 'document', name, markdown: publicMarkdown(text, token) }
  }
  return {
    ...base,
    kind: 'file',
    name,
    contentUrl: `${env.API_URL}/api/shared/${encodeURIComponent(token)}/content`,
    ...(OFFICE.test(row.contentType) && {
      previewPath: `/shared/${encodeURIComponent(token)}/preview`,
    }),
  }
}

/**
 * Whether a file uploaded into documents may be served under this link: only one the shared
 * document's published text refers to now (its own, or a block copied in from another), never
 * another's, nor one named only where the link hides it (in a comment).
 */
export async function sharesAsset(shared: SharedRow, assetId: string) {
  if (shareKind(shared.document).kind !== 'document') return false
  const asset = await shared.db.documentAsset.findFirst({
    where: { id: assetId, status: 'ready' },
    select: { id: true },
  })
  if (!asset) return false
  const text = new TextDecoder().decode(await readLibraryFile(shared.scope, shared.document))
  return assetIds(publishedText(text)).includes(assetId)
}
