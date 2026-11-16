// Themes (docs/themes.md): a person's own look for the dashboard, made by talking with a
// teammate. Colours land on the dashboard's colour tokens, a stylesheet goes after the app's own,
// and the files it uses (images, fonts) live in the bucket. A theme is one member's: it changes
// only their windows. Nothing in it may load from anywhere else: the API checks its text, and the
// dashboard checks each parsed rule before applying it (apps/web/lib/theme).
import { z } from 'zod'

export const THEME_LIMITS = {
  /** Characters of a theme's stylesheet. */
  cssChars: 100_000,
  /** Bytes of one theme file. */
  fileBytes: 5 * 1024 * 1024,
  /** Files of one theme. */
  filesPerTheme: 30,
  /** Themes one member keeps. */
  themesPerMember: 50,
  /** Look changes kept to go back to. */
  history: 30,
} as const

/** A saved theme's id: also how a teammate names it. */
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,47}$/
/** Ids no saved theme may take: the built-in looks (`none` takes the theme off). */
export const BUILT_IN_LOOKS = ['none', 'light', 'dark', 'system'] as const
export type BuiltInLook = (typeof BUILT_IN_LOOKS)[number]

/**
 * A theme file's name. Images and fonts only: no SVG, which a browser may run as a page when
 * someone opens its address.
 */
export const THEME_FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,79}\.(png|jpe?g|webp|gif|avif|woff2?|ttf|otf)$/

export const THEME_FILE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

export const themeFileType = (name: string): string | undefined =>
  THEME_FILE_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]

/** How a theme's stylesheet names one of its files: `url("theme:<file>")`. */
export const THEME_FILE_SCHEME = 'theme:'

/** The dashboard's colour tokens a theme may set (apps/web/app/theme.css), as `--<token>`. */
export const THEME_COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const
export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number]

/** What each token paints, for the teammate's guide. */
export const THEME_TOKEN_HELP: Readonly<Record<ThemeColorToken, string>> = {
  background: 'the page behind everything',
  foreground: 'main text',
  card: 'cards: tickets, questions, sub-threads',
  'card-foreground': 'text on cards',
  popover: 'menus, popovers and dialogs',
  'popover-foreground': 'text in them',
  primary: 'main buttons, links and highlights',
  'primary-foreground': 'text on primary',
  secondary: 'secondary buttons and soft fills',
  'secondary-foreground': 'text on secondary',
  muted: 'quiet fills: the composer, hovered rows',
  'muted-foreground': 'quieter text: captions, times, hints',
  accent: 'a hovered or chosen item',
  'accent-foreground': 'text on accent',
  destructive: 'errors and delete',
  'destructive-foreground': 'text on destructive',
  border: 'borders and dividers',
  input: 'text fields’ borders',
  ring: 'the keyboard focus ring',
  sidebar: 'the sidebar',
  'sidebar-foreground': 'text in the sidebar',
  'sidebar-primary': 'the sidebar’s highlights',
  'sidebar-primary-foreground': 'text on them',
  'sidebar-accent': 'the sidebar’s hovered or current row',
  'sidebar-accent-foreground': 'text on it',
  'sidebar-border': 'the sidebar’s borders',
  'sidebar-ring': 'the focus ring in the sidebar',
  'chart-1': 'charts',
  'chart-2': 'charts',
  'chart-3': 'charts',
  'chart-4': 'charts',
  'chart-5': 'charts',
}

const Hex = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, 'a hex colour such as #1a2b3c')

