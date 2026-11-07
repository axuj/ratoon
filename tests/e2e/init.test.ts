import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeDir, gitOut, ratoon, readJson } from '../helpers/repo.ts'

const RATOON_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const TYPES = fileURLToPath(new URL('../../node_modules/@types', import.meta.url))

/** What `init` writes into the repository — nothing outside `.ratoon/` belongs to it. */
const SCAFFOLD = [
  '.ratoon/hooks.ts',
  '.ratoon/types.ts',
  '.ratoon/plugins/npm-install.ts',
  '.ratoon/plugins/shared.ts',
  '.ratoon/plugins/task-notes.ts',
]

const created: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ratoon init '))
  created.push(dir)
  return dir
}

/** A directory holding one git repository — what `init` expects to be run from. */
function freshRepo(): { root: string, repo: string } {
  const root = freshDir()
  const repo = path.join(root, 'proj')
  mkdirSync(repo, { recursive: true })
  gitOut(repo, 'init', '-b', 'master')
  return { root, repo }
}

afterEach(() => {
  for (const dir of created.splice(0))
    disposeDir(dir)
})

describe('ratoon init', () => {
  it('installs into the repository and leaves the project files alone', async () => {
    const { root, repo } = freshRepo()
    const manifest = '{ "name": "mine" }\n'
    writeFileSync(path.join(repo, 'package.json'), manifest)
    writeFileSync(path.join(repo, 'tsconfig.json'), '{}\n')

    const result = await ratoon(['init'], { cwd: repo })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('installing ratoon into')

    for (const rel of SCAFFOLD)
      expect(existsSync(path.join(repo, rel)), rel).toBe(true)

    // the project's own files are not ratoon's to write; .gitignore gains exactly one line
    expect(readFileSync(path.join(repo, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('.ratoon/*\n')
    // agent rules stay in the skill — no frozen copy is written into the repository
    expect(existsSync(path.join(repo, 'AGENTS.md'))).toBe(false)
    expect(existsSync(path.join(repo, '.ratoon', 'AGENTS.md'))).toBe(false)
    expect(existsSync(path.join(repo, '.ratoon', 'docs'))).toBe(false)
    expect(readdirSync(path.join(repo, '.ratoon')).sort()).toEqual(['hooks.ts', 'plugins', 'types.ts'])

    // `init` declares the pool but does not create it — `start` does, on demand. No sibling pool.
    expect(existsSync(path.join(repo, '.ratoon', 'worktrees'))).toBe(false)
    expect(existsSync(path.join(root, 'proj-wt'))).toBe(false)
    expect(existsSync(path.join(repo, 'slot-0'))).toBe(false)
    expect(existsSync(path.join(repo, '.state'))).toBe(false)
    expect(gitOut(repo, 'status', '--porcelain', '-uall')).not.toContain('.ratoon/worktrees')

    const hooks = readFileSync(path.join(repo, '.ratoon', 'hooks.ts'), 'utf8')
    expect(hooks).toContain('export default [taskNotes()] satisfies Plugin[]')
    expect(readFileSync(path.join(repo, '.ratoon/plugins/task-notes.ts'), 'utf8')).toContain('export function taskNotes')
  })

  it('typechecks the hooks against the copies it carries', async () => {
    const { repo } = freshRepo()
    await ratoon(['init'], { cwd: repo })

    // no package resolution involved: the project gets @types/node from its own install
    mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    symlinkSync(TYPES, path.join(repo, 'node_modules', '@types'), 'junction')
    const config = path.join(repo, 'tsconfig.ratoon.json')
    writeFileSync(config, JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        types: ['node'],
      },
      include: ['.ratoon/**/*.ts'],
    }))

    const typecheck = spawnSync(process.execPath, [TSC, '--noEmit', '-p', config], {
      cwd: repo,
      encoding: 'utf8',
    })
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0)
  })

  it('appends the ignore rule once, even across repeated runs', async () => {
    const { repo } = freshRepo()
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')

    await ratoon(['init'], { cwd: repo })
    await ratoon(['init'], { cwd: repo })
    const third = await ratoon(['init'], { cwd: repo })
    expect(third.status).toBe(0)
    // its own paragraph: straight under `node_modules/` the rule would read as part of that group
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n\n.ratoon/*\n')
  })

  it('closes a .gitignore whose last line has no newline', async () => {
    const { repo } = freshRepo()
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/')

    const result = await ratoon(['init'], { cwd: repo })
    expect(result.status).toBe(0)
    expect(readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\ndist/\n\n.ratoon/*\n')
  })

  it('is a no-op on the second run', async () => {
    const { repo } = freshRepo()
    await ratoon(['init'], { cwd: repo })

    const again = await ratoon(['init'], { cwd: repo })
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('exists')
    expect(again.stdout).toContain('Delete one and run init again')
    expect(again.stdout).not.toContain('wrote')
  })

  it('never overwrites your edits — not hooks, not a starter plugin', async () => {
    const { repo } = freshRepo()
    await ratoon(['init'], { cwd: repo })

    const mine = 'export default []\n'
    const fork = '// my fork\nexport function npmInstall() {}\n'
    writeFileSync(path.join(repo, '.ratoon', 'hooks.ts'), mine)
    writeFileSync(path.join(repo, '.ratoon', 'plugins', 'npm-install.ts'), fork)
    const note = path.join(repo, '.ratoon', 'notes.md')
    writeFileSync(note, 'mine\n')

    const result = await ratoon(['init'], { cwd: repo })
    expect(result.status).toBe(0)

    // every existing file stays byte-for-byte, whoever wrote it
    expect(readFileSync(path.join(repo, '.ratoon', 'hooks.ts'), 'utf8')).toBe(mine)
    expect(readFileSync(path.join(repo, '.ratoon', 'plugins', 'npm-install.ts'), 'utf8')).toBe(fork)
    expect(readFileSync(note, 'utf8')).toBe('mine\n')
  })

  it('fills in a .ratoon/ it did not write, without touching your files', async () => {
    const { repo } = freshRepo()
    mkdirSync(path.join(repo, '.ratoon'), { recursive: true })
    const mine = path.join(repo, '.ratoon', 'notes.md')
    writeFileSync(mine, 'mine\n')

    const result = await ratoon(['init'], { cwd: repo })
    expect(result.status).toBe(0)
    expect(readFileSync(mine, 'utf8')).toBe('mine\n')
    expect(existsSync(path.join(repo, '.ratoon', 'types.ts'))).toBe(true)
  })

  it('says what is wrong when .ratoon is a file', async () => {
    const { repo } = freshRepo()
    writeFileSync(path.join(repo, '.ratoon'), 'oops\n')

    const result = await ratoon(['init'], { cwd: repo })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is a file, not a directory')
  })

  it('says --force is gone instead of silently doing nothing', async () => {
    const { repo } = freshRepo()

    const result = await ratoon(['init', '--force'], { cwd: repo })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--force was removed')
    expect(existsSync(path.join(repo, '.ratoon'))).toBe(false)
  })

  it('refuses to run outside a repository', async () => {
    const dir = freshDir()

    const result = await ratoon(['init'], { cwd: dir })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not inside a git repository')
  })

  it('refuses to install over ratoon itself', async () => {
    const before = readJson(path.join(RATOON_ROOT, 'package.json'))

    const result = await ratoon(['init'], { cwd: RATOON_ROOT })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to init ratoon inside itself')

    // the guard runs before any write, so ratoon's own manifest must be untouched
    expect(readJson(path.join(RATOON_ROOT, 'package.json'))).toEqual(before)
  })
})
