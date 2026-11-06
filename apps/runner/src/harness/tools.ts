// Connector tools: AI SDK tools whose execute forwards the call to the API,
// which checks the grant, asks for approval if needed, and makes the request.
import { resolve } from 'node:path'
import { jsonSchema, tool, type JSONSchema7, type Tool } from 'ai'
import {
  ATTACHMENT_MAX,
  CHILD_WAIT_MAX_MINUTES,
  CHILD_WAIT_MINUTES,
  CHILDREN_AT_WORK,
  CHIEF_NAME,
  COMPLETE_THREAD_TOOL,
  DONE_SUMMARY_MAX,
  DoneSummary,
  FOLLOWERS_PER_THREAD,
  isChiefName,
  DESIGN_ENTRY,
  DESIGN_FILES_MAX,
  DESIGN_MANIFEST,
  DESIGN_SUFFIX,
  DESIGN_SYSTEM_FILES_MAX,
  DESIGN_SYSTEM_PREVIEW,
  DESIGN_SYSTEM_README,
  DESIGN_SYSTEM_TOKENS,
  DESIGN_THUMBNAIL,
  designFolderOf,
  DesignManifest,
  formatMention,
  parseSkillMarkdown,
  PROPOSE_SKILL_TOOL,
  REPORT_FILES_MAX,
  REPORT_MAX,
  SKILL_ENTRY,
  SKILL_FILE_MAX,
  SKILL_TOTAL_MAX,
  SkillContent,
  TeamProposal,
  TRASH_DAYS,
  Widget,
  WIDGET_GUIDE_TOOL,
  WIDGET_HTML_MAX,
  WAKEUP_MAX_DAYS,
  WAKEUP_MIN_MINUTES,
  WAKEUPS_IN_A_ROW,
  WAKEUPS_PER_THREAD,
  type ConnectorGrant,
  type DesignPersonEdit,
  type ScheduleOperation,
} from '@brigade/contracts'
import { ComputerUseError, type RequestOptions } from '../computer-use.js'
import type { LibraryOperation, StagedFile } from '../uploads.js'
import type { Arrivals, Cut } from './arrivals.js'
import { answerText, errorMessage } from './events.js'
import { WIDGET_GUIDE } from './widget-guide.js'

export type ConnectorCaller = (call: {
  connectionId: string
  operation: string
  input: unknown
  toolCallId: string
  toolName: string
}) => Promise<unknown>

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 24)

/**
 * Marks a tool's input schema so the Codex bridge (patched) sends it as a
 * deferred tool in this namespace: the model finds it through tool search
 * instead of getting every schema each turn. Claude Code defers MCP tools on its own.
 */
const NAMESPACE = 'x-codex-namespace'

/**
 * An App whose operations' schemas weigh more than this goes behind a catalog (catalogTools)
 * rather than a tool per operation: PostHog's 250 operations, 2.6 MB of schemas, held about
 * 100 MB in each Claude Code process and its bridge, and their names alone ~17k tokens of each
 * request. The others stay tools of their own.
 */
const CATALOG_MIN_CHARS = Number(process.env.BRIGADE_CATALOG_MIN_CHARS) || 300_000
/** Apps the dashboard shows cards for by tool name (pull requests, emails): never catalogued. */
const CARD_KINDS = new Set(['github', 'gmail', 'email'])
/** The catalog tools of an App, always loaded in Claude Code: they are small (CATALOG_TOOL). */
export const CATALOG_TOOL = Symbol('catalog tool')
/**
 * The most a search answers, its operations together, and the start of each one's description
 * it gives. Claude Code moves a tool result past 25,000 tokens into a file, which the teammate
 * must then read in pieces: on Nov 4 a search for a PostHog trend came to 133k characters, its
 * operations' descriptions alone up to 15k each, and the schema of one to 100k.
 */
const FOUND_CHARS = 30_000
const FOUND_DESCRIPTION_CHARS = 600
const FOUND_MAX = 12
/**
 * The most one operation's description and schema take when described. Past it, the schema
 * keeps its descriptions only near its top (SCHEMA_NOTES_DEPTH), then none: its shape stays
 * whole, and the operation's own description keeps its start (DESCRIBED_DESCRIPTION_CHARS).
 */
const DESCRIBED_CHARS = 60_000
const DESCRIBED_DESCRIPTION_CHARS = 4_000
const SCHEMA_NOTES_DEPTH = 2

/**
 * JSON Schema's keywords whose value is a schema (or, for `items`, a list of them), a list of
 * schemas, or a map of names to schemas (`dependencies` maps a name to a schema or to a list of
 * names). Every other keyword's value is data (`const`, `enum`, `default`, `examples`,
 * `required`, `dependentRequired`…), kept as it is: a key named `description` there is a value.
 */
const SCHEMA_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
])
const SCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/**
 * A JSON schema without the notes (`description`) of its subschemas deeper than `depth` (every
 * one when below zero): what it accepts stays the same. Only schemas are walked, through the
 * keywords that hold them; data in it stays whole.
 */
export function withoutDeepNotes(schema: unknown, depth: number, level = 0): unknown {
  if (!isRecord(schema)) return schema
  const sub = (value: unknown) => withoutDeepNotes(value, depth, level + 1)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' && level > depth) continue
    if (SCHEMA_KEYWORDS.has(key)) out[key] = Array.isArray(value) ? value.map(sub) : sub(value)
    else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) out[key] = value.map(sub)
    else if (SCHEMA_MAPS.has(key) && isRecord(value))
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, v]) => [name, Array.isArray(v) ? v : sub(v)]),
      )
    else out[key] = value
  }
  return out
}

const charsOf = (value: unknown) => JSON.stringify(value ?? {}).length

const catalogued = (kind: string, grants: ConnectorGrant[]) => {
  if (CARD_KINDS.has(kind)) return false
  const seen = new Set<string>()
  let chars = 0
  for (const grant of grants)
    for (const operation of grant.operations) {
      if (seen.has(operation.name)) continue
      seen.add(operation.name)
      chars += JSON.stringify(operation.inputSchema ?? {}).length + operation.description.length
    }
  return chars > CATALOG_MIN_CHARS
}

/**
 * A big App's operations behind three tools: `<app>_find` searches them (each found one with its
 * description, and its input schema while they fit), `<app>_describe` gives one's schema, and
 * `<app>_run` calls one, on an account when the thread has several. Like a tool search, then its
 * call: a thread holds a few KB instead of megabytes, and reads a schema only when it uses it.
 * The API still checks each call by its operation (scope, approvals).
 */
function catalogTools(
  kind: string,
  grants: ConnectorGrant[],
  call: ConnectorCaller,
  options: { defer?: boolean },
): Record<string, Tool> {
  const label = grants[0]!.label
  const accountOf = (grant: ConnectorGrant) => grant.externalAccount ?? grant.label
  const accounts = grants.map(accountOf)
  const several = grants.length > 1
  /**
   * Each operation as its accounts have it: one variant for those whose grant gives it the same
   * description and schema, another for each that differs.
   */
  type Variant = {
    name: string
    description: string
    write: boolean
    inputSchema: unknown
    grants: ConnectorGrant[]
  }
  const operations = new Map<string, Variant[]>()
  for (const grant of grants)
    for (const operation of grant.operations) {
      const variants = operations.get(operation.name) ?? []
      const same = variants.find(
        (v) =>
          v.write === !!operation.write &&
          v.description === operation.description &&
          JSON.stringify(v.inputSchema) === JSON.stringify(operation.inputSchema),
      )
      if (same) same.grants.push(grant)
      else variants.push({ ...operation, write: !!operation.write, grants: [grant] })
      operations.set(operation.name, variants)
    }
  const where = several
    ? `${label}, the account in \`account\`: ${accounts.join(', ')}`
    : `${label}: ${accounts[0]}`
  const namespace = { name: kind, description: `${label}: ${accounts.join(', ')}` }
  const schema = (value: JSONSchema7) =>
    jsonSchema<any>({
      ...value,
      ...(options.defer ? { [NAMESPACE]: namespace } : {}),
    } as JSONSchema7)
  /** An operation as told: the start of its description when it is long (`shortened`). */
  const entry = (v: Variant, descriptionChars = Infinity) => ({
    operation: v.name,
    description: v.description.slice(0, descriptionChars),
    ...(v.description.length > descriptionChars ? { shortened: true } : {}),
    ...(v.write ? { write: true } : {}),
    ...(several ? { accounts: v.grants.map(accountOf) } : {}),
  })
  /**
   * An operation described: whole while it fits DESCRIBED_CHARS, else its schema without the
   * notes deep in it, then without any, and the start of its description.
   */
  const described = (v: Variant) => {
    const whole = { ...entry(v), inputSchema: v.inputSchema }
    if (charsOf(whole) <= DESCRIBED_CHARS) return whole
    const short = entry(v, DESCRIBED_DESCRIPTION_CHARS)
    const condensed = {
      ...short,
      inputSchema: withoutDeepNotes(v.inputSchema, SCHEMA_NOTES_DEPTH),
      condensed: 'Notes deep in the schema are left out; what it accepts is whole.',
    }
    if (charsOf(condensed) <= DESCRIBED_CHARS) return condensed
    return {
      ...short,
      inputSchema: withoutDeepNotes(v.inputSchema, -1),
      condensed: "The schema's notes are left out; what it accepts is whole.",
    }
  }
  const words = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  const find = `${kind}_find`
  const describe = `${kind}_describe`
  const run = `${kind}_run`
  const unknownOperation = (operation: string) =>
    new Error(`${label} has no operation ${operation}: ${find} finds them`)
  /** The variant of an operation an account has, or an error saying which accounts do. */
  const variantFor = (operation: string, account: string | undefined, describing = false) => {
    const variants = operations.get(operation)
    if (!variants) throw unknownOperation(operation)
    // Described without an account, an operation all its accounts have alike.
    if (describing && account === undefined && variants.length === 1) return variants[0]!
    const variant = several
      ? variants.find((v) => v.grants.some((g) => accountOf(g) === account))
      : variants[0]
    if (!variant)
      throw new Error(
        `${operation} has no ${label} account "${String(account)}": use one of ${variants
          .flatMap((v) => v.grants.map(accountOf))
          .join(', ')}`,
      )
    return variant
  }
  const accountParam: Record<string, JSONSchema7> = several
    ? {
        account: {
          type: 'string',
          enum: accounts,
          description: `The ${label} account to use`,
        },
      }
    : {}
  const tools: Record<string, Tool> = {
    [find]: tool({
      description:
        `Find ${label}'s operations for a task, by words of what you want to do (empty: all of them, by name). ` +
        `Each comes with its description (its start when long)${several ? ', the accounts that have it' : ''}, and ` +
        `its input schema while they fit; call ${describe} for one without, then ${run} to call it. [${where}]`,
      inputSchema: schema({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, in a few words' },
        },
        required: ['query'],
      }),
      execute: async (input: { query?: string }) => {
        const wanted = words(input.query ?? '')
        if (wanted.length === 0) return { operations: [...operations.keys()] }
        const scored = [...operations.values()]
          .flat()
          .map((v) => {
            const name = words(v.name)
            const text = words(v.description)
            const score = wanted.reduce(
              (sum, w) =>
                sum +
                (name.some((n) => n === w)
                  ? 4
                  : name.some((n) => n.startsWith(w) || w.startsWith(n))
                    ? 2
                    : 0) +
                (text.includes(w) ? 1 : 0),
              0,
            )
            return { v, score }
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, FOUND_MAX)
        // The best first: each takes its share of FOUND_CHARS, its schema while that fits too;
        // past it, the others come by name.
        let budget = FOUND_CHARS
        return {
          operations: scored.map(({ v }) => {
            const told = entry(v, FOUND_DESCRIPTION_CHARS)
            const size = charsOf(told)
            if (size > budget) return { operation: v.name }
            budget -= size
            const schemaSize = charsOf(v.inputSchema)
            if (schemaSize > budget) return told
            budget -= schemaSize
            return { ...told, inputSchema: v.inputSchema }
          }),
        }
      },
    }),
    [describe]: tool({
      description:
        `The description and input schema of one of ${label}'s operations (${find} finds them)` +
        `${several ? ', as the account given has it (needed when its accounts have it differently)' : ''}; ` +
        `a very long one comes condensed, what its schema accepts whole. [${where}]`,
      inputSchema: schema({
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'The operation, as found' },
          ...accountParam,
        },
        required: ['operation'],
      }),
      execute: async (input: { operation: string; account?: string }) =>
        described(variantFor(input.operation, input.account, true)),
    }),
    [run]: tool({
      description:
        `Call one of ${label}'s operations with its input, as its schema says (${describe}). ` +
        `An operation that makes a change may need a person's approval. [${where}]`,
      inputSchema: schema({
        type: 'object',
        properties: {
          operation: { type: 'string', description: 'The operation, as found' },
          ...accountParam,
          input: { type: 'object', description: "The operation's input, as its schema says" },
        },
        required: ['operation', ...(several ? ['account'] : []), 'input'],
      }),
      execute: async (
        input: { operation: string; account?: string; input?: unknown },
        { toolCallId },
      ) => {
        const variant = variantFor(input.operation, input.account)
        const grant = several
          ? variant.grants.find((g) => accountOf(g) === input.account)!
          : variant.grants[0]!
        return call({
          connectionId: grant.connectionId,
          operation: variant.name,
          input: input.input ?? {},
          toolCallId,
          toolName: run,
        })
      },
    }),
  }
  for (const t of Object.values(tools))
    (t as unknown as Record<symbol, boolean>)[CATALOG_TOOL] = true
  return tools
}

/** The parameter naming the account, on an App tool shared by its accounts (connectorTools). */
const ACCOUNT_PARAM = 'account'

const isObjectSchema = (schema: unknown): schema is JSONSchema7 =>
  typeof schema === 'object' &&
  schema !== null &&
  (schema as JSONSchema7).type === 'object' &&
  !('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema || '$ref' in schema)

/** The Apps an access ask may name (open_ticket's app.kind): an MCP server added by its URL is mcp. */
export const TICKET_APP_KINDS = [
  'gmail',
  'google_calendar',
  'google_drive',
  'google_docs',
  'google_sheets',
  'google_search_console',
  'google_analytics',
  'stripe',
  'github',
  'cloudflare',
  'google_cloud',
  'neon',
  'supabase',
  'atlassian',
  'notion',
  'linear',
  'mixpanel',
  'resend',
  'replicate',
  'openrouter',
  'posthog',
  'dataforseo',
  'ahrefs',
  'revenuecat',
  'expo',
  'mcp',
] as const

/**
 * The tools of the Apps granted to a thread. An App with one account: one tool per operation.
 * With several, one tool per operation all the same, whose `account` parameter picks the account
 * among those whose grant has the operation (a read-only grant has no writes): its schema, often
 * the biggest part of a thread's tools (PostHog's run to 100 KB), is sent once rather than once
 * per account. An operation whose schemas differ between accounts, or that takes an `account` of
 * its own, keeps a tool per account, its name suffixed with the account's.
 */
export function connectorTools(
  grants: ConnectorGrant[],
  call: ConnectorCaller,
  options: { defer?: boolean } = {},
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}
  const write = ' makes a change, a person may need to approve it'
  const accountOf = (grant: ConnectorGrant) => grant.externalAccount ?? grant.label
  const make = (
    name: string,
    description: string,
    schema: JSONSchema7,
    namespace: { name: string; description: string },
    route: (input: unknown) => { grant: ConnectorGrant; input: unknown },
    operation: string,
  ) =>
    (tools[name] = tool({
      description,
      inputSchema: jsonSchema({
        ...schema,
        ...(options.defer ? { [NAMESPACE]: namespace } : {}),
      } as JSONSchema7),
      execute: async (input, { toolCallId }) => {
        const to = route(input)
        return call({
          connectionId: to.grant.connectionId,
          operation,
          input: to.input,
          toolCallId,
          toolName: name,
        })
      },
    }))
  const kinds = [...new Set(grants.map((g) => g.kind))]
  for (const kind of kinds) {
    const ofKind = grants.filter((g) => g.kind === kind)
    if (catalogued(kind, ofKind)) {
      Object.assign(tools, catalogTools(kind, ofKind, call, options))
      continue
    }
    if (ofKind.length === 1) {
      const grant = ofKind[0]!
      const account = accountOf(grant)
      const namespace = { name: kind, description: `${grant.label}: ${account}` }
      for (const operation of grant.operations)
        make(
          operation.name,
          `${operation.description} [${grant.label}: ${account}${operation.write ? `;${write}` : ''}]`,
          operation.inputSchema as JSONSchema7,
          namespace,
          (input) => ({ grant, input }),
          operation.name,
        )
      continue
    }
    const label = ofKind[0]!.label
    const names = [...new Set(ofKind.flatMap((g) => g.operations.map((o) => o.name)))]
    for (const operationName of names) {
      const having = ofKind.flatMap((grant) => {
        const operation = grant.operations.find((o) => o.name === operationName)
        return operation ? [{ grant, operation }] : []
      })
      const first = having[0]!.operation
      const same = having.every(
        ({ operation }) =>
          operation.write === first.write &&
          operation.description === first.description &&
          JSON.stringify(operation.inputSchema) === JSON.stringify(first.inputSchema),
      )
      const schema = first.inputSchema as JSONSchema7
      const accounts = having.map(({ grant }) => accountOf(grant))
      const shared =
        same &&
        new Set(accounts).size === accounts.length &&
        isObjectSchema(schema) &&
        !(schema.properties && ACCOUNT_PARAM in schema.properties)
      if (!shared) {
        // A tool per account, as before.
        for (const { grant, operation } of having) {
          const account = accountOf(grant)
          make(
            `${operation.name}_${slug(account)}`.slice(0, 64),
            `${operation.description} [${grant.label}: ${account}${operation.write ? `;${write}` : ''}]`,
            operation.inputSchema as JSONSchema7,
            { name: `${kind}_${slug(account)}`, description: `${grant.label}: ${account}` },
            (input) => ({ grant, input }),
            operation.name,
          )
        }
        continue
      }
      make(
        operationName,
        `${first.description} [${label}, the account in \`${ACCOUNT_PARAM}\`: ${accounts.join(', ')}${first.write ? `;${write}` : ''}]`,
        {
          ...schema,
          properties: {
            [ACCOUNT_PARAM]: {
              type: 'string',
              enum: accounts,
              description: `The ${label} account to use`,
            },
            ...schema.properties,
          },
          required: [ACCOUNT_PARAM, ...(schema.required ?? [])],
        },
        { name: kind, description: `${label}: ${accounts.join(', ')}` },
        (input) => {
          const { [ACCOUNT_PARAM]: account, ...rest } = (input ?? {}) as Record<string, unknown>
          const to = having.find(({ grant }) => accountOf(grant) === account)
          if (!to)
            throw new Error(
              `${operationName} has no ${label} account "${String(account)}": use one of ${accounts.join(', ')}`,
            )
          return { grant: to.grant, input: rest }
        },
        operationName,
      )
    }
  }
  return tools
}

