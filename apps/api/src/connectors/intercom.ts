// Intercom connector (REST API), on an access token kept in the vault with its region's address.
import { z } from 'zod'
import {
  ConnectorError,
  json,
  op,
  type ApiKeyCredential,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

export const VERSION = '2.11'
/** Intercom keeps each workspace in one region, each with its own API address. */
const REGIONS = [
  'https://api.intercom.io',
  'https://api.eu.intercom.io',
  'https://api.au.intercom.io',
]

type Author = { type: string; id?: string; name?: string | null; email?: string | null }
type Part = {
  id: string
  part_type: string
  body: string | null
  created_at: number
  author: Author
}
type Conversation = {
  id: string
  title: string | null
  state: 'open' | 'closed' | 'snoozed'
  read: boolean
  priority?: string
  created_at: number
  updated_at: number
  waiting_since?: number | null
  admin_assignee_id?: number | null
  source: { type: string; subject?: string | null; body: string | null; author: Author }
  contacts?: { contacts: { id: string; external_id?: string | null }[] }
  conversation_parts?: { conversation_parts: Part[]; total_count: number }
}
type Contact = {
  id: string
  role: string
  email: string | null
  name: string | null
  phone: string | null
  external_id: string | null
  created_at: number
  last_seen_at: number | null
  custom_attributes?: Record<string, unknown>
}
type Me = {
  type: 'admin'
  id: string
  name: string
  email: string
  app?: { name: string; id_code: string }
}

const time = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : null
const author = (a: Author) => ({ type: a.type, name: a.name ?? null, email: a.email ?? null })

const conversation = (c: Conversation) => ({
  id: c.id,
  title: c.title ?? c.source.subject ?? null,
  state: c.state,
  read: c.read,
  priority: c.priority,
  created: time(c.created_at),
  updated: time(c.updated_at),
  waitingSince: time(c.waiting_since),
  assigneeId: c.admin_assignee_id ? String(c.admin_assignee_id) : null,
  from: author(c.source.author),
  firstMessage: c.source.body?.slice(0, 500) ?? null,
  contactIds: c.contacts?.contacts.map((x) => x.id) ?? [],
})
const contact = (c: Contact) => ({
  id: c.id,
  role: c.role,
  email: c.email,
  name: c.name,
  phone: c.phone,
  externalId: c.external_id,
  created: time(c.created_at),
  lastSeen: time(c.last_seen_at),
  attributes: c.custom_attributes,
})

const headers = { 'intercom-version': VERSION, accept: 'application/json' }
const get = async <T>(ctx: ConnectorContext, path: string) =>
  json<T>(await ctx.fetch(path, { headers }))
const post = async <T>(ctx: ConnectorContext, path: string, body: unknown) =>
  json<T>(
    await ctx.fetch(path, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

/** The admin the token belongs to: replies and notes go out in their name. */
const me = (ctx: ConnectorContext) => get<Me>(ctx, '/me')

/** Plain text as Intercom's message HTML: one paragraph per line, nothing interpreted. */
export const paragraphs = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    )
    .map((line) => `<p>${line}</p>`)
    .join('')

const conversationId = z.string().regex(/^\d+$/, 'An Intercom conversation id (digits)')
const limit = z.number().int().min(1).max(50).default(20)
const message = z.string().trim().min(1).max(10_000)

/** Close, snooze or reopen, as a part of the conversation. */
async function part(ctx: ConnectorContext, id: string, body: Record<string, unknown>) {
  const admin = await me(ctx)
  return conversation(
    await post<Conversation>(ctx, `/conversations/${id}/parts`, {
      type: 'admin',
      admin_id: admin.id,
      ...body,
    }),
  )
}

export const intercom: ConnectorDefinition = {
  kind: 'intercom',
  label: 'Intercom',
  auth: 'api_key',
  key: { headers: ({ apiKey }) => ({ authorization: `Bearer ${apiKey}` }) },
  operations: {
    intercom_search_conversations: op({
      description:
        "Find conversations, newest activity first: by state (open, closed, snoozed), by a customer's email, or by words in the customer's first message.",
      write: false,
      input: z.object({
        state: z.enum(['open', 'closed', 'snoozed']).optional(),
        email: z.email().optional().describe("The customer's email"),
        text: z.string().trim().min(1).max(200).optional().describe('Words in the first message'),
        unread: z.boolean().optional().describe('Only conversations no teammate has read'),
        limit,
      }),
      target: (i) =>
        `conversations${i.state ? ` ${i.state}` : ''}${i.email ? ` from ${i.email}` : ''}${i.text ? ` with "${i.text}"` : ''}`,
      run: async (ctx, i) => {
        const filters = [
          i.state && { field: 'state', operator: '=', value: i.state },
          i.email && { field: 'source.author.email', operator: '=', value: i.email },
          i.text && { field: 'source.body', operator: '~', value: i.text },
          i.unread !== undefined && { field: 'read', operator: '=', value: !i.unread },
        ].filter(Boolean)
        // Intercom's search needs a filter: with none, everything updated since 1970.
        const query =
          filters.length === 0
            ? { field: 'updated_at', operator: '>', value: 0 }
            : filters.length === 1
              ? filters[0]
              : { operator: 'AND', value: filters }
        const list = await post<{ conversations: Conversation[]; total_count: number }>(
          ctx,
          '/conversations/search',
          {
            query,
            pagination: { per_page: i.limit },
            sort: { field: 'updated_at', order: 'descending' },
          },
        )
        return { conversations: list.conversations.map(conversation), total: list.total_count }
      },
    }),
    intercom_get_conversation: op({
      description:
        'Read one conversation with every message and internal note in it, oldest first, as plain text.',
      write: false,
      input: z.object({ conversationId }),
      target: (i) => `conversation ${i.conversationId}`,
      run: async (ctx, i) => {
        const c = await get<Conversation>(
          ctx,
          `/conversations/${i.conversationId}?display_as=plaintext`,
        )
        return {
          ...conversation(c),
          firstMessage: c.source.body,
          // Assignments, state changes and the like carry no text: only what someone wrote.
          parts: (c.conversation_parts?.conversation_parts ?? [])
            .filter((p) => p.body)
            .map((p) => ({
              type: p.part_type === 'note' ? 'note' : 'message',
              at: time(p.created_at),
              from: author(p.author),
              body: p.body,
            })),
        }
      },
    }),
    intercom_search_contacts: op({
      description: 'Find customers (users and leads) by email or name.',
      write: false,
      input: z
        .object({
          email: z.string().trim().min(1).max(200).optional(),
          name: z.string().trim().min(1).max(200).optional(),
          limit,
        })
        .refine((i) => i.email || i.name, 'Give an email or a name'),
      target: (i) => `contacts ${i.email ?? i.name}`,
      run: async (ctx, i) => {
        const list = await post<{ data: Contact[]; total_count: number }>(ctx, '/contacts/search', {
          query: i.email
            ? { field: 'email', operator: i.email.includes('@') ? '=' : '~', value: i.email }
            : { field: 'name', operator: '~', value: i.name },
          pagination: { per_page: i.limit },
        })
        return { contacts: list.data.map(contact), total: list.total_count }
      },
    }),
    intercom_get_contact: op({
      description: 'Read one customer, with their custom attributes.',
      write: false,
      input: z.object({ contactId: z.string().regex(/^[A-Za-z0-9]+$/, 'An Intercom contact id') }),
      target: (i) => `contact ${i.contactId}`,
      run: async (ctx, i) => contact(await get<Contact>(ctx, `/contacts/${i.contactId}`)),
    }),
    intercom_reply: op({
      description:
        'Reply to the customer in a conversation, as the admin who connected Intercom. The customer sees it. A person approves each reply first.',
      write: true,
      approval: 'always',
      input: z.object({ conversationId, message }),
      target: (i) => `reply in conversation ${i.conversationId}`,
      run: async (ctx, i) => {
        const admin = await me(ctx)
        const c = await post<Conversation>(ctx, `/conversations/${i.conversationId}/reply`, {
          message_type: 'comment',
          type: 'admin',
          admin_id: admin.id,
          body: paragraphs(i.message),
        })
        return { ...conversation(c), repliedAs: admin.email }
      },
    }),
    intercom_add_note: op({
      description:
        'Add an internal note to a conversation, for the support team only. The customer does not see it.',
      write: true,
      input: z.object({ conversationId, note: message }),
      target: (i) => `note in conversation ${i.conversationId}`,
      run: async (ctx, i) => {
        const admin = await me(ctx)
        return conversation(
          await post<Conversation>(ctx, `/conversations/${i.conversationId}/reply`, {
            message_type: 'note',
            type: 'admin',
            admin_id: admin.id,
            body: paragraphs(i.note),
          }),
        )
      },
    }),
    intercom_set_state: op({
      description: 'Close, reopen or snooze a conversation (snooze until a time).',
      write: true,
      input: z
        .object({
          conversationId,
          state: z.enum(['closed', 'open', 'snoozed']),
          snoozedUntil: z.iso.datetime({ offset: true }).optional().describe('snoozed: until when'),
        })
        .refine((i) => i.state !== 'snoozed' || i.snoozedUntil, 'Snoozing needs snoozedUntil'),
      target: (i) =>
        `${i.state === 'open' ? 'reopen' : i.state === 'closed' ? 'close' : 'snooze'} conversation ${i.conversationId}`,
      run: async (ctx, i) =>
        part(
          ctx,
          i.conversationId,
          i.state === 'closed'
            ? { message_type: 'close' }
            : i.state === 'open'
              ? { message_type: 'open' }
              : {
                  message_type: 'snoozed',
                  snoozed_until: Math.floor(new Date(i.snoozedUntil!).getTime() / 1000),
                },
        ),
    }),
  },
}

/**
 * Check a token and find its workspace's region: the credential to keep, and the account to
 * show (the workspace's name and the admin's email). Never the token.
 */
export async function intercomAccount(apiKey: string) {
  for (const baseUrl of REGIONS) {
    const response = await fetch(`${baseUrl}/me`, {
      headers: { ...headers, authorization: `Bearer ${apiKey}` },
    })
    // Another region's token: Intercom answers 401 with token_not_found.
    if (response.status === 401) continue
    const admin = await json<Me>(response)
    const credential: ApiKeyCredential = { apiKey, baseUrl }
    return {
      credential,
      account: admin.app ? `${admin.app.name} (${admin.email})` : admin.email,
      url: admin.app ? `https://app.intercom.com/a/apps/${admin.app.id_code}` : undefined,
    }
  }
  throw new ConnectorError('Intercom did not accept that access token in any region')
}
