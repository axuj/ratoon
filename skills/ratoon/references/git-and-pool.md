# Git and the pool

The pool lives outside the project by default: `$XDG_DATA_HOME/ratoon/pools/<mirror of the repo>`
(`~/.local/share/ratoon/pools` when the variable is unset), one directory per repository. Nothing in
the project records it, and `start` writes nothing there — the location is derived from the
repository path, and `ratoon list` prints it.

`.ratoon/` is local state, not project content: `init` keeps it out of git with the single
`.ratoon/*` rule in `.gitignore`. Never `git add` the toolbox on your own; it stays local unless the
team whitelisted it. `ratoon.poolPath` can move the pool back into the repository — then the same
rule covers it, and nothing else.

Keeping the pool out of the tree is what keeps the project's tools out of it: a busy slot is a full
copy of the project, possibly on another branch, and a pool inside the repository makes every test
runner, `tsc`, IDE index and `grep -r` walk it as ordinary directories. Never read a file in the pool
as the project's current state.

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

Never leave dirt: `finish` refuses a dirty tree and the next `start` runs `git clean -fd`.
Untracked files count unless gitignored. Anything that is not repo content — notes, logs, locks —
belongs in the pool's `.state/<slot>/`, never in a worktree. Do not run `git clean -fdx` in the main
worktree: it wipes `.ratoon/` — the hook toolbox, which is ignored and therefore untracked — so
`start` keeps working with no hooks until `ratoon init` runs again. The pool and its notes sit
outside the tree and survive.

Hooks are read from the main working tree, never from the slot — even when the team commits
`.ratoon/hooks.ts` and a copy shows up in the checkout. Edit it in the main working tree; the
change takes effect on the next `start`.

Slots left in the old in-repo pool by ratoon 0.3.x are invisible to a newer CLI. `references/upgrade.md`
has the recovery steps.

A conflict pauses `finish` with exit 2. Edit the named files, remove the `<<<<<<<` markers, then
run the *same command again* — it stages the files and completes the rebase.
