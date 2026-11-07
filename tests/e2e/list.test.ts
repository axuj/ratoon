import type { Repo } from '../helpers/repo.ts'
import { mkdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  finish,
  gitOut,
  makeRepo,
  ratoon,
  slotDir,
  start,
} from '../helpers/repo.ts'

let c: Repo

beforeEach(async () => {
  c = await makeRepo()
})

afterEach(() => {
  c.dispose()
})

function list(extra: string[] = []) {
  return ratoon(['list', ...extra], { cwd: c.repo })
}

describe('ratoon list', () => {
  it('says so when the pool is empty', async () => {
    const result = await list()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`no slots yet in ${c.pool}`)
  })

  it('renders a table with status, task and checked-out branch', async () => {
    await start(c, 'alpha')
    await start(c, 'beta')

    const result = await list()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('SLOT')
    expect(result.stdout).toContain('STATUS')
    expect(result.stdout).toContain('slot-0')
    expect(result.stdout).toContain('slot-1')
    expect(result.stdout).toContain('feature/alpha')
    expect(result.stdout).toContain('feature/beta')
    expect(result.stdout).toContain('2 slot(s) · 2 busy · 0 free')
  })

  it('names the pool and the main repo above the table', async () => {
    await start(c, 'alpha')

    const result = await list()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`pool: ${c.pool}`)
    expect(result.stdout).toContain(`repo: ${c.repo}`)
    expect(result.stdout).toMatch(/slot-0\s+busy\s+alpha\s+feature\/alpha/)
  })

  it('finds the pool from inside the repository it manages', async () => {
    await start(c, 'alpha')

    const result = await ratoon(['list'], { cwd: c.repo })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`pool: ${c.pool}`)
    expect(result.stdout).toMatch(/slot-0\s+busy\s+alpha\s+feature\/alpha/)
  })

  it('finds the pool from a subdirectory of a slot', async () => {
    await start(c, 'alpha')

    const result = await ratoon(['list'], {
      cwd: path.join(slotDir(c, 'slot-0'), 'vendor'),
    })
    expect(result.status).toBe(0)
    // git reports the long form of a path; the temp directory is an 8.3 short name
    expect(result.stdout).toContain(`pool: ${realpathSync.native(c.pool)}`)
  })

  it('lists a repository that never ran init as having no slots', async () => {
    const outside = path.join(c.tmp, 'outside')
    mkdirSync(outside, { recursive: true })
    gitOut(outside, 'init', '-b', 'master')

    const result = await ratoon(['list'], { cwd: outside })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('no slots yet')
    expect(result.stdout).toContain(path.join(outside, '.ratoon', 'worktrees'))
  })

  it('shows a parked slot as free and detached once it is finished', async () => {
    await start(c, 'alpha')
    await finish(c, 'alpha', ['-m', 'feat: alpha'])

    const result = await list()
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/slot-0\s+free\s+—\s+\(detached\)/)
  })

  it('shows a directory with no worktree as unknown instead of hiding it', async () => {
    mkdirSync(path.join(c.pool, 'slot-0'), { recursive: true })
    await start(c, 'alpha') // lands in slot-1, because slot-0 is not the pool's to hand out

    const result = await list()
    expect(result.status).toBe(0)
    // the pool is the disk: slot-0 is a directory git does not know, so it is not a slot
    expect(result.stdout).toMatch(/slot-0\s+unknown\s+—\s+\(not a git worktree\)/)
    expect(result.stdout).toMatch(/slot-1\s+busy\s+alpha\s+feature\/alpha/)
    expect(result.stdout).toContain('2 slot(s) · 1 busy · 1 unknown · 0 free')
  })
})