/**
 * Brigade's question tool, for harnesses whose adapter has no question tool of
 * its own (Codex). It has no execute: the turn pauses until a person answers
 * in the thread, and the answer comes back as its result.
 */
export const ASK_USER_TOOL = 'ask_user'

export const askUserTool = tool({
  description:
    'Ask the person who gave you this task one or more questions and wait for their answer. ' +
    'Use it when you need a decision or information only they have; offer options when there are clear choices. ' +
    'Never ask for a password, key or other secret here: set secret: true and they pick a saved credential, ' +
    'or, for one the vault lacks, open a ticket with an access ask of kind credential so they can save it.',
  inputSchema: jsonSchema<{ questions: unknown[] }>({
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id, unique among these questions' },
            question: { type: 'string' },
            header: { type: 'string', description: 'A short label, e.g. "Database"' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
            allowMultiple: { type: 'boolean', description: 'Several options may be picked' },
            allowFreeForm: { type: 'boolean', description: 'They may answer in their own words' },
            secret: {
              type: 'boolean',
              description: 'The answer is a credential: they pick one from the vault',
            },
          },
          required: ['id', 'question'],
        },
      },
    },
    required: ['questions'],
  }),
})

/**
 * Brigade's ticket tool, for both harnesses: the teammate asks a person for
 * sign-off, a choice, access, an action or information. Like ask_user it has
 * no execute; the turn pauses until every ask is answered.
 */
export const OPEN_TICKET_TOOL = 'open_ticket'

export const openTicketTool = tool({
  description:
    'Open a ticket for a person and wait until they answer it. Brigade asks a person by itself only where a ' +
    "tool says so (an App write that may need a person's approval, saving a credential, a trigger), and never " +
    'needs a ticket of yours to approve that same call. Elsewhere nothing waits for a person, so open one when ' +
    'you judge a person should decide first: sign-off on a draft or plan before you send or apply it ' +
    '(approval), a choice (decision), a connection or credential you lack (access), something only a person can do ' +
    'such as a phone call (action), or information only they have (input). Put several asks in one ticket rather than ' +
    'opening several. When a website stops you with a human check (a CAPTCHA, a "verify you are human" box, a ' +
    'bot or firewall block page), use an action ask with browser: true and leave the page open: the person takes ' +
    'over your browser from the ticket, clears it and hands back. Never ask for a password, key or other secret ' +
    'in words. For values a preview needs that only a person has (a third-party API key), use a variables ask: the ' +
    "person sets them for the repository's preview, and each start_preview gives them to the app; you learn which " +
    'were set, never their values. For a login or key the vault lacks, ' +
    'use an access ask of kind credential and fill in `credential` with what you know: the person saves it to the ' +
    'vault right in the ticket, and its mention comes back for you to use at once. Write it to be read at a glance: ' +
    "the ticket's title says what it is about once, each ask's title says what to do, without repeating it, and " +
    'anything a person copies elsewhere (an address, a value, a command) goes in `backticks`, which gives it a copy ' +
    'button.',
  inputSchema: jsonSchema<{ title: string; asks: unknown[] }>({
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What the ticket is about, in a few words' },
      asks: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short id, unique among these asks' },
            type: {
              type: 'string',
              enum: ['approval', 'decision', 'access', 'action', 'input', 'variables'],
            },
            title: {
              type: 'string',
              description: 'approval and action: what to sign off on or to do',
            },
            draft: {
              type: 'string',
              description:
                'approval: the full draft or plan, in Markdown, exactly as you would send or apply it',
            },
            question: { type: 'string', description: 'decision and input: what you ask' },
            options: {
              type: 'array',
              description: 'decision: the choices. Leave out for approve / decline',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
            kind: {
              type: 'string',
              enum: ['connection', 'credential'],
              description: 'access: what you lack',
            },
            what: {
              type: 'string',
              description: 'access: which service or credential, e.g. "Stripe"',
            },
            reason: { type: 'string', description: 'access: what you need it for' },
            app: {
              type: 'object',
              description:
                'access to an App (kind connection): which, and the access you need. The person grants it from the ticket, or connects the App there first. Ask read_write only when you must send or change something there. For an MCP server, such as one the person gives you a URL for, use kind mcp with its url: they add it and sign in from the ticket. For an MCP server already added, such as one a message mentions as an App, use kind mcp and put its name in what, and its server id when list_apps gives one; the url can be left out',
              properties: {
                kind: { type: 'string', enum: [...TICKET_APP_KINDS] },
                scope: { type: 'string', enum: ['read', 'read_write'] },
                url: {
                  type: 'string',
                  description: 'kind mcp: the MCP server URL, e.g. https://mcp.example.com/mcp',
                },
                server: {
                  type: 'string',
                  description:
                    'kind mcp: a server already added, by its id as list_apps gives it (app.server): the ticket finds that one, whatever its name',
                },
                repository: {
                  type: 'string',
                  description:
                    'kind github: the repository you need, as owner/name (e.g. acme/web), such as one checkout_repository could not reach. The person installs the GitHub app on it, or adds it, from the ticket',
                },
                account: {
                  type: 'string',
                  description:
                    'The account you mean, as its row shows it (e.g. the Gmail address), when you know which: the ticket picks it first',
                },
                permission: {
                  type: 'string',
                  description:
                    'A permission an account you already have lacks, which the person allows on the provider\'s consent page as they sign in to it again, e.g. "Account API Tokens: Write" on Cloudflare\'s. The ticket offers to reconnect the account: never write steps for that',
                },
                teammate: {
                  type: 'string',
                  description:
                    'The teammate the access is for, by name, when it is not you: e.g. the one a playbook you install hands this App to',
                },
              },
              required: ['kind', 'scope'],
            },
            credential: {
              type: 'object',
              description:
                'access to a credential: what you know of it, to fill in the form the person saves it with. Never a secret',
              properties: {
                kind: { type: 'string', enum: ['website', 'database', 'api_key', 'other'] },
                name: { type: 'string', description: 'e.g. "Reddit"' },
                url: {
                  type: 'string',
                  description:
                    "website: the sign-in page, e.g. https://www.reddit.com/login (the password is only typed on its domain). api_key: the API's base URL",
                },
                username: {
                  type: 'string',
                  description: 'website: the username or email, if known',
                },
              },
            },
            steps: {
              type: 'array',
              items: { type: 'string' },
              description:
                'action: what to do, in order: one short line each, such as "Development → MCP connectors → Create", with no asides in parentheses; put what they need to know (use a test account, why) in the title instead',
            },
            browser: {
              type: 'boolean',
              description:
                'action: done in your browser on this computer, such as a "verify you are human" check. The person takes over your browser from the ticket',
            },
            secret: {
              type: 'boolean',
              description: 'input: the answer is a credential; they pick one from the vault',
            },
            repository: {
              type: 'string',
              description: 'variables: the repository (owner/name) whose preview needs them',
            },
            variables: {
              type: 'array',
              maxItems: 20,
              description:
                'variables: what the app needs, by environment variable name. Only values you cannot make up or run locally',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'e.g. "STRIPE_SECRET_KEY"' },
                  description: {
                    type: 'string',
                    description:
                      'What the app uses it for and where to get one, e.g. "Payments on /checkout: a test-mode key from the Stripe dashboard"',
                  },
                  secret: {
                    type: 'boolean',
                    description: 'false for a setting that is not secret (default true)',
                  },
                },
                required: ['name'],
              },
            },
          },
          required: ['id', 'type'],
        },
      },
    },
    required: ['title', 'asks'],
  }),
})

/**
 * The team card shows under the chief's reply, whether it comes before or after
 * it. It is best called right before the reply: text written before a tool call
 * may come back only as the server's summary of it (narration). Its result never
 * asks for the reply outright: the chief knows whether it wrote it, and one told
 * to write it again did. Replies and choices are blocks in the reply (replyCard).
 */
const UNDER_REPLY =
  'It shows under your reply: call it right before writing that reply, as text written before a tool call ' +
  'may reach the person only as a summary. If you wrote the reply already, do not write it again.'
const SHOWN =
  'Shown under your reply. If you have not written that reply yet, write it now as text; if you have, ' +
  'your turn is over: write nothing more.'

/**
 * A visual drawn in the thread: throwaway HTML the dashboard shows in a
 * sandboxed frame. It does not pause the turn.
 */
export const showWidgetTool = tool({
  description:
    'Draw a visual in the thread: options side by side, a diagram, a chart of data you have. For seeing ' +
    `something now, not for keeping (that is a design). Call ${WIDGET_GUIDE_TOOL} once before your first widget ` +
    'in a thread. To let the person pick among options it shows, end your reply with a choices block. ' +
    "Write its title and text in the language of the person's latest message; only the product's own interface " +
    'drawn in it stays as the product has it.',
  inputSchema: jsonSchema<Widget>({
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `What it shows, a few words in the person's language, e.g. "Six ways to show the shortcut"`,
      },
      html: {
        type: 'string',
        maxLength: WIDGET_HTML_MAX,
        description: `The body's HTML: inline <style>, <script> and SVG, following ${WIDGET_GUIDE_TOOL}`,
      },
    },
    required: ['title', 'html'],
  }),
  execute: async (input) => {
    const parsed = Widget.safeParse(input)
    if (!parsed.success) throw new Error(`Invalid widget: ${parsed.error.message}`)
    return {
      shown: true,
      next:
        'If it shows options, end your reply with a choices block, labels numbered and named as in the widget ("3 · Small square caps"): ' +
        'other teammates see the pick, never the widget.',
    }
  },
})

/**
 * A teammate's answer, at once, to a person's message given to its running turn: a question it
 * can answer now. Brigade shows it as the teammate's message under theirs, word for word, and
 * keeps it in sight once the turn ends, where text written between steps can fold away with them
 * or reach the person only as the server's summary of it (narration). EventMapper records the
 * call as that message (answerText); the call itself shows nothing.
 */
export const answerMessageTool = tool({
  description:
    'Answer at once a message a person wrote while you work (it says so), in a line or two, then go on with ' +
    'the work. It shows as your message, word for word, under theirs, and stays there once your turn ends. ' +
    "Only for such a message: your turn's reply is still text, at its end, without that answer again.",
  inputSchema: jsonSchema<{ text: string }>({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Your answer, as you would write it to them' },
    },
    required: ['text'],
  }),
  execute: async (input) => {
    if (!answerText(input)) throw new Error('Give your answer as text')
    return { shown: true, next: 'Shown under their message. Go on with the work.' }
  },
})

/** The rules for show_widget, read on demand so they cost nothing in turns without one. */
export const widgetGuideTool = tool({
  description: `How to draw a widget with show_widget: when, layout, theme, what is blocked, examples. Read it before your first widget in a thread.`,
  inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
  execute: async () => WIDGET_GUIDE,
})

/** The chief's proposal of teammates, shown as a card a person edits and accepts. */
export const proposeTeamTool = tool({
  description:
    'Show the person the teammates you suggest as a card they can edit, then create with one click; your reply ' +
    'describes the team. Their answer arrives as their next message: "Created the team: …" naming the new ' +
    'teammates, or their own words to change it. ' +
    UNDER_REPLY,
  inputSchema: jsonSchema<TeamProposal>({
    type: 'object',
    properties: {
      teammates: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: `A short first name, e.g. "Riley"; never "${CHIEF_NAME}"`,
            },
            role: {
              type: 'string',
              description:
                'One line: what it does, e.g. "Ships features and fixes bugs in acme/web"',
            },
            instructions: {
              type: 'string',
              description:
                'Written to the teammate as "you": the role, what it owns, how it works, what it asks a person first',
            },
            connections: {
              type: 'array',
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: [
                      'gmail',
                      'google_calendar',
                      'google_drive',
                      'google_docs',
                      'google_sheets',
                      'google_search_console',
                      'google_analytics',
                      'stripe',
                      'github',
                    ],
                  },
                  scope: {
                    type: 'string',
                    enum: ['read', 'read_write'],
                    description:
                      'read_write only when the role must send or change something there',
                  },
                  why: { type: 'string', description: 'A few words, e.g. "to answer customers"' },
                },
                required: ['kind', 'scope'],
              },
            },
          },
          required: ['name', 'role', 'instructions'],
        },
      },
    },
    required: ['teammates'],
  }),
  execute: async (input) => {
    const parsed = TeamProposal.safeParse(input)
    if (!parsed.success) throw new Error(`Invalid proposal: ${parsed.error.message}`)
    const names = parsed.data.teammates.map((t) => t.name.toLowerCase())
    if (names.some(isChiefName)) throw new Error(`"${CHIEF_NAME}" is your name; pick another`)
    if (new Set(names).size !== names.length) throw new Error('Give each teammate its own name')
    return {
      shown: parsed.data.teammates.length,
      next: `${SHOWN} The person edits the card and creates the team, or answers in their own words.`,
    }
  },
})

type Credentials = {
  canFill: boolean
  list: (call: Call) => Promise<unknown>
  env: (
    credentialId: string,
    call: Call,
  ) => Promise<{
    file: string
    variables: string[]
    credential: { name: string; details: unknown }
  }>
  fill: (credentialId: string, submit: boolean, call: Call) => Promise<unknown>
  save: (input: SaveInput, call: Call) => Promise<unknown>
}
type SaveInput =
  | {
      mode: 'create'
      kind: 'website' | 'database' | 'api_key' | 'other'
      name: string
      details: object
      secretFile: string
    }
  | { mode: 'update'; credentialId: string; changes: object; secretFile?: string }
type Call = { toolCallId: string; toolName: string; input: unknown }

const MENTIONS =
  'Members mention credentials in messages as @[Name](credential:<id>). You may use a credential shared with you once a member mentions it in this thread or a person approves, or right away when you may use it without asking (list_credentials says which). ' +
  'One not shared with you needs its creator or an admin to allow it. ' +
  'For one the vault lacks, open a ticket with an access ask of kind credential: the person saves it from the ticket.'

