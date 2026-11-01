// The MCP server a teammate's access ask names, as the API's grant step finds it (decide.ts): by
// its App's id when the ask gives one (list_apps' app.server), whose url is then none to add
// (serverOnlyUrl); else by the URL the teammate gave, its App once someone has added it; with
// neither, the server added under the name it asked for.
type Server = { id: string; name: string | null; mcp: { url: string } | null }

/** The same MCP server however its URL was typed, as the API compares them. */
export const sameServer = (a: string, b: string) => {
  try {
    const [x, y] = [new URL(a.trim()), new URL(b.trim())]
    x.hash = ''
    y.hash = ''
    return x.href.replace(/\/$/, '') === y.href.replace(/\/$/, '')
  } catch {
    return false
  }
}

export function askedServer<A extends Server>(
  ask: { what: string; app: { kind: string; url?: string; server?: string } },
  apps: A[] | undefined,
) {
  if (ask.app.kind !== 'mcp') return {}
  const serverId = ask.app.server
  const serverUrl = serverId ? undefined : ask.app.url
  const server = serverId
    ? apps?.find((a) => a.mcp && a.id === serverId)
    : serverUrl
      ? apps?.find((a) => a.mcp && sameServer(a.mcp.url, serverUrl))
      : apps?.find((a) => a.mcp && a.name?.toLowerCase() === ask.what.trim().toLowerCase())
  return { serverId, serverUrl, server }
}
