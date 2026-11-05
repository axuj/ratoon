/**
 * Exit code **2**: `finish` paused and changed nothing — the slot is still busy, the branch still
 * exists, and the slot is still marked busy. Do what the message names (edit a file, discard some dirt)
 * and run the *same* command again.
 *
 * Exit 1 is everything else: a failure a re-run alone will not fix (no slot, wrong branch, a hook
 * that threw). An agent can branch on the code instead of parsing prose.
 */
export class PausedError extends Error {
  readonly exitCode = 2
}
