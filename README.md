# ratoon

A worktree **slot pool** for git. Tasks run in pre-warmed worktrees, land as exactly one commit
each, and all the project-specific logic — install, build, notes — lives in one TypeScript file
outside every worktree.

The name is the agronomic one: after a harvest the *ratoon* (regrowth) springs from the same root
system, which is exactly what a slot does. It keeps `node_modules` and a warm checkout alive
between tasks, so the next `start` is a branch switch instead of a cold clone.

```
ratoon init                      scaffold a container in an empty directory
ratoon start <task>              claim a slot, create the branch, run the hooks
ratoon finish <task> -m <title>  squash the task into one commit, park the slot
ratoon abandon <task>            throw the work away, keep the slot
ratoon list                      show the pool
```

## Why

- **Warm by default.** A slot is a real worktree that survives `finish`. Whatever the last task
  installed or built is still there when the next one starts.
- **One task, one commit.** `finish` squashes the branch and lands your `-m` verbatim; the drafts
  you committed along the way never reach the base. Undoing a task is `git revert <sha>`.
- **Hooks outside the worktree.** `<root>/.ratoon/hooks.ts` is shared by every slot and every
  branch, copied in by `init`, typechecked by `tsc`, executed by Node's type stripping.
- **No remote, no surprises.** A slot manager should not fetch, pull or push. Local `<base>` is the
  single source of truth; moving it is your call.

## Quick start

```bash
npm i -g .                 # from a checkout; Node >= 26
mkdir my-wt && cd my-wt
ratoon init                # writes the container, installs nothing
# move or clone the repository you want to work on under my-wt/
ratoon start add-banner
```

`init` writes a container:

```
my-wt/
├─ package.json         # typescript + @types/node only — for `npm run typecheck`
├─ tsconfig.json        # includes .ratoon/** so the hooks are typechecked
├─ AGENTS.md            # the workflow rules, for whoever works in a slot
├─ .ratoon/hooks.ts     # the one file with all project-specific logic
├─ .ratoon/plugins/     # starter plugins — copied in, not enabled
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
nub run demo        # throwaway container in ./wt-demo
nub run typecheck   # tsc --noEmit
nub run lint        # eslint
nub run test        # unit + real-git end-to-end suites
```

## License

MIT
