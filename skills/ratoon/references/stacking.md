# Building on another task

`start B --base feature/A` checks out A's current commit as B's starting point — a copy of A's
work in a new slot. B's branch contains A's drafts, so `finish B` lands the whole tree, not just
B's own changes. `--base` needs a committed checkpoint; uncommitted work in A is not visible.

- Only B should survive → finish B, then `abandon A`. The landing commit contains A + B.
- Both should land as separate commits → **finish A first**; B rebases onto the new main
  automatically. Landing B first puts A's work under B's commit and leaves nothing for A to land.
- Two independent directions → start both from the main branch, do not base one on the other.

`--base` only says where a branch *starts*. Where it lands is decided by `finish` — the main
worktree's checked-out branch, or `--into <branch>` (see `references/landing-targets.md`).
