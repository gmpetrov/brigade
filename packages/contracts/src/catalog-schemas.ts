// A catalog's input schemas, shared: each subschema a tool's schema repeats is written once,
// under $defs, and named by a $ref wherever it was. PostHog's tools repeat their filters' and
// queries' schemas dozens of times each: its catalog went from 2.6 M characters to 1.6 M. The
// API keeps catalogs shared and sends them so to a runner that asks (CATALOG_SHARED_PARAM);
// the runner writes each schema out whole again before its harness gets it, since Claude Code's
// bridge turns each schema into zod and reads a $ref as any value.

/** GET /runner/catalogs/<connectionId>?schemas=shared asks for its schemas shared. */
export const CATALOG_SHARED_PARAM = 'schemas'

/** Where a JSON Schema holds other schemas: one, a list of them, or a map of them by name. */
const ONE_SCHEMA = [
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'items',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]
const SCHEMA_LIST = ['anyOf', 'oneOf', 'allOf', 'prefixItems', 'items']
const SCHEMA_MAP = ['properties', 'patternProperties', 'dependentSchemas']
/** A schema with these names its own parts or ids: its subschemas stay where they are. */
const SELF_REFERENCING = /"(\$ref|\$defs|definitions|\$id|\$anchor|\$dynamicRef|\$dynamicAnchor)":/
/** Shorter subschemas are not worth a reference. */
const SHARED_MIN_CHARS = 100
/** A shared subschema's name under $defs: only these are written out whole again. */
const SHARED = 'shared-'
const REF = `#/$defs/${SHARED}`

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Each subschema of a schema, with what to put in its place: never the schema itself, nor data (enum, default). */
function eachSubschema(schema: Schema, visit: (sub: Schema) => unknown): Schema {
  const out: Schema = { ...schema }
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_LIST.includes(key) && Array.isArray(value))
      out[key] = value.map((v) => (isSchema(v) ? visit(v) : v))
    else if (ONE_SCHEMA.includes(key) && isSchema(value)) out[key] = visit(value)
    else if (SCHEMA_MAP.includes(key) && isSchema(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, v]) => [name, isSchema(v) ? visit(v) : v]),
      )
  }
  return out
}

/**
 * A tool's input schema with each subschema it repeats written once: the same schema, shorter.
 * One that has references or ids of its own, or nothing worth sharing, is left as it is.
 */
export function sharedSubschemas(schema: Schema): Schema {
  const whole = JSON.stringify(schema)
  if (SELF_REFERENCING.test(whole)) return schema
  const seen = new Map<string, number>()
  // A repeat's own subschemas were counted at its first sight: counting them again would share
  // what only ever appears inside it.
  const count = (sub: Schema): unknown => {
    const text = JSON.stringify(sub)
    if (text.length < SHARED_MIN_CHARS) return eachSubschema(sub, count)
    const times = seen.get(text) ?? 0
    seen.set(text, times + 1)
    return times ? sub : eachSubschema(sub, count)
  }
  eachSubschema(schema, count)
  const names = new Map<string, string>()
  const defs: Schema = {}
  const share = (sub: Schema): unknown => {
    const text = JSON.stringify(sub)
    if ((seen.get(text) ?? 0) < 2) return eachSubschema(sub, share)
    let name = names.get(text)
    if (!name) {
      name = `${SHARED}${names.size}`
      names.set(text, name)
      defs[name] = eachSubschema(sub, share)
    }
    return { $ref: `#/$defs/${name}` }
  }
  const shared = eachSubschema(schema, share)
  if (!names.size) return schema
  const result = { ...shared, $defs: defs }
  return JSON.stringify(result).length < whole.length ? result : schema
}

/**
 * A schema sharedSubschemas made, whole again: each of its references replaced by what it names,
 * one object for all of them (JSON writes it out at each). Any other schema is left as it is.
 */
export function unsharedSubschemas(schema: Schema): Schema {
  const defs = schema.$defs
  if (!isSchema(defs) || !Object.keys(defs).some((name) => name.startsWith(SHARED))) return schema
  const whole = new Map<string, unknown>()
  const resolve = (sub: Schema): unknown => {
    const ref = sub.$ref
    if (typeof ref !== 'string' || !ref.startsWith(REF)) return eachSubschema(sub, resolve)
    const name = ref.slice('#/$defs/'.length)
    let found = whole.get(name)
    if (found === undefined) {
      const def = defs[name]
      found = isSchema(def) ? eachSubschema(def, resolve) : {}
      whole.set(name, found)
    }
    return found
  }
  const { $defs: _, ...rest } = eachSubschema(schema, resolve)
  const others = Object.entries(defs).filter(([name]) => !name.startsWith(SHARED))
  return others.length ? { ...rest, $defs: Object.fromEntries(others) } : rest
}
