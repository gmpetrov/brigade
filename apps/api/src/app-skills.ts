// The skills that come with an App: a GitHub repository of skills, imported as a
// pack of the App when its first account connects. Its skills load only for
// teammates that can use one of the App's accounts (threadSkills).
import type { Actor } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import {
  fetchGitHubZip,
  githubSourceKey,
  parseGitHubUrl,
  readSkills,
  zipballRoot,
} from './skill-import.js'
import { previewImport, savePack } from './skills.js'

/**
 * Import (or update) an App's skills. Skills whose names another pack or the
 * workspace already uses are left out; the rest are added as the App's pack.
 * Returns how many it holds.
 */
export async function installAppSkills(
  db: ScopedDb,
  scope: Scope,
  actor: Actor,
  app: { id: string; name: string },
  repository: string,
) {
  const source = parseGitHubUrl(repository)
  if (!source) throw new Error(`Not a GitHub address: ${repository}`)
  const bytes = await fetchGitHubZip(source)
  const root = zipballRoot(bytes)
  const found = readSkills(
    `${source.repo}.zip`,
    bytes,
    [root, source.path].filter(Boolean).join('/'),
  ).map((f) => ({ ...f, folder: f.folder.slice(root.length + 1) }))
  const preview = await previewImport(db, scope, githubSourceKey(source), app.name, found)
  const skills = preview.skills
    .filter((s) => s.status === 'new' || s.status === 'update' || s.status === 'same')
    .map((s) => ({
      name: s.name,
      description: s.description,
      instructions: s.instructions,
      files: s.files,
      enabled: s.enabled ?? true,
    }))
  if (skills.length === 0) return 0
  // Every thread may get them; threadSkills keeps them to teammates with the App.
  const pack = await savePack(db, scope, actor, {
    name: app.name,
    source: preview.source,
    everywhere: true,
    teammateIds: [],
    projectIds: [],
    skills,
  })
  await db.skillPack.updateMany({ where: { id: pack.id }, data: { appId: app.id } })
  return skills.length
}
