// Writes src/generated/playbooks.ts from the playbook templates in playbooks/<id>/: the API runs on
// Workers too, which have no files, so the templates ship inside its code. Each template is
// its playbook.yaml, parsed, and its text files by path. src/playbooks.ts checks them when it loads.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'yaml'

const root = new URL('..', import.meta.url).pathname
const dir = join(root, 'playbooks')
const out = join(root, 'src/generated/playbooks.ts')

/** Every file under a folder, by its path in it; hidden files left out. */
function files(folder) {
  const found = {}
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (name.startsWith('.')) continue
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else found[relative(folder, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(folder)
  return found
}

const templates = {}
for (const name of readdirSync(dir).sort()) {
  const folder = join(dir, name)
  if (!statSync(folder).isDirectory()) continue
  const all = files(folder)
  const yaml = all['playbook.yaml']
  if (yaml === undefined) throw new Error(`playbooks/${name} has no playbook.yaml`)
  delete all['playbook.yaml']
  let manifest
  try {
    manifest = parse(yaml)
  } catch (error) {
    throw new Error(`playbooks/${name}/playbook.yaml: ${error.message}`)
  }
  templates[name] = { manifest, files: all }
}

mkdirSync(join(root, 'src/generated'), { recursive: true })
writeFileSync(
  out,
  '// Written by scripts/playbooks.mjs from playbooks/: do not edit.\n' +
    `export const LOOP_TEMPLATES: Record<string, { manifest: unknown; files: Record<string, string> }> = ${JSON.stringify(templates, null, 2)}\n`,
)
