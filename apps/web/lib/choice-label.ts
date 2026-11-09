/**
 * How a choice card shows an option's label. Teammates number them as in the widget above
 * ("2 · Calm", "B · Bold"): that mark goes in the row's badge and the rest is the name, so the
 * card and the widget say the same number. A label without one gets its place in the list.
 * The message a pick sends keeps the whole label (`choiceMessage`).
 */
export function choiceLabel(label: string, index: number): { mark: string; name: string } {
  const numbered = /^\s*([0-9]{1,2}|[A-Za-z])\s*[·.)]\s+(\S.*)$/s.exec(label)
  if (numbered) return { mark: numbered[1]!.toUpperCase(), name: numbered[2]!.trim() }
  return { mark: String(index + 1), name: label.trim() }
}
