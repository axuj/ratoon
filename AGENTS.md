# AGENTS.md

Conventions for agents working **on ratoon itself**. The workflow for *using* ratoon —
slots, draft commits, the `finish` approval gate — is in `skills/ratoon/SKILL.md`.
Load it before editing; those rules are not restated here.

## Landed commits

`finish -m "<title>"` is the permanent commit on the base branch: English, with the
repository's gitmoji + conventional type prefix — `:sparkles: feat:`, `:bug: fix:`,
`:recycle: refactor:`, `:memo: docs:`, `:bookmark: chore:`. Draft commits inside the
slot are throwaway notes in the user's language, and are squashed away.

## Release notes

`.github/workflows/release.yml` builds the GitHub Release body with
`changelogithub@15`. Its built-in type table keeps only `feat`, `fix` and `perf`;
`changelogithub.config.ts` adds `refactor` and `docs`. `chore`, `ci` and `test` are
left out so release and pipeline commits stay out of the notes. To surface another
type, extend that config — do not rewrite commit prefixes or history to satisfy the
generator.

## Releasing

A version bump is a `:bookmark: chore: release X` commit on master. Push master and
wait for CI, then push the lightweight `vX` tag; the tag triggers
`npm publish --provenance` and the Release. Publishing is done by CI via npm trusted
publishing; a local `npm publish` is not part of the flow.