/** The vault's credentials, as tools. Their secrets never appear in a tool result. */
export function credentialTools(credentials: Credentials): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    list_credentials: tool({
      description: `List the vault's credentials you may use, and those mentioned in this thread: names, kinds, non-secret details such as URL, username or host, and whether using one needs approval. Never the secrets. ${MENTIONS}`,
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        credentials.list({ toolCallId, toolName: 'list_credentials', input }),
    }),
    use_credential: tool({
      description:
        `Get a database, API key or other non-website credential as a private env file on this computer. ` +
        `Returns the file and its variable names (e.g. DATABASE_URL, PGPASSWORD, API_KEY), not the values. ` +
        `Load it only in the command that needs it, e.g. \`set -a; . <file>; set +a; psql "$DATABASE_URL"\`. ` +
        `Never print, copy or commit the file or its values. ${MENTIONS}`,
      inputSchema: jsonSchema<{ credentialId: string }>({
        type: 'object',
        properties: { credentialId: { type: 'string' } },
        required: ['credentialId'],
      }),
      execute: async (input, { toolCallId }) => {
        const result = await credentials.env(input.credentialId, {
          toolCallId,
          toolName: 'use_credential',
          input,
        })
        return {
          credential: result.credential.name,
          details: result.credential.details,
          file: result.file,
          variables: result.variables,
          note: 'The file is removed when this thread goes idle; call use_credential again if it is gone.',
        }
      },
    }),
  }
  tools.save_credential = tool({
    description:
      `Save a secret you produced to the vault: a password you set while creating an account, an API key you generated, a password a site made you reset. ` +
      `Write the secret alone to a file first, without printing it (e.g. redirect the command that makes it), and pass the file's path: never put a secret in a tool call. ` +
      `mode create: a new credential, which only you may use until someone shares it. mode update: a new secret, and optionally a new name, username, database or notes, for one you may use; ` +
      `where a credential's secret goes (its URL, host or port) cannot be changed here. A person approves before anything is kept; the replaced secret can be restored. ` +
      `Delete the file once it is saved.`,
    inputSchema: jsonSchema<{
      mode: 'create' | 'update'
      secretFile?: string
      credentialId?: string
      kind?: 'website' | 'database' | 'api_key' | 'other'
      name?: string
      url?: string
      username?: string
      engine?: 'postgres' | 'mysql' | 'mongodb' | 'other'
      host?: string
      port?: number
      database?: string
      notes?: string
    }>({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['create', 'update'] },
        secretFile: {
          type: 'string',
          description:
            'Path to a file holding only the secret. Required to create; optional to update.',
        },
        credentialId: { type: 'string', description: 'update: the credential to change' },
        kind: {
          type: 'string',
          enum: ['website', 'database', 'api_key', 'other'],
          description:
            'create: website (a login typed into a sign-in page), database, api_key or other',
        },
        name: { type: 'string', description: 'A short name, e.g. "Acme dashboard (support bot)"' },
        url: {
          type: 'string',
          description: "create: a website's sign-in page, or an API's base URL",
        },
        username: { type: 'string' },
        engine: { type: 'string', enum: ['postgres', 'mysql', 'mongodb', 'other'] },
        host: { type: 'string', description: "create: a database's host" },
        port: { type: 'number' },
        database: { type: 'string' },
        notes: { type: 'string', description: 'For teammates: what it is for, any limits' },
      },
      required: ['mode'],
    }),
    execute: async (input, { toolCallId }) => {
      const call = { toolCallId, toolName: 'save_credential', input }
      const defined = <T extends object>(o: T) =>
        Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''))
      if (input.mode === 'create') {
        if (!input.secretFile || !input.kind || !input.name)
          throw new Error('To create a credential, give secretFile, kind and name')
        const saved = await credentials.save(
          {
            mode: 'create',
            kind: input.kind,
            name: input.name,
            details: defined({
              url: input.url,
              username: input.username,
              engine: input.engine,
              host: input.host,
              port: input.port,
              database: input.database,
              notes: input.notes,
            }),
            secretFile: input.secretFile,
          },
          call,
        )
        return { saved, note: 'Saved. Delete the secret file now.' }
      }
      if (!input.credentialId) throw new Error('To update a credential, give its credentialId')
      if (input.url || input.host || input.port || input.engine || input.kind)
        throw new Error(
          "Where a credential's secret goes (its URL, host, port, engine) or its kind can only be changed by a person in the vault",
        )
      const saved = await credentials.save(
        {
          mode: 'update',
          credentialId: input.credentialId,
          changes: defined({
            name: input.name,
            username: input.username,
            database: input.database,
            notes: input.notes,
          }),
          ...(input.secretFile ? { secretFile: input.secretFile } : {}),
        },
        call,
      )
      return {
        saved,
        ...(input.secretFile ? { note: 'Saved. Delete the secret file now.' } : {}),
      }
    },
  })
  if (credentials.canFill)
    tools.fill_credential = tool({
      description:
        `Sign in to a website with a login from the vault: Brigade types the username and password into your current tab of that site ` +
        `(which must be on the credential's own domain) and presses Enter, so you never see the password. ` +
        `Open the sign-in page in your browser first. On a two-step sign-in, call it again on the password page. ` +
        `Never read the password back from the page. ${MENTIONS}`,
      inputSchema: jsonSchema<{ credentialId: string; submit?: boolean }>({
        type: 'object',
        properties: {
          credentialId: { type: 'string' },
          submit: { type: 'boolean', description: 'Press Enter after filling (default true)' },
        },
        required: ['credentialId'],
      }),
      execute: (input, { toolCallId }) =>
        credentials.fill(input.credentialId, input.submit ?? true, {
          toolCallId,
          toolName: 'fill_credential',
          input,
        }),
    })
  return tools
}

export type LibraryCaller = (call: {
  /** A save's bytes and a proposal's files are uploaded to the bucket before the hub hears of them. */
  operation: LibraryOperation
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

/**
 * The workspace's search (library, memory, past thread summaries) and, with a
 * read-write grant on the library or a folder of it, saving, moving and
 * deleting library files. The API checks the grant.
 */
export function libraryTools(options: {
  access: 'read' | 'read_write'
  /** Folders where the teammate's access differs from `access`. */
  folders?: { path: string; access: 'read' | 'read_write' }[]
  libraryDir: string
  call: LibraryCaller
  /** Reads a file the teammate wrote on this computer, as the teammate. */
  readFile: (path: string) => Promise<Buffer>
  /** Copies a file the teammate wrote, as the teammate, to be sent as it streams (save_to_library). */
  stageFile: (path: string) => Promise<StagedFile>
  /** The files in a folder on this computer, as the teammate: paths relative to it. */
  listFiles: (folder: string) => Promise<string[]>
  /** Render a design folder with this computer's Chrome: screenshots and the page's errors. */
  renderDesign: (
    folder: string,
    options: { viewports?: string[]; shots?: boolean; thumbnail?: boolean },
  ) => Promise<{ screenshots: string[]; errors: string[]; thumbnail?: string }>
}): Record<string, Tool> {
  /** A folder's files on this computer, as paths relative to it, without dotfiles and node_modules. */
  const folderFiles = async (folder: string) =>
    (await options.listFiles(folder)).filter(
      (f) => !f.split('/').some((part) => part.startsWith('.') || part === 'node_modules'),
    )
  /**
   * Save a folder's files to the library under `path`, with a picture for each
   * design in it that has none (`''` for the folder itself). Best effort: not
   * every computer has Chrome.
   */
  const saveFolder = async (
    folder: string,
    path: string,
    files: string[],
    designs: string[],
    call: { toolCallId: string; toolName: string; input: unknown },
  ) => {
    const sources = new Map(files.map((f) => [f, `${folder}/${f}`]))
    for (const design of designs) {
      const at = (file: string) => (design ? `${design}/${file}` : file)
      if (sources.has(at(DESIGN_THUMBNAIL)) || !sources.has(at(DESIGN_ENTRY))) continue
      const shot = await options
        .renderDesign(design ? `${folder}/${design}` : folder, { shots: false, thumbnail: true })
        .catch(() => undefined)
      if (shot?.thumbnail) sources.set(at(DESIGN_THUMBNAIL), shot.thumbnail)
    }
    const saved: string[] = []
    for (const [file, source] of sources) {
      const bytes = await options.readFile(source)
      try {
        await options.call({
          ...call,
          operation: { name: 'save', path: `${path}/${file}`, bytes },
        })
      } catch (error) {
        throw new Error(
          `Saved ${saved.length} of ${sources.size} files, then ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      saved.push(file)
    }
    return saved.length
  }
  const tools: Record<string, Tool> = {
    search_workspace: tool({
      description:
        `Search the workspace's shared knowledge by keywords: its document library (mirrored read-only at ${options.libraryDir}), ` +
        `the workspace, project and teammate memory, lines removed from memory (with why), and summaries of past threads, ` +
        "each with the thread's mention, to name it by in a reply. " +
        'Use it before asking a person something the team may already know.',
      inputSchema: jsonSchema<{ query: string; limit?: number }>({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords; "quotes" for a phrase, -word to exclude',
          },
          limit: { type: 'number', description: 'At most this many results (default 8, up to 20)' },
        },
        required: ['query'],
      }),
      execute: async (input, { toolCallId }) => {
        const hits = (await options.call({
          operation: { name: 'search', query: input.query, limit: Math.min(input.limit ?? 8, 20) },
          toolCallId,
          toolName: 'search_workspace',
          input,
        })) as { kind: string; path: string; sessionId?: string | null; title?: string }[]
        return hits.map((hit) =>
          hit.kind === 'library'
            ? { ...hit, file: `${options.libraryDir}/${hit.path}` }
            : // A thread named by its mention is a link people open in the dashboard.
              hit.kind === 'thread_summary' && hit.sessionId
              ? {
                  ...hit,
                  mention: formatMention({
                    kind: 'thread',
                    id: hit.sessionId,
                    label: hit.title?.replace(/^Thread: /, '') || hit.sessionId,
                  }),
                }
              : hit,
        )
      },
    }),
  }
  // Any teammate may propose; an admin decides in a ticket, so nothing waits on the answer.
  tools[PROPOSE_SKILL_TOOL] = tool({
    description:
      'Propose a skill for the workspace, or a change to one: how to do a kind of work, for teammates to follow ' +
      'when the work calls for it. Write its folder on this computer first: a SKILL.md (YAML frontmatter with ' +
      '`name`, lowercase words joined by hyphens, and `description`, when to use it; then the steps) and the text ' +
      'files it points to. To change a skill, propose it whole under its name. An admin approves it in a ticket; it ' +
      'applies to threads that start after that. Do not wait for the answer.',
    inputSchema: jsonSchema<{ folder: string; reason?: string; onlyMe?: boolean }>({
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'The skill folder on this computer, with its SKILL.md',
        },
        reason: {
          type: 'string',
          description:
            'For the admin: the work it comes from and why it is worth keeping, in a line or two',
        },
        onlyMe: {
          type: 'boolean',
          description:
            "A new skill for your own threads only, not every teammate's: a task a person taught you",
        },
      },
      required: ['folder'],
    }),
    execute: async (input, { toolCallId }) => {
      const folder = input.folder.replace(/\/+$/, '')
      const paths = await folderFiles(folder)
      if (!paths.includes(SKILL_ENTRY)) throw new Error(`${folder} has no ${SKILL_ENTRY}`)
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const text = (bytes: Buffer) => {
        if (bytes.includes(0)) return null
        try {
          return decoder.decode(bytes)
        } catch {
          return null
        }
      }
      const entry = text(await options.readFile(`${folder}/${SKILL_ENTRY}`))
      if (entry === null) throw new Error(`${SKILL_ENTRY} is not text`)
      const parsed = parseSkillMarkdown(entry)
      const files: { path: string; content: string; bytes: Buffer }[] = []
      const skipped: string[] = []
      for (const path of paths) {
        if (path === SKILL_ENTRY) continue
        const bytes = await options.readFile(`${folder}/${path}`)
        const content = text(bytes)
        if (content === null) skipped.push(path)
        else if (bytes.length > SKILL_FILE_MAX)
          throw new Error(
            `${path} is too large: a skill's file can be up to ${SKILL_FILE_MAX / 1024 / 1024} MB`,
          )
        else files.push({ path, content, bytes })
      }
      if (files.reduce((sum, f) => sum + f.bytes.length, 0) > SKILL_TOTAL_MAX)
        throw new Error(`The skill is too large: up to ${SKILL_TOTAL_MAX / 1024 / 1024} MB in all`)
      const skill = SkillContent.safeParse({
        name: parsed.name ?? '',
        description: parsed.description ?? '',
        instructions: parsed.instructions,
        files: files.map(({ path, content }) => ({ path, content })),
      })
      if (!skill.success)
        throw new Error(
          `Not a skill yet: ${skill.error.issues.map((i) => `${i.path.join('.') || 'skill'}: ${i.message}`).join('; ')}`,
        )
      const result = (await options.call({
        operation: {
          name: 'skill_proposal',
          // Its files go to the bucket first; the proposal names them by their SHA-256.
          proposal: {
            skill: { ...skill.data, files: [] },
            reason: input.reason?.trim().slice(0, 1000) ?? '',
            teammateOnly: input.onlyMe === true,
          },
          files: files.map(({ path, bytes }) => ({ path, bytes })),
        },
        toolCallId,
        toolName: PROPOSE_SKILL_TOOL,
        input,
      })) as { ticketId: string; change: boolean }
      return {
        ...result,
        name: skill.data.name,
        files: files.length,
        ...(skipped.length > 0 ? { skipped: `Left out (not text): ${skipped.join(', ')}` } : {}),
        status:
          'Proposed. An admin approves it in a ticket; it applies to threads that start after that. Go on with your work.',
      }
    },
  })
  if (options.access === 'read_write' || options.folders?.some((f) => f.access === 'read_write')) {
    tools.save_to_library = tool({
      description:
        `Add a file to the workspace's document library, or replace the one at that path, so the team and other teammates can use it. ` +
        `Write the file on this computer first, then pass its path. The library copy at ${options.libraryDir} is read-only; it updates shortly after.`,
      inputSchema: jsonSchema<{ file: string; path: string }>({
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description:
              'The file on this computer (absolute, or relative to your working directory)',
          },
          path: {
            type: 'string',
            description: 'Where it goes in the library, e.g. "guides/refunds.md"',
          },
        },
        required: ['file', 'path'],
      }),
      execute: async (input, { toolCallId }) => {
        const file = await options.stageFile(input.file)
        return options.call({
          operation: { name: 'save', path: input.path, file },
          toolCallId,
          toolName: 'save_to_library',
          input,
        })
      },
    })
    tools.move_in_library = tool({
      description:
        `Move or rename a file in the workspace's library, or a folder with everything in it. ` +
        `Refused when something is already at the new path. Documents and memory that name the old path keep it: update those that matter.`,
      inputSchema: jsonSchema<{ path: string; to: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Its library path, e.g. "guides/refunds.md"' },
          to: {
            type: 'string',
            description: 'Its whole new path, e.g. "guides/billing/refunds.md"',
          },
        },
        required: ['path', 'to'],
      }),
      execute: (input, { toolCallId }) =>
        options.call({
          operation: { name: 'move', path: input.path, to: input.to },
          toolCallId,
          toolName: 'move_in_library',
          input,
        }),
    })
    tools.delete_from_library = tool({
      description:
        `Put a file of the workspace's library, or a folder with everything in it, in the library's trash, ` +
        `where a person can restore it for ${TRASH_DAYS} days. Delete only what a person asked you to, ` +
        `or what you saved yourself and nobody needs any more (a draft, a copy, a note that only points elsewhere).`,
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Its library path, e.g. "guides/old-refunds.md"' },
        },
        required: ['path'],
      }),
      execute: (input, { toolCallId }) =>
        options.call({
          operation: { name: 'delete', path: input.path },
          toolCallId,
          toolName: 'delete_from_library',
          input,
        }),
    })
    tools.save_design = tool({
      description:
        `Save a design (a page, screen, prototype, slide or one-pager) to the library, where people view and comment on it. ` +
        `Make it in a folder on this computer with ${DESIGN_ENTRY} and ${DESIGN_MANIFEST} at its top, then pass the folder. ` +
        `Every file in it is saved; saving again replaces them. People edit saved designs by hand: a save over their ` +
        `edits is refused once, saying what to do.`,
      inputSchema: jsonSchema<{ folder: string; path: string; overwrite?: boolean }>({
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description:
              'The folder on this computer (absolute, or relative to your working directory)',
          },
          path: {
            type: 'string',
            description: `Where it goes in the library, ending in "${DESIGN_SUFFIX}", e.g. "acme/pricing-page${DESIGN_SUFFIX}"`,
          },
          overwrite: {
            type: 'boolean',
            description:
              'Save even though a person edited the saved design since you last saved it: only when your files were made from the library copy that has their edits',
          },
        },
        required: ['folder', 'path'],
      }),
      execute: async (input, { toolCallId }) => {
        const path = input.path.replace(/\/+$/, '')
        if (!path.endsWith(DESIGN_SUFFIX) || path.split('/').pop() === DESIGN_SUFFIX)
          throw new Error(`The library path must end in "<name>${DESIGN_SUFFIX}"`)
        const files = await folderFiles(input.folder)
        for (const needed of [DESIGN_ENTRY, DESIGN_MANIFEST])
          if (!files.includes(needed)) throw new Error(`The folder has no ${needed} at its top`)
        if (files.length > DESIGN_FILES_MAX)
          throw new Error(
            `A design can have up to ${DESIGN_FILES_MAX} files; this folder has ${files.length}`,
          )
        const folder = input.folder.replace(/\/+$/, '')
        const manifest = await options
          .readFile(`${folder}/${DESIGN_MANIFEST}`)
          .then((bytes) => DesignManifest.safeParse(JSON.parse(bytes.toString('utf8'))).data)
          .catch(() => undefined)
        const missing = (manifest?.boards ?? []).filter((b) => !files.includes(b.file))
        if (missing.length)
          throw new Error(
            `${DESIGN_MANIFEST} lists boards whose page is not in the folder: ${missing.map((b) => b.file).join(', ')}`,
          )
        if (!input.overwrite) {
          // Before saving anything: a person may have changed the saved design on its canvas.
          const edited = (await options
            .call({
              operation: { name: 'design_edits', path },
              toolCallId,
              toolName: 'save_design',
              input,
            })
            // An API from before canvases does not know the question: nobody edited by hand.
            .catch(() => [])) as DesignPersonEdit[]
          const overwritten = edited.filter((e) => files.includes(e.file))
          if (overwritten.length)
            throw new Error(
              `${overwritten.map((e) => `${e.by} edited \`${e.file}\``).join(', ')} on the canvas after you last saved ` +
                `${overwritten.length > 1 ? 'them' : 'it'}. Copy the library's copy (${options.libraryDir}/${path}/) into your ` +
                'folder and make your change on it, then save. If your files were made from that copy, save again with overwrite: true. Nothing was saved.',
            )
        }
        const saved = await saveFolder(folder, path, files, [''], {
          toolCallId,
          toolName: 'save_design',
          input,
        })
        return { path, files: saved }
      },
    })
    tools.save_design_system = tool({
      description:
        'Save a design system to the library and register it, so teammates follow it in their designs. ' +
        `Make it in a folder on this computer: ${DESIGN_SYSTEM_README} (the rules), ${DESIGN_SYSTEM_TOKENS} (the tokens), ` +
        `assets/ and ${DESIGN_SYSTEM_PREVIEW}/ (a design that shows it), then pass the folder. Every file in it is saved. ` +
        'Saving again with the same name replaces its files and updates it; what you leave out keeps its value.',
      inputSchema: jsonSchema<{
        folder: string
        path: string
        name: string
        description?: string
        default?: boolean
        repositories?: string[]
        folders?: string[]
      }>({
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description:
              'The folder on this computer (absolute, or relative to your working directory)',
          },
          path: {
            type: 'string',
            description: 'Its library folder, e.g. "design-systems/acme"',
          },
          name: { type: 'string', description: 'What designs name it, e.g. "acme"' },
          description: {
            type: 'string',
            description: 'One line: the product or brand it is for',
          },
          default: {
            type: 'boolean',
            description:
              "Use it where no other applies. Default: yes for the workspace's first design system",
          },
          repositories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Work in these repositories (owner/name) follows it',
          },
          folders: {
            type: 'array',
            items: { type: 'string' },
            description: 'Designs saved in these library folders follow it',
          },
        },
        required: ['folder', 'path', 'name'],
      }),
      execute: async (input, { toolCallId }) => {
        const path = input.path.replace(/\/+$/, '')
        if (designFolderOf(path))
          throw new Error(
            `A design system's library path is a plain folder, not one ending in "${DESIGN_SUFFIX}"`,
          )
        const files = await folderFiles(input.folder)
        for (const needed of [DESIGN_SYSTEM_README, DESIGN_SYSTEM_TOKENS])
          if (!files.includes(needed)) throw new Error(`The folder has no ${needed} at its top`)
        if (files.length > DESIGN_SYSTEM_FILES_MAX)
          throw new Error(
            `A design system can have up to ${DESIGN_SYSTEM_FILES_MAX} files; this folder has ${files.length}`,
          )
        const folder = input.folder.replace(/\/+$/, '')
        const designs = [...new Set(files.map((f) => designFolderOf(f)).filter((d) => d != null))]
        const call = { toolCallId, toolName: 'save_design_system', input }
        const saved = await saveFolder(folder, path, files, designs, call)
        const registered = await options.call({
          ...call,
          operation: {
            name: 'design_system',
            designSystem: {
              name: input.name,
              path,
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.default !== undefined ? { isDefault: input.default } : {}),
              ...(input.repositories ? { repositories: input.repositories } : {}),
              ...(input.folders ? { folders: input.folders } : {}),
            },
          },
        })
        return {
          ...(registered as object),
          files: saved,
          ...(designs.includes(DESIGN_SYSTEM_PREVIEW)
            ? { preview: `${path}/${DESIGN_SYSTEM_PREVIEW}` }
            : {}),
        }
      },
    })
    tools.check_design = tool({
      description:
        'Render a design folder on this computer with Chrome, before you hand it over: screenshots at its viewports ' +
        '(one per slide for a deck) and the errors its page logged (scripts, files that failed to load). ' +
        'Open the screenshots to look at them, fix what is off, and check again.',
      inputSchema: jsonSchema<{ folder: string; viewports?: ('desktop' | 'tablet' | 'mobile')[] }>({
        type: 'object',
        properties: {
          folder: {
            type: 'string',
            description: `The design folder on this computer, with ${DESIGN_ENTRY} at its top`,
          },
          viewports: {
            type: 'array',
            items: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
            description: `Default: those in ${DESIGN_MANIFEST}, else desktop and mobile`,
          },
        },
        required: ['folder'],
      }),
      execute: async (input) => {
        const result = await options.renderDesign(input.folder, {
          ...(input.viewports ? { viewports: input.viewports } : {}),
        })
        return {
          screenshots: result.screenshots,
          errors: result.errors.length ? result.errors : 'none',
          next: 'Open each screenshot file to look at it.',
        }
      },
    })
  }
  return tools
}

