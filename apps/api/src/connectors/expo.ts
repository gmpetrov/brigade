import type { ConnectorDefinition } from './types.js'

/**
 * Expo's own MCP server: EAS builds, submissions, updates and workflows, build logs and crash
 * reports, and Expo's docs, as the person who signed in. It registers Brigade as a client itself
 * (dynamic client registration) and asks for its one scope, mcp:access. Its tools come from the
 * server: those it does not mark read-only count as writes. Searching the docs needs a paid
 * Expo plan; the tools that drive a local simulator need the project's own expo-mcp, which a
 * remote sign-in does not reach.
 */
export const expo: ConnectorDefinition = {
  kind: 'expo',
  label: 'Expo',
  auth: 'mcp',
  operations: {},
  mcp: {
    url: 'https://mcp.expo.dev/mcp',
    tools: {},
  },
}
