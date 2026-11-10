# ratoon

[![npm](https://img.shields.io/npm/v/ratoon)](https://www.npmjs.com/package/ratoon)
[![ci](https://img.shields.io/github/actions/workflow/status/axuj/ratoon/ci.yml?branch=master)](https://github.com/axuj/ratoon/actions/workflows/ci.yml)

A worktree **slot pool** for git. Two tasks at once usually means two clones and two cold
installs — or a stash dance in one worktree. ratoon gives each task a slot instead: a worktree in
an ignored `.ratoon/worktrees/` pool, landed as exactly one commit, kept warm for the next task.

The name is the agronomic one: after a harvest the *ratoon* (regrowth) springs from the same root
system, which is exactly what a slot does.

```
ratoon start <task>                 claim a slot, create the branch, run the hooks
ratoon start <task> --base <ref>    start from another task's commit, not the base branch
ratoon finish <task> -m <title>     squash the task into one commit, park the slot
ratoon finish <task> --into <branch> land on another branch, leaving the main worktree alone
ratoon abandon <task>               throw the work away, keep the slot
ratoon list                         show the pool
ratoon task list                    show every slot's handoff sheet (taskNotes, on by default)
ratoon init                         optional: generate the hook toolbox
```

## Why

- **A pool, not a pile of clones.** With plain worktrees you pick the directory, name the branch,
  and remember which one is free. Here the pool tracks that, and `finish` parks the slot instead of
  deleting it — the next `start` switches branches in the same warm worktree.
- **One task, one commit.** Commit inside the slot as often as you like — `wip`, `try this`,
  `ok that was dumb` — `finish` squashes them all and lands your `-m` verbatim. Nothing else
  reaches the base, and undoing a task is `git revert <sha>`.
- **Parallel by construction.** A slot is a directory plus one claim file, so several tasks — or
  several agents — start at once instead of queueing; `finish` lands them one at a time.
- **Hooks are read from the project, never from the slot.** `.ratoon/hooks.ts` carries the install
  and build steps every task needs, and the engine always reads it from the main working tree — so
  an edit there takes effect on the next `start`, even when a slot has an older copy checked out.
  Commit it (and the plugins you wrote) when a team should share it; a `<pool>/hooks.ts` adds
  plugins for one pool only.
- **No remote, no surprises.** It never fetches, pulls or pushes: the base ref is local, and moving
  it is your call.

## Quick start

**For an agent** — the workflow rules live in the skill, not in `--help`:

```bash
npx skills add axuj/ratoon --skill ratoon           # default branch
npx skills add axuj/ratoon@v0.2.1 --skill ratoon    # same version as your CLI
```

Already depend on ratoon in the project? The same `SKILL.md` ships in the npm tarball, so
`npx skills experimental_sync -y` links it from `node_modules` instead of fetching from GitHub.

**Everyone** — the CLI, then a first task:

```bash
npm i -g ratoon                            # Node >= 26
cd your-repo
ratoon start add-banner                    # prints the slot path — edit, commit and test there
```

`start` works in any git repository with no setup. The first run adds `.ratoon/*` to `.gitignore`
— commit that line.

`ratoon init` is optional: it writes the hook toolbox (`.ratoon/hooks.ts`, `types.ts` and the
starter plugins). Two starters are the reason to run it: `taskNotes()` — on by default — writes a
short `TASK.md` handoff sheet under the pool's `.state/`, for whoever picks the slot up next, and
provides `ratoon task list`, which renders the same pool table as `ratoon list` with a `NOTES`
column added. `npmInstall()` — opt in by
adding it to the array — installs dependencies in a cold slot and skips a warm one. Progress
lives in the slot's draft commits, not the sheet. `types.ts` is the hook contract;
`ratoon <command> --help` is the reference for flags.

It also gives those files an editor project of their own — `.ratoon/tsconfig.json` and a private
`.ratoon/package.json` — because a project tsconfig does not collect dot-directories, so an editor
would otherwise open the hooks in an inferred project without `node:fs`. The config names
`@types/node`; `init` installs nothing, so the editor reports TS2688 there until you run
`cd .ratoon && npm i`. Nothing at runtime needs it — Node only strips the types — so install when
you start writing plugins and want completions. That manifest is for editor types alone; whatever
a hook imports at runtime belongs in the project's dependencies.

The Node >= 26 floor comes from those hooks: they are `.ts` files the CLI imports directly, and Node
runs them by stripping the types as it loads — no build step, no `ts-node`, no loader to configure.

`.ratoon/` is local state, not project content. While the pool sits inside it, one rule —
`.ratoon/*` — keeps it out of git, and the glob leaves room for exceptions: add `!.ratoon/hooks.ts`
(or `!.ratoon/plugins/`) when a team should share them.

Every command also works from inside the repository or a slot — `ratoon list` in `your-repo/src`
finds the pool — so there is no need to `cd` back out to see it.

Task names are kebab-case (`add-banner`): the name *is* the branch (`feature/add-banner`), so it is
validated before any git command runs instead of failing inside git afterwards.

By default the pool lives at `.ratoon/worktrees/` and is created by the first `start`. Running
`ratoon init` fills in the optional toolbox in the same directory:

```
your-repo/
├─ .ratoon/
│  ├─ hooks.ts          # the one file with all project-specific logic
│  ├─ plugins/          # starter plugins — taskNotes on, the rest opt-in
│  ├─ types.ts          # Plugin / LifecycleHook / HookContext
│  ├─ tsconfig.json     # the toolbox as its own editor project
│  ├─ package.json      # private manifest, for @types/node if you install it
│  └─ worktrees/        # the default pool — the .ratoon/* rule keeps it out of git
│     ├─ slot-0/ …      # worktrees
│     └─ .state/<slot>/ # TASK.md handoff sheet, claims, install fingerprints
└─ ... the project's own package.json and tsconfig, untouched
```

One repository, one pool — every command finds it through git, from the repository, a subdirectory
or a slot, with no flags. The only file outside `.ratoon/` that ratoon ever touches is one line of
`.gitignore`, so the project still looks like a normal project; `git status` and `git add -A` never
see the slots.

`.ratoon/` holds the worktree checkouts and notes next to a few small config files, so never copy,
archive or cache the directory as a whole — copy the individual files. Do not run `git clean -fdx`
in the main worktree: it deletes everything in `.ratoon/` except the slots themselves — the hook
toolbox, the notes and the install fingerprints — and `start` then runs with no hooks. `ratoon init`
rebuilds the toolbox, but the notes are gone.

The `.gitignore` rule keeps a pool inside the project out of git, and out of nothing else. Anything
that walks the repository — a test runner, `tsc`, an IDE index, a plain `grep -r` — sees every busy
slot as an ordinary directory holding a full copy of the project, possibly on another branch. Scope
those tools off `.ratoon/`; this repository does it with one `exclude` entry in `vitest.config.ts`.

To keep the checkouts out of the project tree altogether, name a base directory instead:

```bash
git config --local  ratoon.poolPath D:/worktree   # one repository
git config --global ratoon.poolPath D:/worktree   # every repository on this machine
```

Each repository lands under its own mirrored path — `D:/code/app` becomes `D:/worktree/d/code/app`,
`C:/Users/you/proj` becomes `D:/worktree/c/Users/you/proj` — so a single base serves every project
without two of them sharing slots. Slots and their `.state/` move together; hooks and starter
plugins stay in `.ratoon/`.

The key is read through git (local over global), so a slot finds its pool without a flag, and
`ratoon list` prints the path and the config file that set it. An external pool leaves nothing to
ignore, so `start` writes no `.gitignore` line. `start` refuses to build a second pool while git
still has worktree bindings in another one, and refuses a base that would land the pool inside the
project but outside `.ratoon/`.

The hooks are optional. Delete `.ratoon/hooks.ts` and the repository is a plain worktree pool:
allocate, branch, clean, squash, rebase, merge, park.

## Plugin commands

A plugin can add commands to the CLI. `Plugin.commands(ctx)` returns a table of command names —
each entry may carry `args`, nested `subCommands` and a `run(ctx)`, and the factory may be async.
A command declares only the flags it reads; `run` receives the parsed args plus a read-only snapshot
of the pool (`rootDir`, `mainDir`, `slots`) and `renderPool(columns)`. `renderPool` prints the pool
in exactly the shape `ratoon list` uses — the pool header, one row per slot (busy, free and unknown
alike), the status labels and the summary — and each column appends one cell. A plugin therefore
needs no dependency on ratoon's own packages and cannot drift from the engine's table. The starter
`taskNotes()` uses it for `ratoon task list`, adding one `NOTES` column with every slot's sheet
path; a parked slot's leftover sheet is marked `(last task)`. The filename comes from the plugin's
own `file` option, so the command follows a custom name too.

Commands are discovered by loading `.ratoon/hooks.ts` and `<pool>/hooks.ts`. The engine does that
only for `--help`, an unknown command, or a name the plugins own; `start`, `finish`, `abandon`,
`list` and `init` never load hooks for discovery. Help and usage errors do, so keep side effects
out of a hooks file's top level and put them in a command's `run`. A name already used by the
engine or an earlier plugin is skipped with a line on stderr, and a hooks file that fails to load
costs only its own commands — never the built-in ones.

`task list` needs no extra setup: `init` writes `taskNotes()` into `.ratoon/hooks.ts` by default, so
the command is there as soon as the toolbox exists. Remove `taskNotes()` from that array and the
command goes away with the sheet. `init` only writes missing files — a plugin source copied by an
older `init` has no `commands` field, so the command is missing even though the plugin is listed.
Delete `.ratoon/plugins/task-notes.ts` and run `init` again to take the current copy.

## What landing looks like

`finish` runs four steps — verify, run the finish hooks, land, park. The output starts at the last
two:

```
$ ratoon finish add-banner -m "feat(ui): add the banner"

[3/4] landing feature/add-banner on master

  commit  : feat(ui): add the banner
  squashed: 3 draft commits

[4/4] parking slot slot-0 (detached at master, worktree binding kept)
```

The message is an input, never derived: `finish` requires `-m` once the branch has commits and
lands it byte for byte. A branch with several commits collapses into that one commit; the branch's
own messages are discarded.

Parking leaves the slot detached at `master`: the branch is dropped, the worktree and its
`node_modules` stay.

## Landing somewhere else

`finish` lands on the branch the main worktree has checked out. `--into` names a different one:

```bash
ratoon finish port-dialog --into v2 -m "feat: port the dialog"
```

The task is squashed, rebased onto `v2`, and `v2` is fast-forwarded — while the main worktree keeps
its branch, its files and its uncommitted edits. Nothing is merged into the checked-out branch.

`--into` takes a local branch. A tag or `origin/v2` is refused rather than turned into a branch of
that name.

That is what makes a second long-lived line workable. `main` keeps shipping, `v2` keeps growing, and
a task lands on either without moving the main worktree between them — no stashing, no switching
back and forth, no second checkout to babysit. `--base` is the opposite direction (where a task
*starts*), and only `start` has it.

Two limits come from git, not from ratoon:

- **The target only moves forward.** The task is rebased onto the target before it lands, so the
  update is a fast-forward by construction. If something else landed on the target in between,
  `finish` pauses with exit 2 and the same command reconciles.
- **The target must not be checked out in another worktree.** Git will not move a branch a worktree
  has open. `finish` refuses before squashing anything and names that worktree.

## Stacking one task on another

`--base` starts a task at another task's commit instead of the base branch:

```bash
ratoon start review --base feature/add-banner   # review starts where add-banner got to
```

It is a copy of that work in a new slot, not a link — the new branch carries the other task's
drafts, so landing it lands both. `--base` needs a committed checkpoint: uncommitted work in the
other slot is invisible, and the flag only says where a branch *starts*. Which of the two to finish
first depends on whether both should land; the skill's *Building on another task* has the decision.

## Development

```bash
nub run demo        # throwaway repo in ./ratoon-demo, pool at ./ratoon-demo/.ratoon/worktrees
nub run typecheck   # tsc --noEmit
nub run lint        # eslint
nub run test        # unit + real-git end-to-end suites
```

`nub run demo` prints the commands to run inside the generated repo. They invoke this checkout's
`src/cli.ts` directly, so the demo works without installing ratoon globally. Install globally
(`npm i -g .`) only when you want the `ratoon` command on your PATH.

## License

[MIT](LICENSE)
