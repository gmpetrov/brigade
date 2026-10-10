// Google Calendar connector (Calendar API v3), on the account's OAuth credential in the vault.
import { z } from 'zod'
import {
  ConnectorError,
  json,
  op,
  type ConnectorContext,
  type ConnectorDefinition,
} from './types.js'

const API = 'https://www.googleapis.com/calendar/v3'

type Attendee = { email?: string; responseStatus?: string; self?: boolean; optional?: boolean }
export type Event = {
  id: string
  status?: string
  created?: string
  updated?: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: Attendee[]
  organizer?: { email?: string; self?: boolean }
  hangoutLink?: string
  recurringEventId?: string
}

const event = (e: Event) => ({
  id: e.id,
  status: e.status,
  summary: e.summary,
  description: e.description?.slice(0, 5000),
  location: e.location,
  start: e.start,
  end: e.end,
  organizer: e.organizer?.email,
  attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus })),
  link: e.htmlLink,
  meet: e.hangoutLink,
})

const calendarId = z
  .string()
  .max(300)
  .default('primary')
  .describe('Calendar id; "primary" is the account\'s own calendar')
const when = z
  .object({
    dateTime: z.iso.datetime({ offset: true }).optional().describe('RFC 3339 time'),
    date: z.iso.date().optional().describe('All-day date, YYYY-MM-DD'),
    timeZone: z.string().max(100).optional(),
  })
  .refine((w) => Boolean(w.dateTime) !== Boolean(w.date), 'Give either dateTime or date')
const sendUpdates = z
  .enum(['all', 'externalOnly', 'none'])
  .default('none')
  .describe('Whether Google emails the guests about the change')

const path = (calendar: string, suffix = '') =>
  `${API}/calendars/${encodeURIComponent(calendar)}/events${suffix}`

/**
 * Event revisions Brigade's own calls made, so a teammate creating or changing
 * an event does not trigger itself. In this process only, the last thousand.
 */
const own = new Set<string>()
const remember = (key: string) => {
  own.add(key)
  if (own.size > 1000) own.delete(own.values().next().value!)
}
export const isOwnChange = (e: Event) =>
  own.has(`${e.id}:${e.updated}`) || (e.status === 'cancelled' && own.has(`${e.id}:deleted`))

async function send(ctx: ConnectorContext, url: string, method: string, body?: unknown) {
  const response = await ctx.fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (response.ok && method === 'DELETE')
    remember(`${decodeURIComponent(url.split('?')[0]!.split('/').pop()!)}:deleted`)
  else if (response.ok) {
    const written = (await response
      .clone()
      .json()
      .catch(() => null)) as Event | null
    if (written?.id) remember(`${written.id}:${written.updated}`)
  }
  return response
}

const when_ = (e: Event) => e.start?.dateTime ?? e.start?.date ?? 'no time'
const eventLines = (e: Event) =>
  [
    `${e.summary ?? '(no title)'}, ${when_(e)} to ${e.end?.dateTime ?? e.end?.date ?? '?'}`,
    ...(e.location ? [`Where: ${e.location}`] : []),
    ...(e.organizer?.email ? [`Organizer: ${e.organizer.email}`] : []),
    ...(e.attendees?.length
      ? [`Guests: ${e.attendees.map((a) => `${a.email} (${a.responseStatus})`).join(', ')}`]
      : []),
    `Event id ${e.id}${e.htmlLink ? `, ${e.htmlLink}` : ''}`,
  ].join('\n')
const calendarOption = {
  name: 'calendarId',
  label: 'Calendar',
  placeholder: 'primary',
  help: "A calendar id from Google Calendar's settings. Empty: the account's own calendar.",
}

