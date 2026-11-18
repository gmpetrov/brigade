// Where a guest of Brigade.app came from (docs/analytics.md, "Downloads"). The site's download
// button tells the API where the visit came from (POST /api/downloads, its utm_* and referrer as
// for a sign-up); the API keeps it a few days under a keyed hash of the visitor's IP address. When
// Brigade.app then makes a guest with nothing to say where they came from, a download from the
// same address in those days gives it, marked `fromDownload` (a guess: one address can be several
// people). The address itself is never kept.
import { createHmac } from 'node:crypto'
import { env } from './config.js'
import { prisma } from './db.js'
import { parseSignupSource, type SignupSource } from './signup-source.js'

/** How long a download waits for its app's guest. */
export const DOWNLOAD_DAYS = 3

/** A keyed hash of an IP address, or nothing without one. */
export function visitorOf(ip: string | null | undefined) {
  const address = ip?.trim()
  if (!address) return undefined
  return createHmac('sha256', `download-source:${env.BETTER_AUTH_SECRET}`)
    .update(address)
    .digest('base64url')
}

/** The visitor's IP address, as Cloudflare gives it; none locally. */
export const ipOf = (headers: Headers | undefined) => headers?.get('cf-connecting-ip') ?? undefined

/** Whether a source says nothing of where someone came from. */
export const unknownSource = (source: SignupSource) =>
  source.channel === 'direct' && !source.source && !source.referrer && !source.adClick

/**
 * Keep where a download's visit came from, by its visitor. Nothing kept for a visit that says
 * nothing (direct) or without an address. Rows older than DOWNLOAD_DAYS go at the same time.
 */
export async function rememberDownload(ip: string | undefined, raw: unknown) {
  const visitor = visitorOf(ip)
  if (!visitor) return false
  const source = parseSignupSource(raw)
  if (unknownSource(source)) return false
  const { adClick: _, ...kept } = source
  await prisma.downloadSource.upsert({
    where: { visitor },
    create: { visitor, source: kept },
    update: { source: kept, createdAt: new Date() },
  })
  await prisma.downloadSource.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - DOWNLOAD_DAYS * 86_400_000) } },
  })
  return true
}

/** The source of a download from this address in the last DOWNLOAD_DAYS, taken once. */
export async function takeDownloadSource(ip: string | undefined) {
  const visitor = visitorOf(ip)
  if (!visitor) return undefined
  const row = await prisma.downloadSource.findUnique({ where: { visitor } })
  if (!row) return undefined
  await prisma.downloadSource.delete({ where: { visitor } }).catch(() => undefined)
  if (row.createdAt.getTime() < Date.now() - DOWNLOAD_DAYS * 86_400_000) return undefined
  return row.source as SignupSource
}
