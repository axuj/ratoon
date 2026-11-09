# The handoff sheet (`TASK.md`)

`finish` only after the user's approval — see SKILL.md, "Before anything".

With `ratoon init` in place, the starter `taskNotes()` plugin writes
`<pool>/.state/<slot>/TASK.md` at `start` — `start` prints the full path, so use that instead of
assuming the default pool location. It is a plain file the user can open without an agent session,
and the one surface a subagent with an isolated context can still reach. It holds Goal, Findings
and Left open. The next task in that slot overwrites it, so it describes the current task only.
Without the plugin there is no sheet — say what changed instead of pointing at a file that does not
exist.

The sheet is temporary: it is read when someone needs to pick the work up, not kept as a record.
Progress lives in the slot's draft commits — read `git log --oneline` there. Write in the user's
language, the way you would say it out loud.

- `## Goal` is one line: what this task is for.
- `## Findings` is what git cannot record: where you are stuck, the next step, what you tried and
  dropped, what not to retry, what is still unverified. **Not a changelog — no "added X", no file
  names.** One line per item: no code blocks, no test output, no timestamps. A sheet longer than a
  screen is one the reviewer skips.
- `## Left open` is for decisions the user has to make. Before asking for approval, paste the sheet
  to the user and resolve whatever is in there; it should be empty by `finish`.
- The sheet does not land in git: `finish` leaves it behind and the next task overwrites it. Anything
  that must outlive the task belongs in a code comment or the project's docs, never here.
- It lives outside the worktree, so it can never be committed or counted as dirt — keep it there.
