// Features hidden until they are ready (docs/feature-flags.md). The list and each one's default
// are in packages/contracts/src/features.ts; a FeatureFlag row opens one to some people. Read
// each time, never cached: a row changed by hand applies on the next request.
import { APP_FEATURES, FEATURES, isFeature, type Feature } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { prisma } from './db.js'

/** Whom a feature is asked about: a person, in the workspace they are in. */
export type FeatureViewer = { email: string; workspaceId: string | null }

type Row = { key: string; everyone: boolean; emails: string[]; workspaceIds: string[] }

/** Whether a row opens its feature to the person. */
export function opens(row: Row, viewer: FeatureViewer) {
  if (row.everyone) return true
  if (viewer.workspaceId && row.workspaceIds.includes(viewer.workspaceId)) return true
  const email = viewer.email.trim().toLowerCase()
  const domain = email.slice(email.lastIndexOf('@'))
  return row.emails.some((entry) => {
    const e = entry.trim().toLowerCase()
    return e === email || (e.startsWith('@') && e === domain)
  })
}

/** The features the person has. */
export async function featuresOf(viewer: FeatureViewer): Promise<Set<Feature>> {
  const rows = await prisma.featureFlag.findMany({
    select: { key: true, everyone: true, emails: true, workspaceIds: true },
  })
  const byKey = new Map(rows.filter((r) => isFeature(r.key)).map((r) => [r.key as Feature, r]))
  const on = new Set<Feature>()
  for (const key of Object.keys(FEATURES) as Feature[]) {
    const row = byKey.get(key)
    if (row ? opens(row, viewer) : FEATURES[key].default) on.add(key)
  }
  return on
}

/** The features of a member, by id, in their workspace. */
export async function featuresOfMember(memberId: string, workspaceId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { user: { select: { email: true } } },
  })
  return member ? featuresOf({ email: member.user.email, workspaceId }) : new Set<Feature>()
}

/** The features of a signed-in user, in the workspace they are in. */
export async function featuresOfUser(userId: string, workspaceId: string | null) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
  return user ? featuresOf({ email: user.email, workspaceId }) : new Set<Feature>()
}

/** Whether an App kind is open to someone with these features. */
export const appOpen = (kind: string, features: Set<Feature>) => {
  const feature = APP_FEATURES[kind]
  return !feature || features.has(feature)
}

/** A 404 for someone without the feature, as if it were not there. */
export function requireFeature(features: Set<Feature>, feature: Feature) {
  if (!features.has(feature)) throw new HTTPException(404, { message: 'Not found' })
}