/**
 * Threads it starts at the top, and writes in later (docs/hand-offs.md): start_thread hands a goal
 * of its own, or work another teammate carries through, to a thread in the sidebar; message_thread
 * writes in one it started, or in one of its children. The API checks every call. A playbook's run
 * starts none outside it: what started it is untrusted, and a thread outside the run has none of
 * its limits. It writes only in its own children.
 */
export function startedThreadTools(
  call: ScheduleCaller,
  options: { playbook: boolean },
): Record<string, Tool> {
  const message = (description: string, threadId: string) =>
    tool({
      description,
      inputSchema: jsonSchema<{ threadId: string; text: string }>({
        type: 'object',
        properties: {
          threadId: { type: 'string', description: threadId },
          text: { type: 'string', description: 'The message, in Markdown' },
        },
        required: ['threadId', 'text'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'message_thread', threadId: input.threadId, text: input.text },
          toolCallId,
          toolName: 'message_thread',
          input,
        }),
    })
  if (options.playbook)
    return {
      message_thread: message(
        'Write in one of your child threads (threadId, from list_children), which carries on and reports to you ' +
          'again. Nowhere else.',
        'One of your child threads',
      ),
    }
  return {
    start_thread: tool({
      description:
        'Start work in a thread of its own, at the top: in the sidebar, on this computer and the accounts of the ' +
        'person in this thread, for whoever asked here. For a goal of yours that came up here but is not this ' +
        "thread's work (leave teammate out), or work another teammate takes on and carries through (teammate). " +
        'Not for work whose result must come back here: that is start_child. The thread does not see this ' +
        'conversation: write a brief that stands alone (the goal, what done looks like, where the specs are). ' +
        'With lines of a list (list and items), it works on them, as when a person hands lines over. One goal is ' +
        'one thread and one deliverable, however big: never a thread per step. It goes in the project you set, ' +
        "else the list's, else this thread's.",
      inputSchema: jsonSchema<{
        title: string
        brief: string
        teammate?: string
        project?: string
        list?: string
        items?: string[]
      }>({
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short and plain, e.g. "Add CSV export to billing"',
          },
          brief: { type: 'string', description: 'The work, standing alone' },
          teammate: {
            type: 'string',
            description: 'Who does it: a teammate id or name, never a person. Unset: you.',
          },
          project: {
            type: 'string',
            description:
              'The project it belongs to: its id or name from your instructions, or "none" for no project.',
          },
          list: { type: 'string', description: "A list's library path, with items" },
          items: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Lines of the list it works on: each line's id, or its text (all of it, or enough of its start to be the only one)",
          },
        },
        required: ['title', 'brief'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'start_thread',
            title: input.title,
            brief: input.brief,
            ...(input.teammate ? { teammate: input.teammate } : {}),
            ...(input.project ? { project: input.project === 'none' ? null : input.project } : {}),
            ...(input.list ? { list: input.list } : {}),
            ...(input.items?.length ? { items: input.items } : {}),
          },
          toolCallId,
          toolName: 'start_thread',
          input,
        }),
    }),
    message_thread: message(
      'Write in another thread: one you started (start_thread), where its teammate reads it and answers there, or ' +
        'one of your child threads (from list_children), which carries on and reports to you again. Nowhere else. ' +
        'To talk to a person, open a ticket instead.',
      'A thread you started, or one of your child threads',
    ),
  }
}

export type ScheduleCaller = (call: {
  operation: ScheduleOperation
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

const CRON =
  'Five-field cron: minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5" for 09:00 on weekdays, ' +
  '"30 7 * * 1" for 07:30 on Mondays, "0 */2 * * *" every two hours. Runs at least 5 minutes apart.'
const TIMEZONE =
  'IANA timezone the hours are in, e.g. "Europe/Paris". Use the person\'s if you know it.'

/**
 * Chief for the person (docs/chief-answers.md). In its daily pass, the thread Brigade starts for
 * it: answer a question in the person's name, try a failed thread again, and report what is left
 * to them. Elsewhere: their rules, written with them.
 */
export function chiefTools(
  call: ScheduleCaller,
  options: { pass: boolean; acts?: boolean },
): Record<string, Tool> {
  if (!options.pass)
    return {
      chief_rules: tool({
        description:
          "Save the person's rules for their teammates, whole, once they agreed to them: short lines in their words " +
          'that settle what they would otherwise be asked. Every teammate working for them reads them. An empty text ' +
          'clears them.',
        inputSchema: jsonSchema<{ rules: string }>({
          type: 'object',
          properties: {
            rules: {
              type: 'string',
              description: 'The rules, whole, one per line (at most 4000 characters)',
            },
          },
          required: ['rules'],
        }),
        execute: (input, { toolCallId }) =>
          call({
            operation: { name: 'chief_rules', rules: input.rules },
            toolCallId,
            toolName: 'chief_rules',
            input,
          }),
      }),
    }
  const pass = {
    chief_answer: tool({
      description:
        "Answer a question item of your brief in the person's name, when one of their rules plainly settles it: the " +
        'teammate gets the answer as their click, with why and the rule.',
      inputSchema: jsonSchema<{ item: number; option: number; reason: string; rule: string }>({
        type: 'object',
        properties: {
          item: { type: 'number', description: 'The question, by its number in your brief' },
          option: { type: 'number', description: 'The answer, by its number (1 for the first)' },
          reason: { type: 'string', description: 'Why, in a line the person reads' },
          rule: { type: 'string', description: 'Their rule that settles it, in their words' },
        },
        required: ['item', 'option', 'reason', 'rule'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'chief_answer',
            item: Math.round(input.item),
            option: Math.round(input.option),
            reason: input.reason,
            rule: input.rule,
          },
          toolCallId,
          toolName: 'chief_answer',
          input,
        }),
    }),
    chief_retry: tool({
      description:
        "Try a failed item's turn again, when its error looks passing (a timeout, a lost connection, a limit since reset).",
      inputSchema: jsonSchema<{ item: number; reason: string }>({
        type: 'object',
        properties: {
          item: { type: 'number', description: 'The failed thread, by its number in your brief' },
          reason: { type: 'string', description: 'Why it may go through now, in a line' },
        },
        required: ['item', 'reason'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'chief_retry', item: Math.round(input.item), reason: input.reason },
          toolCallId,
          toolName: 'chief_retry',
          input,
        }),
    }),
    chief_report: tool({
      description:
        'Once, last: what is still theirs (each with what you would do), what you noticed across their threads, and ' +
        'new rules worth proposing from their recent answers. Then end your turn without a reply.',
      inputSchema: jsonSchema<{
        decisions?: { item: number; recommendation: string; option?: number; rule?: string }[]
        notes?: { item?: number; text: string }[]
        rules?: { line: string; why: string }[]
      }>({
        type: 'object',
        properties: {
          decisions: {
            type: 'array',
            description: 'What is still theirs to decide',
            items: {
              type: 'object',
              properties: {
                item: { type: 'number', description: 'By its number in your brief' },
                recommendation: { type: 'string', description: 'What you would do, in a line' },
                option: {
                  type: 'number',
                  description: 'For a question: the answer you would pick, by its number',
                },
                rule: {
                  type: 'string',
                  description:
                    'For a question: their rule your pick goes by, in their words; leave it out when none settles it',
                },
              },
              required: ['item', 'recommendation'],
            },
          },
          notes: {
            type: 'array',
            description: 'What you see across their threads that they would want to know',
            items: {
              type: 'object',
              properties: {
                item: { type: 'number', description: 'The item it is about, if one' },
                text: { type: 'string', description: 'In a line or two' },
              },
              required: ['text'],
            },
          },
          rules: {
            type: 'array',
            description: 'At most three new rules from their recent answers',
            items: {
              type: 'object',
              properties: {
                line: {
                  type: 'string',
                  description: 'The rule, one line, in their language and words',
                },
                why: { type: 'string', description: 'The answers it comes from, in a line' },
              },
              required: ['line', 'why'],
            },
          },
        },
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'chief_report',
            decisions: (input.decisions ?? []).map((d) => ({
              item: Math.round(d.item),
              recommendation: d.recommendation,
              ...(d.option !== undefined ? { option: Math.round(d.option) } : {}),
              ...(d.rule?.trim() ? { rule: d.rule.trim() } : {}),
            })),
            notes: (input.notes ?? []).map((n) => ({
              ...(n.item !== undefined ? { item: Math.round(n.item) } : {}),
              text: n.text,
            })),
            rules: input.rules ?? [],
          },
          toolCallId,
          toolName: 'chief_report',
          input,
        }),
    }),
  }
  // While it only recommends (no chief_acts), its report is its one way out.
  return options.acts ? pass : { chief_report: pass.chief_report }
}

/**
 * Lists (docs/lists.md): checklist lines of library Markdown files that work is attached to.
 * A line work is attached to has an id, in a marker at its end (`<!-- item:<id> -->`); the API
 * changes the file itself, credited to this thread, within the teammate's library access.
 */
export function listTools(call: ScheduleCaller): Record<string, Tool> {
  const item = {
    type: 'string',
    description: "A line's id, or its text (all of it, or enough of its start to be the only one)",
  } as const
  return {
    list_items: tool({
      description:
        'Read a list: the checklist lines of a Markdown file of the library, each ticked or not, with its id when ' +
        'work is attached to it, the threads and pull requests on it, and the library paths of the files under it. ' +
        'Without a path: the items this thread works on.',
      inputSchema: jsonSchema<{ path?: string }>({
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The file\'s library path, e.g. "Projects/Acme/launch.md"',
          },
        },
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'list_items', ...(input.path ? { path: input.path } : {}) },
          toolCallId,
          toolName: 'list_items',
          input,
        }),
    }),
    link_items: tool({
      description:
        'Attach lines of a list to this thread, as the items you work on: they show this thread on their line, ' +
        'and you get their ids for complete_item and for the items of the pull request you open. Use it when you ' +
        'take on lines the person named that are not yet your items.',
      inputSchema: jsonSchema<{ path: string; items: string[] }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: "The list's library path" },
          items: { type: 'array', items: item, minItems: 1 },
        },
        required: ['path', 'items'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'link_items', path: input.path, items: input.items },
          toolCallId,
          toolName: 'link_items',
          input,
        }),
    }),
    complete_item: tool({
      description:
        'Tick a line of a list once its work is really done: each point of what done means for it checked, ' +
        'with what shows it in the note after it (e.g. "Sitemap read by Google, 7 URLs, 31 Oct"). Brigade ' +
        'changes the file, credited to you. For work a pull request finishes, name the item in that pull ' +
        "request's items.closes instead: it is ticked when merged. When whether it is done is a matter of " +
        'judgment (a video, copy, a design), do not tick it: show it to the person and let them tick it. Never ' +
        'tick what is only partly done: add_item what remains of it (remainsOf) instead.',
      inputSchema: jsonSchema<{ item: string; path?: string; note: string }>({
        type: 'object',
        properties: {
          item,
          path: {
            type: 'string',
            description: "The list's library path; needed when naming the line by its text",
          },
          note: {
            type: 'string',
            description:
              'What shows it is done, in a few words after the line, e.g. "Neon PITR set to 7 days, 29 Oct"',
          },
        },
        required: ['item', 'note'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'complete_item',
            item: input.item,
            ...(input.path ? { path: input.path } : {}),
            note: input.note,
          },
          toolCallId,
          toolName: 'complete_item',
          input,
        }),
    }),
    add_item: tool({
      description:
        'Add a line to a list, attached to this thread: what remains of an item (remainsOf: nested under it, ' +
        'which Brigade ticks once all its remaining lines are ticked), or a follow-up the work showed (after a ' +
        'line, nested under it with nested: true, at the end of a section by its heading, or at the end of the ' +
        "file). Write it as the list's other lines are written, in their language.",
      inputSchema: jsonSchema<{
        path: string
        text: string
        after?: string
        nested?: boolean
        section?: string
        remainsOf?: string
      }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: "The list's library path" },
          text: { type: 'string', description: 'The line, without its checkbox' },
          after: { ...item, description: `The line it follows. ${item.description}` },
          nested: { type: 'boolean', description: 'Under the line `after`, as part of it' },
          section: {
            type: 'string',
            description: 'A heading of the file, to add it at the end of that section',
          },
          remainsOf: {
            ...item,
            description: `The item this line is what remains of, in the same list. ${item.description}`,
          },
        },
        required: ['path', 'text'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'add_item',
            path: input.path,
            text: input.text,
            ...(input.after ? { after: input.after } : {}),
            ...(input.nested ? { nested: true } : {}),
            ...(input.section ? { section: input.section } : {}),
            ...(input.remainsOf ? { remainsOf: input.remainsOf } : {}),
          },
          toolCallId,
          toolName: 'add_item',
          input,
        }),
    }),
  }
}