export const googleCalendar: ConnectorDefinition = {
  kind: 'google_calendar',
  label: 'Google Calendar',
  auth: 'google',
  // Event types come from subscriptions/google-calendar.ts, which reads each change.
  triggers: {
    event_created: {
      label: 'Event created',
      description: 'An event is added to the calendar.',
      options: [calendarOption],
      events: ['created'],
      describe: ({ payload }) => ({
        title: `New event: ${(payload as Event).summary ?? '(no title)'}`,
        summary: eventLines(payload as Event),
      }),
    },
    event_changed: {
      label: 'Event changed or canceled',
      description: "An event's time, guests or details change, or it is canceled.",
      options: [calendarOption],
      events: ['updated', 'cancelled'],
      describe: ({ type, payload }) => ({
        title: `${type === 'cancelled' ? 'Event canceled' : 'Event changed'}: ${(payload as Event).summary ?? (payload as Event).id}`,
        summary: eventLines(payload as Event),
      }),
    },
    invited: {
      label: 'Invited to an event',
      description: 'Someone else invites this account, and it has not answered yet.',
      options: [calendarOption],
      events: ['invited'],
      describe: ({ payload }) => ({
        title: `Invitation: ${(payload as Event).summary ?? '(no title)'}`,
        summary: eventLines(payload as Event),
      }),
    },
  },
  operations: {
    calendar_list_calendars: op({
      description: 'List the calendars this account can see, with their ids.',
      write: false,
      input: z.object({}),
      target: () => 'calendar list',
      run: async (ctx) => {
        const list = await json<{
          items?: { id: string; summary?: string; primary?: boolean; accessRole?: string }[]
        }>(await ctx.fetch(`${API}/users/me/calendarList?maxResults=250`))
        return {
          calendars: (list.items ?? []).map((c) => ({
            id: c.id,
            summary: c.summary,
            primary: c.primary ?? false,
            access: c.accessRole,
          })),
        }
      },
    }),
    calendar_list_events: op({
      description:
        'List events in a time range, earliest first. Recurring events are expanded into single events.',
      write: false,
      input: z.object({
        calendarId,
        timeMin: z.iso.datetime({ offset: true }).describe('Start of the range, RFC 3339'),
        timeMax: z.iso.datetime({ offset: true }).describe('End of the range, RFC 3339'),
        query: z.string().max(300).optional().describe('Free-text search'),
        maxResults: z.number().int().min(1).max(100).default(25),
      }),
      target: (i) => `events on ${i.calendarId} from ${i.timeMin} to ${i.timeMax}`,
      run: async (ctx, i) => {
        const params = new URLSearchParams({
          timeMin: i.timeMin,
          timeMax: i.timeMax,
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: String(i.maxResults),
          ...(i.query ? { q: i.query } : {}),
        })
        const list = await json<{ items?: Event[] }>(
          await ctx.fetch(`${path(i.calendarId)}?${params}`),
        )
        return { events: (list.items ?? []).map(event) }
      },
    }),
    calendar_get_event: op({
      description: 'Read one event.',
      write: false,
      input: z.object({ calendarId, eventId: z.string().max(1024) }),
      target: (i) => `event ${i.eventId} on ${i.calendarId}`,
      run: async (ctx, i) =>
        event(
          await json<Event>(
            await ctx.fetch(path(i.calendarId, `/${encodeURIComponent(i.eventId)}`)),
          ),
        ),
    }),
    calendar_free_busy: op({
      description: 'When the given calendars are busy in a time range.',
      write: false,
      input: z.object({
        timeMin: z.iso.datetime({ offset: true }),
        timeMax: z.iso.datetime({ offset: true }),
        calendarIds: z.array(z.string().max(300)).min(1).max(20).default(['primary']),
        timeZone: z.string().max(100).optional(),
      }),
      target: (i) => `free/busy for ${i.calendarIds.join(', ')} from ${i.timeMin} to ${i.timeMax}`,
      run: async (ctx, i) => {
        const result = await json<{
          calendars?: Record<string, { busy?: { start: string; end: string }[] }>
        }>(
          await send(ctx, `${API}/freeBusy`, 'POST', {
            timeMin: i.timeMin,
            timeMax: i.timeMax,
            ...(i.timeZone ? { timeZone: i.timeZone } : {}),
            items: i.calendarIds.map((id) => ({ id })),
          }),
        )
        return {
          calendars: Object.fromEntries(
            Object.entries(result.calendars ?? {}).map(([id, c]) => [id, c.busy ?? []]),
          ),
        }
      },
    }),
    calendar_create_event: op({
      description: 'Create an event, optionally inviting guests.',
      write: true,
      input: z.object({
        calendarId,
        summary: z.string().min(1).max(500),
        description: z.string().max(20_000).optional(),
        location: z.string().max(500).optional(),
        start: when,
        end: when,
        attendees: z.array(z.email()).max(100).default([]),
        sendUpdates,
      }),
      target: (i) =>
        `event "${i.summary}" at ${i.start.dateTime ?? i.start.date} on ${i.calendarId}${i.attendees.length ? ` with ${i.attendees.join(', ')}` : ''}`,
      run: async (ctx, i) =>
        event(
          await json<Event>(
            await send(ctx, `${path(i.calendarId)}?sendUpdates=${i.sendUpdates}`, 'POST', {
              summary: i.summary,
              ...(i.description ? { description: i.description } : {}),
              ...(i.location ? { location: i.location } : {}),
              start: i.start,
              end: i.end,
              attendees: i.attendees.map((email) => ({ email })),
            }),
          ),
        ),
    }),
    calendar_update_event: op({
      description: 'Change an event. Only the given fields change.',
      write: true,
      input: z.object({
        calendarId,
        eventId: z.string().max(1024),
        summary: z.string().min(1).max(500).optional(),
        description: z.string().max(20_000).optional(),
        location: z.string().max(500).optional(),
        start: when.optional(),
        end: when.optional(),
        attendees: z
          .array(z.email())
          .max(100)
          .optional()
          .describe('The full guest list, replacing the current one'),
        sendUpdates,
      }),
      target: (i) => `event ${i.eventId} on ${i.calendarId}`,
      run: async (ctx, i) => {
        const { calendarId: calendar, eventId, sendUpdates: updates, attendees, ...fields } = i
        const patch = {
          ...fields,
          ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
        }
        if (Object.keys(patch).length === 0) throw new ConnectorError('Nothing to change')
        return event(
          await json<Event>(
            await send(
              ctx,
              `${path(calendar, `/${encodeURIComponent(eventId)}`)}?sendUpdates=${updates}`,
              'PATCH',
              patch,
            ),
          ),
        )
      },
    }),
    calendar_delete_event: op({
      description: 'Delete (cancel) an event.',
      write: true,
      input: z.object({ calendarId, eventId: z.string().max(1024), sendUpdates }),
      target: (i) => `event ${i.eventId} on ${i.calendarId}`,
      run: async (ctx, i) => {
        await json(
          await send(
            ctx,
            `${path(i.calendarId, `/${encodeURIComponent(i.eventId)}`)}?sendUpdates=${i.sendUpdates}`,
            'DELETE',
          ),
        )
        return { deleted: i.eventId }
      },
    }),
    calendar_respond: op({
      description: "Accept, decline or tentatively accept an invitation on this account's behalf.",
      write: true,
      input: z.object({
        calendarId,
        eventId: z.string().max(1024),
        response: z.enum(['accepted', 'declined', 'tentative']),
        sendUpdates: sendUpdates.default('all'),
      }),
      target: (i) => `${i.response} event ${i.eventId} on ${i.calendarId}`,
      run: async (ctx, i) => {
        const url = path(i.calendarId, `/${encodeURIComponent(i.eventId)}`)
        const current = await json<Event>(await ctx.fetch(url))
        const attendees = current.attendees ?? []
        if (!attendees.some((a) => a.self))
          throw new ConnectorError('This account is not a guest of that event')
        const updated = await json<Event>(
          await send(ctx, `${url}?sendUpdates=${i.sendUpdates}`, 'PATCH', {
            attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: i.response } : a)),
          }),
        )
        return event(updated)
      },
    }),
  },
}
