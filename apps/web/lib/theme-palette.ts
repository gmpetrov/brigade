// A theme's colours on the dashboard's tokens (app/theme.css): its canvas and accent give a
// whole palette, mixed in the browser with color-mix, and its single colours go over it.
// docs/themes.md.
import type { ThemeFile } from '@brigade/contracts'

export type Mode = 'light' | 'dark'
type Rgb = [number, number, number]

export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = Number.parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Relative luminance (WCAG). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** Whether a background reads as light or dark: the dashboard turns to match it. */
export const modeOf = (canvas: string): Mode =>
  luminance(parseHex(canvas)) < 0.2 ? 'dark' : 'light'

/** Text that reads on a colour: near-white or near-black, whichever contrasts more. */
export function inkOn(color: string): string {
  const rgb = parseHex(color)
  return contrast(rgb, [255, 255, 255]) >= contrast(rgb, [17, 17, 19]) ? '#ffffff' : '#111113'
}

const mix = (base: string, other: string, percent: number) =>
  `color-mix(in oklab, ${base}, ${other} ${percent}%)`

/** Tokens a canvas gives: surfaces, borders and text, mixed from it and its ink. */
export function canvasTokens(canvas: string): Record<string, string> {
  const dark = modeOf(canvas) === 'dark'
  const ink = dark ? '#f4f4f5' : '#0b0b0d'
  return {
    background: canvas,
    foreground: ink,
    card: mix(canvas, ink, dark ? 5 : 1.5),
    'card-foreground': ink,
    popover: mix(canvas, ink, dark ? 7 : 1),
    'popover-foreground': ink,
    secondary: mix(canvas, ink, dark ? 12 : 7),
    'secondary-foreground': ink,
    muted: mix(canvas, ink, dark ? 9 : 4),
    'muted-foreground': mix(ink, canvas, dark ? 32 : 40),
    accent: mix(canvas, ink, dark ? 12 : 7),
    'accent-foreground': ink,
    border: mix(canvas, ink, dark ? 14 : 10),
    input: mix(canvas, ink, dark ? 16 : 12),
    sidebar: mix(canvas, ink, dark ? 3 : 2.5),
    'sidebar-foreground': ink,
    'sidebar-accent': mix(canvas, ink, dark ? 12 : 7),
    'sidebar-accent-foreground': ink,
    'sidebar-border': mix(canvas, ink, dark ? 12 : 8),
  }
}

/** Tokens an accent gives: buttons, links, focus, and text that reads on them. */
export function accentTokens(accent: string): Record<string, string> {
  const ink = inkOn(accent)
  return {
    primary: accent,
    'primary-foreground': ink,
    ring: accent,
    'sidebar-primary': accent,
    'sidebar-primary-foreground': ink,
    'sidebar-ring': accent,
    'chart-2': accent,
  }
}

/**
 * The custom properties a theme sets on the page, and the mode its canvas wants (null: the
 * person's own light or dark look stays).
 */
export function themeTokens(theme: ThemeFile): { mode: Mode | null; vars: Record<string, string> } {
  const vars: Record<string, string> = {
    ...(theme.canvas ? canvasTokens(theme.canvas) : {}),
    ...(theme.accent ? accentTokens(theme.accent) : {}),
    ...theme.colors,
  }
  if (theme.radius) vars.radius = theme.radius
  if (theme.font) vars['font-sans'] = theme.font
  if (theme.fontMono) vars['font-mono'] = theme.fontMono
  return { mode: theme.canvas ? modeOf(theme.canvas) : null, vars }
}
