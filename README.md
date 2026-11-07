# ratoon

[![npm](https://img.shields.io/npm/v/ratoon)](https://www.npmjs.com/package/ratoon)
[![ci](https://img.shields.io/github/actions/workflow/status/axuj/ratoon/ci.yml?branch=master)](https://github.com/axuj/ratoon/actions/workflows/ci.yml)

A worktree **slot pool** for git. Two tasks at once usually means two clones and two cold
installs — or a stash dance in one worktree. ratoon gives each task a slot instead: a worktree in
an ignored `.ratoon/worktrees/` pool, landed as exactly one commit, kept warm for the next task.

The name is the agronomic one: after a harvest the *ratoon* (regrowth) springs from the same root
system, which is exactly what a slot does.

```
ratoon start <task>               claim a slot, create the branch, run the hooks
ratoon start <task> --base <ref>  start from another task's commit, not the base branch
ratoon finish <task> -m <title>   squash the task into one commit, park the slot
ratoon abandon <task>             throw the work away, keep the slot
ratoon list                       show the pool
ratoon init                       optional: generate the hook toolbox
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

```bash
npm i -g ratoon                            # Node >= 26
npx skills add axuj/ratoon --skill ratoon  # give your agent the workflow rules
cd your-repo
ratoon start add-banner                    # prints the slot path — edit, commit and test there
```

`start` works in any git repository with no setup. The first run adds `.ratoon/*` to `.gitignore`
— commit that line. `ratoon init` is optional: it generates the hook toolbox (`.ratoon/hooks.ts`,
`types.ts` and starter plugins) for projects that want lifecycle plugins.

`.ratoon/` is local state, not project content. `start` writes the single rule `.ratoon/*`, which
also leaves room for exceptions: add `!.ratoon/hooks.ts` (or `!.ratoon/plugins/`) when a team should
share them.

Every command also works from inside the repository or a slot — `ratoon list` in `your-repo/src`
finds the pool — so there is no need to `cd` back out to see it.

Task names are kebab-case (`add-banner`): the name *is* the branch (`feature/add-banner`), so it is
validated before any git command runs instead of failing inside git afterwards.

The pool lives at `.ratoon/worktrees/` and is created by the first `start`. Running `ratoon init`
fills in the optional toolbox in the same directory:

```
your-repo/
├─ .ratoon/
│  ├─ hooks.ts          # the one file with all project-specific logic
│  ├─ plugins/          # starter plugins — taskNotes on, the rest opt-in
│  ├─ types.ts          # Plugin / LifecycleHook / HookContext
│  └─ worktrees/        # the pool — the .ratoon/* rule keeps it out of git
│     ├─ slot-0/ …      # worktrees
│     └─ .state/<slot>/ # TASK.md handoff sheet, claims, install fingerprints
└─ ... the project's own package.json and tsconfig, untouched
```

One repository, one pool, at a fixed path — every command finds it through git, from the
repository, a subdirectory or a slot, with no flags. The only file outside `.ratoon/` that ratoon
ever touches is one line of `.gitignore`, so the project still looks like a normal project;
`git status` and `git add -A` never see the slots.

`.ratoon/` holds the worktree checkouts and notes next to a few small config files, so never copy,
archive or cache the directory as a whole — copy the individual files. Do not run `git clean -fdx`
in the main worktree: it deletes everything in `.ratoon/` except the slots themselves — the hook
toolbox, the notes and the install fingerprints — and `start` then runs with no hooks. `ratoon init`
rebuilds the toolbox, but the notes are gone.

The hooks are optional. Delete `.ratoon/hooks.ts` and the repository is a plain worktree pool:
allocate, branch, clean, squash, rebase, merge, park.

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

## Stacking one task on another

`--base` starts a task at another task's commit instead of the base branch:

```bash
ratoon start review --base feature/add-banner   # review starts where add-banner got to
```

It is a copy of that work in a new slot, not a link — the new branch carries the other task's
drafts, so landing it lands both. `--base` needs a committed checkpoint (uncommitted work in the
other slot is invisible), and it is a starting point and a rebase target, never a merge target:
`finish` still lands on the branch checked out in the main worktree. Which of the two to finish
first depends on whether both should land; the skill's *Building on another task* has the
decision.

## The skill

The workflow rules for agents live in the skill — the single source for them, so this README says
what ratoon does and the skill says how to work with it:

```bash
npx skills add axuj/ratoon --skill ratoon           # from GitHub, default branch
npx skills add axuj/ratoon@v0.2.0 --skill ratoon    # pinned to a release
```

The same `SKILL.md` ships in the npm tarball, so a project that already depends on ratoon can link
it from `node_modules` instead of fetching from GitHub:

```bash
npm i -D ratoon
npx skills experimental_sync -y                     # links node_modules/ratoon/skills/ratoon
```

`ratoon --help` and `ratoon <command> --help` are the reference for flags. The hook contract is
`.ratoon/types.ts` and the starter plugins are `.ratoon/plugins/*.ts` — `init` copies both into
your project, so the reference sits next to the code you edit.

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
