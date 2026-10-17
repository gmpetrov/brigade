// Zendesk connector (Support REST API), on an agent's API token kept in the vault with their
// email and the account's subdomain.
import { z } from 'zod'
import {
  ConnectorError,
  json,
  op,
  type ApiKeyCredential,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

type Ticket = {
  id: number
  subject: string | null
  description: string | null
  status: string
  priority: string | null
  type: string | null
  tags: string[]
  requester_id: number
  assignee_id: number | null
  created_at: string
  updated_at: string
  via?: { channel: string }
}
type Comment = {
  id: number
  author_id: number
  plain_body: string
  public: boolean
  created_at: string
  attachments?: { file_name: string; content_url: string; size: number }[]
}
type User = {
  id: number
  name: string
  email: string | null
  role: string
  phone?: string | null
  organization_id?: number | null
  time_zone?: string
  created_at: string
}

const ticket = (t: Ticket) => ({
  id: t.id,
  subject: t.subject,
  status: t.status,
  priority: t.priority,
  type: t.type,
  tags: t.tags,
  requesterId: t.requester_id,
  assigneeId: t.assignee_id,
  channel: t.via?.channel,
  created: t.created_at,
  updated: t.updated_at,
})
const user = (u: User) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  phone: u.phone ?? null,
  organizationId: u.organization_id ?? null,
  created: u.created_at,
})

