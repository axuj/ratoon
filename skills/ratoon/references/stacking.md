# Building on another task

`start B --base feature/A` checks out A's current commit as B's starting point — a copy of A's
work in a new slot. B's branch carries A's drafts, but the landing commit does **not** decide by
itself whether those drafts belong to it. `finish B` therefore requires one of:

- `--skip-base` — land only B's own changes. Use this when A has already landed (or will land on
  its own), and when B reverts part of A: the revert is B's change and lands as one.
- `--include-base` — land A's snapshot and B as one commit. Use this when A has not landed and its
  work should survive inside B's commit; then `abandon A`.

The choice is never inferred: once A is squashed, “A landed and was later reverted” and “A never
landed” can look identical. `start` records the base ref and commit and prints it
(`base    : feature/A @ 1a2b3c`); `finish` refuses until one of the two flags is passed.

- Both should land as separate commits → **finish A first**, then `finish B --skip-base`.
- Only one commit, containing A + B → `finish B --include-base`, then `abandon A`.
- Only B's own changes → `finish B --skip-base`; A's work does not land (finish or abandon A
  separately).
- Two independent directions → start both from the main branch, do not base one on the other.

`--base` needs a committed checkpoint; uncommitted work in A is not visible. It only says where a
branch *starts*; where it lands is decided by `finish` — the main worktree's checked-out branch, or
`--into <branch>` (see `references/landing-targets.md`).
