import type { NpmInstallOptions } from '../src/plugins/npm-install.ts'
import type { HookContext } from '../src/types.ts'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { npmInstall } from '../src/plugins/npm-install.ts'
import { defaultManagers, detectManager, statePath } from '../src/plugins/shared.ts'
import { taskNotes } from '../src/plugins/task-notes.ts'

let tmp = ''
let rootDir = ''
let slotDir = ''

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon plugins '))
  rootDir = tmp
  slotDir = path.join(tmp, 'slot-0')
  mkdirSync(slotDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function ctx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    rootDir,
    mainDir: path.join(tmp, 'repo'),
    slotDir,
    branch: 'feature/x',
    task: 'x',
    base: 'master',
    ...overrides,
  }
}

function stateFile(): string {
  return path.join(rootDir, '.state', 'slot-0', 'install')
}

function marker(): string {
  return path.join(slotDir, 'ran.txt')
}

/** Runs the plugin through a fake package manager so no network or registry is ever touched. */
const OFFLINE: NpmInstallOptions = {
  managers: [
    ['marker.lock', 'node'],
  ],
  args: ['-e', 'require("node:fs").writeFileSync("ran.txt", "ok")'],
}

describe('defaultManagers', () => {
  it('maps every lockfile ratoon knows about', () => {
    expect(defaultManagers).toEqual([
      ['nub.lock', 'nub'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['pnpm-workspace.yaml', 'pnpm'],
      ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['bun.lockb', 'bun'],
    ])
  })
})

describe('detectManager', () => {
  it('lets the packageManager field win over a leftover lockfile', () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"packageManager":"nub@0.9.7"}\n')
    writeFileSync(path.join(slotDir, 'package-lock.json'), '')

    expect(detectManager(slotDir)).toBe('nub')
  })

  it('understands devEngines.packageManager', () => {
    writeFileSync(
      path.join(slotDir, 'package.json'),
      '{"devEngines":{"packageManager":{"name":"pnpm","version":"9.0.0"}}}\n',
    )

    expect(detectManager(slotDir)).toBe('pnpm')
  })

  it('falls back to the lockfile when the field is absent', () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'nub.lock'), '')

    expect(detectManager(slotDir)).toBe('nub')
  })

  it('ignores a manager it does not know and trusts the lockfile', () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"packageManager":"newpm@1.0.0"}\n')
    writeFileSync(path.join(slotDir, 'pnpm-lock.yaml'), '')

    expect(detectManager(slotDir)).toBe('pnpm')
  })

  it('falls back to npm when neither the field nor a lockfile helps', () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{ not json')

    expect(detectManager(slotDir)).toBe('npm')
  })

  it('treats a custom table as the set of known commands', () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"packageManager":"node@26"}\n')

    expect(detectManager(slotDir, [
      ['marker.lock', 'node'],
    ])).toBe('node')
  })
})

describe('taskNotes', () => {
  it('registers both lifecycles under one name', () => {
    const plugin = taskNotes()
    expect(plugin.name).toBe('taskNotes')
    expect(typeof plugin.onStart).toBe('function')
    expect(typeof plugin.onFinish).toBe('function')
  })

  it('writes a skeleton under .state, interpolating the task, branch and slot', () => {
    taskNotes().onStart?.(ctx())
    const written = readFileSync(path.join(rootDir, '.state', 'slot-0', 'TASK.md'), 'utf8')
    expect(written).toContain('TASK: x')
    expect(written).toContain('feature/x')
    expect(written).toContain(slotDir)
    // the plan is the part a killed session cannot re-derive, so it is in the template
    expect(written).toContain('## Plan')
    // nothing lands in the worktree: no gitignore, no dirt, nothing to commit
    expect(existsSync(path.join(slotDir, 'TASK.md'))).toBe(false)
  })

  it('says where the notes are, since they are outside the worktree', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    taskNotes().onStart?.(ctx())

    expect(log).toHaveBeenCalledWith(expect.stringContaining(path.join('.state', 'slot-0', 'TASK.md')))
  })

  it('takes a custom filename and template', () => {
    taskNotes({
      file: 'PROGRESS.md',
      template: ({ task }) => `# ${task}!\n`,
    }).onStart?.(ctx())

    const notes = path.join(rootDir, '.state', 'slot-0', 'PROGRESS.md')
    expect(readFileSync(notes, 'utf8')).toBe('# x!\n')
    expect(existsSync(path.join(slotDir, 'PROGRESS.md'))).toBe(false)
  })

  it('leaves the notes in place in onFinish — reading them later is the point', async () => {
    const plugin = taskNotes()
    plugin.onStart?.(ctx())
    await plugin.onFinish?.(ctx())

    expect(existsSync(path.join(rootDir, '.state', 'slot-0', 'TASK.md'))).toBe(true)
  })

  it('warns about unchecked boxes', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    taskNotes().onStart?.(ctx())
    // the default template has no boxes — they are something the worker writes
    appendFileSync(path.join(rootDir, '.state', 'slot-0', 'TASK.md'), '\n- [ ] still todo\n')
    await taskNotes().onFinish?.(ctx())

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unchecked boxes'))
  })

  it('can be told not to warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    taskNotes().onStart?.(ctx())
    // without a box there is nothing to warn about, and the option would be untested
    appendFileSync(path.join(rootDir, '.state', 'slot-0', 'TASK.md'), '\n- [ ] still todo\n')
    await taskNotes({ warnUnchecked: false }).onFinish?.(ctx())

    expect(spy).not.toHaveBeenCalled()
  })
})

