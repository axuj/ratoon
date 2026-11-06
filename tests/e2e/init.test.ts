import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeDir, gitOut, ratoon, readJson } from '../helpers/container.ts'

const RATOON_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const TYPES = fileURLToPath(new URL('../../node_modules/@types', import.meta.url))
const SCAFFOLD = [
  'package.json',
  'tsconfig.json',
  '.gitignore',
  'AGENTS.md',
  '.ratoon/hooks.ts',
  '.ratoon/types.ts',
  '.ratoon/plugins/check-lock.ts',
  '.ratoon/plugins/npm-install.ts',
  '.ratoon/plugins/progress-file.ts',
  '.ratoon/plugins/shared.ts',
  '.ratoon/docs/workflows.md',
  '.ratoon/docs/plugins.md',
]

const created: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ratoon init '))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0))
    disposeDir(dir)
})

describe('ratoon init', () => {
  it('scaffolds every file and the hooks typecheck against ratoon', async () => {
    const dir = freshDir()
    const result = await ratoon(['init', '--root', dir])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Done. Next steps')
    for (const rel of SCAFFOLD)
      expect(existsSync(path.join(dir, rel)), rel).toBe(true)

    // no runtime dependencies at all: the plugins and types are files in the container
    const manifest = readJson(path.join(dir, 'package.json'))
    expect(manifest).toMatchObject({ type: 'module', private: true })
    expect(manifest.dependencies).toBeUndefined()
    // hooks run through Node's type stripping, so the container itself needs Node >= 26
    expect(manifest.engines).toEqual({ node: '>=26' })
    expect(manifest.devDependencies).toMatchObject({
      typescript: expect.any(String),
    })
    expect(readJson(path.join(dir, 'tsconfig.json')).include).toEqual(['.ratoon/**/*.ts'])
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('ratoon start <task>')
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('.ratoon/docs/')

    const hooks = readFileSync(path.join(dir, '.ratoon', 'hooks.ts'), 'utf8')
    expect(hooks).toContain('satisfies Plugin[]')
    expect(hooks).toContain('export default [] satisfies Plugin[]')

    // starter plugins are copied in but not enabled; each one is its own file
    const npmInstall = readFileSync(path.join(dir, '.ratoon/plugins/npm-install.ts'), 'utf8')
    expect(npmInstall).toContain('export function npmInstall')
    expect(readFileSync(path.join(dir, '.ratoon/plugins/progress-file.ts'), 'utf8')).toContain('export function progressFile')
    expect(readFileSync(path.join(dir, '.ratoon/plugins/check-lock.ts'), 'utf8')).toContain('export function checkLock')
    expect(readFileSync(path.join(dir, '.ratoon/plugins/shared.ts'), 'utf8')).toContain('export function statePath')

    // the scaffold typechecks against the copies it carries — no package resolution involved
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    symlinkSync(TYPES, path.join(dir, 'node_modules', '@types'), 'junction')
    const typecheck = spawnSync(process.execPath, [TSC, '--noEmit', '-p', dir], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
  })

  it('scaffolds around whatever it does not write', async () => {
    const dir = freshDir()
    // the common order: the repository is already in the container when init runs
    mkdirSync(path.join(dir, 'proj'), { recursive: true })
    gitOut(path.join(dir, 'proj'), 'init', '-b', 'master')
    const mine = path.join(dir, 'notes.txt')
    writeFileSync(mine, 'mine\n')

    const result = await ratoon(['init', '--root', dir])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('repository: proj')
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(true)
    expect(readFileSync(mine, 'utf8')).toBe('mine\n')
  })

  it('refuses to scaffold over a file it would write, and writes nothing', async () => {
    const dir = freshDir()
    const existing = path.join(dir, 'package.json')
    writeFileSync(existing, '{"name":"mine"}\n')

    const result = await ratoon(['init', '--root', dir])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('already holds package.json')
    expect(result.stderr).toContain('--force')
    expect(readFileSync(existing, 'utf8')).toBe('{"name":"mine"}\n')
    expect(existsSync(path.join(dir, 'tsconfig.json'))).toBe(false)
  })

  it('refreshes only the files ratoon owns — --force never touches your hooks', async () => {
    const dir = freshDir()
    mkdirSync(path.join(dir, '.ratoon'), { recursive: true })
    const slotState = path.join(dir, '.state', 'slot-9', 'task')
    mkdirSync(path.dirname(slotState), { recursive: true })
    writeFileSync(slotState, 'old-task\n')
    const mine = 'export default [{ name: \'mine\', onStart() {} }]\n'
    writeFileSync(path.join(dir, '.ratoon', 'hooks.ts'), mine)
    mkdirSync(path.join(dir, '.ratoon', 'plugins'), { recursive: true })
    writeFileSync(path.join(dir, '.ratoon', 'plugins', 'npm-install.ts'), '// my own fork\n')
    mkdirSync(path.join(dir, '.ratoon', 'docs'), { recursive: true })
    writeFileSync(path.join(dir, '.ratoon', 'docs', 'workflows.md'), '# old guide\n')
    const manifest = '{ "name": "mine" }\n'
    writeFileSync(path.join(dir, 'package.json'), manifest)

    const result = await ratoon(['init', '--root', dir, '--force'])
    expect(result.status).toBe(0)

    // user-owned files stay byte-for-byte; the toolbox is refreshed
    expect(readFileSync(path.join(dir, '.ratoon', 'hooks.ts'), 'utf8')).toBe(mine)
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(manifest)
    const plugin = readFileSync(path.join(dir, '.ratoon', 'plugins', 'npm-install.ts'), 'utf8')
    expect(plugin).toContain('export function npmInstall')

    // `.state/` is per-slot runtime state, not scaffolding: --force has no business there
    expect(readFileSync(slotState, 'utf8')).toBe('old-task\n')
  })

  it('is a no-op on the second run and says what --force would refresh', async () => {
    const dir = freshDir()
    await ratoon(['init', '--root', dir])

    const again = await ratoon(['init', '--root', dir])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('kept      package.json')
    expect(again.stdout).toContain('--force refreshes')
    expect(again.stdout).toContain('.ratoon/docs/workflows.md')
    expect(again.stdout).not.toContain('refreshed')
  })

  it('refuses to scaffold over ratoon itself', async () => {
    const before = readJson(path.join(RATOON_ROOT, 'package.json'))

    const result = await ratoon(['init', '--root', RATOON_ROOT])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to init ratoon inside itself')

    // the guard runs before any write, so ratoon's own manifest must be untouched
    expect(readJson(path.join(RATOON_ROOT, 'package.json'))).toEqual(before)
  })
})