/**
 * Schedules: the teammate prompted with the same instructions on a cron
 * schedule, on the thread starter's accounts. The API checks the thread (a
 * member's, not a trigger's or a schedule's) and whose schedules they are.
 */
export function scheduleTools(call: ScheduleCaller): Record<string, Tool> {
  return {
    create_schedule: tool({
      description:
        'Set up recurring work: you are prompted with these instructions on a schedule, each run in a fresh ' +
        'thread on the accounts of the person in this thread. Use it when the person asks for something to happen ' +
        'repeatedly or at set times ("every morning", "each Monday", "daily at 6pm"). Each run starts with no memory ' +
        'of this conversation, so write instructions that stand alone: the inputs by name (repositories, mailboxes, ' +
        'documents, searches), the steps, where the result goes (an email, a pull request, the library) and when to ' +
        'open a ticket instead. By default each run is a child thread of this one: it reports here and wakes you ' +
        'only when it has something to say, so follow-ups of this conversation (watch a fix, a release, a reply) ' +
        'come back here. attachToThread false makes runs stand alone in the sidebar, for reports of their own ' +
        '(a weekly digest). Do not ask first; create it, then tell the person in one line when it runs.',
      inputSchema: jsonSchema<{
        title: string
        instructions: string
        cron: string
        timezone?: string
        attachToThread?: boolean
      }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, e.g. "Weekly PR digest"' },
          instructions: { type: 'string', description: 'What to do on each run, standing alone' },
          cron: { type: 'string', description: CRON },
          timezone: { type: 'string', description: TIMEZONE },
          attachToThread: {
            type: 'boolean',
            description:
              'true (default): each run reports to this thread as its child. false: runs are threads of their own.',
          },
        },
        required: ['title', 'instructions', 'cron'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'create',
            title: input.title,
            instructions: input.instructions,
            cron: input.cron,
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.attachToThread !== undefined ? { attachToThread: input.attachToThread } : {}),
          },
          toolCallId,
          toolName: 'create_schedule',
          input,
        }),
    }),
    list_schedules: tool({
      description:
        'List your schedules on the accounts of the person in this thread: id, title, cron, timezone, ' +
        'whether paused, the next runs.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        call({ operation: { name: 'list' }, toolCallId, toolName: 'list_schedules', input }),
    }),
    update_schedule: tool({
      description:
        'Change one of your schedules when the person asks: its title, instructions or timing, or pause and ' +
        'resume it (paused). Only schedules that run on the accounts of the person in this thread. ' +
        'Deleting is done by people, on the Routines page.',
      inputSchema: jsonSchema<{
        scheduleId: string
        title?: string
        instructions?: string
        cron?: string
        timezone?: string
        paused?: boolean
      }>({
        type: 'object',
        properties: {
          scheduleId: { type: 'string', description: 'From list_schedules' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Replaces them whole' },
          cron: { type: 'string', description: CRON },
          timezone: { type: 'string', description: TIMEZONE },
          paused: { type: 'boolean', description: 'true pauses it, false resumes it' },
        },
        required: ['scheduleId'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'update', ...input },
          toolCallId,
          toolName: 'update_schedule',
          input,
        }),
    }),
    list_triggers: tool({
      description:
        "List what can start a thread for you on its own: each App account's events (connectionId, event, " +
        'options), and your triggers with their URLs and instructions.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'list_triggers' },
          toolCallId,
          toolName: 'list_triggers',
          input,
        }),
    }),
    create_trigger: tool({
      description:
        "Make an outside event start a thread for you, on the accounts of the person in this thread: an App's " +
        'event from list_triggers (connectionId, event, options), or any service that can send a webhook as a ' +
        'new custom app (customApp, event "received"), which gets a URL of its own. Use it when the person asks ' +
        'for work to start when something happens ("each failed payment", "every new Sentry error"). Each event ' +
        'starts a fresh thread with your instructions first, then the event: write them to stand alone. An owner ' +
        'or admin approves it first and the call waits for their decision; then it returns the URL, and a custom ' +
        "app's signing secret as a credential only you may use. Set up the sender yourself when you can reach it.",
      inputSchema: jsonSchema<{
        connectionId?: string
        customApp?: string
        event: string
        options?: Record<string, string>
        label: string
        instructions: string
        verification?: 'hmac' | 'none'
        reason?: string
      }>({
        type: 'object',
        properties: {
          connectionId: { type: 'string', description: 'An App account, from list_triggers' },
          customApp: {
            type: 'string',
            description: 'Instead of connectionId: the name of a new custom app, e.g. "Sentry"',
          },
          event: {
            type: 'string',
            description: 'The event, from list_triggers; "received" for a custom app',
          },
          options: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: "The event's options by name, from list_triggers",
          },
          label: { type: 'string', description: 'Short, e.g. "Failed payments"' },
          instructions: {
            type: 'string',
            description: 'What to do with each event, standing alone',
          },
          verification: {
            type: 'string',
            enum: ['hmac', 'none'],
            description:
              'Custom apps only: hmac when the sender can sign its body with a secret (code you write), none when it cannot (most SaaS webhooks)',
          },
          reason: {
            type: 'string',
            description: 'For the person who approves: what the person here asked for',
          },
        },
        required: ['event', 'label', 'instructions'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'create_trigger',
            ...(input.connectionId ? { connectionId: input.connectionId } : {}),
            ...(input.customApp ? { customApp: input.customApp } : {}),
            event: input.event,
            options: input.options ?? {},
            label: input.label,
            instructions: input.instructions,
            ...(input.verification ? { verification: input.verification } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          },
          toolCallId,
          toolName: 'create_trigger',
          input,
        }),
    }),
    set_wakeup: tool({
      description:
        'Be prompted again in this thread later, with this conversation, to check on something that is not ' +
        'ready yet: a deploy, a CI run, a site coming up ("check again in 10 minutes"). A reply to an email you ' +
        'sent from this thread (Gmail, or email_send) and mail to a sign-up address you made wake you by ' +
        'themselves; set one for those only as a deadline. Give minutes ' +
        `or at (${WAKEUP_MIN_MINUTES} minute to ${WAKEUP_MAX_DAYS} days ahead) and a note saying what to check; ` +
        'the note is the prompt you get back. Then end your turn: never sleep or poll in a loop to wait. ' +
        "Prefer what notifies you by itself (a child thread's report, such as a pull request's review, or a ticket) when there is one. " +
        `At most ${WAKEUPS_PER_THREAD} pending per thread, and ${WAKEUPS_IN_A_ROW} in a row without a word ` +
        'from a person. Only in a thread a person started.',
      inputSchema: jsonSchema<{ minutes?: number; at?: string; note: string }>({
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'In this many minutes. Or at.' },
          at: {
            type: 'string',
            description:
              'An ISO 8601 time with its offset, e.g. "2026-10-16T09:00:00+02:00". Or minutes.',
          },
          note: {
            type: 'string',
            description:
              'What to check and how, standing alone, e.g. "Check CI on PR #412; if green, merge it as asked"',
          },
        },
        required: ['note'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'wake',
            note: input.note,
            ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
            ...(input.at !== undefined ? { at: input.at } : {}),
          },
          toolCallId,
          toolName: 'set_wakeup',
          input,
        }),
    }),
    list_wakeups: tool({
      description: 'List your pending wake-ups in this thread: id, note and when.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        call({ operation: { name: 'list_wakeups' }, toolCallId, toolName: 'list_wakeups', input }),
    }),
    cancel_wakeup: tool({
      description:
        'Cancel one of your pending wake-ups in this thread, e.g. once what it was to check is done.',
      inputSchema: jsonSchema<{ wakeupId: string }>({
        type: 'object',
        properties: { wakeupId: { type: 'string', description: 'From list_wakeups' } },
        required: ['wakeupId'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'cancel_wakeup', wakeupId: input.wakeupId },
          toolCallId,
          toolName: 'cancel_wakeup',
          input,
        }),
    }),
  }
}

/** What list_apps says on an API from before it, which cannot read the call. */
const LIST_APPS_UNKNOWN =
  "Brigade's server does not have list_apps yet: it is older than this computer's runner. Until it updates, " +
  "ask for an App with open_ticket's access ask, whose app.kind names every App you can ask for."

/**
 * The Apps a teammate can suggest from what a person needs: its accounts here, the workspace's
 * it may ask for, and those a person may connect (src/app-calls.ts in the API). Names only; an
 * account's tools still come with its grant. None in a playbook's run, which has only the Apps
 * the playbook declares (the API refuses it too).
 */
export function appTools(
  call: ScheduleCaller,
  options: { playbook: boolean },
): Record<string, Tool> {
  if (options.playbook) return {}
  return {
    list_apps: tool({
      description:
        'List the Apps, one line each: the accounts you use here, the accounts of the workspace not granted to you, ' +
        'and the Apps nobody has connected for you yet, each with the app.kind an open_ticket access ask takes. ' +
        'Call it when a person wants to use a service you have no account for ("track my Google rankings", ' +
        '"connect my Gmail"), then propose granting or connecting one with a ticket.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        call({ operation: { name: 'list_apps' }, toolCallId, toolName: 'list_apps', input }).catch(
          (error: unknown) => {
            // An API from before it answers that it cannot read the call (hub/runner-messages.ts).
            if (errorMessage(error).includes('could not read this call'))
              throw new Error(LIST_APPS_UNKNOWN)
            throw error
          },
        ),
    }),
  }
}

/** What complete_thread says on an API from before it, which cannot read the call. */
const COMPLETE_THREAD_UNKNOWN =
  "Brigade's server does not have complete_thread yet: it is older than this computer's runner. Until it " +
  'updates, say in your reply, in a line, what was delivered; a person marks the thread done.'

/**
 * Done (docs/board.md): the teammate declares the work asked in its thread delivered, with a line
 * on what was. Only in a thread a person talks to: a child reports, and a playbook's run ends with
 * its report (the API refuses them too, and a schedule's run, which the spec does not tell). A
 * done block at the end of the reply is the way its instructions give (declaredDone); the call
 * stays for a teammate used to it, never loaded up front.
 */
export function doneTools(
  call: ScheduleCaller,
  options: { child: boolean; playbook: boolean; scheduled?: boolean },
): Record<string, Tool> {
  if (options.child || options.playbook || options.scheduled) return {}
  return {
    [COMPLETE_THREAD_TOOL]: tool({
      description:
        'Declare this thread done, when the Done section of your instructions says: the work asked here is ' +
        'delivered and nothing is pending. A `done` block at the end of your reply does the same as your turn ' +
        'ends, with no call to wait on: prefer it. Brigade refuses it while something is still open here, and ' +
        'lists what.',
      inputSchema: jsonSchema<{ summary: string }>({
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: `One line on what was delivered, at most ${DONE_SUMMARY_MAX} characters, e.g. "CSV export merged (#412) and live"`,
          },
        },
        required: ['summary'],
      }),
      execute: async (input, { toolCallId }) => {
        // Checked here, so that the API's "could not read this call" means only that it is older.
        const summary = DoneSummary.safeParse(input.summary)
        if (!summary.success)
          throw new Error(summary.error.issues[0]?.message ?? 'Say in a line what was delivered')
        return call({
          operation: { name: COMPLETE_THREAD_TOOL, summary: summary.data },
          toolCallId,
          toolName: COMPLETE_THREAD_TOOL,
          input,
        }).catch((error: unknown) => {
          // An API from before it answers that it cannot read the call (hub/runner-messages.ts).
          if (errorMessage(error).includes('could not read this call'))
            throw new Error(COMPLETE_THREAD_UNKNOWN)
          throw error
        })
      },
    }),
  }
}

/**
 * A playbook's run: its triage case once the event is sorted, and how it ended. Through the
 * schedule calls, which the API checks.
 */
export function playbookTools(call: ScheduleCaller): Record<string, Tool> {
  return {
    playbook_triage: tool({
      description:
        "Say the run's case, in the recipe's words (e.g. documented_question, bug, noise), once you have sorted " +
        'the event and before your first write through an App: what the playbook lets you do on your own may ' +
        'depend on it. Call it again if the case turns out to be another.',
      inputSchema: jsonSchema<{ case: string }>({
        type: 'object',
        properties: {
          case: { type: 'string', description: "The triage case, in the recipe's words" },
        },
        required: ['case'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'playbook_triage', case: input.case },
          toolCallId,
          toolName: 'playbook_triage',
          input,
        }),
    }),
    playbook_report: tool({
      description:
        "End a playbook's run: its case, in the recipe's words (e.g. documented_question, bug, noise), and its " +
        'outcome: resolved (done), escalated (a person must take it; open a ticket first), noise (nothing to do) ' +
        'or failed (say why in the summary). Call it once, when the run is done; a later event of the same ' +
        'conversation continues the run.',
      inputSchema: jsonSchema<{
        case: string
        outcome: 'resolved' | 'escalated' | 'noise' | 'failed'
        summary?: string
      }>({
        type: 'object',
        properties: {
          case: { type: 'string', description: "The triage case, in the recipe's words" },
          outcome: { type: 'string', enum: ['resolved', 'escalated', 'noise', 'failed'] },
          summary: { type: 'string', description: 'One or two lines: what was done' },
        },
        required: ['case', 'outcome'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'playbook_report',
            case: input.case,
            outcome: input.outcome,
            ...(input.summary ? { summary: input.summary } : {}),
          },
          toolCallId,
          toolName: 'playbook_report',
          input,
        }),
    }),
    file_idea: tool({
      description:
        "Keep an idea for the team, such as a customer's feature request: one line added to the playbook's " +
        'ideas list in the library, where a person decides what to do with it. It starts nothing.',
      inputSchema: jsonSchema<{ text: string }>({
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'What is asked, why, and who asked (their company), in one line',
          },
        },
        required: ['text'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'file_idea', text: input.text },
          toolCallId,
          toolName: 'file_idea',
          input,
        }),
    }),
  }
}

