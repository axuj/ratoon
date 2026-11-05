import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { exec } from './shell.ts'

// ────────────────────────────────────────────────────────────── the pool
//
// A slot is a directory named `slot-N` holding a git worktree. Nothing else declares it: `list`
// reads the disk, `start` allocates from the disk, and a directory git does not know is reported as
// such — never adopted, never deleted.
//
// Whether a slot is free is read off git: `finish` and `abandon` park a slot detached, `start`
// checks a task branch out into it, so HEAD is the durable answer. What git cannot tell us lives in
// `<root>/.state/<slot>/`, one directory per slot:
//
//   task     which task this slot is working on (written by start, removed when it lands or dies)
//   busy     the pid of the command in there right now, so nobody else may touch it
//   install  fingerprint of the manifests `npmInstall()` already installed (see plugins/npm-install.ts)
//
// `task` is stored rather than derived from the branch because a rebase that paused on a conflict
// leaves HEAD detached — the branch name is nowhere to be read at exactly the moment it matters.

/** A claim whose owner file cannot be read is either mid-write or residue; only age separates them. */
const CLAIM_STALE_MS = 5_000

export interface PoolSlot {
  /** the directory name, e.g. `slot-1` */
  dir: string
  path: string
  /** git knows this path as a worktree */
  worktree: boolean
  /** git still has the binding, but the directory is gone */
  missing: boolean
  /** checked out branch, "" when detached (the parked state) */
  branch: string
  /** task this slot is working on, "" when free */
  task: string
  /** pid of the command working in it right now, 0 when none */
  claimedBy: number
}

/** `<root>/.state/<slot>` — everything about one slot that is not in the worktree itself. */
export function stateDir(root: string, dir: string): string {
  return path.join(root, '.state', dir)
}

/** ESRCH = no such process. EPERM = alive, just not ours to signal. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function claimFile(root: string, dir: string): string {
  return path.join(stateDir(root, dir), 'busy')
}

function taskFile(root: string, dir: string): string {
  return path.join(stateDir(root, dir), 'task')
}

/** The pid a claim file names, 0 when it cannot be read (mid-write, or not a claim at all). */
function readClaim(file: string): number {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0
      ? pid
      : 0
  }
  catch {
    return 0
  }
}

/**
 * The pid of the process holding the slot, 0 when it is free. Residue from a killed command is
 * removed on sight: the pid is the whole test, exactly as it is for any other lock here.
 */
export function claimOn(root: string, dir: string): number {
  const file = claimFile(root, dir)
  const pid = readClaim(file)
  if (pid === 0)
    return 0
  if (!pidAlive(pid)) {
    rmSync(file, { force: true })
    return 0
  }
  return pid
}

/**
 * Take a slot: an exclusive create of its `busy` file, so two commands can never both win and no
 * global lock has to exist. Also writes `task`, which is what the rest of ratoon looks a slot up by
 * while it is busy. Returns false when somebody else holds it.
 */
export function claim(root: string, dir: string, task: string): boolean {
  const file = claimFile(root, dir)
  mkdirSync(path.dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' })
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
        return false
      const holder = readClaim(file)
      if (holder !== 0 && pidAlive(holder))
        return false
      if (holder === 0) {
        // an owner that has not finished writing yet, or residue — only age tells them apart
        try {
          if (Date.now() - statSync(file).mtimeMs < CLAIM_STALE_MS)
            return false
        }
        catch {
          continue // it vanished between the two calls: try again
        }
      }
      // Stealing is a rename with a unique target: atomic, and two thieves cannot both win — the
      // loser's rename finds nothing and loops back to read the winner's fresh claim.
      const stolen = `${file}.stale-${process.pid}-${Date.now()}`
      try {
        renameSync(file, stolen)
      }
      catch {
        continue
      }
      rmSync(stolen, { force: true })
      continue
    }
    // the claim is ours from here on; `task` is how the rest of ratoon finds this slot again
    writeFileSync(taskFile(root, dir), task)
    return true
  }
  return false
}

