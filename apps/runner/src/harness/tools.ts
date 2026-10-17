// Connector tools: AI SDK tools whose execute forwards the call to the API,
// which checks the grant, asks for approval if needed, and makes the request.
import { asSchema, jsonSchema, tool, type Tool } from 'ai'
import {
  CHIEF_NAME,
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
  parseSkillMarkdown,
  PROPOSE_SKILL_TOOL,
  SKILL_ENTRY,
  SkillContent,
  TeamProposal,
  Widget,
  WIDGET_GUIDE_TOOL,
  WIDGET_HTML_MAX,
  WAKEUP_MAX_DAYS,
  WAKEUP_MIN_MINUTES,
  WAKEUPS_IN_A_ROW,
  WAKEUPS_PER_THREAD,
  type ConnectorGrant,
  type DesignPersonEdit,
  type TeammateDesignSystem,
  type ScheduleOperation,
  type SkillProposal,
  type TaskOperation,
} from '@brigade/contracts'
import { errorMessage } from './events.js'
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
 * Marks a tool's input schema so the Claude Code bridge (patched) never defers it
 * behind tool search: a card comes right before the answer, with no tool load between.
 */
export function alwaysLoaded(t: Tool): Tool {
  const schema = asSchema(t.inputSchema).jsonSchema as Parameters<typeof jsonSchema>[0] & object
  return { ...t, inputSchema: jsonSchema({ ...schema, 'x-claude-always-load': true }) }
}

