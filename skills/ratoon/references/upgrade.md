# Upgrading ratoon

## 0.3.x and earlier kept the pool inside the project

Those versions put the default pool at `<repo>/.ratoon/worktrees/`. Newer versions derive it from
the repository path and keep it outside the tree: `$XDG_DATA_HOME/ratoon/pools/<mirror>`, or
`~/.local/share/ratoon/pools` when that variable is unset. The slots did not move, and a newer CLI
never looks at the old path.

Recover before you upgrade when a task is still open — finish or abandon every slot with the version
that created it (`npm i -g ratoon@0.3`), then `rm -rf .ratoon/worktrees` and `git worktree prune`.
That is the whole migration.

Upgraded first? Nothing is lost, but the old slots are out of the new CLI's reach:

- `ratoon list` shows an empty pool. The slots are still on disk and still bound in git.
- `ratoon start` refuses with `git still has ratoon slots outside …` while a busy slot is there, so
  nothing is silently stranded — but `finish` cannot see those tasks any more.

Recovery, in order:

1. `git worktree list` — every slot path under `<repo>/.ratoon/worktrees/` and the branch it holds.
   A slot listed as `(detached HEAD)` is parked and needs nothing.
2. Land or throw away each busy one: `feature/<task>` merged by hand, or the 0.3.x CLI reinstalled
   temporarily for `ratoon finish <task> -m "…"`.
3. Copy out anything worth keeping from `.ratoon/worktrees/.state/` — `TASK.md` handoff sheets and
   install fingerprints. They do not survive the cleanup.
4. `git worktree prune`, then delete the empty pool: `rm -rf .ratoon/worktrees`.
5. The next `start` creates the pool outside the project.

## Staying inside the project

`git config ratoon.poolPath .ratoon` keeps the pool under `.ratoon/`, where the `.ratoon/*` rule
covers it. The mirror still nests, so the pool becomes `<repo>/.ratoon/<drive>/<repo path>` — not the
old `.ratoon/worktrees/`. That is the only supported in-repo location: anywhere else in the tree one
`git add -A` would commit the slots.

## Notes

- `ratoon.poolPath` is a **base** directory, not a pool. A value pointing straight at a pool never
  worked and does not start working now.
- No config is written to remember the default. Nothing to clean up to follow a changed default.
