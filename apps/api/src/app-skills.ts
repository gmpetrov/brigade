// The skills that come with an App: a GitHub repository of skills, imported as a
// pack of the App when its first account connects. Its skills load only for
// teammates that can use one of the App's accounts (threadSkills).
import type { Actor } from './audit.js'
import type { Scope, ScopedDb } from './db.js'
import { githubSourceKey, parseGitHubUrl, readGitHubSkills } from './skill-import.js'
import { previewImport, savePack } from './skills.js'

/**
 * Import (or update) an App's skills. Skills whose names another pack or the
 * workspace already uses are left out; the rest are added as the App's pack.
 * Returns how many it added, and those left out with why.
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
  const found = (await readGitHubSkills(source))
    // A repository may keep an older copy of a skill deeper down (Atlassian's skills/v1):
    // of skills with the same name, only the shallowest is the App's.
    .filter((f, _, all) => {
      const depth = (s: typeof f) => s.folder.split('/').length
      return !all.some((o) => o.name === f.name && depth(o) < depth(f))
    })
  const preview = await previewImport(db, scope, githubSourceKey(source), app.name, found)
  const usable = (s: (typeof preview.skills)[number]) =>
    s.status === 'new' || s.status === 'update' || s.status === 'same'
  const skipped = preview.skills
    .filter((s) => !usable(s))
    .map((s) => ({ name: s.name || s.folder, problem: s.problem ?? s.status }))
  const skills = preview.skills.filter(usable).map((s) => ({
    name: s.name,
    description: s.description,
    instructions: s.instructions,
    files: s.files,
    enabled: s.enabled ?? true,
  }))
  if (skills.length === 0) return { added: 0, skipped }
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
  return { added: skills.length, skipped }
}
