# Memory

What teammates know without being told: how the team wants work done, decisions,
pitfalls, who is who. Three memories load into a thread: the workspace's, its project's
and its teammate's own. Thread summaries are memory too, but only search finds them.

Memory used to be a flat list of lines loaded whole into every session. It grew by about
90 lines a day, the instructions file kept the first 16,000 characters of each memory (the
oldest lines), and the memory run could see only the first 20,000, so corrections and
repeats piled up where nothing read them. Memory now has layers, dates and an archive.

## Decisions

- **Layers in the file people edit.** A memory stays one Markdown file, edited in the
  same live editor. The lines before its first `## ` heading are its core; each `## `
  section is a topic, and a paragraph under its heading says when to read it. No table of
  topics: people move a line by moving it, and rename a topic by renaming its heading.
- **The core loads, topics are read.** A thread's instructions file holds each memory's
  core (workspace 4,000 characters, project 5,000, teammate 3,000) and a list of its
  topics: name, description, size, newest line, and the path of the topic's file, which
  the runner writes beside it (`.brigade-memory/`). The teammate reads a topic before
  work it bears on, as it reads a skill. What every thread loads stays the size of the
  cores however much the team learns, and it works in every language, since the model
  picks the topics. The per-turn recall by keywords (BM25) is gone: memory written in
  English and messages in French rarely shared words, and it brought lines picked on
  words like "files" or "chose".
- **Every line is dated.** A `MemoryLine` row per line, kept by its text (any bullet, case
  or spacing): when it was learned or last confirmed, in which thread, and whether a
  person wrote it. Lines show their date to the teammate ("(19 Oct)", "(19 Oct, by Ada)",
  "(before 21 Oct)" for lines older than dates in memory). The rule: the newer line wins,
  a person's line outranks one a teammate learned, and a line about code, an account or a
  provider is checked before relying on it.
- **Writing is reconciling.** The memory run reads each file it may change whole, its
  lines numbered and dated, and answers per file with new lines and their topic, lines it
  corrects (`replace`: the new text takes the old one's place), lines to archive with
  why, and lines the conversation showed still true (`confirm`: their date moves to
  today). The runner turns numbers back into the lines' text, which is how the API finds
  them, so edits that cross never apply to the wrong line.
- **Verified where it is used.** No run audits the code for memory's sake: the teammate
  with the repository open checks a line before relying on it and says in its reply when
  one is wrong; the memory run then replaces or archives it, and confirms the lines that
  held.
- **Tidy runs keep the file in shape.** When a core is past its budget, a file past 40,000
  characters, a file never tidied reaches 30 lines, or a week after the last tidy once
  lines changed, a run lays the file out again: the core, topics with descriptions,
  repeats merged (keeping the newest date of their lines), and what a newer line replaced
  or what is outdated archived. It runs beside the thread, never in its queue, at most
  once in six hours per file, and a layout that would take away more than 40 % of the
  file (60 % for a file too long) is not applied. A line the layout does not name stays
  where it was.
- **Nothing is lost.** Lines leave a file for the archive, with why, when, by whom and the
  thread they were learned in. Teammates no longer load them; search finds them, and the
  dashboard puts one back under its topic. A line a person takes out minutes after
  writing it was a draft and leaves no trace.
- **Skills stay separate.** A cluster of lessons that reads like a procedure is not turned
  into a skill by the tidy run: topics already load on demand, and each skill needs an
  admin's approval, which would make tickets nobody asked for.
- **Cost.** One-off runs (memory, tidy, titles) use Claude Code's 5-minute prompt cache:
  their prompt is read once, and the one-hour cache writes it at twice the input price.

## Where it is

- Format, edits and layouts: `packages/contracts/src/memory.ts`.
- Lines' rows and the archive: `apps/api/src/memory-edit.ts`, `apps/api/src/library.ts`
  (`changeMemory`, `editMemory`, `tidyMemory`, `restoreMemoryLine`).
- Loading: `apps/runner/src/memory-layers.ts`, `apps/runner/src/instructions.ts`.
- Memory and tidy runs: `apps/runner/src/memory.ts`, `apps/runner/src/memory-tidy.ts`.
- Dashboard: `apps/web/components/memory-card.tsx`.