export function connectorTools(
  grants: ConnectorGrant[],
  call: ConnectorCaller,
  options: { defer?: boolean } = {},
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}
  for (const grant of grants) {
    // Several connections of one kind get distinct tool names.
    const several = grants.filter((g) => g.kind === grant.kind).length > 1
    const account = grant.externalAccount ?? grant.label
    const namespace = {
      name: several ? `${grant.kind}_${slug(account)}` : grant.kind,
      description: `${grant.label}: ${account}`,
    }
    for (const operation of grant.operations) {
      const name = several ? `${operation.name}_${slug(account)}`.slice(0, 64) : operation.name
      tools[name] = tool({
        description: `${operation.description} [${grant.label}: ${account}${operation.write ? '; makes a change, a person may need to approve it' : ''}]`,
        inputSchema: jsonSchema({
          ...(operation.inputSchema as Parameters<typeof jsonSchema>[0] & object),
          ...(options.defer ? { [NAMESPACE]: namespace } : {}),
        }),
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
    'Open a ticket for a person and wait until they answer it. Brigade does not ask a person before your actions, ' +
    'so open one when you judge a person should decide first: sign-off on a draft or plan before you send or apply it ' +
    '(approval), a choice (decision), a connection or credential you lack (access), something only a person can do ' +
    'such as a phone call (action), or information only they have (input). Put several asks in one ticket rather than ' +
    'opening several. When a website stops you with a human check (a CAPTCHA, a "verify you are human" box, a ' +
    'bot or firewall block page), use an action ask with browser: true and leave the page open: the person takes ' +
    'over your browser from the ticket, clears it and hands back. Never ask for a password, key or other secret ' +
    'in words. For values a preview needs that only a person has (a third-party API key), use a variables ask: the ' +
    "person sets them for the repository's preview, and each start_preview gives them to the app; you learn which " +
    'were set, never their values. For a login or key the vault lacks, ' +
    'use an access ask of kind credential and fill in `credential` with what you know: the person saves it to the ' +
    'vault right in the ticket, and its mention comes back for you to use at once.',
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
                'access to an App (kind connection): which, and the access you need. The person grants it from the ticket, or connects the App there first. Ask read_write only when you must send or change something there. For an MCP server, such as one the person gives you a URL for, use kind mcp with its url: they add it and sign in from the ticket. For an MCP server already added, such as one a message mentions as an App, use kind mcp and put its name in what; the url can be left out',
              properties: {
                kind: {
                  type: 'string',
                  enum: [
                    'gmail',
                    'google_calendar',
                    'google_drive',
                    'google_docs',
                    'google_sheets',
                    'stripe',
                    'github',
                    'cloudflare',
                    'google_cloud',
                    'neon',
                    'supabase',
                    'mcp',
                  ],
                },
                scope: { type: 'string', enum: ['read', 'read_write'] },
                url: {
                  type: 'string',
                  description: 'kind mcp: the MCP server URL, e.g. https://mcp.example.com/mcp',
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
              description: 'action: a checklist for the person',
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
    'in a thread. To let the person pick among options it shows, end your reply with a choices block.',
  inputSchema: jsonSchema<Widget>({
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'What it shows, a few words, e.g. "Six ways to show the shortcut"',
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
  operation:
    | { name: 'search'; query: string; limit: number }
    | { name: 'save'; path: string; content: string }
    | { name: 'design_system'; designSystem: TeammateDesignSystem }
    | { name: 'design_edits'; path: string }
    | { name: 'skill_proposal'; proposal: SkillProposal }
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

/**
 * The workspace's search (library, memory, past thread summaries) and, with a
 * read-write grant on the library or a folder of it, saving to the library.
 * The API checks the grant.
 */
export function libraryTools(options: {
  access: 'read' | 'read_write'
  /** Folders where the teammate's access differs from `access`. */
  folders?: { path: string; access: 'read' | 'read_write' }[]
  libraryDir: string
  call: LibraryCaller
  /** Reads a file the teammate wrote on this computer, as the teammate. */
  readFile: (path: string) => Promise<Buffer>
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
          operation: { name: 'save', path: `${path}/${file}`, content: bytes.toString('base64') },
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
      const files: { path: string; content: string }[] = []
      const skipped: string[] = []
      for (const path of paths) {
        if (path === SKILL_ENTRY) continue
        const content = text(await options.readFile(`${folder}/${path}`))
        if (content === null) skipped.push(path)
        else files.push({ path, content })
      }
      const skill = SkillContent.safeParse({
        name: parsed.name ?? '',
        description: parsed.description ?? '',
        instructions: parsed.instructions,
        files,
      })
      if (!skill.success)
        throw new Error(
          `Not a skill yet: ${skill.error.issues.map((i) => `${i.path.join('.') || 'skill'}: ${i.message}`).join('; ')}`,
        )
      const result = (await options.call({
        operation: {
          name: 'skill_proposal',
          proposal: {
            skill: skill.data,
            reason: input.reason?.trim().slice(0, 1000) ?? '',
            teammateOnly: input.onlyMe === true,
          },
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
        const bytes = await options.readFile(input.file)
        return options.call({
          operation: { name: 'save', path: input.path, content: bytes.toString('base64') },
          toolCallId,
          toolName: 'save_to_library',
          input,
        })
      },
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

export type TaskCaller = (call: {
  operation: TaskOperation
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

/**
 * Tasks on the board: create, list, comment on, change, assign, move and
 * complete them. The API checks every call. There is no tool to assign a
 * person or move a task to Needs you: a ticket (ask) does that.
 */
export function taskTools(call: TaskCaller): Record<string, Tool> {
  const send = (toolName: string, operation: TaskOperation, input: unknown, toolCallId: string) =>
    call({ operation, toolCallId, toolName, input })
  const priority = { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] } as const
  const taskId = { type: 'string', description: 'The task id, from list_tasks' } as const
  return {
    create_task: tool({
      description:
        "Create a task on the workspace's Tasks board, where the team follows it. By default this thread becomes " +
        'the task and you do it: use that when the work has a deliverable someone will review (a pull request, ' +
        'document, email or report), takes several steps, will wait on approval or someone else, or the person ' +
        'asks to track it; not for questions, explanations, brainstorming or quick actions you finish in this ' +
        'reply. Call it before starting the work; do not ask first, say in one line that you are tracking it. ' +
        'Set assignee to "none" to put a separate task in Backlog for later, or to another teammate (id or name) ' +
        'to hand them a separate task: it starts at once in its own thread.',
      inputSchema: jsonSchema<{
        title: string
        description: string
        priority?: 'low' | 'medium' | 'high' | 'urgent'
        assignee?: string
      }>({
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short and imperative, e.g. "Add CSV export to billing"',
          },
          description: { type: 'string', description: 'What done looks like, in a few lines' },
          priority,
          assignee: {
            type: 'string',
            description:
              '"self" (default): this thread is the task. "none": Backlog. Else a teammate id or name, never a person.',
          },
        },
        required: ['title', 'description'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          'create_task',
          {
            name: 'create',
            title: input.title,
            description: input.description,
            priority: input.priority ?? 'medium',
            assignee: input.assignee || 'self',
          },
          input,
          toolCallId,
        ),
    }),
    list_tasks: tool({
      description:
        "The tasks on the board (Backlog, Needs you, Doing, Done) with their ids, and the workspace's teammates " +
        'you can assign them to.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) => send('list_tasks', { name: 'list' }, input, toolCallId),
    }),
    comment_on_task: tool({
      description:
        "Post a message to another task's thread; its teammate reads it and answers there. For a task that has " +
        'started (not Backlog). To talk to a person, open a ticket instead.',
      inputSchema: jsonSchema<{ taskId: string; text: string }>({
        type: 'object',
        properties: { taskId, text: { type: 'string', description: 'The comment, in Markdown' } },
        required: ['taskId', 'text'],
      }),
      execute: (input, { toolCallId }) =>
        send('comment_on_task', { name: 'comment', ...input }, input, toolCallId),
    }),
    update_task: tool({
      description: "Change a task's title, description or priority.",
      inputSchema: jsonSchema<{
        taskId: string
        title?: string
        description?: string
        priority?: 'low' | 'medium' | 'high' | 'urgent'
      }>({
        type: 'object',
        properties: {
          taskId,
          title: { type: 'string' },
          description: { type: 'string' },
          priority,
        },
        required: ['taskId'],
      }),
      execute: (input, { toolCallId }) =>
        send('update_task', { name: 'update', ...input }, input, toolCallId),
    }),
    assign_task: tool({
      description:
        'Give a task to a teammate (never a person). A Backlog task starts at once in its own thread; a started ' +
        'one changes hands: the teammate joins its thread and is told why.',
      inputSchema: jsonSchema<{ taskId: string; teammate: string; reason?: string }>({
        type: 'object',
        properties: {
          taskId,
          teammate: { type: 'string', description: 'A teammate id or name, from list_tasks' },
          reason: { type: 'string', description: 'Why, for the teammate taking it over' },
        },
        required: ['taskId', 'teammate'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          'assign_task',
          {
            name: 'assign',
            taskId: input.taskId,
            teammateId: input.teammate,
            reason: input.reason ?? '',
          },
          input,
          toolCallId,
        ),
    }),
    move_task: tool({
      description:
        'Move a task: "doing" reopens a done, archived or trashed task; "archived" puts a done task away; ' +
        '"trash" takes any task off the board (it can be restored). To mark one done, use complete_task. ' +
        'Needs you is not a place you move tasks to: open a ticket when you need a person.',
      inputSchema: jsonSchema<{ taskId: string; to: 'doing' | 'archived' | 'trash' }>({
        type: 'object',
        properties: { taskId, to: { type: 'string', enum: ['doing', 'archived', 'trash'] } },
        required: ['taskId', 'to'],
      }),
      execute: (input, { toolCallId }) =>
        send('move_task', { name: 'move', ...input }, input, toolCallId),
    }),
    complete_task: tool({
      description:
        "Mark a task done once the work is finished and delivered: this thread's task by default, or another by " +
        'its id. Give a short summary of what was done and links to what was produced (pull request, document, ' +
        'file) so a person or another teammate can find it.',
      inputSchema: jsonSchema<{
        taskId?: string
        summary: string
        deliverables?: { label: string; url: string }[]
      }>({
        type: 'object',
        properties: {
          taskId: { type: 'string', description: "Unset: this thread's task" },
          summary: { type: 'string', description: 'What was done, in a few lines' },
          deliverables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'e.g. "Pull request acme/web#42"' },
                url: { type: 'string', description: 'An https link' },
              },
              required: ['label', 'url'],
            },
          },
        },
        required: ['summary'],
      }),
      execute: (input, { toolCallId }) =>
        send(
          'complete_task',
          {
            name: 'complete',
            ...(input.taskId ? { taskId: input.taskId } : {}),
            summary: input.summary,
            deliverables: input.deliverables ?? [],
          },
          input,
          toolCallId,
        ),
    }),
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
        'open a ticket instead. Do not ask first; create it, then tell the person in one line when it runs.',
      inputSchema: jsonSchema<{
        title: string
        instructions: string
        cron: string
        timezone?: string
      }>({
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, e.g. "Weekly PR digest"' },
          instructions: { type: 'string', description: 'What to do on each run, standing alone' },
          cron: { type: 'string', description: CRON },
          timezone: { type: 'string', description: TIMEZONE },
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
          },
          toolCallId,
          toolName: 'create_schedule',
          input,
        }),
    }),
    list_schedules: tool({
      description:
        'List your schedules: id, title, cron, timezone, whether paused, and the next runs.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: (input, { toolCallId }) =>
        call({ operation: { name: 'list' }, toolCallId, toolName: 'list_schedules', input }),
    }),
    update_schedule: tool({
      description:
        'Change one of your schedules when the person asks: its title, instructions or timing, or pause and ' +
        'resume it (paused). Only schedules that run on the accounts of the person in this thread. ' +
        'Deleting is done by people, on the Automations page.',
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
    set_wakeup: tool({
      description:
        'Be prompted again in this thread later, with this conversation, to check on something that is not ' +
        'ready yet: a deploy, a CI run, a reply, a site coming up ("check again in 10 minutes"). Give minutes ' +
        `or at (${WAKEUP_MIN_MINUTES} minute to ${WAKEUP_MAX_DAYS} days ahead) and a note saying what to check; ` +
        'the note is the prompt you get back. Then end your turn: never sleep or poll in a loop to wait. ' +
        "Prefer what notifies you by itself (a pull request's review loop, a ticket) when there is one. " +
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
    },
    signal?: AbortSignal,
  ): Promise<{
    status: string
    origins: Record<number, string>
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
  save(reason?: string): Promise<{ repository: string; recipe: unknown }>
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
    }
    checkout: string
  } | null>
  stop(): Promise<{ stopped: boolean }>
  logs(lines?: number): { status: string; logs: string }
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
        'For a repository with a saved preview, pass only `repository` (owner/name): it starts as it was saved, ' +
        'setup included. Try that first in a checkout; save yours with save_preview once its check passes. ' +
        'The app must listen on 0.0.0.0 (or all interfaces), not only localhost, on `port`: PORT and HOST are set. ' +
        'Write the command with $PORT (e.g. "pnpm dev --port $PORT"): when another preview has `port`, it gets a free one. ' +
        'People reach it through a proxy at one public address, in BRIGADE_PREVIEW_URL; the other `ports` are paths on it ' +
        "(/__ports/<port>/), each port's address in BRIGADE_PREVIEW_URL_<port>. Put what the app needs in `env`, " +
        'where ${BRIGADE_PREVIEW_URL} and ${BRIGADE_PREVIEW_URL_<port>} become the addresses (e.g. NEXTAUTH_URL, ' +
        'NEXT_PUBLIC_API_URL, auth callback URLs, allowed origins), and `envFile` if the app reads only its file. ' +
        "The repository's preview variables, which people set (ask with a variables ask in open_ticket), come on " +
        'top of `env`; the result lists their names. ' +
        "The proxy makes the app's cookies work in the dashboard's frame, shows a waiting page while the app starts, " +
        'and starts it again if it stops. Dev servers that check the Host header need the preview host allowed ' +
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
              'Starts the app and keeps running, e.g. "pnpm dev --port $PORT --host 0.0.0.0"',
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
              '(e.g. docker compose up -d), migrate, seed. Safe to run again: they run on each start',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Settings for setup and the app, not secrets: e.g. {"NEXTAUTH_URL": "${BRIGADE_PREVIEW_URL}", "DATABASE_URL": "postgres://…localhost…"}',
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
        },
      }),
      execute: async (args, { abortSignal, toolCallId }) => {
        let input = args
        let passed = false
        if (args.repository && !args.command) {
          const saved = await previews.saved(args.repository)
          if (!saved)
            return {
              status: 'none',
              note: `${args.repository} has no saved preview. Set it up (setup, env, command), start it, and once its check passes, save it with save_preview.`,
            }
          const { recipe, checkout } = saved
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
          },
          abortSignal,
        )
        if (result.status !== 'running') return result
        return { ...result, check: await checked(previews, paths, abortSignal) }
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
        "Save how this thread's preview starts (setup, env, credentials, command, ports, pages to check) as its " +
        "repository's preview, so a later thread starts it in one step with start_preview({ repository }). " +
        'Only once its check passes, unless what it found is expected: then look at the screenshots and give the ' +
        '`reason` (e.g. "/admin redirects to sign-in"). Saving again replaces it. Secrets go in the repository\'s ' +
        'preview variables (a variables ask in open_ticket), never in env: they are kept beside it, not in it.',
      inputSchema: jsonSchema<{ reason?: string }>({
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why what the last check found is expected, when it did not pass',
          },
        },
      }),
      execute: async (input) => {
        const { repository } = await previews.save(input.reason)
        return {
          saved: true,
          repository,
          note: `Later threads start it with start_preview({ repository: "${repository}" }). Mention in your reply that it is saved.`,
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
        "The latest output of this thread's preview (its dev server's console), e.g. to see why a page fails.",
      inputSchema: jsonSchema<{ lines?: number }>({
        type: 'object',
        properties: { lines: { type: 'number', description: 'How many lines (default 100)' } },
      }),
      execute: (input) => previews.logs(input.lines ?? 100),
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
  ) => Promise<unknown>
  /** Where the next screenshot goes: relative to the working directory, and absolute. */
  screenshotPath: () => { path: string; absolute: string }
  /** Show a screenshot in the thread, like a generated image. */
  share: (path: string, toolCallId: string) => void
}

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
