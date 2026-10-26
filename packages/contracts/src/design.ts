// Designs and design systems. A design system is a library folder (its rules,
// tokens and assets) with a row that names it and says where it applies. A
// design is a library folder named `<name>.design` holding `design.json` and
// `index.html`: teammates make them in threads, people view them in a
// sandboxed frame served from a separate origin.
import { z } from 'zod'
import { LibraryPath } from './library.js'
import { RepositoryName } from './repositories.js'

/** A design's folder ends with this. */
export const DESIGN_SUFFIX = '.design'
/** Every design has one, at the top of its folder. */
export const DESIGN_MANIFEST = 'design.json'
/** The page a design opens on. */
export const DESIGN_ENTRY = 'index.html'
/** Optional: values people can tune in the viewer, as CSS custom properties. */
export const DESIGN_KNOBS = 'knobs.json'
/** Written by `save_design` when the computer can render the design: the gallery's picture. */
export const DESIGN_THUMBNAIL = 'thumbnail.png'
/** Files a teammate saves in one design. */
export const DESIGN_FILES_MAX = 200
/** Every design system folder has one, at its top: the rules designers follow. */
export const DESIGN_SYSTEM_README = 'README.md'
/** Its tokens, as CSS custom properties. */
export const DESIGN_SYSTEM_TOKENS = 'tokens.css'
/** Its design that shows the tokens and components, inside its folder. */
export const DESIGN_SYSTEM_PREVIEW = `preview${DESIGN_SUFFIX}`
/** Files a teammate saves in one design system, its preview included. */
export const DESIGN_SYSTEM_FILES_MAX = 400

/** The design folder a library path is in or is ("a/b.design" for "a/b.design/x.png"), if any. */
export function designFolderOf(path: string): string | undefined {
  const parts = path.split('/')
  const at = parts.findIndex((p) => p.endsWith(DESIGN_SUFFIX) && p.length > DESIGN_SUFFIX.length)
  return at < 0 ? undefined : parts.slice(0, at + 1).join('/')
}

/** A design's own name: its folder's, without the suffix. */
export const designName = (folder: string) =>
  folder.split('/').pop()!.slice(0, -DESIGN_SUFFIX.length)

/**
 * Alternatives offered for one design sit together in a folder ending with
 * this: `acme/pricing.options/a-bold.design`. Picking one makes it the design
 * (`acme/pricing.design`) and sends the rest to the trash.
 */
export const DESIGN_OPTIONS_SUFFIX = '.options'

/** The options folder a design is one of (`a/x.options` for `a/x.options/b.design`), if it is one. */
export function designOptionsOf(folder: string): string | undefined {
  const slash = folder.lastIndexOf('/')
  const parent = slash < 0 ? '' : folder.slice(0, slash)
  const name = parent.split('/').pop()!
  return name.endsWith(DESIGN_OPTIONS_SUFFIX) && name.length > DESIGN_OPTIONS_SUFFIX.length
    ? parent
    : undefined
}

/** Where the pick from an options folder goes: `a/x.design` for `a/x.options`. */
export const pickedDesignPath = (options: string) =>
  `${options.slice(0, -DESIGN_OPTIONS_SUFFIX.length)}${DESIGN_SUFFIX}`

export const DesignViewport = z.enum(['desktop', 'tablet', 'mobile'])
export type DesignViewport = z.infer<typeof DesignViewport>

/** A viewport's width, and the height of its screen. */
export const VIEWPORT_SIZES: Record<DesignViewport, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
}

/** The height of a screen as wide as this: what `100vh` is while a board is measured. */
export const screenHeight = (width: number) =>
  width > 1000
    ? VIEWPORT_SIZES.desktop.height
    : width > 600
      ? VIEWPORT_SIZES.tablet.height
      : VIEWPORT_SIZES.mobile.height

/** A page of a design, by its path in the folder: `index.html`, `screens/signin.html`. */
export const DesignFile = z
  .string()
  .max(200)
  .regex(/^[\w][\w.-]*(\/[\w][\w.-]*)*\.html$/, 'An .html file in the design folder')
  .refine((p) => !p.split('/').some((part) => part === '..' || part.startsWith('.')))

/** Longest page a board shows whole. */
export const BOARD_HEIGHT_MAX = 8000

