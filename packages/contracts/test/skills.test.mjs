import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SkillContent,
  SkillName,
  parseSkillMarkdown,
  skillMarkdown,
  skillSlug,
} from '../dist/skills.js'

test('reads a SKILL.md: frontmatter, then the instructions', () => {
  const parsed = parseSkillMarkdown(
    '---\nname: release-notes\ndescription: "Write release notes: from merged PRs"\n---\n\n# Steps\n\n1. List PRs\n',
  )
  assert.deepEqual(parsed, {
    name: 'release-notes',
    description: 'Write release notes: from merged PRs',
    instructions: '# Steps\n\n1. List PRs',
  })
})

test('reads folded descriptions, single quotes and Windows line ends', () => {
  const folded = parseSkillMarkdown(
    '---\r\nname: pdf\r\ndescription: >\r\n  Fill PDF forms\r\n  and merge files.\r\nlicense: MIT\r\n---\r\nBody\r\n',
  )
  assert.equal(folded.description, 'Fill PDF forms and merge files.')
  assert.equal(folded.instructions, 'Body')
  assert.equal(parseSkillMarkdown("---\nname: x\ndescription: 'it''s'\n---\n").description, "it's")
})

test('a file without frontmatter is all instructions', () => {
  assert.deepEqual(parseSkillMarkdown('Just steps.\n'), { instructions: 'Just steps.' })
})

test('writes a SKILL.md the parser reads back', () => {
  const skill = {
    name: 'triage',
    description: 'Sort new issues: label, assign',
    instructions: 'Do it.',
  }
  assert.deepEqual(parseSkillMarkdown(skillMarkdown(skill)), skill)
})

test('names are slugs, not Brigade’s own', () => {
  assert.equal(SkillName.parse('Release-Notes'), 'release-notes')
  for (const name of ['brigade-designs', 'design', 'visual', 'two words', 'trailing-', ''])
    assert.equal(SkillName.safeParse(name).success, false, name)
  assert.equal(skillSlug('Écrire les notes de version!'), 'ecrire-les-notes-de-version')
})

test('files stay inside the skill', () => {
  const base = { name: 'x', description: 'd', instructions: 'i' }
  for (const path of ['../up.md', '/abs.md', 'a/../b.md', 'SKILL.md', 'a//b.md'])
    assert.equal(
      SkillContent.safeParse({ ...base, files: [{ path, content: '' }] }).success,
      false,
      path,
    )
  assert.equal(
    SkillContent.safeParse({ ...base, files: [{ path: 'scripts/check.sh', content: 'ls' }] })
      .success,
    true,
  )
})
