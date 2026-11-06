# ratoon plugins

All project-specific behaviour lives in `<root>/.ratoon/hooks.ts`, outside every worktree. The
engine itself knows nothing about installs, builds or notes.

```ts
import type { Plugin } from './types.ts'
import { npmInstall } from './plugins/npm-install.ts'
import { taskNotes } from './plugins/task-notes.ts'

export default [
  npmInstall(),
  taskNotes(),
  {
    name: 'build',
    onStart({ slotDir }) {
      // the process cwd is already slotDir
    },
  },
] satisfies Plugin[]
```

`hooks.ts` default-exports one **ordered array**. Array order is execution order, independently
for each lifecycle. Everything is a plugin — your own code included; there is no separate "host"
position. `init` enables `taskNotes()`; the other starter plugins under `./plugins/` are opt-in.

## Lifecycles

| lifecycle | when |
|---|---|
| `onBeforeCheckout` | `ratoon start` — the slot is claimed, but git has not touched it. It still holds the previous task's files. Read them, or clear anything that would block the checkout (for example a dev server holding the directory). On a brand-new slot the directory may not exist yet. |
| `onStart` | `ratoon start` — the branch is checked out and `git clean -fd` has run. |
| `onFinish` | `ratoon finish` — before the dirty check; the last chance to tidy up. Runs before any git state is touched, so a throwing plugin leaves the slot as it was. |

`start` and `finish` are separate processes. Each runs its own pass over the array:

```text
ratoon start : claim -> plugins[].onBeforeCheckout -> branch + clean -> plugins[].onStart
ratoon finish: locate + claim -> plugins[].onFinish -> dirty check -> squash + rebase + merge
```

## Context

Every callback receives facts only:

```ts
interface HookContext {
  rootDir: string // the container
  mainDir: string // the main repository
  slotDir: string // this task's worktree
  branch: string // feature/<task>
  task: string
  base: string
}
```

- Inside a callback the process cwd **is the slot**, so `node:fs` relative paths and spawned
  commands land there without being told. Use `ctx.slotDir` when you want to be explicit.
- State shared between callbacks inside one process is an ordinary module-level `let`. Nothing
  survives in memory from `start` to `finish`; write cross-process state to `<root>/.state/`.
- Import `node:` builtins, relative files in the container, or packages installed in the
  container. The ratoon engine is not a runtime dependency.
- Shell out with `node:child_process` (`execSync` or a shell; on Windows `npm` is a `.cmd` shim,
  which `spawn` cannot find). Add `dax` to the container if you prefer `` $`…` ``.

## Files a plugin writes

Anything that is not repository content — logs, locks, scratch files, task notes — belongs in
`<root>/.state/<slot>/`. Use `statePath(ctx, 'name')` from `./plugins/shared.ts` instead of
building the path by hand.

A file in the worktree is either content or dirt. There is no third kind: `finish` will call it
dirty, and the next `start` removes it with `git clean -fd`.

## Starter plugins in `plugins/`

Each starter is its own file, copied into the container. `init` enables `taskNotes()`; import any
of the others that `hooks.ts` needs, or delete the directory. `taskNotes()` is the only starter
that cannot touch the repository — it writes under `.state/`, never in a worktree.

| plugin | does |
|---|---|
| `npmInstall(opts?)` | Detects the package manager (`packageManager` / `devEngines.packageManager`, then lockfiles), fingerprints the slot's manifests under `.state/`, and skips when nothing changed. `defaultManagers` and `detectManager` live in `plugins/shared.ts` if you need to inspect or replace the table. |
| `taskNotes(opts?)` | Writes `.state/<slot>/TASK.md` on start — a plan section first, for whoever picks the slot up next — prints its path, and warns about unchecked boxes at finish. |

## Typechecking, not runtime validation

The shape is checked by `satisfies Plugin[]` and `tsc`; Node strips types instead of checking
them. `init` writes a `typecheck` script that runs `tsc --noEmit`.

Runtime does no shape checking. A file with no usable default export just idles — the
`  plugins : loaded` line carries no plugin names, the same as having no hooks file. The only
runtime error is one Node itself cannot parse: `hooks failed to load`, with the path and line.

A container without hooks is just a slot pool. Delete `hooks.ts` (or leave it as
`export default []`) and `start` / `finish` still allocate, branch, clean, squash, rebase, merge
and park.

## Failures

A throwing plugin fails the whole command. The error names the plugin, and the stack points at
the file that defines it:

```text
onStart hook failed by "build"
```

For `start`, a failed hook rolls back the branch and the claim; a slot this command created is
removed. For `finish`, `onFinish` runs before any git state is touched, so the slot stays exactly
as it was.
