// Commands a person starts a message with, to say what they want back:
// `/design a pricing page`, `/visual compare the two flows`, `/image a hero photo`. A command is a
// verb (what to make), where a mention (`@`) names a thing. The message keeps
// the command as written, so the thread shows it as a label; the teammate reads
// it in words (`commandPrompt`), as harnesses take a leading `/` for their own
// commands. A workspace skill is a command too: `/release-notes for 2.4`.

export const MESSAGE_COMMANDS = {
  visual: {
    label: 'Visual',
    description: 'Drawn in the thread: variants, a diagram, a chart. Not kept.',
    ask: 'The person asked for a visual (/visual): draw it in your reply with show_widget, not as a design.',
  },
  design: {
    label: 'Design',
    description: 'Kept in the library, on a canvas people edit and comment on.',
    ask: 'The person asked for a design (/design): make it as a design and save it to the library with save_design, not as a visual in your reply.',
  },
  image: {
    label: 'Image',
    description: 'Made by Codex’s image model, on your Codex account.',
    ask: 'The person asked for an image (/image): make it with your image generation tool (generate_image, or your own image tool on Codex). The thread shows the image by itself: say what you made, without linking or embedding its file.',
    /** Shown only to someone with a Codex account: it makes the images. */
    needs: 'codex',
  },
} as const satisfies Record<
  string,
  { label: string; description: string; ask: string; needs?: 'codex' }
>

export type MessageCommand = keyof typeof MESSAGE_COMMANDS

const COMMAND = /^\/([a-z]+)(?=\s|$)[ \t]*/

/** The command a message starts with, and the rest of it. */
export function messageCommand(text: string): { command: MessageCommand; rest: string } | null {
  const m = COMMAND.exec(text)
  if (!m || !(m[1]! in MESSAGE_COMMANDS)) return null
  return { command: m[1] as MessageCommand, rest: text.slice(m[0].length).replace(/^\n+/, '') }
}

const SKILL_COMMAND = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)[ \t]*/

/**
 * The workspace skill a message starts with (`/release-notes for 2.4`), when
 * one has that name. The commands above come first; no skill takes their names.
 */
export function skillCommand(
  text: string,
  skills: readonly string[],
): { skill: string; rest: string } | null {
  if (messageCommand(text)) return null
  const m = SKILL_COMMAND.exec(text)
  if (!m || !skills.includes(m[1]!)) return null
  return { skill: m[1]!, rest: text.slice(m[0].length).replace(/^\n+/, '') }
}

/** The message as the teammate reads it: its command or skill, if any, in words before the rest. */
export function commandPrompt(text: string, skills: readonly string[] = []) {
  const found = messageCommand(text)
  if (found) return [MESSAGE_COMMANDS[found.command].ask, found.rest].filter(Boolean).join('\n\n')
  const skill = skillCommand(text, skills)
  if (!skill) return text
  const ask = `The person asked for the skill ${skill.skill} (/${skill.skill}): read it and follow it.`
  return [ask, skill.rest].filter(Boolean).join('\n\n')
}
