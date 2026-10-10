// Connector tools: AI SDK tools whose execute forwards the call to the API,
// which checks the grant, asks for approval if needed, and makes the request.
import { jsonSchema, tool, type Tool } from 'ai'
import type { ConnectorGrant } from '@brigade/contracts'

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

export function connectorTools(
  grants: ConnectorGrant[],
  call: ConnectorCaller,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}
  for (const grant of grants) {
    // Several connections of one kind get distinct tool names.
    const several = grants.filter((g) => g.kind === grant.kind).length > 1
    const account = grant.externalAccount ?? grant.label
    for (const operation of grant.operations) {
      const name = several ? `${operation.name}_${slug(account)}`.slice(0, 64) : operation.name
      tools[name] = tool({
        description: `${operation.description} [${grant.label}: ${account}${operation.write ? '; makes a change, a person may need to approve it' : ''}]`,
        inputSchema: jsonSchema(operation.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: (input, { toolCallId }) =>
          call({
            connectionId: grant.connectionId,
            operation: operation.name,
            input,
            toolCallId,
            toolName: name,
          }),
      })
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
    'Never ask for a password, key or other secret here: ask them to save it in the vault and mention it, ' +
    'or set secret: true and they can pick a saved credential.',
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
}
type Call = { toolCallId: string; toolName: string; input: unknown }

const MENTIONS =
  'Members mention credentials in messages as @[Name](credential:<id>); a credential mentioned by a member in this thread is yours to use here, any other needs a person to approve it.'

/** The vault's credentials, as tools. Their secrets never appear in a tool result. */
export function credentialTools(credentials: Credentials): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    list_credentials: tool({
      description: `List the credentials saved in the workspace's vault: names, kinds and non-secret details such as URL, username or host, never the secrets. ${MENTIONS}`,
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
  operation:
    | { name: 'search'; query: string; limit: number }
    | { name: 'save'; path: string; content: string }
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

/**
 * The workspace's search (library, memory, past thread summaries) and, with a
 * read-write grant, saving to the library. The API checks the grant.
 */
export function libraryTools(options: {
  access: 'read' | 'read_write'
  libraryDir: string
  call: LibraryCaller
  /** Reads a file the teammate wrote on this computer, as the teammate. */
  readFile: (path: string) => Promise<Buffer>
}): Record<string, Tool> {
  const tools: Record<string, Tool> = {
    search_workspace: tool({
      description:
        `Search the workspace's shared knowledge by keywords: its document library (mirrored read-only at ${options.libraryDir}), ` +
        `the workspace and teammate memory, and summaries of past threads. Use it before asking a person something the team may already know.`,
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
        })) as { kind: string; path: string }[]
        return hits.map((hit) =>
          hit.kind === 'library' ? { ...hit, file: `${options.libraryDir}/${hit.path}` } : hit,
        )
      },
    }),
  }
  if (options.access === 'read_write')
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
        const bytes = await options.readFile(input.file)
        return options.call({
          operation: { name: 'save', path: input.path, content: bytes.toString('base64') },
          toolCallId,
          toolName: 'save_to_library',
          input,
        })
      },
    })
  return tools
}
