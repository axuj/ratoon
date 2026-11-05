import type { Container } from '../helpers/container.ts'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitAll,
  finish as finishCli,
  gitOut,
  gitStatus,
  hooksLine,
  makeContainer,
  slotBranch,
  slotDir,
  slotTask,
  start,
  waitForFile,
  writeFile,
  writeHooks,
} from '../helpers/container.ts'
import { BLOCKING_FINISH, FAIL_ON_FINISH, MARKER, TASK_FILE } from '../helpers/hooks.ts'

let c: Container

beforeEach(async () => {
  c = await makeContainer()
})

afterEach(() => {
  c.dispose()
})

function finish(task: string, extra: string[] = [], title = `feat: ${task}`) {
  return finishCli(c, task, ['-m', title, ...extra])
}

function finishUntitled(task: string) {
  return finishCli(c, task)
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

function commitInSlot(dir: string, file: string, content: string, message: string): void {
  writeFile(path.join(slotDir(c, dir), file), content)
  gitOut(slotDir(c, dir), 'add', file)
  gitOut(slotDir(c, dir), 'commit', '-m', message)
}

describe('ratoon finish', () => {
  it('parks a slot whose branch merged nothing and frees it', async () => {
    await start(c, 'empty-task')
    const before = gitOut(c.proj, 'rev-parse', 'master')

    // nothing to land means nothing to title — no `-m` needed
    const result = await finishUntitled('empty-task')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[1/4] verifying feature/empty-task in slot-0')
    expect(result.stdout).toContain('feature/empty-task is already on top of master')
    expect(result.stdout).toContain('[4/4] parking slot slot-0')
    expect(hooksLine(result.stdout)).toBe('plugins : none')

    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(before)
    expect(gitOut(c.proj, 'branch', '--list', 'feature/empty-task')).toBe('')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(slotState()).toMatchObject({ busy: false })
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('lands nothing when the task commits cancel out, instead of leaking drafts', async () => {
    await start(c, 'net-zero')
    const before = gitOut(c.proj, 'rev-parse', 'master')
    const slot = slotDir(c, 'slot-0')

    commitInSlot('slot-0', 'scratch.txt', 'work in progress\n', 'wip: try something')
    gitOut(slot, 'rm', 'scratch.txt')
    gitOut(slot, 'commit', '-m', 'wip: never mind')

    const result = await finish('net-zero')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`nothing : feature/net-zero changes nothing on master — nothing to land`)
    expect(result.stdout).not.toContain('squashed')

    // neither the drafts nor an empty commit: the base does not move at all
    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(before)
    expect(gitOut(c.proj, 'branch', '--list', 'feature/net-zero')).toBe('')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('prints the step log', async () => {
    writeHooks(c, MARKER)
    await start(c, 'logged-task')

    const result = await finish('logged-task')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[1/4] verifying feature/logged-task in slot-0')
    expect(result.stdout).toContain('[2/4] onFinish')
    expect(hooksLine(result.stdout)).toBe('plugins : loaded (marker)')
    expect(result.stdout).toContain('[3/4] landing feature/logged-task on master')
    expect(result.stdout).toContain('feature/logged-task is already on top of master')
    expect(result.stdout).toContain('[4/4] parking slot slot-0')
    expect(result.stdout).toContain('Done. Slot parked')
  })

  it('fast-forwards committed work into the base branch', async () => {
    await start(c, 'ship-it')
    commitInSlot('slot-0', 'feature.txt', 'hello\n', 'add feature')
    const head = gitOut(slotDir(c, 'slot-0'), 'rev-parse', 'HEAD')

    // title === the commit's own subject: nothing is rewritten, the sha is the one just made
    const result = await finish('ship-it', [], 'add feature')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('feature/ship-it is already on top of master')

    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(head)
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('lands a single commit under the title you give it, dropping the draft body', async () => {
    await start(c, 'retitled')
    commitInSlot('slot-0', 'a.txt', 'a\n', 'wip')
    gitOut(slotDir(c, 'slot-0'), 'commit', '--amend', '-m', 'wip', '-m', 'notes from the author')

    const result = await finish('retitled', [], 'feat(a): the real title')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('  commit  : feat(a): the real title')

    expect(gitOut(c.proj, 'show', '--format=%s', '-s', 'master')).toBe('feat(a): the real title')
    expect(gitOut(c.proj, 'show', '--format=%b', '-s', 'master')).toBe('')
    expect(gitOut(c.proj, 'rev-list', '--count', 'master')).toBe('2')
  })

  it('drops a draft body even when the subject already matches the title', async () => {
    await start(c, 'same-subject')
    commitInSlot('slot-0', 'a.txt', 'a\n', 'feat(same): final title')
    gitOut(slotDir(c, 'slot-0'), 'commit', '--amend', '-m', 'feat(same): final title', '-m', 'draft notes')

    const result = await finish('same-subject', [], 'feat(same): final title')
    expect(result.status).toBe(0)
    expect(gitOut(c.proj, 'show', '--format=%s', '-s', 'master')).toBe('feat(same): final title')
    expect(gitOut(c.proj, 'show', '--format=%b', '-s', 'master')).toBe('')
  })

  it('stamps the landing time on the commit it creates', async () => {
    await start(c, 'backdated')
    commitInSlot('slot-0', 'a.txt', 'a\n', 'wip')
    // a draft cannot smuggle its own timestamp onto the base: the landing commit is new
    gitOut(slotDir(c, 'slot-0'), 'commit', '--amend', '--no-edit', '--date', '2001-02-03T04:05:06')

    const result = await finish('backdated', [], 'feat: the real title')
    expect(result.status).toBe(0)
    const author = gitOut(c.proj, 'show', '-s', '--format=%aI', 'master')
    const committer = gitOut(c.proj, 'show', '-s', '--format=%cI', 'master')
    expect(author).toBe(committer)
    expect(author).not.toContain('2001')
  })

  it('rewrites nothing when the branch already carries the landing commit', async () => {
    const title = 'feat: already final\n\nsecond line'
    await start(c, 'already-final')
    commitInSlot('slot-0', 'a.txt', 'a\n', title)
    const branch = gitOut(c.proj, 'rev-parse', 'feature/already-final')

    const result = await finish('already-final', [], title)
    expect(result.status).toBe(0)
    expect(gitOut(c.proj, 'rev-parse', 'master')).toBe(branch)
  })

  it('refuses to land without a title, and says what the commits are', async () => {
    await start(c, 'untitled')
    commitInSlot('slot-0', 'a.txt', 'a\n', 'step one')

    const result = await finishUntitled('untitled')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('finish needs a title — pass -m "<title>"')
    expect(result.stderr).toContain('ratoon finish untitled -m "<title>"')
    expect(result.stderr).toContain('commits on feature/untitled:\n  step one')

    // nothing was touched: branch, commit, slot and base are exactly as they were
    expect(gitOut(c.proj, 'log', '--format=%s').split('\n')).toEqual(['init'])
    expect(gitOut(c.proj, 'branch', '--list', 'feature/untitled')).toContain('feature/untitled')
    expect(slotState()).toMatchObject({ busy: true, task: 'untitled', branch: 'feature/untitled' })
  })

  it('rebases onto the base branch when it moved on, keeping history linear', async () => {
    await start(c, 'behind-task')
    commitInSlot('slot-0', 'feature.txt', 'from task\n', 'task work')

    // someone else lands work on the base branch while the task runs
    writeFile(path.join(c.proj, 'unrelated.txt'), 'mainline\n')
    await commitAll(c.proj, 'mainline work')

    const result = await finish('behind-task')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('master has new commits — rebasing feature/behind-task onto master')

    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(gitOut(c.proj, 'rev-list', '--count', 'master')).toBe('3')
    expect(gitOut(c.proj, 'show', '--format=%s', '-s', 'master')).toBe('feat: behind-task')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('collapses a multi-commit task into a single commit on the base', async () => {
    await start(c, 'two-step')
    commitInSlot('slot-0', 'a.txt', 'a\n', 'step one')
    commitInSlot('slot-0', 'b.txt', 'b\n', 'step two')

    const before = Number(gitOut(c.proj, 'rev-list', '--count', 'master'))
    const result = await finish('two-step')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('  commit  : feat: two-step')
    expect(result.stdout).toContain('  squashed: 2 draft commits')

    // one task, one line on the base — titled by the caller; draft messages are gone
    expect(Number(gitOut(c.proj, 'rev-list', '--count', 'master'))).toBe(before + 1)
    expect(gitOut(c.proj, 'show', '--format=%s', '-s', 'master')).toBe('feat: two-step')
    expect(gitOut(c.proj, 'show', '--format=%b', '-s', 'master')).toBe('')
    expect(gitOut(c.proj, 'show', 'master:a.txt')).toBe('a')
    expect(gitOut(c.proj, 'show', 'master:b.txt')).toBe('b')
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  })

  it('refuses to merge a dirty worktree and says what each kind of dirt wants', async () => {
    await start(c, 'dirty-task')
    writeFile(path.join(slotDir(c, 'slot-0'), 'scratch.txt'), 'uncommitted\n')

    const result = await finish('dirty-task')
    // exit 2 = paused, nothing changed: fix the worktree, run the same command again
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('has uncommitted changes')
    expect(result.stderr).toContain('?? scratch.txt')
    expect(result.stderr).toContain('untracked leftovers')
    expect(result.stderr).not.toContain('changes to versioned files')

    // nothing was merged and the slot is still taken
    expect(gitOut(c.proj, 'branch', '--list', 'feature/dirty-task')).toContain('feature/dirty-task')
    expect(slotState()).toMatchObject({ busy: true, task: 'dirty-task' })
  })

  it('offers the commit-or-discard hint when versioned files changed', async () => {
    await start(c, 'tracked-dirty')
    writeFile(path.join(slotDir(c, 'slot-0'), 'README.md'), 'edited\n')

    const result = await finish('tracked-dirty')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('changes to versioned files')
    expect(result.stderr).toContain('checkout -- .')
    expect(result.stderr).not.toContain('untracked leftovers')
    expect(slotState()).toMatchObject({ busy: true })
  })

  it('keeps the notes out of the tree, so finish never sees them as dirt', async () => {
    writeHooks(c, TASK_FILE)
    await start(c, 'scratch-task')

    const notes = path.join(c.root, '.state', 'slot-0', 'TASK.md')
    expect(existsSync(notes)).toBe(true)
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])

    const result = await finish('scratch-task')
    expect(result.status).toBe(0)
    expect(hooksLine(result.stdout)).toBe('plugins : loaded (progressFile)')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('keeps the notes readable when finish pauses', async () => {
    writeHooks(c, TASK_FILE)
    await start(c, 'paused-notes')

    // dirt the hook does not know about: onFinish runs, then the dirty check pauses
    writeFile(path.join(slotDir(c, 'slot-0'), 'oops.txt'), 'x\n')

    const result = await finish('paused-notes')
    expect(result.status).toBe(2)

    const notes = path.join(c.root, '.state', 'slot-0', 'TASK.md')
    expect(readFileSync(notes, 'utf8')).toContain('TASK: paused-notes')
  })

  it('runs onFinish while another task starts in another slot', async () => {
    await start(c, 'slow-hook')
    writeHooks(c, BLOCKING_FINISH)

    // the hook announces itself and then waits for us — no sleeping and hoping
    const finishing = finish('slow-hook')
    await waitForFile(path.join(c.root, 'hook-running'))

    // still blocked: a start must not be waiting on user code in another slot
    const other = await start(c, 'meanwhile')
    expect(other.status, `stdout:\n${other.stdout}\nstderr:\n${other.stderr}`).toBe(0)
    expect(slotState('slot-1')).toMatchObject({ busy: true, task: 'meanwhile' })

    writeFile(path.join(c.root, 'hook-release'), '')
    const done = await finishing
    expect(done.status, `stdout:\n${done.stdout}\nstderr:\n${done.stderr}`).toBe(0)
    expect(hooksLine(done.stdout)).toBe('plugins : loaded (blocking)')
    expect(slotState('slot-0')).toMatchObject({ busy: false })
  })

  it('lets only one finish into a slot — the other pauses without changing anything', async () => {
    await start(c, 'same-task')
    commitInSlot('slot-0', 'a.txt', 'one\n', 'step one')
    writeHooks(c, BLOCKING_FINISH)

    const first = finish('same-task')
    await waitForFile(path.join(c.root, 'hook-running'))

    // the slot is claimed for the whole finish, so this one cannot get in at all
    const second = await finish('same-task')
    expect(second.status).toBe(2)
    expect(second.stderr).toMatch(/slot slot-0 is busy \(pid \d+\)/)
    expect(second.stderr).toContain('nothing was changed')
    expect(gitOut(c.proj, 'log', '--format=%s')).toBe('init')

    writeFile(path.join(c.root, 'hook-release'), '')
    const done = await first
    expect(done.status, `stdout:\n${done.stdout}\nstderr:\n${done.stderr}`).toBe(0)
    expect(gitOut(c.proj, 'log', '--format=%s').split('\n')).toEqual(['feat: same-task', 'init'])
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('fails before touching git state when onFinish throws', async () => {
    writeHooks(c, FAIL_ON_FINISH)
    await start(c, 'fail-finish')

    const result = await finish('fail-finish')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('plugin "boom" failed in onFinish')
    expect(result.stderr).toContain('finish boom')

    expect(gitOut(c.proj, 'branch', '--list', 'feature/fail-finish')).toContain('feature/fail-finish')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/fail-finish')
    expect(slotState()).toMatchObject({ busy: true, task: 'fail-finish' })
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('errors when no slot knows the task', async () => {
    const result = await finish('never-started')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no slot is working on task never-started')
  })

  it('errors when the slot is not on the expected branch', async () => {
    await start(c, 'switched-task')
    gitOut(slotDir(c, 'slot-0'), 'checkout', '--detach', 'master')

    const result = await finish('switched-task')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('expected feature/switched-task')
    expect(slotState()).toMatchObject({ busy: true })
  })

  it('frees the slot so the next start reuses it without reinstalling', async () => {
    await start(c, 'first-round')
    expect((await finish('first-round')).status).toBe(0)

    const second = await start(c, 'second-round')
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('[1/3] reusing free slot slot-0 for feature/second-round')
    expect(second.stdout).toContain('[3/3] slot slot-0 ready (reused)')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('leaves a conflicted rebase detectable rather than half-merged', async () => {
    await start(c, 'clashing-task')
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 2\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'index.js')
    gitOut(slotDir(c, 'slot-0'), 'commit', '-m', 'task edit')
    writeFile(path.join(c.proj, 'index.js'), 'export const x = 3\n')
    await commitAll(c.proj, 'mainline edit')

    const first = await finish('clashing-task')
    expect(first.status).toBe(2)
    expect(first.stderr).toContain('git rebase')
    expect(first.stderr).toContain('run the same command again')
    expect(first.stderr).toContain(path.join(slotDir(c, 'slot-0'), 'index.js'))
    // git's own hint would say `git rebase --continue` — it must not reach the caller
    expect(first.stderr).not.toContain('hint:')

    const second = await finish('clashing-task')
    expect(second.status).toBe(2)
    expect(second.stderr).toContain('unfinished rebase detected')
    expect(second.stderr).toContain('index.js')
    expect(slotState()).toMatchObject({ busy: true, task: 'clashing-task' })
  })

  it('needs only the file edited — finish stages and completes the rebase itself', async () => {
    await start(c, 'edit-only')
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 2\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'index.js')
    gitOut(slotDir(c, 'slot-0'), 'commit', '-m', 'task edit')
    writeFile(path.join(c.proj, 'index.js'), 'export const x = 3\n')
    await commitAll(c.proj, 'mainline edit')

    const first = await finish('edit-only')
    expect(first.status).toBe(2)

    // no `git add`, no `git rebase --continue` — just the edit an agent would make anyway
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 4\n')

    const second = await finish('edit-only')
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    expect(second.stdout).toContain('conflicts resolved — continuing the rebase')
    expect(gitOut(c.proj, 'show', 'master:index.js')).toBe('export const x = 4')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('resumes the rebase itself once the resolutions are staged', async () => {
    await start(c, 'resolve-me')
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 2\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'index.js')
    gitOut(slotDir(c, 'slot-0'), 'commit', '-m', 'task edit')
    writeFile(path.join(c.proj, 'index.js'), 'export const x = 3\n')
    await commitAll(c.proj, 'mainline edit')

    const first = await finish('resolve-me')
    expect(first.status).toBe(2)
    expect(first.stderr).toContain('git rebase')
    expect(first.stderr).toContain('run the same command again')

    // resolve in the slot and stage it — nobody is handed `git rebase --continue` to type
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 4\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'index.js')

    const second = await finish('resolve-me')
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    expect(second.stdout).toContain('conflicts resolved — continuing the rebase')
    expect(second.stdout).toContain('Done. Slot parked')
    expect(gitOut(c.proj, 'show', 'master:index.js')).toBe('export const x = 4')
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(slotState()).toMatchObject({ busy: false })
  })

  it('collapses first, so two colliding commits still pause only once', async () => {
    await start(c, 'twice')
    commitInSlot('slot-0', 'index.js', 'export const x = 11\n', 'step one')
    commitInSlot('slot-0', 'index.js', 'export const x = 22\n', 'step two')
    writeFile(path.join(c.proj, 'index.js'), 'export const x = 33\n')
    await commitAll(c.proj, 'mainline edit')

    // the squash runs before the rebase, so only one commit is ever replayed
    const first = await finish('twice')
    expect(first.status).toBe(2)
    expect(first.stdout).toContain('  squashed: 2 draft commits')
    expect(first.stderr).toContain('while rebasing onto master')
    expect(first.stderr).toContain(path.join(slotDir(c, 'slot-0'), 'index.js'))

    // one edit is the whole round trip — no second stop, no bare `command failed (1)`
    writeFile(path.join(slotDir(c, 'slot-0'), 'index.js'), 'export const x = 222\n')
    const second = await finish('twice')
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    expect(second.stdout).toContain('conflicts resolved — continuing the rebase')
    expect(second.stdout).toContain('Done. Slot parked')

    expect(gitOut(c.proj, 'show', '--format=%s', '-s', 'master')).toBe('feat: twice')
    expect(gitOut(c.proj, 'show', '--format=%b', '-s', 'master')).toBe('')
    expect(gitOut(c.proj, 'show', 'master:index.js')).toBe('export const x = 222')
    expect(gitOut(c.proj, 'rev-list', '--merges', 'master')).toBe('')
    expect(slotState()).toMatchObject({ busy: false })
  })
})