/** Security: a colour lands in a custom property the app's rules read, so it may never name a file. */
const Color = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[#a-z0-9(),.%\s/+-]+$/i, 'a CSS colour such as #1a2b3c, oklch(…) or color-mix(…)')
  .refine((value) => !/url|image|src|attr|var/i.test(value), 'a colour, not a file')

const Font = z
  .string()
  .trim()
  .max(300)
  .regex(/^[\w\s"',.-]*$/, 'a font-family list such as "Inter", sans-serif')

/** A theme as it is saved, exported and sent by a teammate. */
export const ThemeFile = z
  .object({
    name: z.string().trim().min(1).max(60),
    /**
     * The base background, as hex: the dashboard derives its surfaces, borders and text from it,
     * and turns light or dark to match it. Absent: the person's light or dark look stays.
     */
    canvas: Hex.optional(),
    /** The highlight, as hex: buttons, links, the focus ring. */
    accent: Hex.optional(),
    /** Single tokens, over what canvas and accent derive. */
    colors: z.partialRecord(z.enum(THEME_COLOR_TOKENS), Color).optional(),
    /** Roundness: a CSS length such as 0.5rem; 0 for square corners. */
    radius: z
      .string()
      .trim()
      .regex(/^(0|\d{1,2}(\.\d{1,3})?(rem|px|em))$/, 'a length such as 0.5rem or 8px')
      .optional(),
    /** The font-family list of the text; a theme file can bring one with @font-face. */
    font: Font.optional(),
    /** The font-family list of code. */
    fontMono: Font.optional(),
    /** A stylesheet applied after the dashboard's own. */
    css: z.string().max(THEME_LIMITS.cssChars).optional(),
  })
  .strict()
export type ThemeFile = z.infer<typeof ThemeFile>

/** One of a theme's files, as the dashboard and the teammate read it. */
export type ThemeFileRef = { name: string; contentType: string; size: number }

/** A saved theme, in lists. */
export type ThemeSummary = {
  id: string
  name: string
  hasCss: boolean
  files: string[]
  updatedAt: string
}

/** What one look change did. */
export const LOOK_CHANGE_KINDS = ['made', 'edited', 'wore', 'off', 'deleted', 'undid'] as const
export type LookChangeKind = (typeof LOOK_CHANGE_KINDS)[number]

/** One of a member's last look changes, newest first. */
export type LookChange = {
  /** Increases with each change: undo_theme and the dashboard go back to the look right after one. */
  seq: number
  kind: LookChangeKind
  /** The theme it was about. */
  name: string | null
  /** For undid: how many changes it went back on. */
  count?: number
  at: string
  /** Who made it: a teammate's name, or null for the person themselves. */
  by: string | null
}

/** GET /api/themes: the member's themes, the one they wear, and their last changes. */
export type ThemeList = {
  active: string | null
  themes: ThemeSummary[]
  history: LookChange[]
}

/** GET /api/themes/active: the worn theme with its files' short-lived addresses. */
export type WornTheme = {
  id: string
  theme: ThemeFile
  /** Each file's signed address, by name, good until `expires`. */
  files: Record<string, string>
  /** When the addresses stop working (ISO): the dashboard asks again before. */
  expires: string
} | null

/** PUT /api/themes/active: wear a saved theme, or null for the dashboard's own look. */
export const WearTheme = z.object({ id: z.string().max(64).nullable() })

/** POST /api/themes/undo: go back `steps` changes, or to the look right after change `seq`. */
export const UndoLook = z
  .object({
    steps: z.number().int().min(1).max(THEME_LIMITS.history).optional(),
    seq: z.number().int().min(0).optional(),
  })
  .refine((u) => u.steps === undefined || u.seq === undefined, 'Give steps or seq, not both')

/** POST /api/themes/import: a theme and its files, each uploaded first (purpose theme_file). */
export const ImportTheme = z.object({
  id: z.string().regex(THEME_ID).optional(),
  theme: ThemeFile,
  files: z.record(z.string().regex(THEME_FILE_NAME), z.string().max(64)).optional(),
})

/** The theme JSON people export and import: the theme with its files inlined. */
export const THEME_EXPORT_VERSION = 1
export const ThemeExport = z
  .object({
    brigadeTheme: z.literal(THEME_EXPORT_VERSION),
    theme: ThemeFile,
    files: z
      .record(
        z.string().regex(THEME_FILE_NAME),
        z
          .string()
          .max(Math.ceil(THEME_LIMITS.fileBytes * 1.4))
          .regex(/^data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+$/),
      )
      .optional(),
  })
  .strict()
export type ThemeExport = z.infer<typeof ThemeExport>

/** A theme's id from its name: what set_theme uses when it is given none. */
export function themeSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug && !(BUILT_IN_LOOKS as readonly string[]).includes(slug) ? slug : `theme-${slug || 'custom'}`
}

/** A theme file's name from any file name: lowercase, safe, its extension kept. */
export function themeFileName(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  const stem = name
    .slice(0, dot)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 70)
  const file = `${stem || 'file'}.${ext}`
  return THEME_FILE_NAME.test(file) ? file : null
}

// --- What a theme's stylesheet may load -------------------------------------------------------

/**
 * A url() target a theme may use: one of its own files (`theme:<file>`), an image or font inline
 * as a data: address, or a #fragment (an SVG filter in the page).
 */
export function themeUrlAllowed(target: string): boolean {
  const t = target.trim()
  if (t.startsWith('#')) return true
  if (/^data:(image|font)\/[\w.+-]+[;,]/i.test(t)) return true
  if (/^data:application\/(font-woff2?|x-font-\w+)[;,]/i.test(t)) return true
  return t.startsWith(THEME_FILE_SCHEME) && THEME_FILE_NAME.test(t.slice(THEME_FILE_SCHEME.length))
}

/** The url() arguments in a text, in order; null when one cannot be read cleanly. */
export function urlTargets(text: string): string[] | null {
  const lower = text.toLowerCase()
  const found: string[] = []
  for (let at = lower.indexOf('url('); at !== -1; at = lower.indexOf('url(', at + 4)) {
    let i = at + 4
    while (/\s/.test(text[i] ?? '')) i++
    const quote = text[i]
    let target: string
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, i + 1)
      if (close === -1) return null
      target = text.slice(i + 1, close)
      i = close + 1
      while (/\s/.test(text[i] ?? '')) i++
      if (text[i] !== ')') return null
    } else {
      const close = text.indexOf(')', i)
      if (close === -1) return null
      target = text.slice(i, close).trim()
      if (/[\s"'(]/.test(target)) return null
    }
    found.push(target.trim())
  }
  return found
}

/** CSS functions that load a file without url(), or make one from the page's own text. */
const LOADS_BY_NAME = /(?:^|[^\w-])(?:-webkit-)?(?:image-set|image|src|cross-fade|element)\(/i
const ATTR_URL = /attr\([^)]*(?:url|type\()/i

/**
 * Security: whether one declaration's value, as the browser parsed it, could load anything but
 * the theme's own files, inline data or a #fragment. The dashboard drops such declarations. A
 * value still holding a backslash is refused whole: an escape can spell `url` where a check of the
 * text would not see it.
 */
export function themeValueLoads(value: string): boolean {
  if (value.includes('\\') || LOADS_BY_NAME.test(value) || ATTR_URL.test(value)) return true
  const targets = urlTargets(value)
  return targets === null || targets.some((target) => !themeUrlAllowed(target))
}

/** The text with comments and quoted strings blanked, so a check of the code skips what they say. */
function codeOnly(css: string): string {
  let out = ''
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      out += ' '
    } else if (c === '"' || c === "'") {
      let end = i + 1
      while (end < css.length && css[end] !== c && css[end] !== '\n') end += css[end] === '\\' ? 2 : 1
      out += `${c}${' '.repeat(Math.max(0, end - i - 1))}${c}`
      i = end
    } else out += c
  }
  return out
}

/**
 * The API's early answer on a theme's stylesheet, in words a teammate can act on; null when
 * nothing in it loads from elsewhere. Escapes can hide from a check of the text, so the
 * dashboard's check of the parsed rules is the guard: this one only says why early.
 */
export function themeCssProblem(css: string): string | null {
  const code = codeOnly(css)
  if (/@import/i.test(code)) return '@import is not allowed: a theme loads no other stylesheet.'
  if (code.includes('\\')) return 'Backslash escapes are allowed only inside quoted strings.'
  if (LOADS_BY_NAME.test(code))
    return 'image-set(), image(), src(), cross-fade() and element() are not allowed: use url() with a theme file or a data: address.'
  if (ATTR_URL.test(code)) return 'attr() may not make a URL.'
  const targets = urlTargets(css.replace(/\/\*[\s\S]*?\*\//g, ' '))
  if (targets === null) return 'A url() could not be read. Write url("theme:<file>").'
  const other = targets.find((target) => !themeUrlAllowed(target))
  if (other !== undefined)
    return `url(${other.slice(0, 80)}) is not allowed: a theme loads only its own files (url("theme:<file>")), images or fonts inline as data: addresses, or #ids. Never the internet.`
  return null
}

/** The theme's files its stylesheet names. */
export function themeFilesUsed(css: string): string[] {
  const targets = urlTargets(css.replace(/\/\*[\s\S]*?\*\//g, ' ')) ?? []
  return [
    ...new Set(
      targets
        .filter((t) => t.startsWith(THEME_FILE_SCHEME))
        .map((t) => t.slice(THEME_FILE_SCHEME.length)),
    ),
  ]
}

// --- A teammate's theme tools ------------------------------------------------------------------

/**
 * A teammate's theme tools, sent by the runner (schedule.call) and checked by the API. A theme
 * is the thread starter's: it changes only their windows. `theme` travels as given and the API
 * reads it, so a theme that does not fit gets an answer that says why.
 */
export const ThemeOperations = [
  /** Their themes, the one they wear, their last changes and the guide; `id`: that theme too. */
  z.object({ name: z.literal('theme_read'), id: z.string().max(64).optional() }),
  /**
   * With `theme`: save it (as `id`, or its name's slug) and wear it. With only `id`: wear that
   * saved theme, or `none` to take any off.
   */
  z.object({
    name: z.literal('theme_set'),
    id: z.string().max(64).optional(),
    theme: z.unknown().optional(),
  }),
  /**
   * A file of the teammate's folder into theme `id`: the runner uploads it first and names the
   * upload; `path` is as the teammate wrote it.
   */
  z.object({
    name: z.literal('theme_add_file'),
    id: z.string().max(64),
    path: z.string().max(4096),
    upload: z.object({ id: z.string().max(64) }).optional(),
  }),
  /** Go back `steps` changes (default 1), or to the look right after change `seq`. */
  z.object({
    name: z.literal('theme_undo'),
    steps: z.number().int().min(1).max(THEME_LIMITS.history).optional(),
    seq: z.number().int().min(0).optional(),
  }),
] as const

export const THEME_TOOLS = ['theme_read', 'theme_set', 'theme_add_file', 'theme_undo'] as const

// --- Stable selectors and the guide ------------------------------------------------------------

/**
 * Selectors a theme can rely on across releases: the dashboard's other class names are
 * utilities that change. apps/web/test/theme-hooks.test.ts fails when one leaves the code.
 */
export const THEME_HOOKS = [
  { selector: '[data-look="app"]', what: 'the whole dashboard, behind everything' },
  { selector: '[data-slot="sidebar"]', what: 'the sidebar' },
  { selector: '[data-slot="sidebar-menu-button"]', what: 'a row of the sidebar' },
  { selector: '[data-look="sidebar-thread"]', what: "a thread's row in the sidebar" },
  { selector: '[data-slot="sidebar-inset"]', what: 'the page beside the sidebar' },
  { selector: '[data-look="thread"]', what: "a thread's page, behind its messages" },
  { selector: '[data-look="thread-header"]', what: 'the bar at the top of a thread' },
  { selector: '[data-look="person-message"]', what: "a person's message bubble" },
  { selector: '[data-look="teammate-message"]', what: "a teammate's reply" },
  { selector: '[data-look="tool-step"]', what: "a line of a teammate's work, folded" },
  { selector: '[data-look="chat-card"]', what: 'a card in a thread: tickets, questions, sub-threads' },
  { selector: '[data-look="composer"]', what: 'the message box' },
  { selector: '[data-look="code-block"]', what: 'a code block' },
  { selector: '[data-look="today"]', what: 'the Today page' },
  { selector: '[data-look="library"]', what: 'the library' },
  { selector: '[data-look="settings"]', what: 'the settings pages' },
  { selector: '[data-slot="card"]', what: 'every card' },
  { selector: '[data-slot="dialog-content"]', what: 'a dialog' },
  { selector: '[data-slot="dropdown-menu-content"]', what: 'a menu' },
  { selector: '[data-slot="tooltip-content"]', what: 'a tooltip' },
  { selector: '[data-slot="button"]', what: 'a button' },
  { selector: '[data-slot="input"], [data-slot="textarea"]', what: 'text fields' },
  { selector: '[data-slot="switch"]', what: 'an on/off switch' },
  { selector: '[data-slot="badge"]', what: 'a badge' },
] as const

/** Brings a person back to the dashboard's own look, whatever a theme hides. */
export const THEME_RESET_SHORTCUT = 'Cmd+Option+Shift+R on a Mac, Ctrl+Alt+Shift+R elsewhere'
/** Opening the dashboard with this in its address starts it without the theme. */
export const SAFE_LOOK_PARAM = 'safe-look'

/** What a teammate needs to restyle Brigade; theme_read returns it. */
export function themeGuide(): string {
  return [
    "A theme restyles Brigade's dashboard (web and Brigade.app) for the person who started this thread, in every window they have open in this workspace. Nobody else sees it.",
    '',
    'Colours first. `canvas` (hex) is the base background: the dashboard derives its surfaces, borders and text from it, and turns light or dark to match. `accent` (hex) is the highlight: buttons, links, the focus ring. Without `canvas`, the person keeps their own light or dark look.',
    `\`colors\` sets single tokens over what canvas and accent derive, as any CSS colour: ${THEME_COLOR_TOKENS.map((t) => `${t} (${THEME_TOKEN_HELP[t]})`).join('; ')}.`,
    '`radius` is the roundness (0 for square corners, 1rem for soft ones). `font` and `fontMono` are font-family lists: fonts installed on the computer work by name, and a font file can be a theme file loaded with @font-face.',
    '',
    `CSS: \`css\` (up to ${THEME_LIMITS.cssChars.toLocaleString('en')} characters) applies after the dashboard's own styles: borders, spacing, bubble shapes, backgrounds, gradients, @keyframes, hover effects. The dashboard's rules can be more specific: add !important when a rule has no effect. Respect @media (prefers-reduced-motion: reduce) for big animations.`,
    'Never the internet: @import, image-set(), image(), src() and any url() to an address are refused, and so is a backslash escape outside a string.',
    'url() may name one of the theme\'s files (url("theme:<file>")), an image or font inline as a data: address, or an #id.',
    `Theme files: theme_add_file copies an image (png, jpg, webp, gif, avif; animated is fine) or a font (woff2, woff, ttf, otf) from your folder into a saved theme, up to ${THEME_LIMITS.fileBytes / 1024 / 1024} MB each and ${THEME_LIMITS.filesPerTheme} per theme. No SVG: inline one as a data: address instead. You can make an image with generate_image, then add it.`,
    '',
    'Stable selectors (every other class name changes between releases: never rely on them):',
    ...THEME_HOOKS.map((h) => `- ${h.selector}: ${h.what}`),
    '',
    "A theme changes the look, not the layout or behaviour: it cannot move the sidebar to the right, add a panel or change what a screen does. Say so rather than promise it. Never hide or disguise what asks the person to decide (tickets, approvals, the Allow and Deny buttons).",
    '',
    'Calls: theme_read (optional id: that saved theme too). theme_set with theme (the theme as JSON) saves it, as id or its name\'s slug, and wears it; with only id it wears a saved theme, or "none" takes the theme off. theme_add_file with id and path, then use url("theme:<file>") in the css and call theme_set again. theme_undo goes back: steps (default 1) undoes that many changes; seq returns to the look right after that change from theme_read\'s history. An undo is itself a change, so undoing it again is a redo.',
    '',
    'You cannot see the result. Make one small change at a time, then ask the person how it looks.',
    '"Undo that", "go back", "as it was before" → theme_undo. "The purple one from earlier" → theme_read, then theme_undo with its seq. "Reset", "the normal look" → theme_set with id "none".',
    `If a theme hides something the person needs, tell them: ${THEME_RESET_SHORTCUT} takes the theme off, and opening the dashboard with ?${SAFE_LOOK_PARAM} in its address starts it without the theme. Settings → Preferences → Appearance lists their themes and changes.`,
  ].join('\n')
}