/** Give the slot back, but keep `task`: the work is still in it, just nobody is running a command. */
export function release(root: string, dir: string): void {
  const file = claimFile(root, dir)
  if (readClaim(file) !== process.pid)
    return
  rmSync(file, { force: true })
}

/** The slot is done with this task — free again. */
export function clearTask(root: string, dir: string): void {
  rmSync(claimFile(root, dir), { force: true })
  rmSync(taskFile(root, dir), { force: true })
}

function readTask(root: string, dir: string): string {
  try {
    return readFileSync(taskFile(root, dir), 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** Real path, case-folded on Windows — git reports the long form of a path, temp dirs are 8.3. */
function realKey(file: string): string {
  try {
    const resolved = realpathSync.native(file)
    return process.platform === 'win32'
      ? resolved.toLowerCase()
      : resolved
  }
  catch {
    const resolved = path.resolve(file)
    return process.platform === 'win32'
      ? resolved.toLowerCase()
      : resolved
  }
}

/** Branch per slot name, straight from git — one call for the whole pool. */
async function worktreeBranches(root: string, mainDir: string): Promise<Map<string, { path: string, branch: string }>> {
  const found = new Map<string, { path: string, branch: string }>()
  const result = await exec('git', [
    '-C',
    mainDir,
    'worktree',
    'list',
    '--porcelain',
  ])
  if (result.status !== 0)
    return found

  const rootKey = realKey(root)
  let current: { path: string, branch: string } | undefined
  const flush = (): void => {
    if (current) {
      const dir = path.basename(current.path)
      if (/^slot-\d+$/.test(dir) && realKey(path.dirname(current.path)) === rootKey)
        found.set(dir, current)
    }
    current = undefined
  }
  for (const raw of result.stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        branch: '',
      }
    }
    else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length)
    }
  }
  flush()
  return found
}

function bySlotName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

/** Every slot: what is on disk, what git knows about it, and what its state directory says. */
export async function scanPool(root: string, mainDir: string): Promise<PoolSlot[]> {
  const known = await worktreeBranches(root, mainDir)

  const names = new Set<string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^slot-\d+$/.test(entry.name))
      names.add(entry.name)
  }
  // a binding whose directory was deleted still belongs to this container — reporting it is what
  // lets `finish` say "the worktree is gone" instead of "there is no such task"
  for (const dir of known.keys())
    names.add(dir)

  return [...names].sort(bySlotName).map((dir) => {
    const slotPath = path.join(root, dir)
    const worktree = known.get(dir)
    return {
      dir,
      path: slotPath,
      worktree: worktree !== undefined,
      missing: !existsSync(slotPath),
      branch: worktree?.branch ?? '',
      task: readTask(root, dir),
      claimedBy: claimOn(root, dir),
    }
  })
}

/** The slots ratoon may hand out: real worktrees, parked, with no task and nobody in them. */
export function isFree(slot: PoolSlot): boolean {
  return slot.worktree && !slot.missing && !slot.branch && !slot.task && slot.claimedBy === 0
}

/**
 * The slot working on `task`: by its own `task` file, else by the branch it has checked out. The
 * second half is what makes a lost `.state/` recoverable instead of a dead end.
 */
export function slotForTask(pool: PoolSlot[], task: string, branch: string): PoolSlot | undefined {
  return pool.find(s => s.task === task) ?? pool.find(s => s.branch === branch)
}

/** One line per slot — the pool an error message can show without a JSON dump. */
export function poolSummary(pool: PoolSlot[]): string {
  if (pool.length === 0)
    return '  (no slots yet)'
  return pool.map((slot) => {
    if (slot.missing)
      return `  ${slot.dir}  missing (git still has the binding — \`git worktree prune\` clears it)`
    if (!slot.worktree)
      return `  ${slot.dir}  not a git worktree (left alone)`
    if (slot.task || slot.branch) {
      return `  ${slot.dir}  busy: ${slot.task || slot.branch}${slot.claimedBy
        ? ` (pid ${slot.claimedBy})`
        : ''}`
    }
    return `  ${slot.dir}  free`
  }).join('\n')
}
