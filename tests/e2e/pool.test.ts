import type { Repo } from '../helpers/repo.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitOut, hooksLine, makeRepo, ratoon } from '../helpers/repo.ts'

/**
 * The pool outside the repository: every command resolves it from git, with no flags, whether run
 * from the repository itself, a slot, or a nested directory — and the project gains nothing.
 */
let c: Repo

beforeEach(async () => {
  c = await makeRepo()
})

afterEach(() => {
  c.dispose()
})

function commitInSlot(task: string): void {
  const slot = path.join(c.pool, 'slot-0')
  writeFileSync(path.join(slot, 'feature.txt'), `${task}\n`)
  gitOut(slot, 'add', '-A')
  gitOut(slot, 'commit', '-m', 'work')
}

describe('the default pool', () => {
  it('lives outside the project, mirrored under XDG_DATA_HOME', async () => {
    const base = process.env.XDG_DATA_HOME ?? ''
    expect(base).not.toBe('')
    // outside the working tree, so nothing in the project can see a second copy of it
    expect(path.relative(c.repo, c.pool).startsWith('..')).toBe(true)
    expect(c.pool.startsWith(path.join(base, 'ratoon', 'pools'))).toBe(true)
    // the repository path is mirrored, so two checkouts called `repo` never share a pool
    expect(path.basename(c.pool)).toBe('repo')

    const started = await ratoon(['start', 'alpha'], { cwd: c.repo })
    expect(started.status, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0)
    expect(started.stdout).toContain(`worktree: ${path.join(c.pool, 'slot-0')}`)

    const listed = await ratoon(['list'], { cwd: c.repo })
    expect(listed.stdout).toContain(`pool: ${c.pool}`)
    // a derived default is not a configured one
    expect(listed.stdout).not.toContain('pool path set in')
  })

  it('runs start, list and finish from the repository with no flags', async () => {
    const started = await ratoon(['start', 'alpha'], { cwd: c.repo })
    expect(started.status, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0)
    expect(started.stdout).toContain('slot-0')
    expect(existsSync(path.join(c.pool, 'slot-0', '.git'))).toBe(true)

    const listed = await ratoon(['list'], { cwd: c.repo })
    expect(listed.status, `stdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`).toBe(0)
    expect(listed.stdout).toMatch(/slot-0\s+busy\s+alpha/)

    commitInSlot('alpha')
    const finished = await ratoon(['finish', 'alpha', '-m', 'feat: alpha'], { cwd: c.repo })
    expect(finished.status, `stdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`).toBe(0)
    expect(gitOut(c.repo, 'log', '-1', '--format=%s')).toBe('feat: alpha')
    expect(gitOut(c.repo, 'status', '--porcelain', '-uall')).toBe('')
  })

  it('works in a repository that never ran init and writes nothing into it', async () => {
    const plain = await makeRepo({ init: false })
    try {
      const started = await ratoon(['start', 'first'], { cwd: plain.repo })
      expect(started.status, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0)
      // no hooks, no config: the slot still works, and the project is left exactly as it was
      expect(hooksLine(started.stdout)).toBe('plugins : none')
      expect(gitOut(plain.repo, 'status', '--porcelain', '-uall')).toBe('')
      expect(readFileSync(path.join(plain.repo, '.gitignore'), 'utf8')).toBe('node_modules/\n')
      expect(existsSync(path.join(plain.repo, '.ratoon'))).toBe(false)
      expect(existsSync(path.join(plain.pool, 'slot-0', '.git'))).toBe(true)
    }
    finally {
      plain.dispose()
    }
  })

  it('finishes from inside a slot', async () => {
    const started = await ratoon(['start', 'beta'], { cwd: c.repo })
    expect(started.status, started.stderr).toBe(0)

    const slot = path.join(c.pool, 'slot-0')
    commitInSlot('beta')
    const finished = await ratoon(['finish', 'beta', '-m', 'feat: beta'], { cwd: slot })
    expect(finished.status, `stdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`).toBe(0)
    expect(gitOut(c.repo, 'log', '-1', '--format=%s')).toBe('feat: beta')
  })

  it('a second start from inside a slot reuses the same pool', async () => {
    const first = await ratoon(['start', 'one'], { cwd: c.repo })
    expect(first.status, first.stderr).toBe(0)

    const slot = path.join(c.pool, 'slot-0')
    const second = await ratoon(['start', 'two'], { cwd: slot })
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    expect(existsSync(path.join(c.pool, 'slot-1'))).toBe(true)
    // no nested pool, no sibling pool
    expect(existsSync(path.join(slot, '.ratoon', 'worktrees'))).toBe(false)
    expect(existsSync(path.join(c.tmp, 'repo-wt'))).toBe(false)
  })

  it('keeps the pool out of reach of git clean -fdx', async () => {
    // the pool is not in the working tree, so a clean never touches it — with or without a slot
    mkdirSync(c.pool, { recursive: true })
    gitOut(c.repo, 'clean', '-fdx')
    expect(existsSync(c.pool)).toBe(true)

    const first = await ratoon(['start', 'alpha'], { cwd: c.repo })
    expect(first.status, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0)
    expect(existsSync(c.pool)).toBe(true)

    gitOut(c.repo, 'clean', '-fdx')
    expect(existsSync(path.join(c.pool, 'slot-0', '.git'))).toBe(true)
    expect(existsSync(path.join(c.pool, '.state', 'slot-0', 'task'))).toBe(true)

    const listed = await ratoon(['list'], { cwd: c.repo })
    expect(listed.status, listed.stderr).toBe(0)
    expect(listed.stdout).toMatch(/slot-0\s+busy\s+alpha/)
    const again = await ratoon(['start', 'beta'], { cwd: c.repo })
    expect(again.status, `stdout:\n${again.stdout}\nstderr:\n${again.stderr}`).toBe(0)
  })

  it('runs pool-level hooks before the repository hooks', async () => {
    mkdirSync(c.pool, { recursive: true })
    writeFileSync(
      path.join(c.pool, 'hooks.ts'),
      'export default [{ name: \'pool-plugin\', onStart() {} }]\n',
    )
    writeFileSync(
      path.join(c.repo, '.ratoon', 'hooks.ts'),
      'export default [{ name: \'project-plugin\', onStart() {} }]\n',
    )

    const started = await ratoon(['start', 'hooks'], { cwd: c.repo })
    expect(started.status, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0)
    expect(hooksLine(started.stdout)).toBe('plugins : loaded (pool-plugin, project-plugin)')
  })
})
