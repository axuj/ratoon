# Dispatching subagents

Give each subagent its slot path and the task name, and tell it to load the `ratoon` skill before it
touches anything — the rules live there, and a global install is in every slot. Then: commit only in
that slot, keep notes and logs in `.state/<slot>/`, never commit in the main working tree, never run
`finish`.

**When a subagent takes over or its context breaks, it first reads the slot's `git log --oneline`
and `<pool>/.state/<slot>/TASK.md`** — progress is in the commits, the state and the open questions
are in the sheet. Without both, a fresh agent starts from zero.

Subagents have isolated contexts and their in-session task lists cannot be read from outside;
progress that the user must see belongs in the draft commits, or in what you report back.
