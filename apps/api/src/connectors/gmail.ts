// Gmail connector (Gmail API v1), on the mailbox's OAuth credential in the vault.
import { z } from 'zod'
import {
  ConnectorError,
  json,
  op,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

type Header = { name: string; value: string }
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] }
type Message = {
  id: string
  threadId: string
  snippet?: string
  labelIds?: string[]
  payload?: Part
}

const header = (m: Message, name: string) =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
const decode = (data: string) =>
  Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

function textOf(part: Part | undefined): string {
  if (!part) return ''
  if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data)
  for (const child of part.parts ?? []) {
    const text = textOf(child)
    if (text) return text
  }
  if (part.mimeType === 'text/html' && part.body?.data)
    return decode(part.body.data)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  return ''
}

const summary = (m: Message) => ({
  id: m.id,
  threadId: m.threadId,
  from: header(m, 'From'),
  to: header(m, 'To'),
  subject: header(m, 'Subject'),
  date: header(m, 'Date'),
  snippet: m.snippet,
  labels: m.labelIds,
})

const full = (m: Message) => ({
  ...summary(m),
  cc: header(m, 'Cc'),
  body: textOf(m.payload).slice(0, 50_000),
})

const Compose = z.object({
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).optional(),
  subject: z.string().max(500),
  body: z.string().max(100_000).describe('Plain text body'),
  replyToMessageId: z
    .string()
    .optional()
    .describe('Gmail message id to reply to, keeping the thread'),
})

/** An RFC 2822 message, base64url-encoded as Gmail expects, threaded when replying. */
async function compose(ctx: ConnectorContext, input: z.infer<typeof Compose>) {
  let threadId: string | undefined
  const headers = [`To: ${input.to.join(', ')}`]
  if (input.cc?.length) headers.push(`Cc: ${input.cc.join(', ')}`)
  let subject = input.subject
  if (input.replyToMessageId) {
    const original = await json<Message>(
      await ctx.fetch(
        `${API}/messages/${encodeURIComponent(input.replyToMessageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References`,
      ),
    )
    threadId = original.threadId
    const messageId = header(original, 'Message-ID')
    if (messageId)
      headers.push(
        `In-Reply-To: ${messageId}`,
        `References: ${[header(original, 'References'), messageId].filter(Boolean).join(' ')}`,
      )
    if (!subject) subject = `Re: ${header(original, 'Subject') ?? ''}`
  }
  headers.push(
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  )
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${input.body}`).toString('base64url')
  return { raw, ...(threadId ? { threadId } : {}) }
}

const post = (ctx: ConnectorContext, path: string, body: unknown) =>
  ctx.fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const gmail: ConnectorDefinition = {
  kind: 'gmail',
  label: 'Gmail',
  auth: 'google',
  operations: {
    gmail_search: op({
      description:
        'Search the mailbox with Gmail search syntax (e.g. "is:unread newer_than:2d"). Returns message summaries.',
      write: false,
      input: z.object({
        query: z.string().max(500),
        maxResults: z.number().int().min(1).max(25).default(10),
      }),
      target: (i) => `search "${i.query}"`,
      run: async (ctx, i) => {
        const list = await json<{ messages?: { id: string }[] }>(
          await ctx.fetch(
            `${API}/messages?q=${encodeURIComponent(i.query)}&maxResults=${i.maxResults}`,
          ),
        )
        const messages = await Promise.all(
          (list.messages ?? []).map(async ({ id }) =>
            summary(
              await json<Message>(
                await ctx.fetch(
                  `${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
                ),
              ),
            ),
          ),
        )
        return { messages }
      },
    }),
    gmail_read_message: op({
      description: 'Read one message: headers and plain-text body.',
      write: false,
      input: z.object({ messageId: z.string() }),
      target: (i) => `message ${i.messageId}`,
      run: async (ctx, i) =>
        full(
          await json<Message>(
            await ctx.fetch(`${API}/messages/${encodeURIComponent(i.messageId)}?format=full`),
          ),
        ),
    }),
    gmail_read_thread: op({
      description: 'Read a whole conversation thread.',
      write: false,
      input: z.object({ threadId: z.string() }),
      target: (i) => `thread ${i.threadId}`,
      run: async (ctx, i) => {
        const thread = await json<{ id: string; messages?: Message[] }>(
          await ctx.fetch(`${API}/threads/${encodeURIComponent(i.threadId)}?format=full`),
        )
        return { id: thread.id, messages: (thread.messages ?? []).map(full) }
      },
    }),
    gmail_list_labels: op({
      description: 'List the mailbox labels and their ids.',
      write: false,
      input: z.object({}),
      target: () => 'labels',
      run: async (ctx) => json(await ctx.fetch(`${API}/labels`)),
    }),
    gmail_send: op({
      description: 'Send an email, or a reply in an existing thread with replyToMessageId.',
      write: true,
      input: Compose,
      target: (i) => `email to ${i.to.join(', ')}: "${i.subject}"`,
      run: async (ctx, i) => {
        const sent = await json<Message>(await post(ctx, '/messages/send', await compose(ctx, i)))
        return { id: sent.id, threadId: sent.threadId }
      },
    }),
    gmail_create_draft: op({
      description: 'Create a draft (not sent), or a reply draft with replyToMessageId.',
      write: true,
      input: Compose,
      target: (i) => `draft to ${i.to.join(', ')}: "${i.subject}"`,
      run: async (ctx, i) => {
        const draft = await json<{ id: string; message: Message }>(
          await post(ctx, '/drafts', { message: await compose(ctx, i) }),
        )
        return { draftId: draft.id, messageId: draft.message.id }
      },
    }),
    gmail_modify_labels: op({
      description:
        'Add or remove labels on a message (e.g. remove "UNREAD" to mark it read, add "STARRED").',
      write: true,
      input: z.object({
        messageId: z.string(),
        addLabelIds: z.array(z.string()).max(20).default([]),
        removeLabelIds: z.array(z.string()).max(20).default([]),
      }),
      target: (i) => `message ${i.messageId}`,
      run: async (ctx, i) => {
        if (i.addLabelIds.length + i.removeLabelIds.length === 0)
          throw new ConnectorError('Nothing to change')
        const m = await json<Message>(
          await post(ctx, `/messages/${encodeURIComponent(i.messageId)}/modify`, {
            addLabelIds: i.addLabelIds,
            removeLabelIds: i.removeLabelIds,
          }),
        )
        return { id: m.id, labels: m.labelIds }
      },
    }),
  },
}
