// A playbook's live run keeps an idea for the team, such as a customer's feature request
// (file_idea): one line in the playbook's ideas list, linked to no thread, which starts nothing.
// A person moves it into their backlog, hands it to a teammate or deletes it. It took the place of
// a task in the Tasks board's Backlog (docs/hand-offs.md). The list is the playbook's `ideas`
// setting when it has one (a library path, with the heading of a section after #), else ideas.md
// in its project's folder or at the library's root, made when missing as Chief's parked list is.
// The run never chooses where: what it read is untrusted, and a line in another list, or another
// section, could be work a routine takes up.
import { projectFolder, type PlaybookManifest } from '@brigade/contracts'
import { audit } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import { teammateLibraryAccess } from './library-folders.js'
import { addListLine } from './lists.js'

/** The file a playbook's ideas go to when its settings name none. */
export const IDEAS_FILE = 'ideas.md'

/** What an ideas list made for a playbook starts with. */
export const ideasHeader = (playbook: string) =>
  `# Ideas\n\nIdeas the ${playbook} playbook kept for the team. Move a line to your backlog, hand it ` +
  'to a teammate, or delete it.\n'

/**
 * Where a playbook's ideas go: its `ideas` setting (`path` or `path#Section`, a Markdown file of
 * the library), else ideas.md in its project's folder, else at the library's root.
 */
export function ideasPlace(
  setting: unknown,
  project: { name: string; folder: string | null } | null,
): { path: string; section?: string } {
  const value = typeof setting === 'string' ? setting.trim() : ''
  const hash = value.indexOf('#')
  const path = (hash >= 0 ? value.slice(0, hash) : value).trim().replace(/^\/+/, '')
  const section = hash >= 0 ? value.slice(hash + 1).trim() : ''
  if (path)
    return {
      path: /\.md$/i.test(path) ? path : `${path}.md`,
      ...(section ? { section } : {}),
    }
  return {
    path: project ? `${project.folder ?? projectFolder(project.name)}/${IDEAS_FILE}` : IDEAS_FILE,
  }
}

/** file_idea, from a playbook's run: a line at the end of its ideas list (or of its section). */
export async function fileIdea(
  db: ScopedDb,
  scope: Scope,
  session: { id: string; title: string; playbookRunId: string | null },
  teammate: Parameters<typeof teammateLibraryAccess>[1] & { id: string },
  op: { text: string },
): Promise<object | { error: string }> {
  if (!session.playbookRunId)
    return {
      error: "file_idea is for a playbook's run. Elsewhere, add a line to a list with add_item.",
    }
  const run = await db.playbookRun.findFirst({
    where: { id: session.playbookRunId },
    select: {
      dryRun: true,
      installation: {
        select: {
          id: true,
          settings: true,
          manifest: true,
          project: { select: { name: true, folder: true } },
        },
      },
    },
  })
  if (!run) return { error: 'This playbook run is gone.' }
  if (run.dryRun)
    return {
      error: "A dry run files nothing: say in playbook_report's summary what you would have filed.",
    }
  const settings = (run.installation.settings ?? {}) as Record<string, unknown>
  const place = ideasPlace(settings.ideas, run.installation.project)
  // Only where its teammate may save: a folder people closed to it stays closed.
  if ((await teammateLibraryAccess(db, teammate)).of(place.path) !== 'read_write')
    return {
      error:
        `You may not change ${place.path}, the playbook's ideas list: say in playbook_report's ` +
        'summary what was asked, for a person to keep it.',
    }
  const name = (run.installation.manifest as PlaybookManifest | null)?.name ?? 'This'
  const id = await addListLine(
    db,
    scope,
    { type: 'teammate', id: teammate.id },
    {
      path: place.path,
      header: ideasHeader(name),
      text: `${op.text} (from “${session.title}”)`,
      ...(place.section ? { section: place.section } : {}),
    },
  )
  await audit({
    ...scope,
    actor: { type: 'teammate', id: teammate.id },
    action: 'playbook.idea_filed',
    target: { type: 'playbook', id: run.installation.id },
    data: { path: place.path, itemId: id, sessionId: session.id },
  })
  return {
    filed: { path: place.path, id },
    note: `Kept as a line of ${place.path}: it starts nothing, a person decides what to do with it.`,
  }
}
