import type { Repo } from '../helpers/repo.ts'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitAll,
  gitOut,
  makeRepo,
  ratoon,
  start,
  writeFile,
} from '../helpers/repo.ts'

const KEY = 'ratoon.poolPath'

let c: Repo
let base: string

beforeEach(async () => {
  c = await makeRepo({ init: false })
  base = path.join(c.tmp, 'pool-base')
})

afterEach(() => {
  c.dispose()
})

/** Where a repository's pool lands under a base — the same mirror the CLI computes. */
function poolFor(baseDir: string, repo: string = c.repo): string {
  const canonical = realpathSync.native(repo)
  const { root: volume } = path.parse(canonical)
  const drive = volume.replace(/[:/\\]/g, '').toLowerCase()
  return path.join(baseDir, drive, path.relative(volume, canonical))
}

function configure(value: string): void {
  gitOut(c.repo, 'config', '--local', KEY, value)
}

describe('a pool under a base directory', () => {
  it('mirrors the repository path under the base and leaves the repository untouched', async () => {
    configure(base)

    const result = await start(c, 'alpha')
    expect(result.status).toBe(0)
    // the pool repeats the repository path with the drive folded in, so it is never ambiguous
    expect(poolFor(base).startsWith(base)).toBe(true)
    expect(path.relative(base, poolFor(base))).not.toBe('')
    expect(existsSync(path.join(poolFor(base), 'slot-0', '.git'))).toBe(true)
    expect(existsSync(path.join(c.repo, '.ratoon'))).toBe(false)
    // no ratoon file lives in the project, so start must not add an ignore rule either
    expect(readFileSync(path.join(c.repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
    expect(gitOut(c.repo, 'status', '--porcelain', '-uall')).toBe('')
  })

  it('gives two repositories a pool each under one shared base', async () => {
    const globalConfig = path.join(c.tmp, 'global.gitconfig')
    gitOut(c.repo, 'config', '--file', globalConfig, KEY, base)
    const env = { GIT_CONFIG_GLOBAL: globalConfig }

    const first = await ratoon(['start', 'alpha'], { cwd: c.repo, env })
    expect(first.status).toBe(0)

    const sibling = path.join(c.tmp, 'sibling')
    mkdirSync(sibling, { recursive: true })
    gitOut(sibling, 'init', '-b', 'master')
    gitOut(sibling, 'config', 'user.email', 'ratoon@test')
    gitOut(sibling, 'config', 'user.name', 'ratoon')
    writeFile(path.join(sibling, 'sib.txt'), 'sib\n')
    await commitAll(sibling, 'init')

    const second = await ratoon(['start', 'beta'], { cwd: sibling, env })
    expect(second.status).toBe(0)

    // one base, two pools: the slots never meet
    expect(poolFor(base, sibling)).not.toBe(poolFor(base))
    expect(existsSync(path.join(poolFor(base, sibling), 'slot-0', '.git'))).toBe(true)
    const list = await ratoon(['list'], { cwd: c.repo, env })
    expect(list.stdout).toContain('slot-0')
    expect(list.stdout).not.toContain('unknown')
  })

  it('finds the pool from inside a slot with no flags', async () => {
    configure(base)
    await start(c, 'alpha')
    const pool = poolFor(base)

    const result = await ratoon(['list'], {
      cwd: path.join(pool, 'slot-0'),
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`pool: ${pool}`)
    expect(result.stdout).toContain('pool path set in')
    expect(result.stdout).toMatch(/slot-0\s+busy\s+alpha\s+feature\/alpha/)
  })

  it('finishes a task when the command runs from the external slot', async () => {
    configure(base)
    await start(c, 'alpha')
    const slot = path.join(poolFor(base), 'slot-0')
    writeFile(path.join(slot, 'alpha.txt'), 'alpha\n')
    await commitAll(slot, 'step one')

    const result = await ratoon(['finish', 'alpha', '-m', 'feat: alpha'], { cwd: slot })
    expect(result.status).toBe(0)
    expect(gitOut(c.repo, 'log', '--oneline', '-1')).toContain('feat: alpha')
  })

  it('resolves a relative base against the main working tree', async () => {
    configure('../pool-relative')

    const result = await start(c, 'alpha')
    expect(result.status).toBe(0)
    const pool = poolFor(path.join(c.tmp, 'pool-relative'))
    expect(existsSync(path.join(pool, 'slot-0', '.git'))).toBe(true)
  })

  it('honours a global setting without writing to the repository', async () => {
    const globalConfig = path.join(c.tmp, 'global.gitconfig')
    gitOut(c.repo, 'config', '--file', globalConfig, KEY, base)

    const result = await ratoon(['start', 'alpha'], {
      cwd: c.repo,
      env: { GIT_CONFIG_GLOBAL: globalConfig },
    })
    expect(result.status).toBe(0)
    expect(existsSync(path.join(poolFor(base), 'slot-0', '.git'))).toBe(true)
    expect(readFileSync(path.join(c.repo, '.git', 'config'), 'utf8')).not.toContain(KEY)
  })

  it('refuses a base that lands the pool inside the repository', async () => {
    // nothing in the project would ignore it: the slots become untracked files, and one
    // `git add -A` would commit every worktree
    configure('pools')
    const result = await start(c, 'alpha')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must point outside the repository or into .ratoon/')
    expect(existsSync(poolFor(path.join(c.repo, 'pools')))).toBe(false)

    // the repository itself lands the mirror inside it too
    configure('.')
    const self = await start(c, 'beta')
    expect(self.status).toBe(1)
    expect(self.stderr).toContain('must point outside the repository or into .ratoon/')

    // under .ratoon/ the mirror is inside the one ignore rule, so it is allowed
    configure('.ratoon/pools')
    const under = await start(c, 'gamma')
    expect(under.status).toBe(0)
    expect(existsSync(path.join(poolFor(path.join(c.repo, '.ratoon', 'pools')), 'slot-0', '.git'))).toBe(true)
    // the rule is written but uncommitted; the slots themselves never reach git status
    expect(gitOut(c.repo, 'status', '--porcelain', '-uall')).not.toContain('slot-0')
  })

  it('moves the base once every task is done, leaving only a parked slot behind', async () => {
    await start(c, 'alpha')
    const slot = path.join(c.pool, 'slot-0')
    writeFile(path.join(slot, 'alpha.txt'), 'alpha\n')
    await commitAll(slot, 'step one')
    const done = await ratoon(['finish', 'alpha', '-m', 'feat: alpha'], { cwd: slot })
    expect(done.status).toBe(0)

    // the slot is parked and detached, holding no task — it must not block the move
    configure(base)
    const moved = await start(c, 'beta')
    expect(moved.status).toBe(0)
    expect(existsSync(path.join(poolFor(base), 'slot-0', '.git'))).toBe(true)
  })

  it('refuses to strand slots when the pool path changes or disappears', async () => {
    configure(base)
    await start(c, 'alpha')

    configure(path.join(c.tmp, 'other-base'))
    const changed = await start(c, 'beta')
    expect(changed.status).toBe(1)
    expect(changed.stderr).toContain('git still has ratoon slots outside')
    expect(existsSync(poolFor(path.join(c.tmp, 'other-base')))).toBe(false)

    gitOut(c.repo, 'config', '--unset', KEY)
    const removed = await start(c, 'gamma')
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain('git still has ratoon slots outside')
    expect(readFileSync(path.join(c.repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
  })
})
