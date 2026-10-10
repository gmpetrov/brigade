import { z } from 'zod'
import type { ConnectorDefinition } from './types.js'
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
    }))
}

export type { ConnectorDefinition }
