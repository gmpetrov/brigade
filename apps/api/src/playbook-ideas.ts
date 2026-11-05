// A playbook's live run keeps an idea for the team, such as a customer's feature request
// (file_idea): one line in the playbook's ideas list, linked to no thread, which starts nothing.
// A person moves it into their backlog, hands it to a teammate or deletes it. It took the place of
// a task in the Tasks board's Backlog (docs/hand-offs.md). The list is the playbook's `ideas`
// setting when it has one (a library path, with the heading of a section after #), else ideas.md
// in its project's folder or at the library's root, made when missing as Chief's parked list is.
// The line goes under that heading, else under "Ideas", added at the end of the file when it has
// none by that name. The run never chooses where: what it read is untrusted, and a line in another
// list, or under another heading, could be work a routine takes up.
import { projectFolder, type PlaybookManifest } from '@brigade/contracts'
import { HTTPException } from 'hono/http-exception'
import { audit } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import { teammateLibraryAccess } from './library-folders.js'
import { addListLine } from './lists.js'

/** The file a playbook's ideas go to when its settings name none. */
export const IDEAS_FILE = 'ideas.md'

/** The heading they go under when its settings name none: the file's own title, made so. */
export const IDEAS_SECTION = 'Ideas'

/** What an ideas list made for a playbook starts with. */
export const ideasHeader = (playbook: string) =>
  `# Ideas\n\nIdeas the ${playbook} playbook kept for the team. Move a line to your backlog, hand it ` +
  'to a teammate, or delete it.\n'

/**
 * Where a playbook's ideas go: its `ideas` setting (`path` or `path#Section`, a Markdown file of
 * the library), else ideas.md in its project's folder, else at the library's root; under the
 * section it names, else under "Ideas".
 */
export function ideasPlace(
  setting: unknown,
  project: { name: string; folder: string | null } | null,
): { path: string; section: string } {
  const value = typeof setting === 'string' ? setting.trim() : ''
  const hash = value.indexOf('#')
  const path = (hash >= 0 ? value.slice(0, hash) : value).trim().replace(/^\/+/, '')
  const section = (hash >= 0 ? value.slice(hash + 1).trim() : '') || IDEAS_SECTION
  if (path) return { path: /\.md$/i.test(path) ? path : `${path}.md`, section }
  return {
    path: project ? `${project.folder ?? projectFolder(project.name)}/${IDEAS_FILE}` : IDEAS_FILE,
    section: IDEAS_SECTION,
  }
}

/** file_idea, from a playbook's run: a line at the end of its section of its ideas list. */
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
  const settings = (run.installation.settings ?? {}) as Record<string, unknown>
  const place = ideasPlace(settings.ideas, run.installation.project)
  // A dry run's writes are simulated: it says where the line would go, and writes nothing.
  if (run.dryRun)
    return {
      simulated: true,
      wouldFile: { path: place.path, section: place.section, text: op.text },
      note: 'A dry run files nothing: in a live run, this line would go to that list.',
    }
  // Only where its teammate may save: a folder people closed to it stays closed.
  if ((await teammateLibraryAccess(db, teammate)).of(place.path) !== 'read_write')
    return {
      error:
        `You may not change ${place.path}, the playbook's ideas list: say in playbook_report's ` +
        'summary what was asked, for a person to keep it.',
    }
  const name = (run.installation.manifest as PlaybookManifest | null)?.name ?? 'This'
  let id: string
  try {
    id = await addListLine(
      db,
      scope,
      { type: 'teammate', id: teammate.id },
      {
        path: place.path,
        header: ideasHeader(name),
        text: `${op.text} (from “${session.title}”)`,
        section: place.section,
      },
    )
  } catch (error) {
    // A setting naming no file that can be a list, say: the run says so, a person keeps the idea.
    if (error instanceof HTTPException)
      return {
        error:
          `The idea could not go to ${place.path}: ${error.message}. Say in playbook_report's ` +
          'summary what was asked, for a person to keep it.',
      }
    throw error
  }
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
