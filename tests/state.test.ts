import type { PoolSlot } from '../src/state.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/shell.ts'
import {
  claim,
  claimOn,
  clearTask,
  isFree,
  pidAlive,
  poolSummary,
  release,
  scanPool,
  slotForTask,
} from '../src/state.ts'

let tmp = ''
let root = ''
let mainDir = ''

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-C', cwd, ...args], { quiet: true })
}

/** A repository with one commit on master and no slots yet. */
async function makeRepo(): Promise<void> {
  mainDir = path.join(root, 'proj')
  mkdirSync(mainDir, { recursive: true })
  await git(mainDir, 'init', '-q', '-b', 'master')
  await git(mainDir, 'config', 'user.email', 'x@y')
  await git(mainDir, 'config', 'user.name', 'x')
  writeFileSync(path.join(mainDir, 'a.txt'), 'a\n')
  await git(mainDir, 'add', '.')
  await git(mainDir, 'commit', '-qm', 'init')
}

async function addSlot(dir = 'slot-0', branch = ''): Promise<void> {
  const slotPath = path.join(root, dir)
  if (branch) {
    await git(mainDir, 'branch', branch, 'master')
    await git(mainDir, 'worktree', 'add', '-q', slotPath, branch)
  }
  else {
    await git(mainDir, 'worktree', 'add', '-q', '--detach', slotPath, 'master')
  }
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon-state-'))
  root = path.join(tmp, 'root')
  mkdirSync(root, { recursive: true })
  await makeRepo()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function slot(dir: string): PoolSlot {
  return {
    dir,
    path: path.join(root, dir),
    worktree: true,
    missing: false,
    branch: '',
    task: '',
    claimedBy: 0,
  }
}

describe('scanPool', () => {
  it('is empty before there is a slot', async () => {
    expect(await scanPool(root, mainDir)).toEqual([])
  })

  it('reads dirs, branches and the per-slot state directory', async () => {
    await addSlot('slot-0', 'feature/alpha')
    await addSlot('slot-1')
    mkdirSync(path.join(root, '.state', 'slot-0'), { recursive: true })
    writeFileSync(path.join(root, '.state', 'slot-0', 'task'), 'alpha\n')

    const pool = await scanPool(root, mainDir)
    expect(pool.map(s => s.dir)).toEqual(['slot-0', 'slot-1'])
    expect(pool[0]).toMatchObject({
      branch: 'feature/alpha',
      task: 'alpha',
      worktree: true,
      missing: false,
    })
    expect(pool[1]).toMatchObject({ branch: '', task: '', worktree: true })
  })

  it('shows a directory git does not know, and a binding whose directory is gone', async () => {
    await addSlot('slot-0')
    mkdirSync(path.join(root, 'slot-1'))
    rmSync(path.join(root, 'slot-0'), { recursive: true, force: true })

    const pool = await scanPool(root, mainDir)
    expect(pool.find(s => s.dir === 'slot-0')).toMatchObject({ worktree: true, missing: true })
    expect(pool.find(s => s.dir === 'slot-1')).toMatchObject({ worktree: false, missing: false })
  })

  it('never reports a slot as claimed by a dead process', async () => {
    await addSlot('slot-0')
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    mkdirSync(path.join(root, '.state', 'slot-0'), { recursive: true })
    writeFileSync(path.join(root, '.state', 'slot-0', 'busy'), String(dead))

    const pool = await scanPool(root, mainDir)
    expect(pool[0]!.claimedBy).toBe(0)
    // residue is removed on sight, not left for someone to wonder about
    expect(existsSync(path.join(root, '.state', 'slot-0', 'busy'))).toBe(false)
  })
})

describe('claim', () => {
  it('is exclusive: the second attempt loses while the first is alive', () => {
    expect(claim(root, 'slot-0', 'alpha')).toBe(true)
    expect(claim(root, 'slot-0', 'beta')).toBe(false)
    expect(claimOn(root, 'slot-0')).toBe(process.pid)
  })

  it('takes over a claim whose process is gone', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    mkdirSync(path.join(root, '.state', 'slot-0'), { recursive: true })
    writeFileSync(path.join(root, '.state', 'slot-0', 'busy'), String(dead))

    expect(claim(root, 'slot-0', 'mine')).toBe(true)
    expect(claimOn(root, 'slot-0')).toBe(process.pid)
  })

  it('writes the task the slot is working on', () => {
    claim(root, 'slot-0', 'alpha')
    expect(readFileSync(path.join(root, '.state', 'slot-0', 'task'), 'utf8')).toBe('alpha')
  })

  it('release keeps the task, clearTask frees the slot', () => {
    claim(root, 'slot-0', 'alpha')
    release(root, 'slot-0')
    expect(claimOn(root, 'slot-0')).toBe(0)
    expect(existsSync(path.join(root, '.state', 'slot-0', 'task'))).toBe(true)

    clearTask(root, 'slot-0')
    expect(existsSync(path.join(root, '.state', 'slot-0', 'task'))).toBe(false)
  })

  it('does not release a claim that belongs to another process', () => {
    mkdirSync(path.join(root, '.state', 'slot-0'), { recursive: true })
    writeFileSync(path.join(root, '.state', 'slot-0', 'busy'), String(process.pid + 1))
    release(root, 'slot-0')
    expect(existsSync(path.join(root, '.state', 'slot-0', 'busy'))).toBe(true)
  })
})