describe('statePath', () => {
  it('points under .state, never inside the worktree', () => {
    const file = statePath(ctx(), 'dev.log')
    expect(file).toBe(path.join(rootDir, '.state', 'slot-0', 'dev.log'))
  })
})

describe('npmInstall', () => {
  it('does nothing at all for a non-JS project', async () => {
    await npmInstall(OFFLINE).onStart?.(ctx())

    expect(existsSync(stateFile())).toBe(false)
  })

  it('installs when node_modules is missing and records the fingerprint', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'marker.lock'), '')

    await npmInstall(OFFLINE).onStart?.(ctx())

    expect(existsSync(marker())).toBe(true)
    expect(existsSync(stateFile())).toBe(true)
    expect(readFileSync(stateFile(), 'utf8')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('skips when the fingerprint still matches and node_modules is present', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'marker.lock'), '')
    mkdirSync(path.join(slotDir, 'node_modules'))

    const plugin = npmInstall(OFFLINE)
    await plugin.onStart?.(ctx()) // writes the state
    const mtime = statSync(stateFile()).mtimeMs
    const stored = readFileSync(stateFile(), 'utf8')
    rmSync(marker(), { force: true }) // clear the record of the first run

    await plugin.onStart?.(ctx()) // must skip: no run, no write

    expect(existsSync(marker())).toBe(false)
    expect(statSync(stateFile()).mtimeMs).toBe(mtime)
    expect(readFileSync(stateFile(), 'utf8')).toBe(stored)
  })

  it('installs again once the manifest changes', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'marker.lock'), '')
    mkdirSync(path.join(slotDir, 'node_modules'))

    const plugin = npmInstall(OFFLINE)
    await plugin.onStart?.(ctx())
    const stored = readFileSync(stateFile(), 'utf8')

    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x","version":"2"}\n')
    await plugin.onStart?.(ctx())

    expect(readFileSync(stateFile(), 'utf8')).not.toBe(stored)
    expect(readFileSync(stateFile(), 'utf8')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('installs again when node_modules disappeared', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'marker.lock'), '')

    await npmInstall(OFFLINE).onStart?.(ctx())
    rmSync(path.join(slotDir, 'node_modules'), { recursive: true, force: true })
    rmSync(marker(), { force: true })

    await npmInstall(OFFLINE).onStart?.(ctx())
    expect(existsSync(marker())).toBe(true)
  })

  it('honours a custom command and its arguments', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'marker.lock'), '')

    await npmInstall(OFFLINE).onStart?.(ctx())

    // the fake command wrote into the slot, proving cwd and args both landed
    expect(readFileSync(marker(), 'utf8')).toBe('ok')
  })

  it('picks the first lockfile the table recognises', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{"name":"x"}\n')
    writeFileSync(path.join(slotDir, 'first.lock'), '')
    writeFileSync(path.join(slotDir, 'second.lock'), '')

    const table: NpmInstallOptions['managers'] = [
      ['first.lock', 'node'],
      ['second.lock', 'ratoon-missing-binary-xyz'],
    ]
    // if the second entry won, the missing binary would make this throw
    await npmInstall({ managers: table, args: OFFLINE.args }).onStart?.(ctx())
    expect(readFileSync(marker(), 'utf8')).toBe('ok')
  })

  it('falls back to npm when no lockfile matches', async () => {
    // invalid JSON guarantees `npm install` fails fast, and the error names the command that ran
    writeFileSync(path.join(slotDir, 'package.json'), '{ not json')
    writeFileSync(path.join(slotDir, 'second.lock'), '')

    await expect(
      npmInstall({
        managers: [
          ['first.lock', 'node'],
        ],
      }).onStart?.(ctx()),
    ).rejects.toThrow(/npm install/)
    expect(existsSync(stateFile())).toBe(false)
  })

  it('quiets npm by default and leaves other managers alone', async () => {
    writeFileSync(path.join(slotDir, 'package.json'), '{ not json')

    // npm would otherwise run `npm audit` — a registry round trip on every cold start
    writeFileSync(path.join(slotDir, 'package-lock.json'), '')
    await expect(npmInstall().onStart?.(ctx()))
      .rejects
      .toThrow(/npm install --no-audit --no-fund/)

    // a manager that is not npm gets the plain argument list, whatever it is
    writeFileSync(path.join(slotDir, 'marker.lock'), '')
    await expect(npmInstall({
      managers: [
        ['marker.lock', 'node'],
      ],
    }).onStart?.(ctx()))
      .rejects
      .toThrow(/\bnode install \(cwd/)
  })
})
