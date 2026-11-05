import type { Container } from '../helpers/container.ts'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  abandon as abandonCli,
  commitAll,
  finish,
  gitOut,
  gitStatus,
  makeContainer,
  slotBranch,
  slotDir,
  slotTask,
  start,
  writeFile,
} from '../helpers/container.ts'

let c: Container

beforeEach(async () => {
  c = await makeContainer()
})

afterEach(() => {
  c.dispose()
})

function abandon(task: string) {
  return abandonCli(c, task)
}

function slotState(dir = 'slot-0'): any {
  const task = slotTask(c, dir)
  const branch = slotBranch(c, dir)
  return {
    dir,
    task,
    branch,
    busy: task !== '' || branch !== '',
  }
}

function commitInSlot(file: string, content: string, message: string): void {
  writeFile(path.join(slotDir(c, 'slot-0'), file), content)
  gitOut(slotDir(c, 'slot-0'), 'add', file)
  gitOut(slotDir(c, 'slot-0'), 'commit', '-m', message)
}

describe('ratoon abandon', () => {
  it('discards a committed task and leaves the base alone', async () => {
    await start(c, 'dead-end')
    commitInSlot('a.txt', 'one\n', 'step one')
    commitInSlot('b.txt', 'two\n', 'step two')
    const base = gitOut(c.proj, 'rev-parse', 'master')

    const result = await abandon('dead-end')
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('[1/3] abandoning feature/dead-end in slot-0')
    expect(result.stdout).toContain('discarding 2 commits')
    // newest first, one per line — a receipt, not a paragraph
    expect(result.stdout).toMatch(/ {2}- step two\n {2}- step one/)
    expect(result.stdout).toContain('[2/3] parking slot slot-0')
    expect(result.stdout).toContain('[3/3] freeing slot-0 and deleting feature/dead-end')

    // the base never moved, and no branch is left behind
    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(base)
    expect(gitOut(c.proj, 'branch', '--list', 'feature/dead-end')).toBe('')
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')

    // parked and clean, exactly like a finished slot
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
    expect(slotState()).toMatchObject({ busy: false })

    // the "recover" line is a command that actually works
    const tip = result.stdout.match(/recover: git branch feature\/dead-end-rescued ([0-9a-f]{40})/)?.[1]
    expect(tip, result.stdout).toBeTruthy()
    gitOut(c.proj, 'branch', 'feature/dead-end-rescued', tip!)
    expect(gitOut(c.proj, 'show', 'feature/dead-end-rescued:b.txt')).toBe('two')
  })

  it('leaves the slot ready for the next task', async () => {
    await start(c, 'first-try')
    commitInSlot('a.txt', 'one\n', 'step one')
    await abandon('first-try')

    const next = await start(c, 'second-try')
    expect(next.status, `stdout:\n${next.stdout}\nstderr:\n${next.stderr}`).toBe(0)
    expect(next.stdout).toContain('[1/3] reusing free slot slot-0 for feature/second-try')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/second-try')
    expect(existsSync(path.join(slotDir(c, 'slot-0'), 'a.txt'))).toBe(false)
  })

  it('drops uncommitted work instead of pausing — a discard has nothing to resolve', async () => {
    await start(c, 'messy')
    writeFile(path.join(slotDir(c, 'slot-0'), 'README.md'), 'edited\n')
    writeFile(path.join(slotDir(c, 'slot-0'), 'junk.txt'), 'junk\n')

    const result = await abandon('messy')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('dropped 2 uncommitted entries')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
    expect(existsSync(path.join(slotDir(c, 'slot-0'), 'junk.txt'))).toBe(false)
    expect(gitOut(c.proj, 'show', 'master:README.md')).toBe('# fixture')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('aborts a rebase that finish paused on, so a discard never needs a resolution', async () => {
    await start(c, 'conflicted')
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 2\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'index.js')
    gitOut(slotDir(c, 'slot-0'), 'commit', '-m', 'task edit')
    writeFile(path.join(c.proj, 'index.js'), 'export const x = 3\n')
    await commitAll(c.proj, 'mainline edit')

    const paused = await finish(c, 'conflicted', ['-m', 'feat: conflicted'])
    expect(paused.status).toBe(2)
    const base = gitOut(c.proj, 'rev-parse', 'master')

    const result = await abandon('conflicted')
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('aborted the rebase that finish paused on')
    expect(result.stdout).toContain('discarding 1 commit')
    expect(gitOut(slotDir(c, 'slot-0'), 'status')).not.toContain('rebase')
    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(base)
    expect(gitOut(c.proj, 'branch', '--list', 'feature/conflicted')).toBe('')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('is idempotent: a second abandon says there is nothing left', async () => {
    await start(c, 'twice')
    expect((await abandon('twice')).status).toBe(0)

    const again = await abandon('twice')
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('Nothing to abandon — feature/twice does not exist and no slot is working on twice')
    // and it does not pretend to have done anything
    expect(again.stdout).not.toContain('Done.')
    expect(gitOut(c.proj, 'branch', '--list', 'feature/twice')).toBe('')
  })

  it('refuses to touch a slot that sits on another branch', async () => {
    await start(c, 'honest')
    commitInSlot('a.txt', 'one\n', 'step one')
    gitOut(slotDir(c, 'slot-0'), 'checkout', '-b', 'side-quest')

    const result = await abandon('honest')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('slot slot-0 is on branch side-quest, not feature/honest — nothing was changed')
    // still busy, branch intact, commit still there
    expect(gitOut(c.proj, 'branch', '--list', 'feature/honest')).toContain('feature/honest')
    expect(gitOut(slotDir(c, 'slot-0'), 'log', '-1', '--format=%s')).toBe('step one')
    expect(slotState()).toMatchObject({ busy: true, task: 'honest' })
  })

  it('says there is nothing to abandon when the task never existed', async () => {
    const result = await abandon('never-started')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Nothing to abandon — feature/never-started does not exist')
  })

  it('drops the branch when no worktree holds it any more', async () => {
    await start(c, 'orphan')
    commitInSlot('a.txt', 'one\n', 'step one')
    // somebody deleted the slot directory by hand: the branch is the task's only trace
    rmSync(slotDir(c, 'slot-0'), { recursive: true, force: true })

    const result = await abandon('orphan')
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(gitOut(c.proj, 'branch', '--list', 'feature/orphan')).toBe('')
  })
})
