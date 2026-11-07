---
name: ratoon
description: Work on several tasks at once in parallel git worktrees, or land a task as exactly one commit. Use when a second task starts while another is in progress, when several agents or subagents work at once, when a task must be isolated from the main working tree, or when a branch's draft commits need squashing into one. Commands are ratoon init, start, list, finish, abandon.
---

# ratoon

ratoon gives each task a slot — a worktree in the gitignored `.ratoon/worktrees/` pool — and lands
it as one commit. Install the CLI with `npm i -g ratoon` (Node >= 26). `ratoon start` works in any
git repository with no setup: the first run adds `.ratoon/*` to `.gitignore` (commit that line) and
creates the pool. `ratoon init` is optional — it only generates the hook toolbox
(`.ratoon/hooks.ts`, `types.ts`, starter plugins), so run it when the project wants lifecycle
plugins such as task notes. Every command works from the repository, any subdirectory, or inside a
slot — no flags needed; the pool is always `<repo>/.ratoon/worktrees/`.

## Workflow

1. `ratoon start <task>` claims a free slot, creates `feature/<task>` from the base commit, and runs
   the hooks. It prints the slot path: edit, commit and test there.
2. Commit inside the slot as often as you like. Those messages are drafts and never reach the base.
3. Show the user what changed and **wait for explicit approval** before landing. When `taskNotes()`
   is enabled, the handoff sheet is what you show.
4. `ratoon finish <task> -m "<message>"` squashes, rebases onto the base, fast-forwards, and parks
   the slot. The `-m` text is the landing commit, verbatim.
5. `ratoon abandon <task>` throws the work away and parks the slot.

`ratoon list` shows the pool. `ratoon <command> --help` is the reference for flags.

## Building on another task

`start B --base feature/A` checks out A's current commit as B's starting point — a copy of A's
work in a new slot. B's branch contains A's drafts, so `finish B` lands the whole tree, not just
B's own changes. `--base` needs a committed checkpoint; uncommitted work in A is not visible.

- Only B should survive → finish B, then `abandon A`. The landing commit contains A + B.
- Both should land as separate commits → **finish A first**; B rebases onto the new main
  automatically. Landing B first puts A's work under B's commit and leaves nothing for A to land.
- Two independent directions → start both from the main branch, do not base one on the other.

`finish` lands on the main worktree's checked-out branch (usually `master`); `--base` is a
starting point and a rebase target, never a merge target.

## Rules

- **Land only when the user asks.** Never run `finish` on your own initiative, and never delegate
  it to a subagent. Leave the task checked out in its slot until approval.
- One task per slot. The task name *is* the branch, so two agents cannot use the same task name.
- Commit in the slot, never in the repository's own working tree.
- Never leave dirt: `finish` refuses a dirty tree and the next `start` runs `git clean -fd`.
  Untracked files count unless gitignored.
- Anything that is not repo content — notes, logs, locks — belongs in
  `.ratoon/worktrees/.state/<slot>/`, never in a worktree. Do not run `git clean -fdx` in the main
  worktree: it wipes `.ratoon/` — the hook toolbox, the notes and the install fingerprints — while
  the slots themselves survive, so `start` keeps working with no hooks until `ratoon init` runs
  again.
- Hooks are read from the main working tree, never from the slot — even when the team commits
  `.ratoon/hooks.ts` and a copy shows up in the checkout. Edit it in the main working tree; the
  change takes effect on the next `start`.
- A conflict pauses `finish` with exit 2. Edit the named files, remove the `<<<<<<<` markers, then
  run the *same command again* — it stages the files and completes the rebase.
- A change is not landed until `finish` succeeds.

## Git

`.ratoon/` is local state, not project content: `start` keeps it out of git with the single
`.ratoon/*` rule in `.gitignore`. Never `git add` the pool or the state on your own; the config files
stay local too unless the team whitelisted them.

A team can share individual files by whitelisting them. The rule has to be `.ratoon/*` for that to
work: with plain `.ratoon/`, git never descends into the directory and every `!` exception below it
is ignored.

```
.ratoon/*
!.ratoon/hooks.ts            # share the workflow config
!.ratoon/plugins/            # share the whole plugin folder, including your own
!.ratoon/plugins/ai.ts       # or just one plugin
```

Share `hooks.ts` and the plugins you wrote or edited. `types.ts` and the starter plugins are copies
of the ratoon version that ran `init`; they can be shared too, but expect a diff on every upgrade.

## The handoff sheet (`TASK.md`)

With `ratoon init` in place, the starter `taskNotes()` plugin writes
`.ratoon/worktrees/.state/<slot>/TASK.md` at `start`. It is a plain file the user can open without
an agent session, and the one surface a subagent with an isolated context can still reach. It holds
Plan (checkboxes), Findings and Left open. The next task in that slot overwrites it, so it describes
the current task only. Without the plugin there is no sheet — say what changed instead of pointing
at a file that does not exist.

It is not your working memory: your own task list covers that. The sheet is read once, at approval,
so write for the person deciding whether to land the work.

- Replace the placeholder box with real steps before starting, and change `[ ]` to `[x]` as each one
  finishes.
- Write only what git cannot record. The diff already holds the changed files and the draft messages;
  the sheet is for the reasons — why an approach was dropped, what not to retry, what is still
  unverified. One line per item: no code blocks, no test output, no timestamps. A sheet longer than
  a screen is one the reviewer skips.
- The sheet does not land in git: `finish` leaves it behind and the next task overwrites it. Anything
  that must outlive the task — a pitfall in an API, a decision the code depends on — belongs in a
  code comment or the project's own docs, never here.
- An open box makes `onFinish` warn at `finish`. Before asking for approval, paste the sheet to the
  user and resolve whatever is still open.
- It lives outside the worktree, so it can never be committed or counted as dirt — keep it there.

## Dispatching subagents

Give each subagent its slot path, the task name, and these lines: commit only in that slot, keep
notes and logs in `.state/<slot>/`, never commit in the main working tree, never run `finish`.
Subagents have isolated contexts and their in-session task lists cannot be read from outside;
progress that the user must see belongs in the handoff sheet, or in what you report back.
