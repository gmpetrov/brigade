// What Brigade turns off in Codex. It goes to Codex as the config each thread starts with
// (createCodex's codexConfig), above the member's own config.toml, which keeps the rest.

/**
 * Codex's own memory: memory is Brigade's (AGENTS.md's memory sections). It is off unless a
 * config turns it on (a member's own, on a Mac), and since Codex 0.165 a profile that never had
 * any starts on its second version. Not generating keeps a Codex with memory on elsewhere, on the
 * same login, from learning from Brigade's threads.
 */
export const CODEX_SETTINGS = {
  features: { memories: false },
  memories: { generate_memories: false, use_memories: false },
}