/** One board on a design's canvas: a page of the design at a size. */
export const DesignBoard = z.object({
  file: DesignFile,
  title: z.string().max(120).optional(),
  /** Its width in px. Default 1280. */
  width: z.number().int().min(200).max(4000).optional(),
  /**
   * Its height in px. Absent: the page's own height, or a screen's when the page
   * is sized by the frame (`vh`), then scrolling inside.
   */
  height: z.number().int().min(200).max(BOARD_HEIGHT_MAX).optional(),
  /** Where it sits on the canvas, in px. Absent: after the board before it. */
  x: z.number().min(-200_000).max(200_000).optional(),
  y: z.number().min(-200_000).max(200_000).optional(),
})
export type DesignBoard = z.infer<typeof DesignBoard>

/** `design.json`, written by the teammate. Lenient: a design with a bad one still shows. */
export const DesignManifest = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  /** The design system it follows, by name. Pinned when the design is made. */
  designSystem: z.string().max(100).optional(),
  /** The sizes it is meant for, the first shown first. */
  viewports: z.array(DesignViewport).max(3).optional(),
  /** A deck: each slide is an element with `data-slide`, its speaker notes in `data-notes`. */
  kind: z.enum(['page', 'slides']).optional(),
  /** Its pages on the canvas, in reading order. A bad entry is left out, not the manifest. */
  boards: z
    .array(DesignBoard.nullable().catch(null))
    .max(60)
    .transform((boards) => boards.filter((b) => b !== null))
    .optional()
    .catch(undefined),
})
export type DesignManifest = z.infer<typeof DesignManifest>

/** Space between boards in a row. */
export const BOARD_GAP = 80

/** A board as the canvas draws it: every value filled in. `height` absent: measured. */
export type PlacedBoard = DesignBoard & { width: number; x: number; y: number }

/**
 * The boards a design shows: its own, else its `index.html` once per viewport
 * (desktop alone when it names none), a deck as one board. Each without a place
 * goes after the one before it, in a row.
 */
export function designBoards(manifest: DesignManifest | null): PlacedBoard[] {
  const listed: DesignBoard[] = manifest?.boards?.length
    ? manifest.boards
    : manifest?.kind === 'slides'
      ? [{ file: DESIGN_ENTRY, width: VIEWPORT_SIZES.desktop.width }]
      : (manifest?.viewports?.length ? manifest.viewports : (['desktop'] as const)).map((v) => ({
          file: DESIGN_ENTRY,
          title: `${v[0]!.toUpperCase()}${v.slice(1)}`,
          width: VIEWPORT_SIZES[v].width,
        }))
  let x = 0
  let y = 0
  return listed.map((board) => {
    const width = board.width ?? VIEWPORT_SIZES.desktop.width
    const placed = { ...board, width, x: board.x ?? x, y: board.y ?? y }
    x = placed.x + width + BOARD_GAP
    y = placed.y
    return placed
  })
}

// ---------------------------------------------------------------------------
// Editing a design's pages by hand
// ---------------------------------------------------------------------------

/** Text that, once entities are decoded, is not a script address. */
const decode = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&(colon|tab|newline);?/gi, (_, name: string) =>
      name.toLowerCase() === 'colon' ? ':' : ' ',
    )

/** An address a person may give a link or an image: relative, a page on the web, mail, a phone, an anchor. */
export function isSafeAddress(value: string) {
  const plain = decode(value)
    .replace(/[\u0000- \u007f-\u009f]/g, '')
    .toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(plain)
  return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1]!)
}

/** A CSS property: `padding`, `font-size`, `--brand`. */
export const CssProperty = z.string().regex(/^(--)?-?[a-z][a-z0-9-]{0,60}$/, 'A CSS property')
/** A CSS value written into a `style` attribute: nothing that could end it or run script. */
export const CssValue = z
  .string()
  .max(300)
  .refine((v) => {
    const plain = decode(v).toLowerCase()
    if (/[;{}<>\\]|\/\*|expression\s*\(|javascript:|@import/.test(plain)) return false
    // Images only from the page's folder or the web.
    for (const [, , url] of plain.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g))
      if (!isSafeAddress(url!) || /^(data|blob):/.test(url!.trim())) return false
    return true
  }, 'A plain CSS value')

