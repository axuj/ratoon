# ratoon

[![npm](https://img.shields.io/npm/v/ratoon)](https://www.npmjs.com/package/ratoon)
[![ci](https://img.shields.io/github/actions/workflow/status/axuj/ratoon/ci.yml?branch=master)](https://github.com/axuj/ratoon/actions/workflows/ci.yml)

A worktree **slot pool** for git. Two tasks at once usually means two clones and two cold
installs — or a stash dance in one worktree. ratoon gives each task a slot instead: `finish`
lands it as exactly one commit, and the slot stays warm for the next task.

The name is the agronomic one: after a harvest the *ratoon* (regrowth) springs from the same root
system, which is exactly what a slot does.

```
ratoon init                      scaffold the container files in a directory
ratoon start <task>              claim a slot, create the branch, run the hooks
ratoon finish <task> -m <title>  squash the task into one commit, park the slot
ratoon abandon <task>            throw the work away, keep the slot
ratoon list                      show the pool
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
- **Hooks outside the worktree.** `<root>/.ratoon/hooks.ts` is shared by every slot and every
  branch, copied in by `init`, typechecked by `tsc`, executed by Node's type stripping.
- **No remote, no surprises.** A slot manager should not fetch, pull or push. Local `<base>` is the
  single source of truth; moving it is your call.

## Quick start

```bash
npm i -g ratoon            # Node >= 26
mkdir my-wt && cd my-wt
git clone <your-repo>      # or move an existing checkout here
ratoon init                # writes the container, leaves the repo alone
ratoon start add-banner
```

Every command also works from inside the repository or a slot — `ratoon list` in `my-wt/proj`
finds the container — so there is no need to `cd` back out to see the pool.

Task names are kebab-case (`add-banner`): the name *is* the branch (`feature/add-banner`), so it is
validated before any git command runs instead of failing inside git afterwards.

`init` writes a container:

```
my-wt/
├─ package.json         # typescript + @types/node only — for `npm run typecheck`
├─ tsconfig.json        # includes .ratoon/** so the hooks are typechecked
├─ AGENTS.md            # the workflow rules, for whoever works in a slot
├─ .ratoon/hooks.ts     # the one file with all project-specific logic
├─ .ratoon/plugins/     # starter plugins — taskNotes on, the rest opt-in
├─ .ratoon/types.ts     # Plugin / LifecycleHook / HookContext
├─ .ratoon/docs/        # workflows.md + plugins.md
└─ .gitignore           # node_modules/ .state/
```

The hooks are optional. Delete `.ratoon/hooks.ts` and the container is a plain slot pool:
allocate, branch, clean, squash, rebase, merge, park.

## What landing looks like

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

## Docs

- [`docs/workflows.md`](docs/workflows.md) — daily use, A/B experiments, conflicts, abandoning.
- [`docs/plugins.md`](docs/plugins.md) — the hook contract and the starter plugins.

Both are copied into `.ratoon/docs/` by `init`, so an agent in a slot reads them as ordinary
files. `ratoon --help` and `ratoon <command> --help` are always the current reference for flags and
commands.

## Development

```bash
npm i -g .         # or install this checkout
nub run demo        # throwaway container in ./wt-demo
nub run typecheck   # tsc --noEmit
nub run lint        # eslint
nub run test        # unit + real-git end-to-end suites
```

## License

MIT
