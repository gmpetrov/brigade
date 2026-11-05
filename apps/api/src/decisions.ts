// A project's decisions (docs/projects.md, Decisions): the specs and notes under its library
// folder that say their status on their third line, and its designs, whose design.json says it.
// Nobody keeps an index by hand: the project page reads them here. A pull request names those it
// ships or is part of (github_create_pull_request's `specs`); once it is merged, Brigade writes
// its number on each, and sets those it ships to shipped (settleSpecsOnMerge).
import {
  DECISIONS_FOLDER,
  DESIGN_MANIFEST,
  DESIGN_OPTIONS_SUFFIX,
  DESIGN_SUFFIX,
  DESIGNS_FOLDER,
  markdownTitle,
  namesReference,
  parseStatusLine,
  pullNumbersIn,
  readDesignStatus,
  withPullInDesign,
  withPullOnStatusLine,
  type DecisionFlag,
  type DecisionView,
  type PullSpecs,
} from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { prisma, scoped, type Scope, type ScopedDb } from './db.js'
import { teammateLibraryAccess } from './library-folders.js'
import { saveLibraryFile, withLibraryLock } from './library.js'
import { storedText } from './lists.js'
import { noteInThread } from './thread-notes.js'

/** Files read for a project's decisions, at most: the newest first. */
const DECISIONS_MAX = 2000
/** What is read of a Markdown file (its status line is near the top) and of a design.json. */
const MARKDOWN_HEAD = 2000
const MANIFEST_HEAD = 20_000

const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join('\n')

/** The library path a pull request names: a Markdown file, or a design (its folder). */
function specFile(path: string) {
  const clean = path.trim().replace(/^\/+|\/+$/g, '')
  if (clean.endsWith(DESIGN_SUFFIX)) return `${clean}/${DESIGN_MANIFEST}`
  return clean
}

/** A design.json's design: its folder. */
const designOf = (manifestPath: string) => manifestPath.slice(0, -`/${DESIGN_MANIFEST}`.length)

/** A design whose folder is not an option for another, nor a design system's preview. */
function isDesignManifest(path: string) {
  if (!path.endsWith(`${DESIGN_SUFFIX}/${DESIGN_MANIFEST}`)) return false
  const folders = designOf(path).split('/')
  return !folders
    .slice(0, -1)
    .some((f) => f.endsWith(DESIGN_OPTIONS_SUFFIX) || f.endsWith(DESIGN_SUFFIX))
}

/**
 * A project's decisions, from the files under its folder: each Markdown file whose status line
 * Brigade can read, and each under `decisions/` that has none (flagged); each design whose
 * design.json has a status, and each under `designs/` that has none (flagged). Flags say what
 * looks behind: a spec still open though a pull request linked to it is merged, a shipped spec
 * that names no reference.
 */
