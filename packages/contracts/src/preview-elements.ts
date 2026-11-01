// Elements a person picked in a thread's preview, for the teammate. The preview's
// proxy adds a script to its pages that, while the panel's select mode is on,
// outlines what the pointer is over and sends what was clicked to the dashboard
// (runner/src/preview-select.ts). The composer holds them as chips and writes each
// into the message as a <preview-element> block: the teammate reads where it is
// and its HTML; the dashboard shows a chip in its place. Its picture, when the page
// could draw it, goes with the message as an image the block names. What the person
// wants changed on it, written beside it in the composer's pending edits, is its note.
import { z } from 'zod'

export const PreviewElement = z.object({
  /** What people read on its chip: its component and tag ("HeroCopy › h1.title"). */
  label: z.string().min(1).max(200),
  /** The page it is on: path, query and hash. */
  page: z.string().max(2000),
  /** A CSS selector that finds it on that page. */
  selector: z.string().max(1000),
  /** React components around it, outermost first, when the page is a React app in development. */
  components: z.array(z.string().max(100)).max(8).optional(),
  /** Its nearest component's props that are plain values (strings, numbers, booleans), clipped. */
  props: z
    .record(z.string().max(100), z.string().max(200))
    .refine((props) => Object.keys(props).length <= 12, 'Up to 12 props')
    .optional(),
  /** Its size on screen, in CSS pixels ("672×419"). */
  size: z.string().max(40).optional(),
  /** Its text, clipped. */
  text: z.string().max(500).optional(),
  /** The name of the image of it attached to the same message. */
  image: z.string().max(200).optional(),
  /** What the person wants changed on it, written beside it before the message went. */
  note: z.string().max(4000).optional(),
  /** Its HTML, clipped. */
  html: z.string().max(4000),
})
export type PreviewElement = z.infer<typeof PreviewElement>

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\s+/g, ' ')
/** A note keeps its line breaks. */
const escapeNote = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r?\n/g, '&#10;')
const unescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')

/** The block a message carries for one element. */
export function formatPreviewElement(element: PreviewElement) {
  const attributes: [string, string | undefined][] = [
    ['label', element.label],
    ['page', element.page],
    ['selector', element.selector],
    ['components', element.components?.join(' › ')],
    [
      'props',
      element.props && Object.keys(element.props).length
        ? JSON.stringify(element.props)
        : undefined,
    ],
    ['size', element.size],
    ['text', element.text],
    ['image', element.image],
    ['note', element.note?.trim()],
  ]
  const head = attributes
    .filter((a): a is [string, string] => !!a[1])
    .map(([name, value]) => ` ${name}="${name === 'note' ? escapeNote(value) : escape(value)}"`)
    .join('')
  const html = element.html.replace(/<\/preview-element/gi, '<\\/preview-element')
  return `<preview-element${head}>\n${html}\n</preview-element>`
}

const BLOCK = /<preview-element((?:\s+[a-z]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/preview-element>/g

/** The elements a message's text carries, and its text without them. */
export function splitPreviewElements(text: string): { text: string; elements: PreviewElement[] } {
  if (!text.includes('<preview-element')) return { text, elements: [] }
  const elements: PreviewElement[] = []
  const rest = text.replace(BLOCK, (_, head: string, html: string) => {
    const attributes = Object.fromEntries(
      [...head.matchAll(/([a-z]+)="([^"]*)"/g)].map((m) => [m[1]!, unescape(m[2]!)]),
    )
    elements.push({
      label: attributes.label || 'Element',
      page: attributes.page ?? '',
      selector: attributes.selector ?? '',
      ...(attributes.components ? { components: attributes.components.split(' › ') } : {}),
      ...(attributes.props ? { props: parseProps(attributes.props) } : {}),
      ...(attributes.size ? { size: attributes.size } : {}),
      ...(attributes.text ? { text: attributes.text } : {}),
      ...(attributes.image ? { image: attributes.image } : {}),
      ...(attributes.note ? { note: attributes.note } : {}),
      html,
    })
    return ''
  })
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), elements }
}

function parseProps(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json)
    if (!value || typeof value !== 'object') return {}
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  } catch {
    return {}
  }
}

/** Elements reduced to their labels (and notes), for titles and previews. */
export const previewElementsToText = (text: string) =>
  text.includes('<preview-element')
    ? text.replace(BLOCK, (_, head: string) => {
        const label = /\slabel="([^"]*)"/.exec(head)?.[1]
        const note = /\snote="([^"]*)"/.exec(head)?.[1]
        const name = label ? unescape(label) : 'Element'
        return note ? `[${name}: ${unescape(note).replace(/\s+/g, ' ')}]` : `[${name}]`
      })
    : text
