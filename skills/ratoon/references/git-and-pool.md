# Git and the pool

`.ratoon/` is local state, not project content: `start` keeps it out of git with the single
`.ratoon/*` rule in `.gitignore`. Never `git add` the pool or the state on your own; the config files
stay local too unless the team whitelisted them.

That rule is for git alone. A busy slot in the default pool is a full copy of the project inside the
repository, so anything that walks the tree — the project's test runner, `tsc`, your own `grep` —
finds the slots as ordinary directories, possibly on another branch. Keep their scope off `.ratoon/`,
and never read a file there as the project's current state. A repository can keep the pool out of the
tree with `git config ratoon.poolPath <base>`; the pool then lands under its own mirrored path inside
that base, and `ratoon list` shows where it went.

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
worktree: it wipes `.ratoon/` — the hook toolbox, the notes and the install fingerprints — while
the slots themselves survive, so `start` keeps working with no hooks until `ratoon init` runs
again.

Hooks are read from the main working tree, never from the slot — even when the team commits
`.ratoon/hooks.ts` and a copy shows up in the checkout. Edit it in the main working tree; the
change takes effect on the next `start`.

A conflict pauses `finish` with exit 2. Edit the named files, remove the `<<<<<<<` markers, then
run the *same command again* — it stages the files and completes the rebase.