/** Attributes a person may change by hand. */
export const EDITABLE_ATTRS = ['href', 'src', 'alt', 'title', 'placeholder', 'aria-label'] as const
const ADDRESS_ATTRS = new Set(['href', 'src'])

export const DesignEditOp = z.union([
  z.object({
    /** The element, as the page numbers it (`data-bid`). */
    id: z.number().int().min(0),
    /** Inline declarations to set, or remove with null. */
    style: z.record(CssProperty, CssValue.nullable()),
  }),
  z.object({ id: z.number().int().min(0), text: z.string().max(10_000) }),
  z.object({
    id: z.number().int().min(0),
    attrs: z
      .partialRecord(z.enum(EDITABLE_ATTRS), z.string().max(2000).nullable())
      .refine(
        (attrs) =>
          Object.entries(attrs).every(
            ([name, value]) => value === null || !ADDRESS_ATTRS.has(name) || isSafeAddress(value),
          ),
        'Links and images go to a page of the design or the web',
      ),
  }),
])
export type DesignEditOp = z.infer<typeof DesignEditOp>

/** Changes to one page of a design, made on the canvas. */
export const DesignEdit = z.object({
  /** The design's folder. */
  path: LibraryPath,
  file: DesignFile,
  /** The page's sha256 the changes were made on: refused when it was saved since. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ops: z.array(DesignEditOp).min(1).max(50),
})
export type DesignEdit = z.infer<typeof DesignEdit>
export const DesignEditResult = z.object({ sha256: z.string(), updatedAt: z.string() })
export type DesignEditResult = z.infer<typeof DesignEditResult>

/** The canvas's picture of a design's first board, for the gallery, after a person's edits. */
export const SaveDesignThumbnail = z
  .object({
    path: LibraryPath,
    /** The PNG uploaded straight to the bucket (POST /api/uploads, purpose library). */
    uploadId: z.string().min(1).max(64).optional(),
    /** PNG, base64 (no data: prefix): only without R2, in development. */
    png: z.string().max(3_000_000).optional(),
  })
  .refine((t) => (t.uploadId === undefined) !== (t.png === undefined), {
    message: 'Give the upload or the picture',
  })

/** Files of a design a person changed since a thread last saved them: `design_edits`. */
export const DesignPersonEdit = z.object({
  /** In the design folder. */
  file: z.string(),
  by: z.string(),
  at: z.string(),
})
export type DesignPersonEdit = z.infer<typeof DesignPersonEdit>

/** A CSS custom property a person can tune: `--brand`, `--radius`. */
export const KnobVar = z
  .string()
  .regex(/^--[A-Za-z0-9_-]{1,60}$/, 'A CSS custom property, like --brand')
/** A knob's value, as CSS. Nothing that could end the declaration or the style element. */
export const KnobValue = z
  .string()
  .max(200)
  .refine((v) => !/[;{}<>\\]/.test(v), 'A plain CSS value')

export const DesignKnob = z.object({
  var: KnobVar,
  label: z.string().max(80).optional(),
  type: z.enum(['color', 'range', 'select', 'text']).default('text'),
  /** For a range: its bounds and step, and the unit after the number ("px", "rem"). */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().max(10).optional(),
  /** For a select. */
  options: z
    .array(z.object({ label: z.string().max(80), value: KnobValue }))
    .max(30)
    .optional(),
  /** The value in use, with the unit for a range. */
  value: KnobValue,
})
export type DesignKnob = z.infer<typeof DesignKnob>

/** `knobs.json`. */
export const DesignKnobs = z.object({ knobs: z.array(DesignKnob).max(40) })
export type DesignKnobs = z.infer<typeof DesignKnobs>

/** The knobs' values as a style that wins over the design's own `:root`. */
export function knobsStyle(knobs: DesignKnob[]) {
  const declarations = knobs
    .filter((k) => KnobValue.safeParse(k.value).success)
    .map((k) => `${k.var}:${k.value}`)
  return declarations.length ? `:root:root{${declarations.join(';')}}` : ''
}

/**
 * Add tags to a page where they run before its body and keep it in standards
 * mode: before `</head>` (`first`: just after `<head>`, to run before the page's
 * own scripts), else just after the doctype, else first.
 */
export function addToHead(html: string, tags: string, options: { first?: boolean } = {}) {
  if (!tags) return html
  if (options.first) {
    const open = /<head(?:\s[^>]*)?>/i.exec(html)
    if (open)
      return (
        html.slice(0, open.index + open[0].length) + tags + html.slice(open.index + open[0].length)
      )
  } else {
    const head = html.search(/<\/head\s*>/i)
    if (head >= 0) return html.slice(0, head) + tags + html.slice(head)
  }
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)
  return doctype ? doctype[0] + tags + html.slice(doctype[0].length) : tags + html
}

/** Save the values chosen in the viewer into the design's `knobs.json`. */
export const SaveKnobs = z.object({
  path: LibraryPath,
  values: z.record(KnobVar, KnobValue),
})

export const DesignSystem = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Its library folder. */
  path: z.string(),
  /** Used where nothing more specific applies. One per workspace at most. */
  isDefault: z.boolean(),
  /** Designs saved in these library folders (or below) follow it. */
  folders: z.array(z.string()),
  /** Threads working in these repositories (owner/name) follow it. */
  repositories: z.array(z.string()),
  /** These teammates follow it by default. */
  teammateIds: z.array(z.string()),
  /** Threads in these projects follow it. */
  projectIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DesignSystem = z.infer<typeof DesignSystem>

export const SaveDesignSystem = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  path: LibraryPath,
  isDefault: z.boolean().default(false),
  folders: z.array(LibraryPath).max(50).default([]),
  repositories: z.array(RepositoryName).max(50).default([]),
  teammateIds: z.array(z.string()).max(200).default([]),
  projectIds: z.array(z.string()).max(200).default([]),
})
export type SaveDesignSystem = z.input<typeof SaveDesignSystem>

