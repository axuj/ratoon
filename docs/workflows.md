# ratoon workflows

A slot runs one task. `finish` lands that task on the main branch; `abandon` throws it away.
The landing commit is exactly your `-m` message — draft commit messages in the slot are discarded.

## Commands

```bash
ratoon start <task>                 # take a free slot, check out feature/<task>
ratoon list                         # who is busy, who is free
ratoon finish <task> -m "<title>"   # land the task on the main branch
ratoon abandon <task>               # discard the task, park the slot
```

## Commits

Commit checkpoints inside the slot as you go — one per step you might want to come back to is
normal. The messages are drafts: they never reach the main branch, because `finish` lands exactly
its `-m` message. Nobody else reads them either — they are for whichever person scrolls the slot's
log — so write them for that reader: their language, as few words as they need to recognise the
step, no conventional-commit prefix. `just saving`, `try this`, `ok that was dumb` are enough.
Spending a minute on a subject line that never reaches history is wasted effort.

The one message worth crafting is the `-m` you pass to `finish`. Commit in the slot, not in the
main worktree.

## Task notes

By default each `start` writes `.state/<slot>/TASK.md`, and the next `start` in that slot
overwrites it. Its reader is whoever picks the slot up — possibly the same agent after a kill, or
another one after a context loss — so write for that reader, not for the commit log.

- Include the plan (one line per step, edited as it changes), findings git cannot hold (why an
  approach was dropped, what the next person must not retry), and what you did not verify.
- Leave out anything git already records: changed files, test counts, commit messages.

## Pick a case

| Goal | Do this |
|---|---|
| One normal task | `start A` → develop (WIP checkpoints) → `finish A -m "..."` |
| Try another direction, keep only one | checkpoint A → `start B --base feature/A` → test → **abandon the loser, then finish the winner** |
| Two independent tasks, both land | start both from the main branch (do not `--base` one on the other), finish each |
| B depends on A, both land | **finish A first, then finish B** — B rebases onto the new main automatically |
| Several agents, one task each | `start` a different task per agent — the name *is* the branch, so two agents cannot share one; `finish` lands them one at a time |
| Conflict during finish | `finish` exits 2, edit the files, run the same command again |
| Nothing to land (the commits cancel out) | `finish` says so, lands no commit, and parks the slot — an empty commit would be noise |
| Drop the task | `abandon <task>` |

`--base` needs a commit. To try a direction from uncommitted work:

```bash
git -C slot-A add -A && git -C slot-A commit -m "just saving"
# after the experiment, to get A back as uncommitted:
git -C slot-A reset --soft HEAD~1
```

## The one rule about `--base`

`start B --base feature/A` means B starts at A, so **B contains A**.

`finish B` squashes and lands B's whole tree; it does not land "only the difference from A".
Because of that:

- **A is a stepping stone; only B survives** → land B, then `abandon A`. The landing commit contains A+B.
- **A and B must land as separate commits** → land A first, then B. B rebases automatically; no `pull` or manual merge.
- **A and B are independent directions** → start both from the main branch; do not base one on the other.

Do not land B before A when A must stay a separate task: A's code would enter the main branch
under B's commit and A would lose its own review/commit.

## Where `finish` lands

`finish` merges into the main worktree's checked-out branch (usually `master`), **not** `--base`.
`--base` is the starting point and the rebase target; it is not a merge target.

## Conflicts

When `finish` pauses with exit 2:

1. Edit the files; remove every `<<<<<<<` / `=======` / `>>>>>>>` marker.
2. Do not run `git add`.
3. Run the **same** `ratoon finish ... -m "..."` again.

The main branch does not move while the finish is paused. To give up, `abandon` the task.
