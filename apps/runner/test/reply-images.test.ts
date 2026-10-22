import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { imagesIn, readReplyImages } from '../src/reply-images.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

test('a reply names its images by path, as the dashboard reads them', () => {
  assert.deepEqual(
    imagesIn(
      [
        '![Top of the landing](/tmp/rec/m0.png)',
        'See [the chart](./out/chart.JPG "Chart") and ![again](/tmp/rec/m0.png).',
        '![spaced](<shots/a b.webp>) ![encoded](shots/a%20c.gif#x)',
        '[a page](https://example.com/a.png) [notes](notes.md) [top](#top) ![](//cdn.example.com/x.png)',
      ].join('\n'),
    ),
    ['/tmp/rec/m0.png', 'out/chart.JPG', 'shots/a b.webp', 'shots/a c.gif'],
  )
})

test('images on the computer come as data: URLs; missing ones and non-images are left out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-images-'))
  const workDir = join(root, 'thread')
  await mkdir(join(workDir, 'shots'), { recursive: true })
  await writeFile(join(workDir, 'shots', 'a.png'), PNG)
  await writeFile(join(root, 'elsewhere.png'), PNG)
  await writeFile(join(workDir, 'fake.png'), 'not an image')
  const images = await readReplyImages(
    `![a](shots/a.png) ![b](${join(root, 'elsewhere.png')}) ![c](fake.png) ![d](gone.png)`,
    { workDir },
  )
  const url = `data:image/png;base64,${PNG.toString('base64')}`
  assert.deepEqual(images, { 'shots/a.png': url, [join(root, 'elsewhere.png')]: url })
})