export async function projectDecisions(scope: Scope, folder: string): Promise<DecisionView[]> {
  const prefix = `${folder.replace(/\/+$/, '')}/`
  const rows = await prisma.$queryRaw<
    { id: string; path: string; updatedAt: Date; head: string }[]
  >`
    SELECT "id", "path", "updatedAt",
      left("text", CASE WHEN "path" LIKE '%/design.json' THEN ${MANIFEST_HEAD}::int ELSE ${MARKDOWN_HEAD}::int END) AS "head"
    FROM "Document"
    WHERE "workspaceId" = ${scope.workspaceId}
      AND "organizationId" = ${scope.organizationId}
      AND "kind" = 'library'
      AND "deletedAt" IS NULL
      AND starts_with("path", ${prefix})
      AND ("path" LIKE '%.md' OR "path" LIKE '%.design/design.json')
    ORDER BY "updatedAt" DESC
    LIMIT ${DECISIONS_MAX}`
  const inFolder = (path: string, name: string) => path.startsWith(`${prefix}${name}/`)
  const views: DecisionView[] = []
  for (const row of rows) {
    const updatedAt = row.updatedAt.toISOString()
    if (row.path.endsWith(`/${DESIGN_MANIFEST}`)) {
      if (!isDesignManifest(row.path)) continue
      const design = readDesignStatus(row.head)
      if (!design.status && !inFolder(row.path, DESIGNS_FOLDER)) continue
      const path = designOf(row.path)
      views.push({
        documentId: row.id,
        path,
        type: 'design',
        title: design.title || path.split('/').pop()!.slice(0, -DESIGN_SUFFIX.length),
        kind: null,
        date: null,
        status: design.status,
        detail: '',
        pullRequests: design.pullRequests,
        flags: design.status ? [] : ['no_status'],
        updatedAt,
      })
      continue
    }
    // A design's own notes are the design's.
    if (row.path.includes(`${DESIGN_SUFFIX}/`)) continue
    const name = row.path.split('/').pop()!
    const line = parseStatusLine(row.head)
    if (!line && !(inFolder(row.path, DECISIONS_FOLDER) && name.toLowerCase() !== 'readme.md'))
      continue
    const flags: DecisionFlag[] = []
    if (!line) flags.push('no_status')
    else if (line.status === 'shipped' && !namesReference(line.rest)) flags.push('no_reference')
    views.push({
      documentId: row.id,
      path: row.path,
      type: 'spec',
      title: markdownTitle(row.head) || name.replace(/\.md$/i, ''),
      kind: line?.kind ?? null,
      date: line?.date ?? null,
      status: line?.status ?? null,
      detail: line ? line.rest.replace(/^[\s.]+/, '') : '',
      pullRequests: line ? pullNumbersIn(line.rest) : [],
      flags,
      updatedAt,
    })
  }
  // Still open, though a pull request linked to it is merged: its status is behind.
  const open = views.filter((v) => v.status === 'draft' || v.status === 'accepted')
  if (open.length) {
    const merged = await scoped(scope).specPull.findMany({
      where: {
        documentId: { in: open.map((v) => v.documentId) },
        pullRequest: { state: 'merged' },
      },
      select: { documentId: true },
    })
    const behind = new Set(merged.map((m) => m.documentId))
    for (const v of open) if (behind.has(v.documentId)) v.flags.push('merged_not_shipped')
  }
  return views
}

/**
 * The specs and designs a pull request ships or is part of, by library path: kept when its author
 * may change them, since Brigade changes them in its name once it is merged. A path named in both
 * is shipped. Returns the paths it could not keep (no such file, or out of its author's reach).
 */
export async function linkPullSpecs(
  db: ScopedDb,
  pullRequestId: string,
  teammateId: string,
  specs: PullSpecs,
) {
  const ships = new Set((specs.ships ?? []).map(specFile).filter(Boolean))
  const partOf = new Set((specs.partOf ?? []).map(specFile).filter((p) => p && !ships.has(p)))
  const wanted = [...ships, ...partOf]
  if (!wanted.length) return []
  const teammate = await db.teammate.findFirst({ where: { id: teammateId } })
  if (!teammate) return wanted.map((p) => (isDesignManifest(p) ? designOf(p) : p))
  const access = await teammateLibraryAccess(db, teammate)
  const rows = await db.document.findMany({
    where: { kind: 'library', path: { in: wanted }, deletedAt: null },
    select: { id: true, path: true },
  })
  const kept = rows.filter((r) => access.of(r.path) === 'read_write')
  if (kept.length)
    await db.specPull.createMany({
      data: kept.map((r) => ({
        documentId: r.id,
        pullRequestId,
        ships: ships.has(r.path),
      })) as never,
      skipDuplicates: true,
    })
  const keptPaths = new Set(kept.map((r) => r.path))
  // As people name them: a design by its folder.
  return wanted.filter((p) => !keptPaths.has(p)).map((p) => (isDesignManifest(p) ? designOf(p) : p))
}

/**
 * A pull request was merged: each spec or design it was linked to gets its number, and those it
 * ships are set to shipped, saved as a new version credited to the teammate that opened it, where
 * it may still change them. Its thread is told, and asked to name the reference. Each link is
 * settled once done (or for good: the file gone, out of reach, or with no status line to change);
 * one that failed otherwise is tried again by sweepSpecMerges.
 */