/**
 * Installing a playbook from the chat: its card, its settings one by one, a dry run on real
 * past events with every write simulated, its report, then the card that activates it.
 * Through the schedule calls, which the API checks.
 */
export function playbookInstallTools(call: ScheduleCaller): Record<string, Tool> {
  const send = (
    operation: ScheduleOperation,
    toolCallId: string,
    toolName: string,
    input: unknown,
  ) => call({ operation, toolCallId, toolName, input })
  const id = { type: 'string', description: 'The installationId configure_playbook gave' } as const
  return {
    show_playbook: tool({
      description:
        'Playbooks are whole jobs Brigade ships, ready to install (support, releases…): what starts them, their ' +
        'recipe, the Apps they need, their settings and the writes they may make. Without playbookKey: the catalog. ' +
        'With one: its card in the thread (what it does, its Apps, its author, its version). Use it when a person ' +
        'asks to install or see a playbook.',
      inputSchema: jsonSchema<{ playbookKey?: string }>({
        type: 'object',
        properties: { playbookKey: { type: 'string', description: 'e.g. brigade/support-bugs' } },
      }),
      execute: (input, { toolCallId }) =>
        send(
          {
            name: 'show_playbook',
            ...(input.playbookKey ? { playbookKey: input.playbookKey } : {}),
          },
          toolCallId,
          'show_playbook',
          input,
        ),
    }),
    configure_playbook: tool({
      description:
        'Install a playbook for the person in this thread, on their accounts: first with its playbookKey, then with ' +
        'the installationId it gives. Pass the answers you have by setting key; Brigade checks each by its type ' +
        'and says what is still missing, which question to ask next, and which Apps are missing. Ask one ' +
        'question at a time, and never invent an answer. Nothing runs until it is activated.',
      inputSchema: jsonSchema<{
        playbookKey?: string
        installationId?: string
        teammate?: string
        settings?: Record<string, string | number>
      }>({
        type: 'object',
        properties: {
          playbookKey: {
            type: 'string',
            description: 'To start installing one, e.g. brigade/support-bugs',
          },
          installationId: id,
          teammate: {
            type: 'string',
            description: 'The teammate that runs it, by name; leave out for yourself',
          },
          settings: {
            type: 'object',
            description:
              'Answers by setting key, e.g. { "product": "Acme", "inbox": "support@acme.com" }',
            additionalProperties: { type: ['string', 'number'] },
          },
        },
      }),
      execute: (input, { toolCallId }) =>
        send(
          {
            name: 'configure_playbook',
            ...(input.playbookKey ? { playbookKey: input.playbookKey } : {}),
            ...(input.installationId ? { installationId: input.installationId } : {}),
            ...(input.teammate ? { teammate: input.teammate } : {}),
            settings: input.settings ?? {},
          },
          toolCallId,
          'configure_playbook',
          input,
        ),
    }),
    start_dry_run: tool({
      description:
        'Try an installed playbook on real past events (for Gmail, the latest mails its search matches) before ' +
        'it is active: each event a run of its own, every write simulated (recorded, answered with a fake ' +
        'success, never sent) and no push. Its progress shows under your reply, and you are woken here once ' +
        'all are done. It runs on the subscription of the person in this thread.',
      inputSchema: jsonSchema<{ installationId: string; last?: number }>({
        type: 'object',
        properties: {
          installationId: id,
          last: {
            type: 'number',
            description: 'Fewer events than the playbook replays, for a quick try (at most 20)',
          },
        },
        required: ['installationId'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          {
            name: 'start_dry_run',
            installationId: input.installationId,
            ...(input.last ? { last: input.last } : {}),
          },
          toolCallId,
          'start_dry_run',
          input,
        ),
    }),
    dry_run_report: tool({
      description:
        "A playbook's latest dry run: for each event, the case found, what would have been done (each simulated " +
        'write with what it would have sent) and its thread, and the session minutes it took with a week at that ' +
        'pace. Shows its report in the thread, one card per event.',
      inputSchema: jsonSchema<{ installationId: string }>({
        type: 'object',
        properties: { installationId: id },
        required: ['installationId'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          { name: 'dry_run_report', installationId: input.installationId },
          toolCallId,
          'dry_run_report',
          input,
        ),
    }),
    activate_playbook: tool({
      description:
        'Show the card that activates an installed playbook: its settings, Apps, actions and their levels, and ' +
        'whose accounts it runs on, with an Activate button. A click by an owner or admin activates it; a ' +
        "member's asks one. Only after its settings are all answered, usually after a dry run.",
      inputSchema: jsonSchema<{ installationId: string }>({
        type: 'object',
        properties: { installationId: id },
        required: ['installationId'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          { name: 'activate_playbook', installationId: input.installationId },
          toolCallId,
          'activate_playbook',
          input,
        ),
    }),
    update_playbook: tool({
      description:
        "Move an installed playbook to its template's newer version, in place: its runs, numbers, action levels " +
        'and history are kept, and autonomy never grows. Without apply, it says what changes and which new ' +
        'settings need an answer; with apply: true and those answers, it updates (or says what is still missing). ' +
        'Give its installationId, or its playbookKey when only one is installed.',
      inputSchema: jsonSchema<{
        installationId?: string
        playbookKey?: string
        settings?: Record<string, string | number>
        replaceSkills?: string[]
        apply?: boolean
      }>({
        type: 'object',
        properties: {
          installationId: { type: 'string', description: 'The installed playbook' },
          playbookKey: { type: 'string', description: 'e.g. brigade/support-bugs' },
          settings: {
            type: 'object',
            description: 'Answers to its new settings by key, e.g. { "developer": "Sam" }',
            additionalProperties: { type: ['string', 'number'] },
          },
          replaceSkills: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Skills the workspace edited that should take the new version anyway, by name',
          },
          apply: {
            type: 'boolean',
            description: 'Update it now; leave out to see what changes first',
          },
        },
      }),
      execute: (input, { toolCallId }) =>
        send(
          {
            name: 'update_playbook',
            ...(input.installationId ? { installationId: input.installationId } : {}),
            ...(input.playbookKey ? { playbookKey: input.playbookKey } : {}),
            settings: input.settings ?? {},
            ...(input.replaceSkills?.length ? { replaceSkills: input.replaceSkills } : {}),
            apply: input.apply ?? false,
          },
          toolCallId,
          'update_playbook',
          input,
        ),
    }),
  }
}

/**
 * Reviews: another teammate reviews a pull request of this thread's, or of one of its
 * children's, in a child thread of the thread that opened it, which Brigade starts with a
 * brief of its own (src/reviews.ts in the API). Its report wakes that thread: this one, or the
 * child, which reports here once it is done. Through the schedule calls; the API checks the
 * pull request is this thread's or its child's.
 */
export function reviewTools(call: ScheduleCaller): Record<string, Tool> {
  return {
    request_review: tool({
      description:
        'Have another teammate review a pull request this thread (or one of its child threads) opened, in a ' +
        'child thread of the one that opened it, which Brigade starts with a brief of its own: the pull request, ' +
        'how that thread started, and whether the repository runs checks. You are woken here with its report; ' +
        "for a child thread's pull request, that child is, and reports here once the review is done. Use it when " +
        'the person asks for a review, or where the Code section of your instructions says to; for a pull ' +
        "request you open, github_create_pull_request's `review` says whether it gets one.",
      inputSchema: jsonSchema<{ repository: string; number: number; reviewer?: string }>({
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'owner/name, e.g. acme/web' },
          number: { type: 'number', description: 'The pull request number' },
          reviewer: {
            type: 'string',
            description:
              'A teammate id or name, when the person named one. Unset: Brigade picks one, on another model when it can.',
          },
        },
        required: ['repository', 'number'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'request_review',
            repository: input.repository,
            number: Math.round(input.number),
            ...(input.reviewer ? { reviewer: input.reviewer } : {}),
          },
          toolCallId,
          toolName: 'request_review',
          input,
        }),
    }),
  }
}

/**
 * Child threads: work started beside this thread, in a fresh context, whose report
 * comes back here. A child reports with `report` and starts no children of its own: the
 * review of a pull request it opens is the one thread under it, which it lists and reads.
 * A playbook's run may also follow another run's child (follow_thread, `follow`).
 * They go through the schedule calls; the API checks the thread and its children.
 */
export function childTools(
  call: ScheduleCaller,
  options: { child: boolean; follow?: boolean },
): Record<string, Tool> {
  const threadId = { type: 'string', description: 'A child thread, from list_children' } as const
  const list_children = tool({
    description:
      "This thread's child threads, newest first: who, status, whether you wait for it, and its report once in." +
      (options.child
        ? ' Here, the reviews of the pull requests you opened.'
        : options.follow
          ? " Also fromOtherRuns: the child threads of this playbook's other runs from the last week " +
            '(e.g. the fix of a bug another customer reported), which follow_thread can follow.'
          : ''),
    inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: (input, { toolCallId }) =>
      call({
        operation: { name: 'list_children' },
        toolCallId,
        toolName: 'list_children',
        input,
      }),
  })
  const read_child = tool({
    description:
      "A child thread's full report, the files it sent (in your working folder), its last message and the pull " +
      'requests it opened' +
      (options.follow ? ', or those of a thread you follow (follow_thread).' : '.'),
    inputSchema: jsonSchema<{ threadId: string }>({
      type: 'object',
      properties: { threadId },
      required: ['threadId'],
    }),
    execute: (input, { toolCallId }) =>
      call({
        operation: { name: 'read_child', threadId: input.threadId },
        toolCallId,
        toolName: 'read_child',
        input,
      }),
  })
  if (options.child)
    return {
      list_children,
      read_child,
      report: tool({
        description:
          'Report to the thread that started this one, once, when your work is done, then end your turn. ' +
          'status: report when you have something to tell (what you found or did, with links), nothing when there is ' +
          'nothing new (a scheduled check that found nothing: it wakes nobody), needs_person when the work cannot ' +
          'go on without a person and you leave it to them (say what they must do), failed when you could not do it (say why). That thread cannot see your files, ' +
          '/tmp included: never point it to one. Put all it needs in the summary, and send the files it needs ' +
          '(reproduction scripts, logs, screenshots) in files: Brigade puts them in its working folder. Without a ' +
          'report, your last message stands for it. Not while a review of a pull request you opened runs: end your ' +
          'turn instead, and report once it is done.',
        inputSchema: jsonSchema<{
          status: 'report' | 'nothing' | 'needs_person' | 'failed'
          summary: string
          files?: string[]
        }>({
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['report', 'nothing', 'needs_person', 'failed'] },
            summary: {
              type: 'string',
              description:
                'The answer first, in a few lines (its note shows the start), then everything the parent needs in ' +
                `full, such as each finding with file:line and how to reproduce it. At most ${REPORT_MAX} characters.`,
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: `Paths of files to send, in your folder or /tmp: at most ${REPORT_FILES_MAX}, ${ATTACHMENT_MAX / (1024 * 1024)} MB each`,
            },
          },
          required: ['status', 'summary'],
        }),
        execute: (input, { toolCallId }) =>
          call({
            operation: {
              name: 'report',
              status: input.status,
              summary: input.summary,
              // Paths here: the harness sends the files first, and the report carries their ids.
              ...(input.files?.length ? { files: input.files } : {}),
            },
            toolCallId,
            toolName: 'report',
            input,
          }),
      }),
    }
  return {
    start_child: tool({
      description:
        'Start work in a child thread of this one: a fresh context, on this computer and the accounts of the person in ' +
        'this thread, out of their sidebar and shown here. Use it for work that must outlive your turn, is for ' +
        'another teammate (teammate), or may need a person; otherwise do the work yourself, with your own ' +
        'sub-agents for parallel parts if you have them. The child does not see this ' +
        'conversation: write instructions that stand alone (the goal, inputs by name, where the result goes, what ' +
        'done looks like). Its files are not visible from here: its report brings back what it found, and the ' +
        'files it sends with it come to your working folder. With wait (default), you are woken here once, with ' +
        'one note, when every child you wait for has reported: start them all, then end your turn; never wait or poll. ' +
        `At most ${CHILDREN_AT_WORK} at work at once.`,
      inputSchema: jsonSchema<{
        title: string
        instructions: string
        teammate?: string
        wait?: boolean
        timeoutMinutes?: number
      }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, e.g. "Bisect the Next 16.3 regression"' },
          instructions: { type: 'string', description: 'The work, standing alone' },
          teammate: {
            type: 'string',
            description:
              "Who does it: a teammate id or name. In a playbook's thread, one of its teammates by its key (e.g. developer). Unset: you.",
          },
          wait: {
            type: 'boolean',
            description:
              'true (default): woken when it and the others you wait for reported. false: woken only if it reports something or fails.',
          },
          timeoutMinutes: {
            type: 'number',
            description: `Stop waiting after this long and hear what is done (default ${CHILD_WAIT_MINUTES}, at most ${CHILD_WAIT_MAX_MINUTES})`,
          },
        },
        required: ['title', 'instructions'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'start_child',
            title: input.title,
            instructions: input.instructions,
            ...(input.teammate ? { teammate: input.teammate } : {}),
            wait: input.wait ?? true,
            ...(input.timeoutMinutes ? { timeoutMinutes: Math.round(input.timeoutMinutes) } : {}),
          },
          toolCallId,
          toolName: 'start_child',
          input,
        }),
    }),
    list_children,
    read_child,
    cancel_child: tool({
      description:
        'Stop a child thread that is no longer needed. You stop waiting for it; the others you wait for still count.',
      inputSchema: jsonSchema<{ threadId: string }>({
        type: 'object',
        properties: { threadId },
        required: ['threadId'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: { name: 'cancel_child', threadId: input.threadId },
          toolCallId,
          toolName: 'cancel_child',
          input,
        }),
    }),
    ...(options.follow
      ? {
          follow_thread: tool({
            description:
              'Wait for a child thread of another run of this playbook, instead of starting the same work again: when a bug ' +
              'your customer reports is already being fixed there (list_children shows them in fromOtherRuns), follow ' +
              'that fix. You are woken here once, with a short note, when it reports (and again if it reports later); ' +
              'read_child then gives its full report. Tell your customer the team is on it, then end your turn: never ' +
              `wait or poll. Not your own child (its report already comes to you). At most ${FOLLOWERS_PER_THREAD} threads follow one.`,
            inputSchema: jsonSchema<{ threadId: string }>({
              type: 'object',
              properties: {
                threadId: {
                  type: 'string',
                  description: "A thread from list_children's fromOtherRuns",
                },
              },
              required: ['threadId'],
            }),
            execute: (input, { toolCallId }) =>
              call({
                operation: { name: 'follow_thread', threadId: input.threadId },
                toolCallId,
                toolName: 'follow_thread',
                input,
              }),
          }),
        }
      : {}),
  }
}

/** Checking out a GitHub repository the teammate reaches, into its working directory. */
export function repoTools(
  checkout: (input: { repository: string; base?: string; directory?: string }) => Promise<unknown>,
): Record<string, Tool> {
  return {
    checkout_repository: tool({
      description:
        'Check out a GitHub repository you have access to into your working directory, on a branch of your own for this thread ' +
        '(brigade/...), and return where. Fast after the first time: the computer keeps a copy. Calling it again on a checkout ' +
        'fetches the latest from GitHub without touching your files. Push with `git push -u origin HEAD`; ' +
        'only branches under brigade/ can be pushed, so open a pull request with the GitHub tool to propose changes.',
      inputSchema: jsonSchema<{ repository: string; base?: string; directory?: string }>({
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'owner/name, e.g. acme/web' },
          base: {
            type: 'string',
            description: 'The branch to start from (default: the default branch)',
          },
          directory: {
            type: 'string',
            description: 'Folder name in your working directory (default: the repository name)',
          },
        },
        required: ['repository'],
      }),
      execute: (input) => checkout(input),
    }),
  }
}

