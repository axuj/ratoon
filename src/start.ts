import type { StartOptions } from './cli.ts'
import type { PoolSlot } from './state.ts'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { branchExists, currentBranch, deleteBranchIfUnchanged, park, pruneWorktrees, revOf } from './git.ts'
import { describeHooks, loadHooks } from './hooks.ts'
import { layoutOf, resolveBaseRef } from './layout.ts'
import { exec, rmrf, run } from './shell.ts'
import { claim, clearBase, clearTask, foreignSlotPaths, isFree, release, scanPool, setBase } from './state.ts'

function message(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}

export async function runStart(opts: StartOptions, task: string): Promise<void> {
  const layout = await layoutOf()
  const branch = `${opts.branchPrefix}${task}`
  const { root, mainDir } = layout

  const base = await resolveBaseRef(opts.base, mainDir)
  await warnUncommittedMain(mainDir, base)

  // A changed ratoon.poolPath — or the default moving outside the repository — leaves git's
  // bindings in the old pool while every command looks at the new one. Refuse before creating
  // anything, while the old slots are still untouched.
  const foreign = await foreignSlotPaths(root, mainDir)
  if (foreign.length > 0) {
    throw new Error(
      `git still has ratoon slots outside ${root}:\n  ${foreign.join('\n  ')}\n`
      + `land or discard those tasks first (see \`git worktree list\`), then \`git worktree prune\`.`,
    )
  }

  // The pool itself is created on demand: an empty directory is not an installation marker.
  mkdirSync(root, { recursive: true })

  let slot: PoolSlot | undefined
  let isNew = false
  let slotWasThere = true
  let branchCreated = false

  async function rollback(): Promise<void> {
    const target = slot
    if (!target)
      return
    const slotDir = target.path

    // Put the slot back the way we found it: parked if we moved it, deleted if we built it, and
    // free of our task either way. Only a directory this start created is ours to remove.
    if (!isNew && existsSync(slotDir)) {
      try {
        if (await currentBranch(slotDir) === branch)
          await park(mainDir, slotDir, base)
      }
      catch (err) {
        console.warn(`warning: could not park ${target.dir} back at ${base}: ${message(err)}`)
      }
    }
    if (isNew && !slotWasThere) {
      await rmrf(slotDir)
      await pruneWorktrees(mainDir)
    }
    // never touch a branch somebody else made: our own `git branch` can lose the race
    if (branchCreated)
      await deleteBranchIfUnchanged(mainDir, branch, base)
    clearTask(root, target.dir)
  }

  try {
    if (await branchExists(mainDir, branch))
      throw new Error(`branch ${branch} already exists`)

    // housekeeping for deleted slot dirs — outside any claim, it is nobody's reservation
    await pruneWorktrees(mainDir)

    // Claim a slot before git touches it: an exclusive create per slot, so two starts can never
    // take the same one and no global lock has to exist. A claim is also what lets a hook run in
    // the slot safely — it is ours from here on, until `release`.
    const pool = await scanPool(root, mainDir)
    let claimed: string | undefined
    for (const candidate of pool.filter(isFree)) {
      if (claim(root, candidate.dir, task)) {
        claimed = candidate.dir
        break
      }
    }

    if (!claimed) {
      isNew = true
      // every name is taken, so grow the pool. Existing directories count as taken even when git
      // does not know them: a slot whose state went missing is not ours to hand out.
      let i = 0
      while (!claimed) {
        while (pool.some(s => s.dir === `slot-${i}`))
          i++
        if (claim(root, `slot-${i}`, task))
          claimed = `slot-${i}`
        else
          i++
      }
      console.log(`\n[1/3] creating new slot ${claimed} for ${branch}\n`)
    }
    else {
      console.log(`\n[1/3] reusing free slot ${claimed} for ${branch} (node_modules kept)\n`)
    }

    const slotDir = path.join(root, claimed)
    slotWasThere = existsSync(slotDir)
    const planned = pool.find(s => s.dir === claimed)
    slot = planned ?? {
      dir: claimed,
      path: slotDir,
      worktree: false,
      missing: !slotWasThere,
      branch: '',
      task,
      baseRef: '',
      baseSha: '',
      claimedBy: process.pid,
    }

    const created = await exec('git', ['-C', mainDir, 'branch', branch, base])
    if (created.status !== 0) {
      const detail = `${created.stdout}${created.stderr}`.trim()
      if (/already exists/i.test(detail))
        throw new Error(`branch ${branch} already exists`)
      throw new Error(`git branch ${branch} failed\n${detail}`)
    }
    branchCreated = true

    // `--base` is a choice the task carries to finish: record the ref and the exact commit it
    // named, so a later finish can ask whether to land it or only the task's own changes. A task
    // without --base has no such choice to make.
    const baseSha = await revOf(mainDir, branch)
    if (opts.base !== undefined)
      setBase(root, claimed, base, baseSha)
    else
      clearBase(root, claimed)

    // Slot claimed, git has not touched it yet: the only place a hook may still see the previous
    // task's files. Outside any lock — a hook is user code.
    const hooks = await loadHooks({
      rootDir: root,
      mainDir,
      slotDir,
      branch,
      task,
      base,
    })
    await hooks.run('onBeforeCheckout')

    if (isNew) {
      await run('git', [
        '-C',
        mainDir,
        'worktree',
        'add',
        slotDir,
        branch,
      ])
    }
    else {
      await run('git', [
        '-C',
        slotDir,
        'checkout',
        '-f',
        branch,
      ])
    }

    // drop crash residue. node_modules is gitignored so `clean -fd` leaves it alone.
    await run('git', ['-C', slotDir, 'clean', '-fd'])

    console.log('\n[2/3] onStart\n')
    const ranHooks = await hooks.run('onStart')
    if (!hooks.present)
      console.log('no hooks.ts in the pool or the repository — skipped\n')

    // done working in it, not done with it: the task stays on the slot and the branch says so
    release(root, claimed)

    console.log(`\n[3/3] slot ${claimed} ready (${isNew ? 'new' : 'reused'})\n`)
    console.log(
      `  branch  : ${branch}\n  worktree: ${slotDir}\n  base    : ${base} @ ${baseSha.slice(0, 7)}\n`
      + `  plugins : ${describeHooks(hooks.present, ranHooks, hooks.count)}\n`,
    )
    // The most common first-run surprise: an empty hooks array installs nothing and the slot looks
    // broken. Say so once here, where the consequence shows up.
    if (hooks.present && hooks.count === 0)
      console.log('  hint    : no plugins enabled — starters live in .ratoon/plugins/\n')
  }
  catch (err) {
    try {
      await rollback()
    }
    catch (rollbackErr) {
      console.warn(`warning: rollback incomplete: ${message(rollbackErr)}`)
    }
    throw new Error(`start failed: ${message(err)}`)
  }
}

/**
 * A slot branches from the base *commit*, so edits sitting in the main worktree do not exist in it.
 * Warn instead of refusing: starting from a clean base is a legitimate choice.
 */
async function warnUncommittedMain(mainDir: string, base: string): Promise<void> {
  const status = await exec('git', ['-C', mainDir, 'status', '--porcelain'])
  const entries = status.stdout.split('\n').filter(line => line.trim().length > 0)
  if (entries.length === 0)
    return
  const plural = entries.length === 1
    ? 'entry'
    : 'entries'
  console.warn(`  warning : main worktree has ${entries.length} uncommitted ${plural} — the slot branches from ${base}, so they are not in it`)
}
