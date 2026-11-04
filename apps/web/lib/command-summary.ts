/**
 * A shell command as a step's line says it: what it does, not how. Its first command only (no
 * `|| …` fallback, `&& …` follow-up or `; …`), past a leading `cd`, without redirections
 * (`2>/dev/null`, `2>&1`, `> out.txt`), and a file's path by its last part: `cat /var/lib/brigade/
 * library/…/threads/x.md 2>/dev/null || find …` reads `cat x.md`. Only a path is shortened: one
 * from the root or home, or deep in a folder to a file (`apps/web/lib/x.ts` reads `x.ts`); a
 * quoted pattern, a package (`@brigade/web`), a short folder (`apps/web`), a ref (`origin/main:x`)
 * or a URL stay whole. The whole command stays in the step's details.
 */
export function commandSummary(command: string): string {
  const commands: string[][] = [[]]
  for (const word of shellWords(command)) {
    if (SEPARATOR.test(word)) commands.push([])
    else commands.at(-1)!.push(word)
  }
  const nonEmpty = commands.filter((words) => words.length > 0)
  const first = nonEmpty.find((words) => words[0] !== 'cd') ?? nonEmpty[0] ?? []
  const shown: string[] = []
  for (let i = 0; i < first.length; i++) {
    const word = first[i]!
    // A redirection on its own (`>`, `2>>`) goes with its target; `2>/dev/null`, `2>&1` alone.
    if (REDIRECT_ALONE.test(word)) {
      i++
      continue
    }
    if (REDIRECT.test(word)) continue
    shown.push(shortPath(word))
  }
  const said = shown.join(' ')
  return said.length > 120 ? said.slice(0, 120) : said
}

/** `&&`, `||`, `;` and line breaks part one command from the next; a pipe does not. */
const SEPARATOR = /^(?:&&|\|\||;|\n)$/
/** A redirection's operator (`>`, `2>>`, `>&`, `&>`, `<<`), alone or with its target. */
const OPERATOR = String.raw`\d*(?:[<>]{1,2}&?|&>{1,2})`
const REDIRECT_ALONE = new RegExp(`^${OPERATOR}$`)
const REDIRECT = new RegExp(`^${OPERATOR}\\S+$`)

/**
 * A command's words, quotes kept as written (`rg "a b" x` is three), its redirections (each with
 * the target written against it: `2>&1`, `2>/dev/null`) and its separators.
 */
function shellWords(command: string): string[] {
  const words = new RegExp(
    String.raw`&&|\|\||;|\n|${OPERATOR}[^\s;&|<>]*|(?:[^\s"';&|<>]+|"(?:\\.|[^"\\])*"|'[^']*')+|[&|<>]`,
    'g',
  )
  return command.match(words) ?? []
}

/** A path's last part, for a path only (see commandSummary); any other word as it is. */
function shortPath(word: string): string {
  if (/^["'@-]/.test(word) || /[:=]/.test(word)) return word
  const path = word.replace(/\/+$/, '')
  const parts = path.split('/')
  const last = parts.at(-1)
  if (!last || parts.length < 2) return word
  const rooted = path.startsWith('/') || path.startsWith('~/')
  const deepFile = parts.length >= 3 && /[.*]/.test(last)
  return rooted || deepFile ? last : word
}