/** A teammate's thread preview: what previewTools reach (see previews.ts). */
export type PreviewTools = {
  start(
    input: {
      command: string
      cwd?: string
      port: number
      ports?: number[]
      timeoutMs?: number
      setup?: string
      env?: Record<string, string>
      envFile?: string
      credentials?: string[]
      envFiles?: string[]
      paths?: string[]
      repository?: string
      passed?: boolean
      archive?: string
    },
    signal?: AbortSignal,
  ): Promise<{
    status: string
    origins: Record<number, string>
    open?: string
    reason?: string
    logs?: string
    variables?: string[]
  }>
  check(
    paths: string[],
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    pages: {
      path: string
      status: number
      finalPath: string
      title: string
      ok: boolean
      problems: string[]
      warnings: string[]
      screenshot: string
    }[]
    serverErrors: string[]
  }>
  save(
    reason?: string,
    inRepository?: boolean,
  ): Promise<{
    repository: string
    recipe: unknown
    file?: { file: string; changed: boolean; local: boolean }
  }>
  saved(repository: string): Promise<{
    recipe: {
      setup?: string
      command: string
      cwd: string
      port: number
      ports: number[]
      env: Record<string, string>
      envFile?: string
      credentials: string[]
      paths: string[]
      timeoutSeconds?: number
      passed?: boolean
      archive?: string
      inRepository?: boolean
    }
    checkout: string
    /** The checkout's settings files it came from, or Brigade, where it was saved. */
    from: string[] | 'brigade'
  } | null>
  /** Setups the repository's checkout has for other tools (orca.yaml, …). */
  otherSetups(repository: string): Promise<string[]>
  stop(): Promise<{ stopped: boolean }>
  logs(lines?: number): Promise<{
    status: string
    origins?: Record<number, string>
    open?: string
    logs: string
  }>
}

type PreviewInput = {
  command?: string
  cwd?: string
  port?: number
  ports?: number[]
  timeoutSeconds?: number
  setup?: string
  env?: Record<string, string>
  envFile?: string
  credentials?: string[]
  paths?: string[]
  repository?: string
  archive?: string
}

const NOT_READY =
  'Not ready yet: fix what the check found (read the screenshots, preview_logs and serverErrors), then call ' +
  'check_preview. Do not tell the person it is ready while a page fails. If a page needs a setting or a ' +
  'service the app does not have here, give it one (env, setup) or ask for its preview variables in a ticket.'

/** Check the preview's pages; a check that cannot run is reported, not thrown. */
async function checked(previews: PreviewTools, paths: string[], signal?: AbortSignal) {
  try {
    const result = await previews.check(paths, signal)
    return {
      ...result,
      note: result.ok
        ? 'Its pages passed the check. Save it with save_preview (unless it is saved and unchanged), then tell the person it is ready: they open it with Preview at the top of the thread.'
        : NOT_READY,
    }
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      note: 'The check could not run: look at the pages yourself (your browser, or curl) before saying it is ready.',
    }
  }
}

/** Run the app being built so people can try it from the thread, check it, save how it starts. */
export function previewTools(
  previews: PreviewTools,
  credentials: Pick<Credentials, 'env'>,
): Record<string, Tool> {
  return {
    start_preview: tool({
      description:
        'Run the app you are working on as a live preview people open from this thread, e.g. its dev server, ' +
        'to try what you built: when the person asks for it. It keeps running after your turn ends; the thread ' +
        'has one preview, and starting another replaces it. Waits until the port answers, then opens `paths` (default "/") with Chrome as a ' +
        'person would and reports what is wrong with each: its status, a blank page, script errors, server errors, ' +
        'with screenshots. Fix those before telling anyone it is ready. ' +
        "For a repository set up before, pass only `repository` (owner/name): it starts as its checkout's " +
        ".brigade/settings.toml says (that branch's), else as saved in Brigade, setup included. Try that first in a " +
        'checkout; save yours with save_preview once its check passes. ' +
        'The app must listen on HOST and `port` (PORT), both set: HOST is 0.0.0.0 on a cloud computer and 127.0.0.1 ' +
        "on a member's own, where nobody else on its network should reach it. " +
        'Write the command with $PORT and $HOST (e.g. "pnpm dev --port $PORT --host $HOST"): when another preview has `port`, it gets a free one. ' +
        'People reach it through a proxy at one public address, in BRIGADE_PREVIEW_URL; the other `ports` are paths on it ' +
        "(/__ports/<port>/), each port's address in BRIGADE_PREVIEW_URL_<port>. Put what the app needs in `env`, " +
        'where ${BRIGADE_PREVIEW_URL} and ${BRIGADE_PREVIEW_URL_<port>} become the addresses (e.g. NEXTAUTH_URL, ' +
        'NEXT_PUBLIC_API_URL, auth callback URLs, allowed origins), and `envFile` if the app reads only its file. ' +
        'On a cloud computer that address lets in only browsers that came from Brigade (or opened `open`, in the ' +
        "result): the app's server must call itself at localhost, not there. " +
        "The repository's preview variables, which people set (ask with a variables ask in open_ticket), come on " +
        'top of `env`; the result lists their names. ' +
        "The proxy makes the app's cookies work in the dashboard's frame, shows a waiting page while the app starts, " +
        'and starts it again if it stops. Dev servers that check the Host header need the preview host (the one in ' +
        'BRIGADE_PREVIEW_URL) allowed ' +
        '(Vite: server.allowedHosts; Next.js: allowedDevOrigins). Use this instead of starting a server in the ' +
        'background yourself: those stop when your turn ends.',
      inputSchema: jsonSchema<PreviewInput>({
        type: 'object',
        properties: {
          repository: {
            type: 'string',
            description:
              'owner/name: start its saved preview (nothing else needed), or, with the other fields, keep its address',
          },
          command: {
            type: 'string',
            description:
              'Starts the app and keeps running, e.g. "pnpm dev --port $PORT --host $HOST"',
          },
          cwd: {
            type: 'string',
            description: 'Where to run it, relative to your working directory, e.g. the checkout',
          },
          port: { type: 'number', description: 'The port of the page people open' },
          ports: {
            type: 'array',
            items: { type: 'number' },
            maxItems: 3,
            description:
              "Other ports the app's pages call from the browser, e.g. its API's: served under /__ports/<port>/ on the preview's address",
          },
          setup: {
            type: 'string',
            description:
              'Shell commands run first, in cwd, stopping at a failure: install dependencies, start its services ' +
              '(e.g. docker compose up -d), migrate, seed. Safe to run again: they run on each start. Longer, and only for the preview: ' +
              "a script in the repository's .brigade/ folder (e.g. .brigade/preview/setup.sh)",
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Settings for setup and the app, e.g. {"NEXTAUTH_URL": "${BRIGADE_PREVIEW_URL}", "DATABASE_URL": "postgres://…localhost…"}. ' +
              'A secret the app only needs locally may be a random value here; one only a person has is a preview variable, never here.',
          },
          envFile: {
            type: 'string',
            description:
              'Also write env into this file, relative to cwd (e.g. ".env.local"), keeping its other lines',
          },
          credentials: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Vault credentials (by id) whose variables the app gets. Prefer preview variables: a preview with credentials needs you to start it',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Pages to check, e.g. ["/", "/signin", "/the-page-you-changed"]: the home page, sign-in, and what you built',
          },
          timeoutSeconds: {
            type: 'number',
            description:
              'How long to wait for the port to answer (default 120, 600 with setup; up to 600)',
          },
          archive: {
            type: 'string',
            description:
              'Shell commands run in cwd once the thread goes quiet, to free what setup made outside the ' +
              'checkout: e.g. "docker compose down -v", or dropping a database it created elsewhere',
          },
        },
      }),
      execute: async (args, { abortSignal, toolCallId }) => {
        let input = args
        let passed = false
        let from: string[] | undefined
        // Saved in Brigade before repositories had .brigade/settings.toml: the next save writes it.
        let unfiled = false
        if (args.repository && !args.command) {
          const saved = await previews.saved(args.repository)
          if (!saved) {
            const others = await previews.otherSetups(args.repository).catch(() => [])
            return {
              status: 'none',
              note:
                `${args.repository} has no preview set up: no .brigade/settings.toml in its checkout, none saved in Brigade. ` +
                (others.length
                  ? `Start from the setup and run scripts in its ${others.join(', ')}, and its README. `
                  : '') +
                'Set it up (setup, env, command), start it, and once its check passes, save it with save_preview.',
            }
          }
          const { recipe, checkout } = saved
          if (saved.from !== 'brigade') from = saved.from
          else if (recipe.inRepository !== false) unfiled = true
          passed = recipe.passed === true
          input = {
            ...recipe,
            cwd: recipe.cwd ? `${checkout}/${recipe.cwd}` : checkout,
            repository: args.repository,
            ...(args.paths?.length ? { paths: args.paths } : {}),
          }
        }
        if (!input.command || !input.port)
          throw new Error('Give the command and port, or a repository with a saved preview')
        const envFiles: string[] = []
        for (const credentialId of input.credentials ?? []) {
          const released = await credentials.env(credentialId, {
            toolCallId,
            toolName: 'start_preview',
            input: { credentialId },
          })
          envFiles.push(released.file)
        }
        const paths = input.paths?.length ? input.paths : ['/']
        const result = await previews.start(
          {
            command: input.command,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            port: input.port,
            ...(input.ports?.length ? { ports: input.ports } : {}),
            ...(input.timeoutSeconds ? { timeoutMs: input.timeoutSeconds * 1000 } : {}),
            ...(input.setup?.trim() ? { setup: input.setup } : {}),
            ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
            ...(input.envFile ? { envFile: input.envFile } : {}),
            ...(input.credentials?.length ? { credentials: input.credentials, envFiles } : {}),
            paths,
            ...(input.repository ? { repository: input.repository } : {}),
            ...(passed ? { passed } : {}),
            ...(input.archive?.trim() ? { archive: input.archive } : {}),
          },
          abortSignal,
        )
        const started = { ...result, ...(from ? { from } : {}) }
        if (result.status !== 'running') return started
        const check = await checked(previews, paths, abortSignal)
        return {
          ...started,
          check,
          ...(unfiled && check.ok
            ? {
                note:
                  "Its setup is saved in Brigade only, not in the repository's .brigade/settings.toml: save it " +
                  'with save_preview, which writes that file in the checkout, and commit it, in a pull request of ' +
                  'its own unless the person wants it in this one or an open pull request already adds it.',
              }
            : {}),
        }
      },
    }),
    check_preview: tool({
      description:
        "Open the running preview's pages with Chrome as a person would, again. Only when the person asks, " +
        'when the preview crashed or restarted, or once after you fixed what its last check found. Reports each ' +
        "page's status, whether it is blank, script and server errors, with screenshots to read. Not after " +
        'edits while the person tries it: the preview reloads by itself and they see it. Pass only the pages ' +
        'you need; once a check passed, it waits less for pages to settle.',
      inputSchema: jsonSchema<{ paths?: string[] }>({
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Pages to check (default: those it started with; after a check passed, the first of them)',
          },
        },
      }),
      execute: (input, { abortSignal }) => checked(previews, input.paths ?? [], abortSignal),
    }),
    save_preview: tool({
      description:
        "Save how this thread's preview starts (setup, env, credentials, command, ports, pages to check, archive) as its " +
        "repository's preview, so a later thread starts it in one step with start_preview({ repository }). " +
        'Only once its check passes, unless what it found is expected: then look at the screenshots and give the ' +
        '`reason` (e.g. "/admin redirects to sign-in"). Saving again replaces it. Secrets only a person has go in ' +
        "the repository's preview variables (a variables ask in open_ticket), never in env: they are kept beside it, " +
        'not in it. A random value for a secret the app only needs locally may stay in env. ' +
        'It is saved in Brigade and written to .brigade/settings.toml in the checkout, so each branch has its own ' +
        "and people review it as code: commit it. When the repository's people want none of Brigade's files in it, " +
        'save with `inRepository: false`: kept in Brigade only, for later saves too.',
      inputSchema: jsonSchema<{ reason?: string; inRepository?: boolean }>({
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why what the last check found is expected, when it did not pass',
          },
          inRepository: {
            type: 'boolean',
            description:
              "false when the repository's people want none of Brigade's files in it; true to write the file again after that",
          },
        },
      }),
      execute: async (input) => {
        const { repository, file } = await previews.save(input.reason, input.inRepository)
        const where = !file
          ? "It is kept in Brigade only, not in the repository's files."
          : file.changed
            ? `It is in ${file.file} in the checkout too: commit it. The first time, in a pull request of its own ` +
              '("Add a Brigade preview") unless the person wants it in this one; later changes go with the code that needs them.'
            : `${file.file} in the checkout already says the same.`
        const local = file?.local
          ? " The checkout also has .brigade/settings.local.toml, a person's own settings, which were part of this " +
            'start: keep in settings.toml only what the team needs.'
          : ''
        return {
          saved: true,
          repository,
          ...(file ? { file: file.file, changed: file.changed } : {}),
          note: `Later threads start it with start_preview({ repository: "${repository}" }). ${where}${local} Mention in your reply that it is saved.`,
        }
      },
    }),
    stop_preview: tool({
      description: "Stop this thread's preview.",
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: () => previews.stop(),
    }),
    preview_logs: tool({
      description:
        "The latest output of this thread's preview (its dev server's console), e.g. to see why a page fails, " +
        'and, while it runs, its address by port (`origins`): test in your browser there rather than starting ' +
        'a copy of your own. On a cloud computer, open `open` first: the preview lets in only a browser that ' +
        'came with its token (for 5 minutes, then for the run), and answers 403 otherwise, also to requests ' +
        "the app's server makes to its own public address (use localhost there).",
      inputSchema: jsonSchema<{ lines?: number }>({
        type: 'object',
        properties: { lines: { type: 'number', description: 'How many lines (default 100)' } },
      }),
      execute: (input) => previews.logs(input.lines ?? 100),
    }),
  }
}

/** A command on the thread's machine, as machineTools give it back (see machine-runs.ts). */
export type MachineRunResult = {
  id: string
  command: string
  cwd: string
  status: 'starting' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'timed_out'
  exitCode?: number
  startedAt: string
  endedAt?: string
  seconds: number
  output?: string
  files?: string[]
  notes: string[]
}

