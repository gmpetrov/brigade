import { z } from 'zod'
import type { ConnectorDefinition, ConnectorKind, TriggerDefinition } from './types.js'
import { gmail } from './gmail.js'
import { github } from './github.js'
import { googleCalendar } from './google-calendar.js'
import { stripe } from './stripe.js'

export const connectors: Partial<Record<ConnectorDefinition['kind'], ConnectorDefinition>> = {
  gmail,
  google_calendar: googleCalendar,
  stripe,
  github,
}

/**
 * A custom app's one trigger: any event posted to the trigger's own URL. The
 * app is not a connector (nothing to call), so it is defined here.
 */
const customApp: Record<string, TriggerDefinition> = {
  received: {
    label: 'Event received',
    description: 'The app posts an event to the URL.',
    events: ['received'],
    describe: ({ type, payload }) => ({
      title:
        typeof payload === 'object' && payload && 'type' in payload ? String(payload.type) : type,
      summary: '',
    }),
  },
}

/** The events that can start threads on a kind of connection. */
export const triggersOf = (kind: ConnectorKind): Record<string, TriggerDefinition> =>
  kind === 'webhook' ? customApp : (connectors[kind]?.triggers ?? {})

/** The catalog as the dashboard shows it. */
export const triggerCatalog = () =>
  Object.fromEntries(
    (['gmail', 'google_calendar', 'stripe', 'github', 'webhook'] as const).map((kind) => [
      kind,
      Object.entries(triggersOf(kind)).map(([event, t]) => ({
        event,
        label: t.label,
        description: t.description,
        options: t.options ?? [],
      })),
    ]),
  )

/** The operations a teammate may see for a grant: reads always, writes only with read_write. */
export function operationSpecs(kind: ConnectorDefinition['kind'], scope: 'read' | 'read_write') {
  const connector = connectors[kind]
  if (!connector) return []
  return Object.entries(connector.operations)
    .filter(([, o]) => scope === 'read_write' || !o.write)
    .map(([name, o]) => ({
      name,
      description: o.description,
      write: o.write,
      inputSchema: z.toJSONSchema(o.input, { io: 'input' }) as Record<string, unknown>,
      ...(o.files ? { filesField: o.files } : {}),
    }))
}

export type { ConnectorDefinition }
