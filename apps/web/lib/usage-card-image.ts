// The Usage card as an image: drawn on a canvas in the browser, in the theme the page shows,
// from what lib/usage-card.ts lays out. Counts only, as on the page.
import type { UsageResponse } from '@brigade/contracts'
import { HARNESS_MARKS } from '@/components/harness-logo'
import { cardGrid, cardText, shades } from '@/lib/usage-card'

const WIDTH = 1200
const HEIGHT = 630
const PAD = 72
/** Each shade's opacity of the primary color; 0 is an empty cell, in the muted color. */
const SHADE_ALPHA = [0, 0.3, 0.55, 0.8, 1]
/** Brigade's pebble, as in app/icon.svg (100 by 100), and its eyes. */
const PEBBLE = 'M56 0A44 56 0 0 1 100 56A40 44 0 0 1 60 100A60 54 0 0 1 0 46A56 46 0 0 1 56 0Z'
const EYES = 'M34.5 44Q40.5 28 46.5 44M53.5 44Q59.5 28 65.5 44'

/** The theme's colors and font, as the page shows them now. */
function look() {
  const css = getComputedStyle(document.documentElement)
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    background: color('--background', '#fff'),
    foreground: color('--foreground', '#000'),
    muted: color('--muted', '#f2f2f2'),
    mutedForeground: color('--muted-foreground', '#666'),
    primary: color('--primary', '#6c43e6'),
    success: color('--success', '#16a34a'),
    font: getComputedStyle(document.body).fontFamily || 'sans-serif',
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
  ctx.fill()
}

/** Draw a path made for a square box of `box` units at (x, y), `size` pixels wide. */
function mark(
  ctx: CanvasRenderingContext2D,
  path: string,
  box: number,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / box, size / box)
  ctx.fillStyle = color
  ctx.fill(new Path2D(path))
  ctx.restore()
}

export async function drawCard(data: UsageResponse): Promise<Blob> {
  const theme = look()
  const font = (weight: number, size: number) => `${weight} ${size}px ${theme.font}`
  await Promise.all([800, 700, 600].map((w) => document.fonts.load(font(w, 40)))).catch(() => {})
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')!
  const text = cardText(data)

  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, WIDTH, HEIGHT)

  // The period, then the total and how much it rose.
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = theme.mutedForeground
  ctx.font = font(600, 24)
  ctx.letterSpacing = '2px'
  ctx.fillText(text.title.toUpperCase(), PAD, PAD + 22)
  ctx.letterSpacing = '-1.5px'
  ctx.fillStyle = theme.foreground
  ctx.font = font(800, 76)
  ctx.fillText(text.total, PAD, PAD + 112)
  if (text.rise !== null) {
    const width = ctx.measureText(text.total).width
    const label = `▲ ${text.rise}%`
    ctx.letterSpacing = '0px'
    ctx.font = font(700, 26)
    const pill = ctx.measureText(label).width + 36
    const x = PAD + width + 24
    ctx.save()
    ctx.globalAlpha = 0.15
    ctx.fillStyle = theme.success
    roundRect(ctx, x, PAD + 60, pill, 50, 25)
    ctx.restore()
    ctx.fillStyle = theme.success
    ctx.fillText(label, x + 18, PAD + 95)
  }
  ctx.letterSpacing = '0px'

  // The providers it was spent on, top right.
  ctx.font = font(600, 22)
  let right = WIDTH - PAD
  for (const provider of [...text.providers].reverse()) {
    const label = provider === 'codex' ? 'Codex' : 'Claude'
    const width = ctx.measureText(label).width
    ctx.fillStyle = theme.mutedForeground
    ctx.fillText(label, right - width, PAD + 24)
    const m = HARNESS_MARKS[provider]
    mark(ctx, m.path, 24, right - width - 40, PAD - 4, 30, m.color ?? theme.foreground)
    right -= width + 40 + 28
  }

  // The grid, as large as the space between the total and the footer allows.
  const grid = cardGrid(data.days, data.quarters)
  const shade = shades(grid.cells)
  const top = PAD + 160
  const bottom = HEIGHT - PAD - 56
  const width = WIDTH - 2 * PAD
  const height = bottom - top
  const step = Math.min(width / (grid.columns - 0.2), height / (grid.rows - 0.2))
  const cell = step * 0.8
  const left = PAD + (width - (grid.columns * step - step * 0.2)) / 2
  const y0 = top + (height - (grid.rows * step - step * 0.2)) / 2
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      const s = shade[row * grid.columns + column]!
      ctx.save()
      ctx.fillStyle = s ? theme.primary : theme.muted
      ctx.globalAlpha = s ? SHADE_ALPHA[s]! : 1
      roundRect(ctx, left + column * step, y0 + row * step, cell, cell, cell * 0.2)
      ctx.restore()
    }

  // Brigade, bottom left.
  mark(ctx, PEBBLE, 100, PAD, HEIGHT - PAD - 30, 32, theme.primary)
  ctx.save()
  ctx.translate(PAD, HEIGHT - PAD - 30)
  ctx.scale(0.32, 0.32)
  ctx.strokeStyle = theme.background
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  ctx.stroke(new Path2D(EYES))
  ctx.restore()
  ctx.fillStyle = theme.mutedForeground
  ctx.font = font(600, 24)
  ctx.fillText('Brigade · brigade.lol', PAD + 46, HEIGHT - PAD - 4)

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not draw the card'))),
      'image/png',
    ),
  )
}