describe('pidAlive', () => {
  it('knows our own pid is alive and a finished process is not', () => {
    expect(pidAlive(process.pid)).toBe(true)
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    expect(pidAlive(dead)).toBe(false)
  })
})

describe('isFree', () => {
  it('is a worktree, parked, with no task and nobody in it', () => {
    expect(isFree(slot('slot-0'))).toBe(true)
    expect(isFree({
      ...slot('slot-0'),
      branch: 'feature/x',
    })).toBe(false)
    expect(isFree({
      ...slot('slot-0'),
      task: 'x',
    })).toBe(false)
    expect(isFree({
      ...slot('slot-0'),
      claimedBy: 42,
    })).toBe(false)
    expect(isFree({
      ...slot('slot-0'),
      missing: true,
    })).toBe(false)
    expect(isFree({
      ...slot('slot-0'),
      worktree: false,
    })).toBe(false)
  })
})

describe('slotForTask', () => {
  it('prefers the recorded task, then the checked-out branch', () => {
    const pool: PoolSlot[] = [
      {
        ...slot('slot-0'),
        branch: 'feature/alpha',
      },
      {
        ...slot('slot-1'),
        task: 'alpha',
      },
    ]
    expect(slotForTask(pool, 'alpha', 'feature/alpha')?.dir).toBe('slot-1')

    const byBranch: PoolSlot[] = [
      {
        ...slot('slot-0'),
        branch: 'feature/alpha',
      },
    ]
    expect(slotForTask(byBranch, 'alpha', 'feature/alpha')?.dir).toBe('slot-0')
    expect(slotForTask(byBranch, 'beta', 'feature/beta')).toBeUndefined()
  })
})

describe('poolSummary', () => {
  it('says what each slot is doing, in one line each', () => {
    const summary = poolSummary([
      {
        ...slot('slot-0'),
        task: 'alpha',
        branch: 'feature/alpha',
        claimedBy: 42,
      },
      slot('slot-1'),
      {
        ...slot('slot-2'),
        missing: true,
      },
      {
        ...slot('slot-3'),
        worktree: false,
      },
    ])
    expect(summary).toContain('slot-0  busy: alpha (pid 42)')
    expect(summary).toContain('slot-1  free')
    expect(summary).toContain('slot-2  missing')
    expect(summary).toContain('slot-3  not a git worktree')
  })

  it('says so when the pool is empty', () => {
    expect(poolSummary([])).toBe('  (no slots yet)')
  })
})
