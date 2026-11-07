import type { Repo } from '../helpers/repo.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitOut, hooksLine, makeRepo, ratoon } from '../helpers/repo.ts'

/**
 * The pool inside the repository: every command resolves it from git, with no flags, whether run
 * from the repository itself, a slot, or a nested directory.
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

describe('pool inside the repository', () => {
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
    expect(gitOut(c.repo, 'status', '--porcelain', '-uall')).not.toContain('.ratoon/worktrees')
  })

  it('works in a repository that never ran init — start writes the ignore line', async () => {
    const plain = await makeRepo({ init: false })
    try {
      const started = await ratoon(['start', 'first'], { cwd: plain.repo })
      expect(started.status, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0)
      // no hooks, no config: the slot still works, and the only edit is the one ignore line
      expect(hooksLine(started.stdout)).toBe('plugins : none')
      expect(started.stdout).toContain('added .ratoon/*')
      expect(gitOut(plain.repo, 'status', '--porcelain', '-uall')).toBe('M .gitignore')
      expect(existsSync(path.join(plain.pool, 'slot-0', '.git'))).toBe(true)
      expect(existsSync(path.join(plain.repo, '.ratoon', 'hooks.ts'))).toBe(false)
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

  it('survives git clean -fdx, with and without a live slot', async () => {
    // an empty ignored pool is removed entirely — the committed config is the installation marker
    mkdirSync(c.pool, { recursive: true })
    gitOut(c.repo, 'clean', '-fdx')
    expect(existsSync(c.pool)).toBe(false)

    const first = await ratoon(['start', 'alpha'], { cwd: c.repo })
    expect(first.status, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0)
    expect(existsSync(c.pool)).toBe(true)

    // with a worktree present git skips the nested repository, but the state is still wiped
    gitOut(c.repo, 'clean', '-fdx')
    expect(existsSync(path.join(c.pool, 'slot-0', '.git'))).toBe(true)
    expect(existsSync(path.join(c.pool, '.state', 'slot-0', 'task'))).toBe(false)

    const listed = await ratoon(['list'], { cwd: c.repo })
    expect(listed.status, listed.stderr).toBe(0)
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
