import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'
import { githubSourceKey, parseGitHubUrl, readSkills, zipballRoot } from '../src/skill-import.js'

const SKILL =
  '---\nname: Release Notes\ndescription: Write release notes from merged PRs\n---\n\nSteps.\n'

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort()

test('reads a SKILL.md', () => {
  const [skill] = readSkills('SKILL.md', strToU8(SKILL))
  assert.deepEqual(skill, {
    folder: '',
    name: 'release-notes',
    description: 'Write release notes from merged PRs',
    instructions: 'Steps.',
    files: [],
    skipped: [],
  })
})

test('reads a zipped folder: every file beside SKILL.md, binaries too', () => {
  const zip = zipSync({
    'release-notes/SKILL.md': strToU8(SKILL),
    'release-notes/template.md': strToU8('# {version}'),
    'release-notes/scripts/prs.sh': strToU8('gh pr list'),
    'release-notes/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    'release-notes/.DS_Store': strToU8('x'),
    '__MACOSX/release-notes/._SKILL.md': strToU8('x'),
  })
  const [skill, ...rest] = readSkills('release-notes.skill', zip)
  assert.equal(rest.length, 0)
  assert.equal(skill!.name, 'release-notes')
  assert.equal(skill!.folder, 'release-notes')
  assert.deepEqual(paths(skill!.files), ['logo.png', 'scripts/prs.sh', 'template.md'])
})

test('reads a pack: each skill with its own files, not a deeper one’s', () => {
  const zip = zipSync({
    'README.md': strToU8('A pack'),
    'skills/pdf/SKILL.md': strToU8('---\nname: pdf\ndescription: PDFs\n---\nUse it.'),
    'skills/pdf/forms.md': strToU8('forms'),
    'skills/pdf/fonts/Inter.ttf': new Uint8Array([0, 1, 0, 0]),
    'skills/docx/SKILL.md': strToU8('---\nname: docx\ndescription: Word\n---\nUse it.'),
    'skills/docx/template.docx': new Uint8Array([0x50, 0x4b, 3, 4]),
    'skills/docx/nested/SKILL.md': strToU8('---\nname: nested\ndescription: Inner\n---\nIn.'),
    'skills/docx/nested/inner.md': strToU8('inner'),
  })
  const found = readSkills('pack.zip', zip)
  assert.deepEqual(
    found.map((f) => [f.folder, f.name, paths(f.files)]),
    [
      ['skills/docx', 'docx', ['template.docx']],
      ['skills/docx/nested', 'nested', ['inner.md']],
      ['skills/pdf', 'pdf', ['fonts/Inter.ttf', 'forms.md']],
    ],
  )
  assert.deepEqual(
    readSkills('pack.zip', zip, 'skills/pdf').map((f) => f.name),
    ['pdf'],
  )
})

test('names a skill without one after its folder', () => {
  const zip = zipSync({ 'triage/SKILL.md': strToU8('---\ndescription: Sort issues\n---\nDo it.') })
  assert.equal(readSkills('upload.zip', zip)[0]!.name, 'triage')
})

test('refuses a zip without SKILL.md', () => {
  const zip = zipSync({ 'notes.md': strToU8('hi') })
  assert.throws(() => readSkills('x.zip', zip), HTTPException)
})

test('reads GitHub addresses: a repository, a folder, a SKILL.md', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/anthropics/skills'), {
    owner: 'anthropics',
    repo: 'skills',
    path: '',
  })
  assert.deepEqual(parseGitHubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf'), {
    owner: 'anthropics',
    repo: 'skills',
    ref: 'main',
    path: 'skills/pdf',
  })
  assert.deepEqual(
    parseGitHubUrl('https://github.com/acme/kit.git/blob/v2/release-notes/SKILL.md')?.path,
    'release-notes',
  )
  for (const url of ['https://gitlab.com/a/b', 'https://github.com/a', 'not a url'])
    assert.equal(parseGitHubUrl(url), null, url)
  assert.equal(
    githubSourceKey(parseGitHubUrl('https://github.com/Anthropics/Skills')!),
    'https://github.com/anthropics/skills',
  )
})

test('finds the folder a GitHub zipball holds everything in', () => {
  const zip = zipSync({
    'anthropics-skills-abc123/': new Uint8Array(),
    'anthropics-skills-abc123/pdf/SKILL.md': strToU8(SKILL),
  })
  assert.equal(zipballRoot(zip), 'anthropics-skills-abc123')
})
