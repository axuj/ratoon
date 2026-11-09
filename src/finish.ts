import type { RatoonOptions } from './cli.ts'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PausedError } from './errors.ts'
import { branchExists, checkedOutAt, currentBranch, park, rebaseInProgress, revOf, squashCommits } from './git.ts'
import { describeHooks, loadHooks } from './hooks.ts'
import { layoutOf } from './layout.ts'
import { exec, run } from './shell.ts'
import { claim, claimOn, clearTask, poolSummary, release, scanPool, slotForTask } from './state.ts'

function message(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}

/** The one line git used to say no — the rest of its output is progress and hints. */
function refusal(detail: string): string {
  const line = detail.split('\n')
    .map(text => text.trim())
    .find(text => /^(?:fatal|error):|^! \[/i.test(text))
  return line
    ? `\n${line}`
    : ''
}

/** Paths still marked `U` in the index — an empty list means every conflict has been staged. */
async function unmergedPaths(worktreeDir: string): Promise<string[]> {
  const result = await exec('git', [
    '-C',
    worktreeDir,
    'diff',
    '--name-only',
    '--diff-filter=U',
  ])
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

/** Absolute paths, one per line, indented — the list an agent can act on without resolving cwd. */
function absolute(worktreeDir: string, files: string[]): string {
  return files.map(file => `  ${path.join(worktreeDir, file)}`).join('\n')
}

/** The `<<<<<<<` start marker means nobody has resolved this file yet. */
function stillMarked(worktreeDir: string, files: string[]): string[] {
  return files.filter((file) => {
    try {
      return readFileSync(path.join(worktreeDir, file), 'utf8').includes('<<<<<<<')
    }
    catch {
      return false
    }
  })
}

/**
 * Run one `git rebase` step and turn a conflict into a pause (exit 2) naming the files to edit.
 *
 * Both the initial rebase and `--continue` come through here: a task keeps every commit, so it can
 * stop **once per commit** — the second stop has to pause just as cleanly as the first, otherwise
 * the caller would get a bare `command failed (1)` with no file list.
 */
async function rebaseStep(worktreeDir: string, ...args: string[]): Promise<void> {
  const result = await exec('git', [
    '-C',
    worktreeDir,
    '-c',
    'core.editor=true',
    'rebase',
    ...args,
  ])
  if (result.status === 0)
    return

  const files = await unmergedPaths(worktreeDir)
  if (files.length === 0) {
    const detail = `${result.stdout}${result.stderr}`.trimEnd()
    throw new Error(`git rebase ${args.join(' ')} failed (cwd: ${worktreeDir})\n${detail}`)
  }

  const where = args.includes('--continue')
    ? 'while applying the next commit'
    : `while rebasing onto ${args[0]}`
  const list = absolute(worktreeDir, files)
  // only git's CONFLICT lines — its own hints say to run `git rebase --continue`, which would
  // contradict the single instruction below
  const marks = `${result.stdout}${result.stderr}`.split('\n').filter(line => line.includes('CONFLICT'))
  const tail = marks.length > 0
    ? `\n${marks.join('\n')}`
    : ''
  throw new PausedError(
    `git rebase stopped on a conflict ${where} — edit these files, then run the same command again (it stages and completes the rebase for you):\n${list}${tail}`,
  )
}

/** Nothing is exempt any more, so say plainly what each kind of dirt wants from you. */
function dirtyError(worktreeDir: string, dirty: string): Error {
  const lines = dirty.split('\n')
  const hints: string[] = []
  if (lines.some(line => line.startsWith('??')))
    hints.push('  ??        untracked leftovers — delete them (or gitignore them) and re-run finish')
  if (lines.some(line => !line.startsWith('??'))) {
    hints.push(
      `  <tracked> changes to versioned files — commit them. Discard only what you know is`,
      `            noise, naming the file: \`git -C ${worktreeDir} checkout -- <file>\``,
    )
  }
  return new PausedError(`worktree ${worktreeDir} has uncommitted changes, aborting\n${dirty}\n\n${hints.join('\n')}`)
}

interface LandingTarget {
  /** the branch the work lands on */
  ref: string
  /**
   * It is checked out in the main worktree. That branch has to be advanced by a merge — a plain ref
   * update would leave the files in that worktree describing the commit it used to point at.
   */
  checkedOut: boolean
}

/**
 * One sentence for a branch another worktree is standing on. It carries the facts only we have —
 * which ref, which directory, and that nothing landed — and no remedy: `git worktree prune` and
 * `checkout --detach` are both right, depending on whether that directory still exists.
 */
function standingElsewhere(ref: string, where: string): string {
  return `${ref} is checked out in another worktree (${where}) — git will not move it, nothing was landed`
}

/**
 * Where this task lands: `--into` names it outright, otherwise it is whatever the main worktree has
 * checked out — the branch a user sees move when `finish` prints its log.
 *
 * A branch another worktree is standing on is refused here, before anything is squashed: git will
 * not move that ref, and discovering it after the rewrite means doing the rewrite twice.
 */
async function resolveLandingTarget(opts: RatoonOptions, mainDir: string): Promise<LandingTarget> {
  const into = opts.into
  if (into !== undefined) {
    // A local branch, not any old ref: a tag or a remote-tracking name passes a plain `rev-parse`
    // check, and the landing then writes `refs/heads/<that name>` — quietly inventing a branch
    // that looks like the remote one and holding a commit nobody pushed.
    if (!await branchExists(mainDir, into))
      throw new Error(`--into needs a local branch, and ${into} is not one — create it first`)

    const onMain = await currentBranch(mainDir) === into
    const holder = await checkedOutAt(mainDir, into)
    if (holder !== '' && !onMain)
      throw new Error(standingElsewhere(into, holder))
    return { ref: into, checkedOut: onMain }
  }

  const head = await currentBranch(mainDir)
  if (head === '') {
    throw new Error(
      `the main worktree is detached (${await revOf(mainDir, 'HEAD')}) — there is no branch to land on\n`
      + 'pass --into <branch>',
    )
  }
  return { ref: head, checkedOut: true }
}

interface FinishContext {
  task: string
  branch: string
  /** the branch the work lands on */
  target: string
  /** the target is checked out in the main worktree, so it is advanced by a merge */
  checkedOut: boolean
  root: string
  mainDir: string
  /** the title the landing commit will carry — typed by the caller, never derived */
  title: string
  /** slot directory name, e.g. `slot-0` */
  slotDir: string
  /** absolute path of the worktree */
  worktreeDir: string
}

/** Commits the task branch has that the base does not; 0 when there is no such branch. */
async function commitsAhead(mainDir: string, base: string, branch: string): Promise<string[]> {
  const listed = await exec('git', [
    '-C',
    mainDir,
    'log',
    '--format=%s',
    `${base}..${branch}`,
  ])
  return listed.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

export async function runFinish(opts: RatoonOptions, task: string, title: string): Promise<void> {
  const layout = await layoutOf()
  const { root, mainDir } = layout
  const branch = `${opts.branchPrefix}${task}`

  try {
    // Reading the pool needs no lock: nothing is shared with another slot, and the only write at
    // the end is this slot's own state directory.
    const pool = await scanPool(root, mainDir)
    const slot = slotForTask(pool, task, branch)
    if (!slot) {
      const hint = await branchExists(mainDir, branch)
        ? `\nthe branch exists but no slot has it — \`ratoon abandon ${task}\` drops it, or restore the slot`
        : ''
      throw new Error(`no slot is working on task ${task} (${branch})\n${poolSummary(pool)}${hint}`)
    }
    if (!existsSync(slot.path))
      throw new Error(`worktree directory ${slot.path} does not exist`)

    // Resolved after the slot lookup: a task no slot holds is answered first, even when the main
    // worktree is detached — CI checks out tags that way.
    const target = await resolveLandingTarget(opts, mainDir)

    // A PR cannot be merged without a title, and neither can this: the landing commit's message is
    // the caller's words, so it is demanded *before* anything is touched — no hooks, no squash, no
    // rebase. An empty task (nothing to land) needs no title, because nothing will carry one.
    const ahead = title === ''
      ? await commitsAhead(mainDir, target.ref, branch)
      : []
    if (ahead.length > 0) {
      throw new Error(
        `finish needs a title — pass -m "<title>", the way a PR needs one:\n`
        + `  ratoon finish ${task} -m "<title>"\n\n`
        + `commits on ${branch}:\n${ahead.map(subject => `  ${subject}`).join('\n')}`,
      )
    }

    // One command per slot, by exclusive create rather than a queue: two finishes of the same task
    // would otherwise rebase and merge over each other.
    if (!claim(root, slot.dir, task)) {
      const holder = claimOn(root, slot.dir)
      throw new PausedError(
        `slot ${slot.dir} is busy (${holder
          ? `pid ${holder}`
          : 'another command'})`
          + ' — nothing was changed, run the same command again when it is done',
      )
    }

    try {
      await landTask({
        task,
        branch,
        target: target.ref,
        checkedOut: target.checkedOut,
        root,
        mainDir,
        title,
        slotDir: slot.dir,
        worktreeDir: slot.path,
      })
    }
    finally {
      // Only a landing clears the task; a pause or a failure leaves it on the slot for the next run.
      release(root, slot.dir)
    }
  }
  catch (err) {
    // keep the pause: the wrapper must not turn exit 2 into a plain failure
    const text = `finish failed: ${message(err)}`
    throw err instanceof PausedError
      ? new PausedError(text)
      : new Error(text)
  }
}

async function landTask(ctx: FinishContext): Promise<void> {
  const { task, branch, target, checkedOut, root, mainDir, title, slotDir, worktreeDir } = ctx
  console.log(`\n[1/4] verifying ${branch} in ${slotDir}\n`)

  // A conflict pauses finish (exit 2) instead of failing it: nothing has been changed, so an agent
  // only has to edit the file and run the same command again. Staging and `--continue` are ours —
  // bare `--continue` would open an editor, and nobody should have to be told to type `git add`.
  // Must run before the branch check: mid rebase HEAD is detached.
  if (await rebaseInProgress(worktreeDir)) {
    const unmerged = await unmergedPaths(worktreeDir)
    const marked = stillMarked(worktreeDir, unmerged)
    if (marked.length > 0) {
      const list = absolute(worktreeDir, marked)
      throw new PausedError(
        `unfinished rebase detected in ${worktreeDir} — these files still have conflict markers. Edit them, then run the same command again:\n${list}`,
      )
    }
    if (unmerged.length > 0) {
      await run('git', [
        '-C',
        worktreeDir,
        'add',
        '--',
        ...unmerged,
      ])
    }
    console.log('conflicts resolved — continuing the rebase\n')
    await rebaseStep(worktreeDir, '--continue')
  }

  const head = await currentBranch(worktreeDir)
  if (head !== branch) {
    throw new Error(
      `slot ${slotDir} is on branch ${head || '(detached)'}${head
        ? ''
        : ` at ${await revOf(worktreeDir, 'HEAD')}`}, expected ${branch}`,
    )
  }

  // The hook gets the worktree before any git state is touched: it is the only safe place for it
  // to fail — and the only place it can tidy up before the dirty check below. No lock is held
  // here: this is user code and may take minutes, and the slot is ours alone anyway.
  const hooks = await loadHooks({
    rootDir: root,
    mainDir,
    slotDir: worktreeDir,
    branch,
    task,
    base: target,
  })
  console.log('\n[2/4] onFinish\n')
  const ranHooks = await hooks.run('onFinish')
  console.log(`  plugins : ${describeHooks(hooks.present, ranHooks, hooks.count)}\n`)

  const status = await exec('git', [
    '-C',
    worktreeDir,
    'status',
    '--porcelain',
    '-uall',
  ])
  const dirty = status.stdout
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .join('\n')
  if (dirty)
    throw dirtyError(worktreeDir, dirty)

  // Only the branch checked out in the main worktree is advanced through that worktree, so only
  // then can its dirt get in the way. A ref update elsewhere leaves that tree untouched.
  if (checkedOut) {
    const mainDirty = await exec('git', ['-C', mainDir, 'status', '--porcelain'])
    if (mainDirty.stdout.trim()) {
      const count = mainDirty.stdout.trim().split('\n').length
      console.warn(`warning: main worktree has uncommitted changes (${count} entries)`)
      console.warn('ff-only merge only touches files changed on the task branch; it will fail if they overlap')
      console.warn('note: staged changes on main get reset to unstaged by the merge (file contents are kept)')
    }
  }

  console.log(`\n[3/4] landing ${branch} on ${target}\n`)

  // The message lands exactly as typed; a multi-commit branch is collapsed into it, and every
  // draft message is discarded. No lock is needed: the index is this slot's own.
  const collapsed = await squashCommits(worktreeDir, target, title)
  if (collapsed === 0) {
    // Nothing to land: the branch has no commits, or they cancel out. The slot is still cleared and
    // parked below, exactly like a task that never started.
    console.log(`  nothing : ${branch} changes nothing on ${target} — nothing to land`)
  }
  else {
    console.log(`  commit  : ${title}`)
    if (collapsed > 1)
      console.log(`  squashed: ${collapsed} draft commits`)
  }
  console.log('')

  const ancestor = await exec('git', [
    '-C',
    worktreeDir,
    'merge-base',
    '--is-ancestor',
    target,
    'HEAD',
  ])
  if (ancestor.status !== 0) {
    if (ancestor.status !== 1)
      throw new Error(`git merge-base --is-ancestor failed (${ancestor.status})`)
    console.log(`${target} has new commits — rebasing ${branch} onto ${target}\n`)
    await rebaseStep(worktreeDir, target)
  }
  else {
    console.log(`${branch} is already on top of ${target}\n`)
  }

  await landOnto(mainDir, target, branch, checkedOut)

  console.log(`\n[4/4] parking slot ${slotDir} (detached at ${target}, worktree binding kept)\n`)
  await park(mainDir, worktreeDir, target)

  const deleted = await exec('git', ['-C', mainDir, 'branch', '-d', branch])
  if (deleted.status !== 0) {
    // content already ff-merged into the target, so forcing only drops the reference
    console.warn(`warning: git branch -d failed (${deleted.status}), retrying with -D (already merged)`)
    const forced = await exec('git', ['-C', mainDir, 'branch', '-D', branch])
    if (forced.status !== 0)
      console.warn(`warning: could not delete branch ${branch} — it will remain until manually removed`)
  }

  // The last step, and this slot's own state only: no other slot can observe or lose it.
  clearTask(root, slotDir)

  console.log('\nDone. Slot parked, dependencies kept — the next task switches branches in place.\n')
}

/**
 * Advance `target` to the task's commit.
 *
 * A branch checked out in the main worktree moves by merging: that also updates the files the user
 * is looking at. Any other branch moves by a ref update, so the main worktree — and whatever it is
 * in the middle of — is left alone. `git fetch .` is that ref update, and it carries both guards
 * this needs already: it is fast-forward-only by default, and it refuses to move a branch another
 * worktree has checked out. Neither has to be re-implemented here, and neither can be skipped.
 */
async function landOnto(mainDir: string, target: string, branch: string, checkedOut: boolean): Promise<void> {
  if (checkedOut) {
    console.log(`merging: git merge --ff-only ${branch}\n`)
    const merged = await exec('git', [
      '-C',
      mainDir,
      'merge',
      '--ff-only',
      branch,
    ])
    if (merged.status === 0)
      return

    // Nothing is locked while landing, so a second finish can slip in between our rebase and this
    // merge, or hold git's own index lock. Either way git refuses before touching the target, so
    // nothing was changed and the same command reconciles — a pause, not a failure.
    const detail = `${merged.stdout}${merged.stderr}`
    const notFastForward = /not possible to fast-forward/i.test(detail)
    if (notFastForward || /index\.lock/i.test(detail)) {
      const why = notFastForward
        ? 'another task landed first'
        : 'git in the main worktree is busy (another task landing, or a leftover index.lock)'
      throw new PausedError(`${why} — nothing was changed, run the same command again${refusal(detail)}`)
    }
    throw new Error(`git merge --ff-only ${branch} failed\n${detail.trimEnd()}`)
  }

  console.log(`fast-forwarding ${target} without touching the main worktree\n`)
  const fetched = await exec('git', [
    '-C',
    mainDir,
    'fetch',
    '--no-tags',
    '.',
    `${branch}:refs/heads/${target}`,
  ])
  if (fetched.status === 0)
    return

  const detail = `${fetched.stdout}${fetched.stderr}`
  // The target was free when this finish started, so this is a race — someone checked the branch
  // out while the task was being rebased. git's own message names the worktree.
  const elsewhere = /checked out at '([^']+)'/i.exec(detail)
  if (elsewhere !== null)
    throw new Error(standingElsewhere(target, elsewhere[1] ?? 'another worktree'))
  if (/non-fast-forward|\[rejected\]/i.test(detail))
    throw new PausedError(`another task landed on ${target} first — nothing was changed, run the same command again${refusal(detail)}`)
  throw new Error(`git fetch . ${branch}:refs/heads/${target} failed\n${detail.trimEnd()}`)
}
