import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { HTTPException } from 'hono/http-exception'
import { githubSourceKey, parseGitHubUrl, readSkills, readTarball } from '../src/skill-import.js'

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

/** A tarball as GitHub makes one: a pax global header, then everything under one folder. */
function tarball(files: Record<string, Uint8Array>) {
  const block = (name: string, size: number, type: string) => {
    const header = new Uint8Array(512)
    header.set(strToU8(name.slice(0, 100)))
    header.set(strToU8(`${size.toString(8).padStart(11, '0')}\0`), 124)
    header[156] = type.charCodeAt(0)
    header.set(strToU8('ustar\0'), 257)
    return header
  }
  const pad = (data: Uint8Array) => {
    const out = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
    out.set(data)
    return out
  }
  const parts = [block('pax_global_header', 52, 'g'), pad(strToU8('52 comment=abc\n'.padEnd(52)))]
  parts.push(block('acme-kit-abc123/', 0, '5'))
  for (const [name, data] of Object.entries(files)) {
    const path = `acme-kit-abc123/${name}`
    if (path.length > 100) {
      const record = strToU8(` path=${path}\n`)
      let length = record.byteLength + 1
      while (String(length).length + record.byteLength > length) length++
      const line = new Uint8Array([...strToU8(String(length)), ...record])
      parts.push(block('PaxHeader', line.byteLength, 'x'), pad(line))
    }
    parts.push(block(path, data.byteLength, '0'), pad(data))
  }
  parts.push(new Uint8Array(1024))
  return new Blob(parts).stream()
}

test('reads only a folder of a GitHub tarball, its paths from the repository root', async () => {
  const long = `skills/pdf/${'deep/'.repeat(20)}note.md`
  // A path may hold a newline: it must not end the pax record early.
  const tricky = `skills/pdf/SKILL.md\n${'x'.repeat(100)}`
  const entries = await readTarball(
    tarball({
      'README.md': strToU8('# Kit'),
      'skills/pdf/SKILL.md': strToU8(SKILL),
      'skills/pdf/form.md': strToU8('fill it'),
      [long]: strToU8('far down'),
      [tricky]: strToU8('not the SKILL.md'),
      'skills/pdf/.cache/x': strToU8('x'),
      'skills/other/SKILL.md': strToU8(SKILL),
      'assets/video.bin': new Uint8Array(4096),
    }),
    'skills/pdf',
  )
  assert.deepEqual(
    Object.keys(entries).sort(),
    ['skills/pdf/SKILL.md', long, 'skills/pdf/form.md', tricky].sort(),
  )
  assert.equal(new TextDecoder().decode(entries['skills/pdf/form.md']!), 'fill it')
  assert.equal(new TextDecoder().decode(entries['skills/pdf/SKILL.md']!), SKILL)
})

test('a GitHub folder keeps its files to 50 MB, whatever the repository holds besides', async () => {
  const big = new Uint8Array(9 * 1024 * 1024)
  const files: Record<string, Uint8Array> = { 'skills/pdf/SKILL.md': strToU8(SKILL) }
  for (let i = 0; i < 8; i++) files[`assets/big-${i}.bin`] = big
  const entries = await readTarball(tarball(files), 'skills/pdf')
  assert.deepEqual(Object.keys(entries), ['skills/pdf/SKILL.md'])
  for (let i = 0; i < 6; i++) files[`skills/pdf/part-${i}.bin`] = big
  await assert.rejects(readTarball(tarball(files), 'skills/pdf'), (error: HTTPException) => {
    assert.equal(error.status, 413)
    return true
  })
})
