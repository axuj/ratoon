# Landing on another branch

Never run `finish` without the user's approval — see SKILL.md, "Before anything".

`finish --into <branch>` lands the work on a branch the main worktree does *not* have checked out —
the shape of a long-lived second line, such as `v2` growing next to a shipping `main`. The task is
squashed, rebased onto that branch, and the branch is fast-forwarded; the main worktree keeps its
branch, its files and its uncommitted edits, so a task can land on either line without stashing or
switching.

- The target only moves forward. If something landed on it first, `finish` pauses with exit 2 —
  nothing changed, run the same command again.
- The target must not be checked out in another worktree; git will not move it. `finish` refuses
  before squashing anything and names that worktree — exit 1, and re-running changes nothing until
  it is free.
- `--into` takes a local branch. A tag or `origin/v2` is refused rather than turned into a branch of
  that name.
