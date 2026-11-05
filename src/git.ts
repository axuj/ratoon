import { existsSync } from 'node:fs'
import path from 'node:path'
import { exec, run } from './shell.ts'

/** True when `ref` resolves to a commit. */
export async function refExists(repoDir: string, ref: string): Promise<boolean> {
  const result = await exec('git', [
    '-C',
    repoDir,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ])
  return result.status === 0
}

export async function branchExists(mainDir: string, branch: string): Promise<boolean> {
  const result = await exec('git', [
    '-C',
    mainDir,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ])
  return result.status === 0
}

/** Branch name at HEAD, or "" when the worktree is detached (a parked slot). */
export async function currentBranch(dir: string): Promise<string> {
  const result = await exec('git', [
    '-C',
    dir,
    'symbolic-ref',
    '--short',
    'HEAD',
  ])
  return result.status === 0
    ? result.stdout.trim()
    : ''
}

/** Commit id for `ref`, or "" when it does not resolve. */
export async function revOf(dir: string, ref: string): Promise<string> {
  const result = await exec('git', [
    '-C',
    dir,
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ])
  return result.status === 0
    ? result.stdout.trim()
    : ''
}

/** Detach a slot at `base` while keeping the worktree binding — this is what "parked" means. */
export async function park(mainDir: string, slotDir: string, base: string): Promise<void> {
  await run('git', [
    '-C',
    slotDir,
    'checkout',
    '--detach',
    base,
  ], { cwd: mainDir })
}

/**
 * True while a rebase is stopped mid-flight in `worktreeDir` — either on a conflict, or paused
 * because the last `--continue` found nothing staged. `finish` resumes it; `abandon` aborts it.
 */
export async function rebaseInProgress(worktreeDir: string): Promise<boolean> {
  const gitDir = await exec('git', [
    '-C',
    worktreeDir,
    'rev-parse',
    '--absolute-git-dir',
  ])
  if (gitDir.status !== 0)
    return false
  const dir = gitDir.stdout.trim()
  return existsSync(path.join(dir, 'rebase-merge')) || existsSync(path.join(dir, 'rebase-apply'))
}

/**
 * Collapse every commit between `base` and HEAD into a single one, in place: `reset --soft` back to
 * the merge base, then commit what the index already holds.
 *
 * Deliberately avoids `git merge --squash`: that runs a real merge in the main repository and, on
 * a conflict, leaves an index with no `MERGE_HEAD` — nothing to `--abort`, nothing to resume, and a
 * re-run conflicts again. A soft reset never merges, so it cannot conflict at all, and it runs in
 * the slot where the worktree is the one being edited.
 *
 * **The title is never derived.** A PR's title comes from the form, not from the commits, and so
 * does this one: the caller passes it, verbatim. The branch's own messages are drafts and are
 * dropped — `-m` is the whole landing message, not just its subject. That is also why a task whose
 * single commit already carries exactly that message is left untouched: same bytes, same sha, and
 * a re-run after a failed finish stays a no-op.
 *
 * A branch whose commits add up to no tree change has nothing to land: its commits are dropped —
 * itself a no-op, since the tree already equals the merge base — rather than landing draft messages
 * that carry no content, or an empty commit that would be pure noise.
 *
 * Returns how many commits the branch had (0 = nothing to land, 1 = kept or replaced, 2+ =
 * collapsed), which is what the step log reports.
 */
export async function squashCommits(repoDir: string, base: string, message: string): Promise<number> {
  const mergeBase = await exec('git', [
    '-C',
    repoDir,
    'merge-base',
    base,
    'HEAD',
  ])
  if (mergeBase.status !== 0)
    return 0
  const from = mergeBase.stdout.trim()

  const count = await exec('git', [
    '-C',
    repoDir,
    'rev-list',
    '--count',
    `${from}..HEAD`,
  ])
  if (count.status !== 0)
    return 0
  const before = Number(count.stdout.trim())
  if (before <= 0)
    return 0

  // Commits that cancel each other out leave no tree difference. Drop them: a task with no net
  // change has nothing to land, and `reset --hard` to the merge base is lossless — the trees are
  // already identical. Landing them instead would put draft commits on the base; landing an empty
  // commit would be noise. This has to run before the single-commit branch below, so one empty
  // commit gets the same treatment as ten.
  const diff = await exec('git', [
    '-C',
    repoDir,
    'diff',
    '--quiet',
    from,
    'HEAD',
  ])
  if (diff.status === 0) {
    await run('git', ['-C', repoDir, 'reset', '--hard', from])
    return 0
  }
  if (diff.status !== 1)
    throw new Error(`git diff --quiet ${from}..HEAD failed (${diff.status})\n${diff.stdout.trimEnd()}`)

  // One commit is already the landing commit when its whole message is exactly what the caller
  // passed. Otherwise the draft message — subject and body — is replaced, not merged.
  if (before === 1) {
    const subject = await exec('git', [
      '-C',
      repoDir,
      'log',
      '-1',
      '--format=%s',
    ])
    const body = await exec('git', [
      '-C',
      repoDir,
      'log',
      '-1',
      '--format=%b',
    ])
    if (subject.stdout.trim() === message && body.stdout.trim() === '')
      return 1
    await run('git', [
      '-C',
      repoDir,
      'commit',
      '--amend',
      '-m',
      message,
    ])
    return 1
  }

  await run('git', ['-C', repoDir, 'reset', '--soft', from])
  await run('git', ['-C', repoDir, 'commit', '-m', message])
  return before
}

/**
 * Force-deletes `branch`, but only when it still points at the same commit as `base`.
 * Setup/finish rollbacks run before any user commit, so "unchanged from base" is the proof
 * that nothing is being thrown away.
 */
export async function deleteBranchIfUnchanged(mainDir: string, branch: string, base: string): Promise<boolean> {
  const [branchRev, baseRev] = await Promise.all([
    revOf(mainDir, branch),
    revOf(mainDir, base),
  ])
  if (!branchRev || !baseRev || branchRev !== baseRev)
    return false
  const result = await exec('git', ['-C', mainDir, 'branch', '-D', branch])
  return result.status === 0
}

export async function pruneWorktrees(mainDir: string): Promise<void> {
  await run('git', ['-C', mainDir, 'worktree', 'prune'])
}
