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
})
export type DesignManifest = z.infer<typeof DesignManifest>

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
 * mode: before `</head>`, else just after the doctype, else first.
 */
export function addToHead(html: string, tags: string) {
  if (!tags) return html
  const head = html.search(/<\/head\s*>/i)
  if (head >= 0) return html.slice(0, head) + tags + html.slice(head)
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

/** A design system as a thread's teammate sees it, in its instructions. */
export const ThreadDesignSystem = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  folders: z.array(z.string()),
  repositories: z.array(z.string()),
  /** It applies to this teammate. */
  teammate: z.boolean(),
  isDefault: z.boolean(),
})
export type ThreadDesignSystem = z.infer<typeof ThreadDesignSystem>