/**
 * A teammate registers the design system it wrote, or changes the one with
 * that name. What it leaves out keeps its value (a new one is the default
 * when the workspace has none).
 */
export const TeammateDesignSystem = z.object({
  name: z.string().trim().min(1).max(60),
  path: LibraryPath,
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional(),
  folders: z.array(LibraryPath).max(50).optional(),
  repositories: z.array(RepositoryName).max(50).optional(),
})
export type TeammateDesignSystem = z.infer<typeof TeammateDesignSystem>

/** Ask for a design's page: a short-lived address on the sandbox origin. */
export const OpenDesignView = z.object({ path: LibraryPath })
export const DesignView = z.object({
  /** The design's `index.html` on the sandbox origin; its relative links resolve in its folder. */
  url: z.string(),
  /** Its `design.json`, when it reads. */
  manifest: DesignManifest.nullable(),
  /** Its `knobs.json`, when it reads. */
  knobs: z.array(DesignKnob),
  /** Its `index.html` in the library. */
  entryId: z.string(),
  /** Its pages, by their path in the folder, to their sha256: what the canvas edits. */
  files: z.record(z.string(), z.string()),
  /** The thread that saved it last, if it is still there; comments go to it. */
  thread: z
    .object({
      id: z.string(),
      title: z.string(),
      /** This member may send it messages (their thread, or one open to others). */
      mayPrompt: z.boolean(),
    })
    .nullable(),
  /** The teammate that saved it last, if one did. */
  teammate: z.object({ id: z.string(), name: z.string() }).nullable(),
  expiresAt: z.string(),
})
export type DesignView = z.infer<typeof DesignView>

/**
 * Where a design a message names is now. An option picked from an options
 * folder moved to the design's own folder (`path`); the others are in the trash.
 */
export const DesignWhere = z.object({
  path: z.string(),
  trashed: z.boolean(),
})
export type DesignWhere = z.infer<typeof DesignWhere>

/** A design system as a thread's teammate sees it, in its instructions. */
export const ThreadDesignSystem = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  folders: z.array(z.string()),
  repositories: z.array(z.string()),
  /** It applies to this teammate. */
  teammate: z.boolean(),
  /** It applies to the thread's project. */
  project: z.boolean().default(false),
  isDefault: z.boolean(),
})
export type ThreadDesignSystem = z.infer<typeof ThreadDesignSystem>
