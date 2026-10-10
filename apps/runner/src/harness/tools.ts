// Connector tools: AI SDK tools whose execute forwards the call to the API,
// which checks the grant, asks for approval if needed, and makes the request.
import { jsonSchema, tool, type Tool } from 'ai'
import type { ConnectorGrant, ScheduleOperation, TaskOperation } from '@brigade/contracts'

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
    'in words. For a login or key the vault lacks, ' +
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
            type: { type: 'string', enum: ['approval', 'decision', 'access', 'action', 'input'] },
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
          },
          required: ['id', 'type'],
        },
      },
    },
    required: ['title', 'asks'],
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
  'Members mention credentials in messages as @[Name](credential:<id>); a credential mentioned by a member in this thread is yours to use here, any other needs a person to approve it. ' +
  'For one the vault lacks, open a ticket with an access ask of kind credential: the person saves it from the ticket.'

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

export type TaskCaller = (call: {
  operation: TaskOperation
  toolCallId: string
  toolName: string
  input: unknown
}) => Promise<unknown>

/**
 * Tasks on the board: turn this thread into one, or mark this thread's task
 * done. The API checks the thread (not a trigger's, not already a task).
 */
export function taskTools(call: TaskCaller): Record<string, Tool> {
  return {
    create_task: tool({
      description:
        "Track this thread's work as a task on the workspace's Tasks board, where the team follows it. " +
        'Use it when the work has a deliverable someone will review (a pull request, document, email or report), ' +
        'takes several steps, will wait on approval or someone else, or the person asks to track it. ' +
        'Do not use it for questions, explanations, brainstorming or quick actions you finish in this reply, ' +
        'or when this thread is already a task. Call it before starting the work, or as soon as a conversation ' +
        'turns into work. Do not ask first; say in one line that you are tracking it.',
      inputSchema: jsonSchema<{
        title: string
        description: string
        priority?: 'low' | 'medium' | 'high' | 'urgent'
      }>({
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short and imperative, e.g. "Add CSV export to billing"',
          },
          description: { type: 'string', description: 'What done looks like, in a few lines' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        },
        required: ['title', 'description'],
      }),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'create',
            title: input.title,
            description: input.description,
            priority: input.priority ?? 'medium',
          },
          toolCallId,
          toolName: 'create_task',
          input,
        }),
    }),
    complete_task: tool({
      description:
        "Mark this thread's task done once the work is finished and delivered. Give a short summary of what you did " +
        'and links to what you produced (pull request, document, file) so a person or another teammate can find it. ' +
        'Only for a thread that is a task.',
      inputSchema: jsonSchema<{ summary: string; deliverables?: { label: string; url: string }[] }>(
        {
          type: 'object',
          properties: {
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
        },
      ),
      execute: (input, { toolCallId }) =>
        call({
          operation: {
            name: 'complete',
            summary: input.summary,
            deliverables: input.deliverables ?? [],
          },
          toolCallId,
          toolName: 'complete_task',
          input,
        }),
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
