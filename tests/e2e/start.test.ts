import type { Container } from '../helpers/container.ts'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commitAll,

  finish,
  gitOut,
  gitStatus,
  hooksLine,
  installDeps,
  makeContainer,
  parkSlot,
  readRootFile,
  slotBranch,
  slotDir,
  slotDirs,
  slotTask,
  start,
  waitForFile,
  writeFile,
  writeHooks,
} from '../helpers/container.ts'
import { BLOCKING_ALLOCATE, FAIL_ON_START, FAILING_PLUGIN, INSTALL, MARKER, NOISY, ORDERED, TASK_FILE } from '../helpers/hooks.ts'

let c: Container

beforeEach(async () => {
  c = await makeContainer()
})

afterEach(() => {
  c.dispose()
})

function stageLog(): string[] {
  return readRootFile(c, 'stages.log').split('\n').filter(Boolean)
}

function stateFile(): string {
  return path.join(c.root, '.state', 'slot-0', 'install')
}

describe('ratoon start', () => {
  it('allocates a slot, branches, and prints the summary', async () => {
    const result = await start(c, 'alpha')
    expect(result.status).toBe(0)

    expect(result.stdout).toContain('[3/3] slot slot-0 ready (new)')
    expect(result.stdout).toContain('branch  : feature/alpha')
    expect(result.stdout).toContain(`worktree: ${slotDir(c, 'slot-0')}`)
    expect(result.stdout).toContain('base    : master')
    expect(hooksLine(result.stdout)).toBe('plugins : none')

    expect(slotDirs(c)).toEqual(['slot-0'])
    expect(slotTask(c)).toBe('alpha')
    expect(slotBranch(c)).toBe('feature/alpha')

    expect(gitOut(c.proj, 'branch', '--list', 'feature/alpha')).toContain('feature/alpha')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('keeps hooks in the container root, out of every worktree', async () => {
    writeHooks(c, MARKER)
    await start(c, 'hooked')

    expect(existsSync(path.join(c.root, '.ratoon', 'hooks.ts'))).toBe(true)
    expect(existsSync(path.join(slotDir(c, 'slot-0'), '.ratoon'))).toBe(false)
    expect(slotTask(c)).toBe('hooked')
  })

  it('runs the array in order — that is the only ordering rule', async () => {
    writeHooks(c, ORDERED)
    const result = await start(c, 'ordered')

    expect(hooksLine(result.stdout)).toBe('plugins : loaded (alpha, beta)')
    expect(stageLog()).toEqual(['A', 'B'])
  })

  it('reports a lifecycle as untouched when no plugin implements it', async () => {
    writeHooks(c, `export default [{ name: 'only-finish', onFinish() {} }]\n`)
    const result = await start(c, 'only-finish')
    expect(hooksLine(result.stdout)).toBe('plugins : loaded (none)')
  })

  it('says so when the hook file enables nothing, and points at the starters', async () => {
    writeHooks(c, 'export default []\n')
    const result = await start(c, 'empty-hooks')

    expect(result.status).toBe(0)
    expect(hooksLine(result.stdout)).toBe('plugins : loaded (no plugins)')
    expect(result.stdout).toContain('.ratoon/hooks.ts enables no plugins')
  })

  it('warns that uncommitted work in the main worktree is not in the slot', async () => {
    const result = await start(c, 'dirty-main')

    expect(result.status).toBe(0)
    // the container fixture is committed by makeContainer, so this run is clean
    expect(result.stderr).not.toContain('uncommitted')

    writeFile(path.join(c.proj, 'README.md'), 'edited in main\n')
    const second = await start(c, 'dirty-main-again')
    expect(second.stderr).toContain('main worktree has')
    expect(second.stderr).toContain('not in it')
  })

  it('lets the built-in install plugin own dependencies: install, skip, reinstall', async () => {
    // the only case here that proves a real install: the committed lockfile makes the fingerprint
    // stable, so the second start can genuinely skip
    await installDeps(c)
    writeHooks(c, INSTALL)

    const first = await start(c, 'first-round')
    expect(hooksLine(first.stdout)).toBe('plugins : loaded (npmInstall)')
    expect(existsSync(path.join(slotDir(c, 'slot-0'), 'node_modules', 'tiny'))).toBe(true)

    const state = stateFile()
    expect(existsSync(state)).toBe(true)
    const afterFirst = readFileSync(state, 'utf8')
    const mtimeAfterFirst = statSync(state).mtimeMs

    // nothing changed — the plugin must not touch its state file
    parkSlot(c)
    await start(c, 'second-round')
    expect(readFileSync(state, 'utf8')).toBe(afterFirst)
    expect(statSync(state).mtimeMs).toBe(mtimeAfterFirst)

    // the manifest changes in the main repo, so the fingerprint no longer matches
    const pkgPath = path.join(c.proj, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.description = 'bumped'
    writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    await commitAll(c.proj, 'bump manifest')
    parkSlot(c)
    await start(c, 'third-round')
    expect(readFileSync(state, 'utf8')).not.toBe(afterFirst)
  })

  it('does nothing install-shaped for a non-JS project', async () => {
    c.dispose()
    c = await makeContainer({ withPackageJson: false })
    writeHooks(c, INSTALL)

    await start(c, 'plain')
    expect(existsSync(stateFile())).toBe(false)
    expect(existsSync(path.join(slotDir(c, 'slot-0'), 'node_modules'))).toBe(false)
  })

  it('writes the progress file outside the worktree, so the tree stays clean', async () => {
    writeHooks(c, TASK_FILE)
    const result = await start(c, 'progress')

    expect(hooksLine(result.stdout)).toBe('plugins : loaded (progressFile)')
    const notes = path.join(c.root, '.state', 'slot-0', 'TASK.md')
    expect(readFileSync(notes, 'utf8')).toContain('TASK: progress')
    expect(result.stdout).toContain('notes   :')
    expect(gitStatus(slotDir(c, 'slot-0'))).toEqual([])
  })

  it('shows hook output next to the step log', async () => {
    writeHooks(c, NOISY)

    const result = await start(c, 'noisy')
    expect(result.status).toBe(0)

    expect(result.stdout).toContain('noisy hook output')
    expect(result.stdout).toContain('[3/3] slot slot-0 ready (new)')
  })

  it('rolls back a NEW slot when onStart throws', async () => {
    await start(c, 'occupier')
    writeHooks(c, FAIL_ON_START)

    const result = await start(c, 'victim')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('plugin "boom" failed in onStart')
    expect(result.stderr).toContain('start boom')

    expect(slotDirs(c)).toEqual(['slot-0'])
    expect(gitOut(c.proj, 'branch', '--list', 'feature/victim')).toBe('')
    expect(slotTask(c)).toBe('occupier')
  })

  it('rolls back a REUSED slot when onStart throws', async () => {
    await start(c, 'occupier')
    parkSlot(c)
    writeHooks(c, FAIL_ON_START)

    const result = await start(c, 'victim')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('plugin "boom" failed in onStart')

    expect(slotTask(c)).toBe('')
    expect(gitOut(c.proj, 'branch', '--list', 'feature/victim')).toBe('')
    // parked back at the base ref instead of being left on a dead branch
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', 'HEAD')).toBe(gitOut(c.proj, 'rev-parse', 'master'))
  })

  it('rolls back — and names the plugin — when a plugin throws', async () => {
    await start(c, 'occupier')
    parkSlot(c)
    writeHooks(c, FAILING_PLUGIN)

    const result = await start(c, 'victim')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('plugin "exploder" failed in onStart')
    expect(result.stderr).toContain('plugin boom')

    expect(slotTask(c)).toBe('')
    expect(gitOut(slotDir(c, 'slot-0'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  })

  it('gives two concurrent starts two different slots', async () => {
    const [a, b] = await Promise.all([
      start(c, 'first'),
      start(c, 'second'),
    ])
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)

    expect(slotDirs(c)).toEqual(['slot-0', 'slot-1'])
    expect([
      slotTask(c, 'slot-0'),
      slotTask(c, 'slot-1'),
    ].sort()).toEqual(['first', 'second'])
    expect([
      slotBranch(c, 'slot-0'),
      slotBranch(c, 'slot-1'),
    ].sort())
      .toEqual(['feature/first', 'feature/second'])
  })

  it('runs onBeforeCheckout outside the lock, so another task can claim a slot meanwhile', async () => {
    writeHooks(c, BLOCKING_ALLOCATE)

    const first = start(c, 'slow-claim')
    await waitForFile(path.join(c.root, 'hook-running'))

    // the first start is still inside its hook — the claim is over, so this must not wait for it
    const second = await start(c, 'meanwhile')
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    // slot-0 is claimed but not created yet (the hook runs before git touches it), so the second
    // start had to grow the pool — the point is that it did not wait for the first one
    expect(slotDirs(c)).toEqual(['slot-1'])

    writeFile(path.join(c.root, 'hook-release'), '')
    const done = await first
    expect(done.status, `stdout:\n${done.stdout}\nstderr:\n${done.stderr}`).toBe(0)
    expect(done.stdout).toContain('[3/3] slot slot-0 ready (new)')
    expect(slotDirs(c)).toEqual(['slot-0', 'slot-1'])
  })

  it('refuses to start a task whose branch already exists', async () => {
    await start(c, 'dupe')

    const again = await start(c, 'dupe')
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('branch feature/dupe already exists')
    expect(slotDirs(c)).toHaveLength(1)
  })

  it('onBeforeCheckout reads the slot as the previous task left it', async () => {
    writeHooks(c, `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default [{
  name: 'probe',
  onBeforeCheckout({ slotDir, rootDir }) {
    const manifest = path.join(slotDir, 'package.json')
    writeFileSync(path.join(rootDir, 'seen.txt'), existsSync(manifest) ? readFileSync(manifest, 'utf8') : 'missing')
  },
}]
`)

    // 1) 槽里把 manifest 定成 0.1.0，落进主线
    await start(c, 'old')
    const slotPkg = path.join(slotDir(c, 'slot-0'), 'package.json')
    writeFile(slotPkg, '{ "name": "demo", "version": "0.1.0" }\n')
    gitOut(slotDir(c, 'slot-0'), 'add', 'package.json')
    gitOut(slotDir(c, 'slot-0'), 'commit', '-m', 'v0')
    await finish(c, 'old', ['-m', 'feat: old'])

    // 2) 主线前进到 1.0.0 —— 槽停在 finish 时的 base，磁盘上还是 0.1.0
    writeFile(path.join(c.proj, 'package.json'), '{ "name": "demo", "version": "1.0.0" }\n')
    await commitAll(c.proj, 'bump main')

    // 3) 复用槽：钩子在 git 改写之前跑，必须读到旧的
    const result = await start(c, 'new')
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(readRootFile(c, 'seen.txt')).toContain('0.1.0')

    // …而 start 结束后，槽里已经是主线的 1.0.0
    expect(readFileSync(slotPkg, 'utf8')).toContain('1.0.0')
  })

  it('prints the step log', async () => {
    writeHooks(c, MARKER)
    const result = await start(c, 'logged')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[1/3] creating new slot slot-0 for feature/logged')
    expect(result.stdout).toContain('[2/3] onStart')
    expect(result.stdout).toContain('[3/3] slot slot-0 ready (new)')
    expect(hooksLine(result.stdout)).toBe('plugins : loaded (marker)')
  })

  it('never deletes a worktree just because its state went missing', async () => {
    await start(c, 'alpha')
    writeFile(path.join(slotDir(c, 'slot-0'), 'uncommitted.txt'), 'live work\n')

    // The realistic way a slot's state disappears: `.state/` is deleted or restored from an old
    // backup. The worktree is still on feature/alpha with uncommitted work in it, and nothing may
    // reuse, park or delete it on the strength of a missing file.
    rmSync(path.join(c.root, '.state', 'slot-0'), { recursive: true, force: true })

    const result = await start(c, 'beta')
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)

    // beta went to the next free *name*, and alpha's slot is exactly as it was left
    expect(result.stdout).toContain('[1/3] creating new slot slot-1 for feature/beta')
    expect(readFileSync(path.join(slotDir(c, 'slot-0'), 'uncommitted.txt'), 'utf8')).toBe('live work\n')
    expect(slotBranch(c, 'slot-0')).toBe('feature/alpha')
    expect(slotDirs(c)).toEqual(['slot-0', 'slot-1'])
  })
})