export async function settleSpecsOnMerge(
  db: ScopedDb,
  scope: Scope,
  pull: { id: string; number: number; sessionId: string | null },
) {
  try {
    const links = await db.specPull.findMany({
      where: { pullRequestId: pull.id, settledAt: null },
      select: { documentId: true, ships: true },
    })
    if (!links.length) return
    const row = await db.pullRequest.findFirst({
      where: { id: pull.id },
      select: { authorTeammateId: true },
    })
    const author = row?.authorTeammateId
      ? await db.teammate.findFirst({ where: { id: row.authorTeammateId } })
      : null
    const access = author ? await teammateLibraryAccess(db, author) : null
    const shipped: string[] = []
    const named: string[] = []
    const unreadable: string[] = []
    for (const link of links) {
      const settle = () =>
        db.specPull.updateMany({
          where: { documentId: link.documentId, pullRequestId: pull.id },
          data: { settledAt: new Date() },
        })
      try {
        const changed = await withLibraryLock(scope, link.documentId, async (lease) => {
          const file = await db.document.findFirst({
            where: { id: link.documentId, kind: 'library', deletedAt: null },
          })
          if (!file || !author || access?.of(file.path) !== 'read_write') return 'gone' as const
          const text = await storedText(scope, file)
          const next = file.path.endsWith(`/${DESIGN_MANIFEST}`)
            ? withPullInDesign(text, pull.number, link.ships)
            : withPullOnStatusLine(text, pull.number, link.ships)
          if (next === null) return { path: file.path, result: 'unreadable' as const }
          if (next !== text)
            await saveLibraryFile(
              db,
              scope,
              { type: 'teammate', id: author.id },
              {
                path: file.path,
                bytes: new TextEncoder().encode(next),
                contentType: file.contentType,
              },
              pull.sessionId ? { sessionId: pull.sessionId } : {},
              { lease },
            )
          return { path: file.path, result: 'done' as const }
        })
        await settle()
        if (changed === 'gone') continue
        const shown = changed.path.endsWith(`/${DESIGN_MANIFEST}`)
          ? designOf(changed.path)
          : changed.path
        if (changed.result === 'unreadable') unreadable.push(shown)
        else (link.ships ? shipped : named).push(shown)
      } catch (error) {
        if (error instanceof HTTPException && error.status === 404) await settle()
        else console.warn(`decisions: ${link.documentId} not settled on merge: ${String(error)}`)
      }
    }
    if (!pull.sessionId) return
    const notes = [
      shipped.length &&
        `Marked shipped in the library, as #${pull.number} ships them:\n${bullets(shipped)}\n` +
          "On each spec's status line, name where the reference now lives (the docs this pull " +
          'request updated, as a path in backticks), if it does not say it yet.',
      named.length &&
        `Named #${pull.number} on the specs and designs it is part of, their status unchanged:\n${bullets(named)}`,
      unreadable.length &&
        `#${pull.number} could not be written on these, as Brigade cannot read their status ` +
          `(a spec's third line, or a design's design.json):\n${bullets(unreadable)}\nFix their status by hand.`,
    ].filter(Boolean) as string[]
    for (const note of notes) await noteInThread(db, pull.sessionId, note)
  } catch (error) {
    console.warn(`decisions: specs of pull request ${pull.id} not settled: ${String(error)}`)
  }
}

/** Merged pull requests whose specs are not all settled: tried again (jobs.ts). */
export async function sweepSpecMerges() {
  const pending = await prisma.specPull.findMany({
    where: { settledAt: null, pullRequest: { state: 'merged' } },
    select: {
      organizationId: true,
      workspaceId: true,
      pullRequest: { select: { id: true, number: true, sessionId: true } },
    },
    distinct: ['pullRequestId'],
    take: 200,
  })
  for (const p of pending) {
    const scope = { organizationId: p.organizationId, workspaceId: p.workspaceId }
    await settleSpecsOnMerge(scoped(scope), scope, p.pullRequest)
  }
}
