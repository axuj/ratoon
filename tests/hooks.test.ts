import type { HookFacts } from '../src/hooks.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hookPath, loadHooks } from '../src/hooks.ts'
import { BROKEN, FAILING_PLUGIN, MARKER, NOT_AN_OBJECT, ORDERED, SPY } from './helpers/hooks.ts'

let root = ''
let mainDir = ''
let slotDir = ''

beforeEach(() => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon hooks '))
  root = tmp
  mainDir = path.join(tmp, 'repo')
  slotDir = path.join(tmp, 'slot-0')
  mkdirSync(mainDir, { recursive: true })
  mkdirSync(slotDir, { recursive: true })
  writeFileSync(path.join(mainDir, 'README.md'), 'from main\n')
  writeFileSync(path.join(slotDir, 'README.md'), 'from slot\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function facts(overrides: Partial<HookFacts> = {}): HookFacts {
  return {
    rootDir: root,
    mainDir,
    slotDir,
    branch: 'feature/demo',
    task: 'demo',
    base: 'master',
    ...overrides,
  }
}

/** The versioned repository hooks — read from the main working tree, not from the pool. */
function write(source: string): void {
  const file = hookPath(mainDir)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source)
}

function stageLog(): string[] {
  return readFileSync(path.join(root, 'stages.log'), 'utf8').split('\n').filter(Boolean)
}

describe('hook discovery', () => {
  it('points at the repository config, not at a worktree', () => {
    expect(hookPath('/repo')).toBe(path.join('/repo', '.ratoon', 'hooks.ts'))
  })

  it('is inert when the file is missing', async () => {
    const runner = await loadHooks(facts())
    expect(runner.present).toBe(false)
    expect(await runner.run('onStart')).toEqual([])
    expect(await runner.run('onFinish')).toEqual([])
  })

  it('reports present once the file exists', async () => {
    write(MARKER)
    expect((await loadHooks(facts())).present).toBe(true)
  })

  it('accepts an empty config — a repository that only wants the slot pool', async () => {
    write(`export default {}\n`)
    const runner = await loadHooks(facts())
    expect(runner.present).toBe(true)
    expect(await runner.run('onStart')).toEqual([])
    expect(await runner.run('onFinish')).toEqual([])
  })
})

describe('no runnable default', () => {
  it('treats a default export that is not an object as idle, not an error', async () => {
    write(NOT_AN_OBJECT)
    const runner = await loadHooks(facts())
    expect(runner.present).toBe(true)
    expect(await runner.run('onStart')).toEqual([])
    expect(await runner.run('onFinish')).toEqual([])
  })

  it('treats a missing default export as idle, not an error', async () => {
    write(`export const nope = 1\n`)
    const runner = await loadHooks(facts())
    expect(runner.present).toBe(true)
    expect(await runner.run('onStart')).toEqual([])
  })

  it('reports a syntax error as a load failure', async () => {
    write(BROKEN)
    await expect(loadHooks(facts())).rejects.toThrow(/hooks failed to load/)
  })

  // Shape errors — `plugins` not an array, a nameless plugin, a stray top-level key, a wrong
  // `ctx` type — are `satisfies Plugin[]`'s job. Node only strips types, so those are caught
  // by `tsc`, not at runtime: see tests/e2e/typecheck.test.ts.
})

describe('dispatch', () => {
  it('runs the array in order — that order is the only ordering rule', async () => {
    write(ORDERED)
    const runner = await loadHooks(facts())

    expect(await runner.run('onStart')).toEqual(['alpha', 'beta'])
    expect(stageLog()).toEqual(['A', 'B'])
  })

  it('runs each lifecycle over its own pass, in array order', async () => {
    write(MARKER)
    const runner = await loadHooks(facts())

    expect(await runner.run('onStart')).toEqual(['marker'])
    expect(stageLog()).toEqual(['onStart:demo'])

    expect(await runner.run('onFinish')).toEqual(['marker'])
    expect(stageLog()).toEqual(['onStart:demo', 'onFinish:demo'])
  })

  it('runs onBeforeCheckout on its own pass, before start', async () => {
    write(`import { appendFileSync } from 'node:fs'
import path from 'node:path'

const mark = (rootDir, label) =>
  appendFileSync(path.join(rootDir, 'stages.log'), label + String.fromCharCode(10))

export default [{
  name: 'probe',
  onBeforeCheckout: ({ rootDir }) => mark(rootDir, 'onBeforeCheckout'),
  onStart: ({ rootDir }) => mark(rootDir, 'onStart'),
}]
`)
    const runner = await loadHooks(facts())

    expect(await runner.run('onBeforeCheckout')).toEqual(['probe'])
    expect(stageLog()).toEqual(['onBeforeCheckout'])

    expect(await runner.run('onStart')).toEqual(['probe'])
    expect(stageLog()).toEqual(['onBeforeCheckout', 'onStart'])
  })

  it('attributes a throw to onBeforeCheckout', async () => {
    write(`export default [{ name: 'boom', onBeforeCheckout() { throw new Error('before boom') } }]\n`)
    const runner = await loadHooks(facts())

    await expect(runner.run('onBeforeCheckout')).rejects.toThrow(
      /plugin "boom" failed in onBeforeCheckout[\s\S]*before boom/,
    )
  })

  it('skips plugins that do not implement that lifecycle', async () => {
    write(`export default [{ name: 'only-start', onStart() {} }]\n`)
    const runner = await loadHooks(facts())

    expect(await runner.run('onStart')).toEqual(['only-start'])
    expect(await runner.run('onFinish')).toEqual([])
  })

  it('names the plugin when it throws, with its stack', async () => {
    write(FAILING_PLUGIN)
    const runner = await loadHooks(facts())

    const err = await runner.run('onStart').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('plugin "exploder" failed in onStart')
    expect((err as Error).message).toContain('plugin boom')
    // the stack points at the file that defines the plugin
    expect((err as Error).message).toMatch(/\n\s+at /)
  })

  it('stops the lifecycle at the first failure', async () => {
    write(FAILING_PLUGIN)
    const runner = await loadHooks(facts())

    await expect(runner.run('onStart')).rejects.toThrow(/plugin "exploder" failed in onStart/)
    expect(existsSync(path.join(root, 'should-not-run'))).toBe(false)
  })
})

describe('the context', () => {
  it('carries exactly the six facts, and nothing that could do work for the hook', async () => {
    write(SPY)
    const runner = await loadHooks(facts({
      branch: 'feature/abc',
      task: 'abc',
      base: 'trunk',
    }))
    await runner.run('onStart')

    const seen = JSON.parse(readFileSync(path.join(root, 'spy.json'), 'utf8'))
    expect(seen.keys).toEqual([
      'base',
      'branch',
      'mainDir',
      'rootDir',
      'slotDir',
      'task',
    ])
    expect(seen).toMatchObject({
      rootDir: root,
      mainDir,
      slotDir,
      branch: 'feature/abc',
      task: 'abc',
      base: 'trunk',
    })
  })

  it('runs callbacks with the slot as the working directory', async () => {
    write(`import { writeFileSync } from 'node:fs'
export default [{ name: 'cwd', onStart() { writeFileSync('cwd.txt', process.cwd()) } }]
`)
    await (await loadHooks(facts())).run('onStart')
    expect(readFileSync(path.join(slotDir, 'cwd.txt'), 'utf8')).toBe(slotDir)
  })

  it('restores the previous working directory afterwards', async () => {
    write(MARKER)
    const before = process.cwd()
    await (await loadHooks(facts())).run('onStart')
    expect(process.cwd()).toBe(before)
  })
})
