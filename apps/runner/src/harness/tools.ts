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
