// What an MCP tool's result gives a teammate. Servers mostly send their result as
// text holding JSON (often JSON of a JSON string); passed on as text, it reached
// the teammate escaped twice over. JSON text comes back as the value it holds.

type ToolResult = {
  content?: { type: string; text?: string }[]
  structuredContent?: unknown
  isError?: boolean
}

/** A text that is JSON, as its value (a JSON string of JSON, unwrapped too); else the text. */
export function parsedText(text: string): unknown {
  let value: unknown = text
  for (let i = 0; i < 2 && typeof value === 'string'; i++) {
    const trimmed = value.trim()
    if (!/^[[{"]/.test(trimmed)) break
    try {
      value = JSON.parse(trimmed)
    } catch {
      break
    }
  }
  return value
}

/**
 * A tool result as the teammate's output: its structured content when the server
 * sends one, else its one text block's value, else every block's text together.
 * An error result's text is thrown by the caller.
 */
export function mcpOutput(result: ToolResult): { output: unknown; text: string } {
  const blocks = result.content ?? []
  const text = blocks.map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n')
  if (result.structuredContent !== undefined) return { output: result.structuredContent, text }
  if (blocks.length === 1 && blocks[0]!.type === 'text') return { output: parsedText(text), text }
  return { output: text, text }
}
