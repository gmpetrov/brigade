// Skills load through the harness's own skills folder, like memory through its
// instruction file: `.claude/skills/<name>/SKILL.md` for Claude Code,
// `.agents/skills/<name>/SKILL.md` for Codex, in the thread's working
// directory, written each time its harness session starts. Both list a skill by
// its name and description, and read the rest only when the work calls for it.
// A folder there that Brigade did not write is left alone. A skill's files
// come from the API by their SHA-256, cached on the computer. Imports keep no
// file modes, so a file that starts with `#!` is written executable: a skill's
// launcher script (Impeccable's `scripts/impeccable`) runs by its path.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { SKILL_ENTRY, type ThreadSkill, type ThreadSpec, skillMarkdown } from '@brigade/contracts'

/** Names of the folders Brigade wrote last time, so it replaces only those. */
const MANIFEST = '.brigade-skills.json'

export const skillsDir = (spec: ThreadSpec) =>
  spec.teammate.harness === 'codex' ? join('.agents', 'skills') : join('.claude', 'skills')

// Run by node as the teammate's user, the skills as JSON on stdin. Folders in
// the old manifest go; a folder Brigade did not write keeps its name. A script
// (it starts with `#!`) is executable.
const SCRIPT = `
const fs = require('node:fs'), path = require('node:path')
const root = process.argv[1]
let input = ''
process.stdin.setEncoding('utf8').on('data', (d) => (input += d)).on('end', () => {
  const skills = JSON.parse(input)
  fs.mkdirSync(root, { recursive: true })
  const manifest = path.join(root, '${MANIFEST}')
  let old = []
  try { old = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch {}
  if (!Array.isArray(old)) old = []
  const safe = (name) => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name)
  for (const name of old) if (safe(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  const written = []
  for (const skill of skills) {
    if (!safe(skill.name)) continue
    const dir = path.join(root, skill.name)
    if (fs.existsSync(dir)) continue
    for (const file of skill.files) {
      const target = path.resolve(dir, file.path)
      if (!target.startsWith(dir + path.sep)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const bytes = Buffer.from(file.base64, 'base64')
      const script = bytes[0] === 0x23 && bytes[1] === 0x21
      fs.writeFileSync(target, bytes, { mode: script ? 0o755 : 0o644 })
    }
    written.push(skill.name)
  }
  fs.writeFileSync(manifest, JSON.stringify(written))
})
`

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

/**
 * Each skill as the files of its folder, SKILL.md first. A file that cannot be
 * fetched is left out, said in the log; the skill still loads.
 */
async function folders(skills: ThreadSkill[], skillFile: (sha256: string) => Promise<Buffer>) {
  return Promise.all(
    skills.map(async (skill) => {
      const refs = await Promise.all(
        (skill.refs ?? []).map((ref) =>
          skillFile(ref.sha256).then(
            (bytes) => [{ path: ref.path, base64: bytes.toString('base64') }],
            (error: unknown) => {
              console.warn(`skill ${skill.name}: no ${ref.path}: ${String(error)}`)
              return []
            },
          ),
        ),
      )
      return {
        name: skill.name,
        files: [
          { path: SKILL_ENTRY, base64: base64(skillMarkdown(skill)) },
          ...(skill.files ?? []).map((f) => ({ path: f.path, base64: base64(f.content) })),
          ...refs.flat(),
        ],
      }
    }),
  )
}

/** Write the skills into the working directory, as the teammate's user on a cloud computer. */
export async function writeSkills(
  workDir: string,
  spec: ThreadSpec,
  skills: ThreadSkill[],
  skillFile: (sha256: string) => Promise<Buffer>,
  runAs?: string,
) {
  const input = JSON.stringify(await folders(skills, skillFile))
  const root = join(workDir, skillsDir(spec))
  const node = [process.execPath, '-e', SCRIPT, root]
  const [command, ...args] = runAs ? ['sudo', '-n', '-u', runAs, '--', ...node] : node
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command!, args, { cwd: '/', stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-500) || `exit ${code}`)),
    )
    // A command that exits without reading its input closes the pipe: its exit says why.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}