/** A teammate's commands on its thread's machine of its own: what machineTools reach. */
export type MachineRunTools = {
  run(
    input: {
      command: string
      cwd?: string
      outputs?: string[]
      env?: Record<string, string>
      envFiles?: string[]
      timeoutMs?: number
    },
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<MachineRunResult>
  get(id: string, waitMs: number, lines?: number, signal?: AbortSignal): Promise<MachineRunResult>
  stop(id: string): Promise<MachineRunResult>
  list(): Omit<MachineRunResult, 'output'>[]
}

/** How long a call waits for a command on the machine, unless it says, and at most. */
const MACHINE_WAIT_MINUTES = 10
const MACHINE_WAIT_MAX_MINUTES = 30

/** What to do next, by how the command stands. */
function machineNote(result: MachineRunResult) {
  switch (result.status) {
    case 'starting':
    case 'running':
      return (
        'Still running on the machine, where it goes on without this call. Wait for it with ' +
        `machine_run({ id: "${result.id}" }), or set a wake-up and end your turn; its outputs come back when it ends.`
      )
    case 'succeeded':
      return result.files?.length
        ? `Done. Its outputs are in your folder: ${result.files.join(', ')}.`
        : 'Done.'
    case 'stopped':
      return 'Stopped.'
    default:
      return (
        'It did not succeed: read its output and notes. machine_run with `lines` gives more of its output ' +
        '(up to 2000 lines).'
      )
  }
}

const withNote = (result: MachineRunResult) => ({ ...result, note: machineNote(result) })

/**
 * Why the wait ended before the command did (arrivals.ts), and what to do: the command goes on
 * on the machine either way. Once it ended meanwhile, the call says so as ever.
 */
function cutShort(result: ReturnType<typeof withNote>, cut: Cut) {
  if (result.status !== 'starting' && result.status !== 'running') return result
  const again = `machine_run({ id: "${result.id}" })`
  return {
    ...result,
    note:
      cut === 'message'
        ? 'A message came in while you waited: it comes with this result. Read it, and answer it if ' +
          `it asks something; the command goes on on the machine. Then wait again with ${again}, or ` +
          'set a wake-up and end your turn.'
        : "Brigade's runner is updating, which ended this wait: the command is still running on the " +
          `machine (id ${result.id}). Wait for it again with ${again}.`,
  }
}

/**
 * Runs a wait of a machine tool, cut short by a message that comes in or a hand-over to the
 * next runner (or by the call's own abort): the turn reads the message now, and an update
 * takes the turn over at once rather than stop it.
 */
async function cutWait(
  arrivals: Arrivals | undefined,
  abortSignal: AbortSignal | undefined,
  wait: (signal: AbortSignal | undefined) => Promise<MachineRunResult>,
) {
  if (!arrivals) return withNote(await wait(abortSignal))
  const watch = arrivals.watch(abortSignal)
  try {
    const result = withNote(await wait(watch.signal))
    return watch.cut ? cutShort(result, watch.cut) : result
  } finally {
    watch.release()
  }
}

/** Minutes a call waits, within bounds. */
const waitMs = (minutes: number | undefined) =>
  Math.min(Math.max(minutes ?? MACHINE_WAIT_MINUTES, 0), MACHINE_WAIT_MAX_MINUTES) * 60_000

/** Heavy commands on the thread's machine of its own: run, wait, read, stop. */
export function machineTools(
  runs: MachineRunTools,
  credentials: Pick<Credentials, 'env'>,
  arrivals?: Arrivals,
): Record<string, Tool> {
  return {
    run_on_machine: tool({
      description:
        "Run a shell command on this thread's machine of its own (8 vCPU, 16 GB) instead of this computer, which " +
        'every teammate of the workspace shares: for work it cannot take without slowing everyone, a render or ' +
        'encode of video or audio, a transcription, a model run on video or images, Docker. Not for code work ' +
        '(installs, builds, a typecheck, lint, the tests of a change: here, since starting the machine takes ' +
        "longer; a whole suite: the repository's checks) nor quick commands (git, reading or searching files, " +
        'small scripts). ' +
        'The folder in `cwd` goes to the machine first: the whole checkout it is in, without .git, node_modules, ' +
        'what git ignores (.env files aside) and files over 2 GB, or the folder alone outside a checkout. Your ' +
        'copy there stays between commands, with what they installed: the next ones send only what changed. ' +
        "The thread's attached files are there too, whatever their size, at the same path relative to your " +
        'working directory as here (from a checkout in it, ../attachments/x.mov), as given to the thread: a ' +
        'copy you edited or removed here does not change them, except in a command run in the attachments ' +
        'folder, which goes as it is. ' +
        'It runs Ubuntu with Node.js, pnpm, Docker, Python, ffmpeg and Chrome, and sudo for anything else ' +
        "(apt-get), but none of this computer's environment, services or credentials: the command installs " +
        'what it needs (e.g. "pip install faster-whisper && python transcribe.py"), with settings in `env` and vault ' +
        'credentials in `credentials`; what it installs stays on its disk. ' +
        'Name in `outputs` the files or folders it makes that you need here (a video, frames to look at, a transcript), ' +
        'relative to cwd: they come back to the same place in your folder once it ends, whether it succeeded or not. ' +
        'Waits up to `waitMinutes` for it to end, or until a message comes in or Brigade updates; a longer ' +
        'one keeps running there: wait again with machine_run.',
      inputSchema: jsonSchema<{
        command: string
        cwd?: string
        outputs?: string[]
        env?: Record<string, string>
        credentials?: string[]
        timeoutMinutes?: number
        waitMinutes?: number
      }>({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Run with bash in cwd on the machine, e.g. "npx hyperframes render --quality looks -o renders/video.mp4"',
          },
          cwd: {
            type: 'string',
            description:
              'The folder it runs in, relative to your working directory: a checkout, a folder of one, or a ' +
              "project's folder (not your whole working directory)",
          },
          outputs: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description:
              'Files or folders it makes, relative to cwd, brought back here once it ends, e.g. ["renders/video.mp4"]',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Settings it gets, e.g. {"NODE_OPTIONS": "--max-old-space-size=8192"}',
          },
          credentials: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description:
              'Vault credentials (by id) whose variables it gets; their values are hidden in its output',
          },
          timeoutMinutes: {
            type: 'number',
            description: 'Stopped past this long (default 60, up to 360)',
          },
          waitMinutes: {
            type: 'number',
            description: `How long this call waits for it to end (default ${MACHINE_WAIT_MINUTES}, up to ${MACHINE_WAIT_MAX_MINUTES}; 0 to start it and go on)`,
          },
        },
        required: ['command'],
      }),
      execute: async (input, { abortSignal, toolCallId }) => {
        const envFiles: string[] = []
        for (const credentialId of input.credentials ?? []) {
          const released = await credentials.env(credentialId, {
            toolCallId,
            toolName: 'run_on_machine',
            input: { credentialId },
          })
          envFiles.push(released.file)
        }
        return cutWait(arrivals, abortSignal, (signal) =>
          runs.run(
            {
              command: input.command,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(input.outputs?.length ? { outputs: input.outputs } : {}),
              ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
              ...(envFiles.length ? { envFiles } : {}),
              ...(input.timeoutMinutes ? { timeoutMs: input.timeoutMinutes * 60_000 } : {}),
            },
            waitMs(input.waitMinutes),
            signal,
          ),
        )
      },
    }),
    machine_run: tool({
      description:
        'A command you started with run_on_machine: wait for it to end (up to `waitMinutes`, or until a ' +
        'message comes in or Brigade updates), read more of its output (`lines`), or stop it (`stop`). ' +
        'Without `id`, lists the commands of this thread.',
      inputSchema: jsonSchema<{
        id?: string
        waitMinutes?: number
        lines?: number
        stop?: boolean
      }>({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'As run_on_machine gave it' },
          waitMinutes: {
            type: 'number',
            description: `How long to wait for it to end (default ${MACHINE_WAIT_MINUTES}, up to ${MACHINE_WAIT_MAX_MINUTES}; 0 not to wait)`,
          },
          lines: {
            type: 'number',
            description: 'How many of its last lines of output (default 60, up to 2000)',
          },
          stop: { type: 'boolean', description: 'Stop it, and all it started on the machine' },
        },
      }),
      execute: async (input, { abortSignal }) => {
        if (!input.id) return { commands: runs.list() }
        if (input.stop) return withNote(await runs.stop(input.id))
        const id = input.id
        return cutWait(arrivals, abortSignal, (signal) =>
          runs.get(id, waitMs(input.waitMinutes), input.lines, signal),
        )
      },
    }),
  }
}

/** Makes an image with Codex's image model, on the thread starter's Codex account. */
export type ImageMaker = (
  input: { prompt: string; references: string[]; toolCallId: string },
  abortSignal?: AbortSignal,
) => Promise<{ path: string; prompt?: string }>

/** For a teammate not on Codex, when the starter has a Codex account: images by Codex. */
export function imageTools(makeImage: ImageMaker): Record<string, Tool> {
  return {
    generate_image: tool({
      description:
        "Make an image (an illustration, a photo, an icon, a mockup, a banner) with OpenAI's image model, " +
        "through the Codex account of the person who started this thread. It spends that account's usage, " +
        'several times a text turn, so make the images asked for, not drafts. Returns the file it saved in your ' +
        'working directory (images/...), which the thread shows; open it to look at it. To change an image, ' +
        'give it as a reference with what to change.',
      inputSchema: jsonSchema<{ prompt: string; references?: string[] }>({
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'What to draw, in full: subject, style, composition, colours, any text it shows, and its shape (square, landscape, portrait)',
          },
          references: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Image files on this computer to start from or match (an earlier image to edit, a logo, a photo)',
          },
        },
        required: ['prompt'],
      }),
      execute: (input, { abortSignal, toolCallId }) =>
        makeImage(
          { prompt: input.prompt, references: input.references ?? [], toolCallId },
          abortSignal,
        ),
    }),
  }
}

/** Computer use on the person's own Mac, through Brigade Computer Use.app (see ../computer-use.ts). */
export type ComputerUse = {
  /** Asks the app, as this thread's turn (the indicator shows the teammate's name). */
  request: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    options?: RequestOptions,
  ) => Promise<unknown>
  /** The working directory, where a command runs by default (computer_run). */
  workDir: string
  /** The environment a command gets: what the teammate's own shell gets, without its keys. */
  env: () => Record<string, string>
  /** Where the next screenshot goes: relative to the working directory, and absolute. */
  screenshotPath: () => { path: string; absolute: string }
  /** Show a screenshot in the thread, like a generated image. */
  share: (path: string, toolCallId: string) => void
}

/** computer_run: the helper's own bounds (apps/computer-use-macos Run.swift). */
const COMMAND_TIMEOUT_DEFAULT = 120
const COMMAND_TIMEOUT_MAX = 1800
const COMMAND_OUTPUT_MAX = 100_000

const ABOUT_COMPUTER =
  "On the person's own Mac (this computer), through Brigade Computer Use. Coordinates are screen points " +
  'with the top-left of the main display at 0,0: the same units as computer_screenshot and computer_ui_tree. ' +
  'While you act, a pill on their screen shows your name with a Stop button.'

const point = {
  x: { type: 'number', description: 'Screen x, in points' },
  y: { type: 'number', description: 'Screen y, in points' },
} as const

/**
 * See and use the apps on a member's Mac: screenshots, the mouse and keyboard,
 * opening apps and reading their interface. For what nothing else reaches:
 * the shell, a CLI or an app's own tools come first.
 */
export function computerUseTools(computer: ComputerUse): Record<string, Tool> {
  const act =
    (method: string) =>
    (input: object, { abortSignal }: { abortSignal?: AbortSignal }) =>
      computer.request(method, input as Record<string, unknown>, abortSignal)
  return {
    computer_screenshot: tool({
      description:
        'Take a screenshot of a display. Returns the PNG it saved in your working directory (images/...): open it ' +
        'to look at it. Take one before acting on what is on screen and after, to check it worked. With share, ' +
        'the thread shows it too, for when the person asked to see their screen. ' +
        ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ display?: number; share?: boolean }>({
        type: 'object',
        properties: {
          display: {
            type: 'number',
            description: '0 (default) is the main display; others follow',
          },
          share: { type: 'boolean', description: 'Also show it in the thread (default false)' },
        },
      }),
      execute: async (input, { abortSignal, toolCallId }) => {
        const { path, absolute } = computer.screenshotPath()
        const shot = (await computer.request(
          'screenshot',
          { path: absolute, display: input.display ?? 0 },
          abortSignal,
        )) as Record<string, unknown>
        if (input.share) computer.share(path, toolCallId)
        return {
          path,
          width: shot.width,
          height: shot.height,
          origin: shot.origin,
          displays: shot.displays,
          next: 'Open the file to look at it. A point in it is at screen (origin.x + x, origin.y + y).',
          ...(input.share ? { shared: 'The thread shows it: do not link or embed its file.' } : {}),
        }
      },
    }),
    computer_click: tool({
      description: 'Click at a point on screen. ' + ABOUT_COMPUTER,
      inputSchema: jsonSchema<{
        x: number
        y: number
        button?: 'left' | 'right' | 'middle'
        count?: number
        modifiers?: string[]
      }>({
        type: 'object',
        properties: {
          ...point,
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: 'Default left',
          },
          count: { type: 'number', description: '2 for a double click, 3 for a triple click' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['cmd', 'shift', 'alt', 'ctrl'] },
            description: 'Keys held during the click',
          },
        },
        required: ['x', 'y'],
      }),
      execute: act('click'),
    }),
    computer_move: tool({
      description:
        'Move the pointer to a point, e.g. to show a tooltip or a menu on hover. ' + ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ x: number; y: number }>({
        type: 'object',
        properties: point,
        required: ['x', 'y'],
      }),
      execute: act('move'),
    }),
    computer_drag: tool({
      description: 'Press at one point, drag to another and release. ' + ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ fromX: number; fromY: number; toX: number; toY: number }>({
        type: 'object',
        properties: {
          fromX: { type: 'number' },
          fromY: { type: 'number' },
          toX: { type: 'number' },
          toY: { type: 'number' },
        },
        required: ['fromX', 'fromY', 'toX', 'toY'],
      }),
      execute: act('drag'),
    }),
    computer_scroll: tool({
      description: 'Scroll at a point. ' + ABOUT_COMPUTER,
      inputSchema: jsonSchema<{
        x: number
        y: number
        direction: 'up' | 'down' | 'left' | 'right'
        amount?: number
      }>({
        type: 'object',
        properties: {
          ...point,
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', description: 'Lines to scroll (default 5)' },
        },
        required: ['x', 'y', 'direction'],
      }),
      execute: act('scroll'),
    }),
    computer_type: tool({
      description:
        'Type text into whatever has the keyboard focus (click the field first); a newline presses Return. ' +
        ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ text: string }>({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      }),
      execute: act('type'),
    }),
    computer_key: tool({
      description:
        'Press a key or a shortcut: "return", "escape", "tab", "cmd+n", "cmd+shift+t", "down". ' +
        ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ key: string }>({
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Modifiers (cmd, shift, alt, ctrl) joined with +' },
        },
        required: ['key'],
      }),
      execute: act('key'),
    }),
    computer_apps: tool({
      description: 'The apps running on this Mac, which one is in front. ' + ABOUT_COMPUTER,
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: act('apps'),
    }),
    computer_open_app: tool({
      description:
        'Open an app (or bring it to the front) by name or bundle id, e.g. "Visual Studio Code" or ' +
        '"com.apple.Notes". ' +
        ABOUT_COMPUTER,
      inputSchema: jsonSchema<{ app: string }>({
        type: 'object',
        properties: { app: { type: 'string' } },
        required: ['app'],
      }),
      execute: act('open_app'),
    }),
    computer_run: tool({
      description:
        'Run a shell command (zsh) through Brigade Computer Use, so that it gets the helper’s Accessibility and ' +
        'Screen Recording: for a command that clicks, types in, reads or records other apps, such as ' +
        'agent-desktop, osascript with System Events or a screen recorder. Commands in your own shell have ' +
        'neither on this Mac, and fail for lack of them (agent-desktop: PERM_DENIED): run those here, and ' +
        'everything else in your shell. While it runs, the pill shows your name with Stop; whatever it leaves ' +
        'running in the background is stopped when it ends. Returns its output (stdout and stderr, the last ' +
        `${COMMAND_OUTPUT_MAX / 1000} KB) and exit code. On the person's own Mac (this computer).`,
      inputSchema: jsonSchema<{ command: string; cwd?: string; timeout?: number }>({
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line, run with zsh -c' },
          cwd: {
            type: 'string',
            description: 'Where it runs: relative to your working directory (default), or absolute',
          },
          timeout: {
            type: 'number',
            description: `Seconds before it is stopped (default ${COMMAND_TIMEOUT_DEFAULT}, at most ${COMMAND_TIMEOUT_MAX})`,
          },
        },
        required: ['command'],
      }),
      execute: async (input, { abortSignal }) => {
        const timeout = Math.min(
          Math.max(Math.round(input.timeout ?? COMMAND_TIMEOUT_DEFAULT), 1),
          COMMAND_TIMEOUT_MAX,
        )
        // An interrupted turn stops its command too, rather than leaving it to its timeout.
        const cancel = () => void computer.request('cancel', {}).catch(() => undefined)
        abortSignal?.addEventListener('abort', cancel, { once: true })
        try {
          return await computer.request(
            'run',
            {
              command: input.command,
              cwd: resolve(computer.workDir, input.cwd ?? '.'),
              env: computer.env(),
              timeout,
            },
            abortSignal,
            { wait: (timeout + 30) * 1000, once: true },
          )
        } catch (error) {
          if (error instanceof ComputerUseError && error.code === 'unknown_method')
            throw new Error(
              'The Brigade Computer Use on this Mac is too old to run commands: ask the person to update ' +
                'Brigade.app (Check for Updates… in its menu), then try again.',
            )
          throw error
        } finally {
          abortSignal?.removeEventListener('abort', cancel)
        }
      },
    }),
    computer_ui_tree: tool({
      description:
        "An app's interface as text: each element's role, title, value and frame [x,y w×h] in screen points. " +
        'Cheaper and more exact than a screenshot to find what to click: click the middle of its frame. ' +
        ABOUT_COMPUTER,
      inputSchema: jsonSchema<{
        app?: string
        maxDepth?: number
        maxNodes?: number
        menus?: boolean
      }>({
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Name, bundle id or pid (default: the app in front)',
          },
          maxDepth: { type: 'number', description: 'Default 12' },
          maxNodes: { type: 'number', description: 'Default 400' },
          menus: { type: 'boolean', description: 'Include the menu bar (default false)' },
        },
      }),
      execute: act('ui_tree'),
    }),
  }
}