const get = async <T>(ctx: ConnectorContext, path: string) => json<T>(await ctx.fetch(path))
const put = async <T>(ctx: ConnectorContext, path: string, body: unknown) =>
  json<T>(
    await ctx.fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const ticketId = z.number().int().positive().describe('The Zendesk ticket number')
const limit = z.number().int().min(1).max(100).default(20)
const message = z.string().trim().min(1).max(30_000)
/** Statuses an agent sets. New is only a ticket nobody has touched; closed comes by itself. */
const status = z.enum(['open', 'pending', 'hold', 'solved'])

/** A comment on a ticket, with a status change in the same update if one is given. */
async function comment(
  ctx: ConnectorContext,
  id: number,
  body: string,
  publicly: boolean,
  next?: string,
) {
  const result = await put<{ ticket: Ticket; audit?: { id: number } }>(
    ctx,
    `/api/v2/tickets/${id}.json`,
    { ticket: { comment: { body, public: publicly }, ...(next ? { status: next } : {}) } },
  )
  return ticket(result.ticket)
}

export const zendesk: ConnectorDefinition = {
  kind: 'zendesk',
  label: 'Zendesk',
  auth: 'api_key',
  // Zendesk's API tokens go with the agent's email, as Basic auth on {email}/token.
  key: {
    headers: ({ apiKey, email }) => ({
      authorization: `Basic ${Buffer.from(`${email}/token:${apiKey}`).toString('base64')}`,
    }),
  },
  operations: {
    zendesk_search_tickets: op({
      description:
        'Find tickets, newest activity first, with Zendesk\'s search syntax, e.g. "status:open", "status<solved requester:ada@example.com" or words in the ticket.',
      write: false,
      input: z.object({ query: z.string().trim().min(1).max(500), limit }),
      target: (i) => `ticket search ${i.query}`,
      run: async (ctx, i) => {
        const query = new URLSearchParams({
          query: `type:ticket ${i.query}`,
          sort_by: 'updated_at',
          sort_order: 'desc',
          per_page: String(i.limit),
        })
        const list = await get<{ results: Ticket[]; count: number }>(
          ctx,
          `/api/v2/search.json?${query}`,
        )
        return { tickets: list.results.map(ticket), total: list.count }
      },
    }),
    zendesk_get_ticket: op({
      description:
        'Read one ticket with its requester and every comment, public replies and internal notes, oldest first.',
      write: false,
      input: z.object({ ticketId }),
      target: (i) => `ticket ${i.ticketId}`,
      run: async (ctx, i) => {
        const [{ ticket: t }, { comments, users }] = await Promise.all([
          get<{ ticket: Ticket }>(ctx, `/api/v2/tickets/${i.ticketId}.json`),
          get<{ comments: Comment[]; users: User[] }>(
            ctx,
            `/api/v2/tickets/${i.ticketId}/comments.json?include=users&sort_order=asc`,
          ),
        ])
        const byId = new Map(users.map((u) => [u.id, u]))
        const requester = byId.get(t.requester_id)
        return {
          ...ticket(t),
          requester: requester ? user(requester) : { id: t.requester_id },
          comments: comments.map((c) => {
            const from = byId.get(c.author_id)
            return {
              type: c.public ? 'reply' : 'note',
              at: c.created_at,
              from: from ? { name: from.name, email: from.email, role: from.role } : null,
              body: c.plain_body,
              attachments: c.attachments?.map((a) => ({ name: a.file_name, size: a.size })),
            }
          }),
        }
      },
    }),
    zendesk_search_users: op({
      description: 'Find customers or agents by email or name.',
      write: false,
      input: z.object({ query: z.string().trim().min(1).max(200), limit }),
      target: (i) => `user search ${i.query}`,
      run: async (ctx, i) => {
        const query = new URLSearchParams({ query: i.query, per_page: String(i.limit) })
        const list = await get<{ users: User[]; count: number }>(
          ctx,
          `/api/v2/users/search.json?${query}`,
        )
        return { users: list.users.map(user), total: list.count }
      },
    }),
    zendesk_reply: op({
      description:
        'Reply to the requester on a ticket, as the agent who connected Zendesk, and optionally set its status (e.g. pending or solved). The customer gets it. A person approves each reply first.',
      write: true,
      approval: 'always',
      input: z.object({ ticketId, message, status: status.optional() }),
      target: (i) => `reply on ticket ${i.ticketId}${i.status ? `, then ${i.status}` : ''}`,
      run: async (ctx, i) => comment(ctx, i.ticketId, i.message, true, i.status),
    }),
    zendesk_add_note: op({
      description:
        'Add an internal note to a ticket, for agents only. The customer does not see it.',
      write: true,
      input: z.object({ ticketId, note: message }),
      target: (i) => `note on ticket ${i.ticketId}`,
      run: async (ctx, i) => comment(ctx, i.ticketId, i.note, false),
    }),
    zendesk_update_ticket: op({
      description: "Change a ticket's status, priority or tags, without writing to the customer.",
      write: true,
      input: z
        .object({
          ticketId,
          status: status.optional(),
          priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          tags: z
            .array(z.string().trim().min(1).max(80))
            .max(50)
            .optional()
            .describe('Replaces every tag'),
        })
        .refine((i) => i.status || i.priority || i.tags, 'Give a status, a priority or tags'),
      target: (i) => `ticket ${i.ticketId}`,
      run: async (ctx, { ticketId: id, ...fields }) =>
        ticket(
          (await put<{ ticket: Ticket }>(ctx, `/api/v2/tickets/${id}.json`, { ticket: fields }))
            .ticket,
        ),
    }),
  },
}

/** acme, acme.zendesk.com or https://acme.zendesk.com/agent/… : the account's API address. */
export function zendeskBaseUrl(subdomain: string) {
  const host = subdomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]!
  const name = host.endsWith('.zendesk.com') ? host.slice(0, -'.zendesk.com'.length) : host
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
    throw new ConnectorError('Not a Zendesk subdomain: give acme for acme.zendesk.com')
  return `https://${name}.zendesk.com`
}

/** Check a token: the credential to keep and the account to show. Never the token. */
export async function zendeskAccount(input: { apiKey: string; email: string; subdomain: string }) {
  const baseUrl = zendeskBaseUrl(input.subdomain)
  const credential: ApiKeyCredential = { apiKey: input.apiKey, email: input.email, baseUrl }
  const response = await fetch(`${baseUrl}/api/v2/users/me.json`, {
    headers: zendesk.key!.headers(credential),
  })
  if (response.status === 404) throw new ConnectorError(`There is no Zendesk account at ${baseUrl}`)
  const { user: me } = await json<{ user: User }>(response)
  // Zendesk answers a refused token as the anonymous user, not with an error.
  if (!me.id || me.role === 'end-user')
    throw new ConnectorError(
      'Zendesk did not accept that email and API token (is token access turned on?)',
    )
  return {
    credential,
    account: `${new URL(baseUrl).host} (${me.email ?? me.name})`,
    url: baseUrl,
  }
}
