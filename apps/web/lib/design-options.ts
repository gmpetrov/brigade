// Switching between the options offered for a design, in its panel.

/**
 * The option the left (-1) or right (1) arrow goes to, wrapping around; from
 * all of them side by side (`current` null), the first or the last.
 */
export function stepOption(options: string[], current: string | null, step: 1 | -1) {
  if (options.length === 0) return undefined
  // Not in the set any more: as from all of them.
  const at = current === null ? -1 : options.indexOf(current)
  if (at < 0) return step > 0 ? options[0] : options.at(-1)
  return options[(at + step + options.length) % options.length]
}
