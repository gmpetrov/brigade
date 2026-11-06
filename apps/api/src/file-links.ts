// Files a teammate sends to an MCP App whose tool takes a file's address beside the file itself
// (OpenRouter's transcribe-audio: audio_url or audio_base64; its images: https or data URLs).
// Without this, the teammate types the whole file into the call: 24 KB of audio in base64 took
// the model 2 minutes 30 and 23,000 output tokens to write, and the person's message sent
// meanwhile waited for it. Instead, the tool gets a field of Brigade's beside the address
// (audio_path): the teammate names a file in its folder, the runner uploads it straight to the
// bucket (the operation's files fields, as an email's attachments go), and the call gives the
// App a link to it, signed for an hour. The bytes never go through the API: only the link does.

/** A tool's field that takes a file's address, and the field Brigade adds beside it. */
export type FileField = {
  /** Brigade's: a path in the teammate's folder (many: a list), its upload's id once sent. */
  path: string
  /** The tool's own: an address, or a list of them (many). */
  url: string
  many: boolean
  /** What the teammate would type the file into otherwise, if the tool takes it inline. */
  inline?: string
  /** The tool requires its address: the address or the path is, once the path can fill it. */
  required?: boolean
}

/** How long the App may fetch a file it is given a link to: a video job may start minutes later. */
export const FILE_LINK_SECONDS = 60 * 60

type Schema = Record<string, unknown>

const propertiesOf = (schema: Schema) =>
  (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<
    string,
    Schema | undefined
  >

const isString = (schema: unknown) => (schema as Schema | undefined)?.type === 'string'

/** A field's name that says it holds a file's address: an image's, an audio's, a frame's. */
const MEDIA = /(^|_)(image|audio|video|file|photo|picture|document|pdf|media|frame)$/

/**
 * The fields of a tool that take a file's address: an `_url` field with a `_base64` one beside
 * it, one whose description takes data URLs, or one named for a file (`first_frame_image_url`);
 * and an `_urls` list of such addresses. Other addresses (a webhook's, a page to read) stay as
 * they are.
 */
export function fileFields(schema: Schema): FileField[] {
  const properties = propertiesOf(schema)
  const fields: FileField[] = []
  for (const [name, property] of Object.entries(properties)) {
    const match = /^(.+)_(urls?)$/.exec(name)
    if (!match || !property) continue
    const stem = match[1]!
    const many = match[2] === 'urls'
    if (many ? !(property.type === 'array' && isString(property.items)) : !isString(property))
      continue
    const base64 = `${stem}_base64`
    const description = typeof property.description === 'string' ? property.description : ''
    const inline =
      base64 in properties ? base64 : /\bdata urls?\b/i.test(description) ? 'a data URL' : undefined
    if (!inline && !MEDIA.test(stem)) continue
    const path = many ? `${stem}_paths` : `${stem}_path`
    // A tool with a field of that name already keeps it as it is.
    if (path in properties) continue
    const required = Array.isArray(schema.required) && schema.required.includes(name)
    fields.push({
      path,
      url: name,
      many,
      ...(inline ? { inline } : {}),
      ...(required ? { required } : {}),
    })
  }
  return fields
}

/**
 * The tool's input schema with Brigade's file fields beside the addresses they fill. An address
 * the tool requires is required no more, as its path may fill it: the harness checks a call
 * against this schema before anything is uploaded, and linkFiles asks for one of the two.
 */
export function withFileFields(schema: Schema, fields: FileField[]): Schema {
  if (fields.length === 0) return schema
  const properties = { ...propertiesOf(schema) }
  for (const field of fields) {
    const either = field.required ? ` Give it or ${field.url}.` : ''
    const rather = field.inline ? ` Use it rather than typing a file into ${field.inline}.` : ''
    properties[field.path] = field.many
      ? {
          type: 'array',
          items: { type: 'string' },
          description:
            `Files in your working folder (paths), sent in ${field.url} after any addresses it ` +
            `has, in this order: Brigade uploads them and gives the App links to them.${either}${rather}`,
        }
      : {
          type: 'string',
          description:
            `A file in your working folder (its path), sent as ${field.url}, which you then leave ` +
            `out: Brigade uploads it and gives the App a link to it.${either}${rather}`,
        }
  }
  const filled = new Set(fields.filter((field) => field.required).map((field) => field.url))
  return {
    ...schema,
    properties,
    ...(Array.isArray(schema.required) && filled.size
      ? { required: schema.required.filter((name) => !filled.has(name as string)) }
      : {}),
  }
}

/**
 * An MCP tool as teammates get it: its schema with Brigade's file fields, and the fields whose
 * paths the runner uploads (a runner before filesFields uploads the first one's only; the
 * others' paths then fail here, as no upload has their name).
 */
export function withFiles(schema: Schema): {
  inputSchema: Schema
  filesField?: string
  filesFields?: string[]
} {
  const fields = fileFields(schema)
  if (fields.length === 0) return { inputSchema: schema }
  return {
    inputSchema: withFileFields(schema, fields),
    filesField: fields[0]!.path,
    filesFields: fields.map((field) => field.path),
  }
}

/**
 * The call's input as the App takes it: each of Brigade's file fields, which the runner turned
 * into its uploads' ids, becomes links in the field it fills (`link` signs one), and goes.
 */
export async function linkFiles(
  input: Record<string, unknown>,
  fields: FileField[],
  link: (id: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  // What the tool requires, and no longer the schema it is called with (withFileFields).
  for (const field of fields)
    if (field.required && input[field.url] === undefined && input[field.path] === undefined)
      throw new Error(`Give ${field.url} or ${field.path}`)
  if (!fields.some((field) => input[field.path] !== undefined)) return input
  const linked = { ...input }
  for (const field of fields) {
    const value = linked[field.path]
    delete linked[field.path]
    if (value === undefined) continue
    if (field.many) {
      if (!Array.isArray(value) || !value.every((id) => typeof id === 'string'))
        throw new Error(`${field.path} lists files in your working folder`)
      const given = linked[field.url] ?? []
      if (!Array.isArray(given)) throw new Error(`${field.url} is a list of addresses`)
      const links: string[] = []
      for (const id of value) links.push(await link(id))
      linked[field.url] = [...given, ...links]
    } else {
      if (typeof value !== 'string')
        throw new Error(`${field.path} is the path of a file in your working folder`)
      if (linked[field.url] !== undefined)
        throw new Error(`Give ${field.url} or ${field.path}, not both`)
      linked[field.url] = await link(value)
    }
  }
  return linked
}
