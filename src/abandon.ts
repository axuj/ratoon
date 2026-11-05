import type { RatoonOptions } from './cli.ts'
import { existsSync } from 'node:fs'
import { PausedError } from './errors.ts'
import { branchExists, currentBranch, park, pruneWorktrees, rebaseInProgress, revOf } from './git.ts'
import { resolveBaseRef, resolveLayout } from './layout.ts'
import { exec, run } from './shell.ts'
import { claim, claimOn, clearTask, release, scanPool, slotForTask } from './state.ts'

function message(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}

/**
 * What is about to be thrown away, in the caller's language: how many commits, their subjects, and
 * the one command that brings them back. Older ones are collapsed into a count — a discard list is
 * a receipt, not a history.
 */
async function discardSummary(mainDir: string, base: string, branch: string): Promise<string> {
  const counted = await exec('git', [
    '-C',
    mainDir,
    'rev-list',
    '--count',
    `${base}..${branch}`,
  ])
  const total = Number(counted.stdout.trim())
  if (counted.status !== 0 || !Number.isFinite(total) || total === 0)
    return ''

  const logged = await exec('git', [
    '-C',
    mainDir,
    'log',
    '-n',
    '5',
    '--format=%s',
    `${base}..${branch}`,
  ])
  const subjects = logged.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const more = total > subjects.length
    ? `\n  … and ${total - subjects.length} more`
    : ''
  const listed = subjects.length > 0
    ? `\n${subjects.map(subject => `  - ${subject}`).join('\n')}${more}`
    : ''
  const noun = total === 1
    ? 'commit'
    : 'commits'
  return `discarding ${total} ${noun} (${total === 1
    ? 'it stays'
    : 'they stay'} in the reflog)${listed}`
}

export async function runAbandon(opts: RatoonOptions, task: string): Promise<void> {
  const layout = resolveLayout(opts.root, opts.main)
  const base = await resolveBaseRef(opts, layout.mainDir)
  const branch = `${opts.branchPrefix}${task}`
  const { root, mainDir } = layout

  try {
    const pool = await scanPool(root, mainDir)
    const slot = slotForTask(pool, task, branch)
    const hasBranch = await branchExists(mainDir, branch)
    const hasWorktree = slot !== undefined && existsSync(slot.path)

    // Re-running is normal (an agent retries blindly), so say so and touch nothing rather than
    // walking through three steps that would all be no-ops.
    if (!hasBranch && !slot) {
      console.log(`\nNothing to abandon — ${branch} does not exist and no slot is working on ${task}.\n`)
      return
    }

    // A slot mid-discard is not a slot anyone else may touch either.
    if (slot && !claim(root, slot.dir, task)) {
      const holder = claimOn(root, slot.dir)
      throw new PausedError(
        `slot ${slot.dir} is busy (${holder
          ? `pid ${holder}`
          : 'another command'})`
          + ' — nothing was changed, run the same command again when it is done',
      )
    }

    try {
      await discard({
        task,
        branch,
        base,
        root,
        mainDir,
        slot,
        hasBranch,
        hasWorktree,
      })
    }
    finally {
      if (slot)
        release(root, slot.dir)
    }
  }
  catch (err) {
    throw err instanceof PausedError
      ? new PausedError(`abandon failed: ${message(err)}`)
      : new Error(`abandon failed: ${message(err)}`)
  }
}

interface DiscardContext {
  task: string
  branch: string
  base: string
  root: string
  mainDir: string
  slot: { dir: string, path: string } | undefined
  hasBranch: boolean
  hasWorktree: boolean
}

async function discard(ctx: DiscardContext): Promise<void> {
  const { task, branch, base, root, mainDir, slot, hasBranch, hasWorktree } = ctx

  // No worktree holds this task any more (its directory was deleted, or a finished slot was
  // cleaned up by hand). The branch is the task's only remaining trace, so dropping it is the job.
  if (!slot) {
    console.log(`\n[1/2] no slot is working on ${task} — dropping the branch anyway\n`)
    await printDiscard(mainDir, base, branch)
    console.log(`\n[2/2] pruning the leftover binding, then deleting ${branch}\n`)
    // a binding whose directory is gone still "checks out" the branch, and git refuses to delete
    // a branch a worktree has checked out — clear the residue first
    await pruneWorktrees(mainDir)
    await deleteBranch(mainDir, branch)
    console.log('\nDone. Base untouched.\n')
    return
  }

  const worktreeDir = slot.path
  console.log(`\n[1/3] abandoning ${branch} in ${slot.dir}\n`)

  // A finish that paused on a conflict left a rebase in flight. Abort it: the work is being thrown
  // away, so there is nothing to resolve, and the slot has to be back on its own branch before we
  // can park it.
  if (hasWorktree && await rebaseInProgress(worktreeDir)) {
    await run('git', ['-C', worktreeDir, 'rebase', '--abort'])
    console.log('aborted the rebase that finish paused on\n')
  }

  // Both checks come before anything is touched. The slot is ours (just claimed), but it must also
  // be on the task's branch: resetting someone else's checkout would destroy a different task's day.
  const head = hasWorktree
    ? await currentBranch(worktreeDir)
    : ''
  if (head && head !== branch)
    throw new Error(`slot ${slot.dir} is on branch ${head}, not ${branch} — nothing was changed`)

  if (hasBranch)
    await printDiscard(mainDir, base, branch)

  if (hasWorktree) {
    const status = await exec('git', [
      '-C',
      worktreeDir,
      'status',
      '--porcelain',
      '-uall',
    ])
    const dropped = status.stdout.split('\n').filter(line => line.trim().length > 0).length
    await run('git', ['-C', worktreeDir, 'reset', '--hard'])
    // node_modules is gitignored, so `clean -fd` leaves the dependencies alone — that is the whole
    // point of parking a slot instead of deleting it
    await run('git', ['-C', worktreeDir, 'clean', '-fd'])
    if (dropped > 0) {
      console.log(`dropped ${dropped} uncommitted entr${dropped === 1
        ? 'y'
        : 'ies'}\n`)
    }
  }

  console.log(`\n[2/3] parking slot ${slot.dir} (detached at ${base}, worktree binding kept)\n`)
  if (hasWorktree)
    await park(mainDir, worktreeDir, base)
  else
    await pruneWorktrees(mainDir) // the directory is gone; git would still refuse to delete its branch

  console.log(`\n[3/3] freeing ${slot.dir} and deleting ${branch}\n`)
  if (hasBranch)
    await deleteBranch(mainDir, branch)

  // The slot is free once nothing is left of the task: no branch, no parked checkout, no state.
  clearTask(root, slot.dir)

  console.log('\nDone. Work discarded, base untouched, dependencies kept.\n')
}

async function printDiscard(mainDir: string, base: string, branch: string): Promise<void> {
  const summary = await discardSummary(mainDir, base, branch)
  const tip = await revOf(mainDir, branch)
  if (summary)
    console.log(`${summary}\n  recover: git branch ${branch}-rescued ${tip}\n`)
}

async function deleteBranch(mainDir: string, branch: string): Promise<void> {
  const deleted = await exec('git', ['-C', mainDir, 'branch', '-D', branch])
  if (deleted.status !== 0)
    console.warn(`warning: could not delete branch ${branch} — remove it manually (${deleted.stdout.trim()})`)
}
