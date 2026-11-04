/**
 * A shell command as a step's line says it: what it does, not how. Its first command only (no
 * `|| …` fallback, `&& …` follow-up or `; …`), past a leading `cd`, without redirections
 * (`2>/dev/null`, `2>&1`), and each path by its last part: `cat /var/lib/brigade/library/…/
 * threads/x.md 2>/dev/null || find …` reads `cat x.md`. The whole command stays in the step's
 * details.
 */
export function commandSummary(command: string): string {
  const parts = command
    .split(/\s*(?:\|\||&&|;|\n)\s*/)
    .map((p) => p.trim())
    .filter(Boolean)
  const first = parts.find((p) => !/^cd\s/.test(p)) ?? parts[0] ?? ''
  const words = first
    .split(/\s+/)
    .filter((w) => !/^\d*[<>]{1,2}&?\S*$/.test(w))
    .map((w) => {
      if (/^[a-z]+:\/\//i.test(w)) return w
      const quoted = w.match(/^(['"]?)(.*?)\1$/)
      const bare = quoted ? quoted[2]! : w
      return bare.includes('/') ? bare.replace(/\/+$/, '').split('/').pop() || bare : w
    })
  const said = words.join(' ')
  return said.length > 120 ? said.slice(0, 120) : said
}
