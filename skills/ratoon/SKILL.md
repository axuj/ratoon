---
name: ratoon
description: Work on several tasks at once in parallel git worktrees, or land a task as exactly one commit. Use when a second task starts while another is in progress, when several agents or subagents work at once, when a task must be isolated from the main working tree, or when a branch's draft commits need squashing into one, or when the work must land on a branch other than the one checked out. Start a slot before editing; commit only in that slot; never run finish without explicit approval. Commands are ratoon init, start, list, finish, abandon.
---

# ratoon

## Before anything

1. `ratoon start <task>` first. Every edit, commit and test happens inside that slot — never in the
   repository's own working tree.
2. Draft commits are notes for the user, not a changelog: short, in the user's language, as often
   as you like. `wip`, `try this`, `ok that was dumb`, `拆了下 skill，门控挪前面了`,
   `框和警告删了，进度交给 commit`. Not `wip: add plugin command support`. They are squashed away
   and never reach the base.
3. Never run `finish` (or delegate it) until the user explicitly says to. Show the changes first
   and leave the task checked out in its slot until then.

## Workflow

1. `ratoon start <task>` claims a free slot, creates `feature/<task>` from the base commit, and runs
   the hooks. It prints the slot path: edit, commit and test there.
2. Commit in the slot as often as you like, with the throwaway messages above.
3. Show the user what changed and **wait for explicit approval**. When `taskNotes()` is enabled,
   show the handoff sheet too, and put anything under `## Left open` in front of the user before
   asking.
4. `ratoon finish <task> -m "<message>"` squashes, rebases onto the target, fast-forwards, and parks
   the slot. The `-m` text is the landing commit, verbatim — this one is written for people. The
   target is the branch checked out in the main worktree; `--into <branch>` lands elsewhere and
   leaves that worktree untouched.
5. `ratoon abandon <task>` throws the work away and parks the slot.

`ratoon list` shows the pool. `ratoon task list` shows where each active task's handoff sheet is;
it comes from `taskNotes()`, which `init` enables in `.ratoon/hooks.ts` by default.
`ratoon <command> --help` is the reference for flags.

## The tool in one paragraph

ratoon gives each task a slot — a worktree in a gitignored pool — and lands it as one commit.
Install with `npm i -g ratoon` (Node >= 26). `ratoon start` works in any git repository with no
setup; `ratoon init` is optional and only writes the hook toolbox (`.ratoon/hooks.ts`, `types.ts`,
starter plugins). Every command works from the repository, any subdirectory or inside a slot. The
default pool is `<repo>/.ratoon/worktrees/`; git config `ratoon.poolPath` can move it. Read the
actual path from `ratoon list` or from `start` output instead of assuming it.

## Rules that are easy to miss

- One task per slot. The task name *is* the branch, so two agents cannot use the same name.
- A change is not landed until `finish` succeeds.

## Read these when you need them

- `references/stacking.md` — starting one task from another (`--base`), and which one to land first.
- `references/landing-targets.md` — landing on another branch with `finish --into <branch>`, and its
  two git limits.
- `references/git-and-pool.md` — `.gitignore`, `poolPath`, sharing hook files, hooks are read from
  the main working tree, scope tools off `.ratoon/`, dirty trees, conflict pause and exit 2.
- `references/handoff-sheet.md` — how to write `TASK.md`, and what to read when a subagent takes over.
- `references/subagents.md` — what to tell a subagent with an isolated context.
- Writing a plugin — read the files `ratoon init` wrote: `.ratoon/types.ts` is the contract,
  `.ratoon/hooks.ts` is the `Plugin[]` to edit, `.ratoon/plugins/` holds editable examples.
