import type { Repo } from '../helpers/repo.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeDir, makeRepo, writeFile } from '../helpers/repo.ts'

const TSC = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url))
const TYPES = fileURLToPath(new URL('../../node_modules/@types', import.meta.url))

/**
 * Node strips types instead of checking them, so `tsc` is the only safety net for the shape of a
 * hook file. This suite is that safety net's own test: if these ever start passing, we lost it.
 */
const TS_CONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'bundler',
    // mirrors the tsconfig `ratoon init` writes: TypeScript 6 stopped pulling in @types on its own
    types: ['node'],
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
  },
  include: ['.ratoon/**/*.ts'],
}, null, 2)

const HEADER = `import type { Plugin } from './types.ts'\n`

let c: Repo | undefined

afterEach(() => {
  if (c)
    disposeDir(c.tmp)
})

/** `makeRepo` ships the real `.ratoon/`; add the type packages tsc needs to see. */
async function repo(): Promise<Repo> {
  const made = await makeRepo()
  mkdirSync(path.join(made.repo, 'node_modules'), { recursive: true })
  symlinkSync(TYPES, path.join(made.repo, 'node_modules', '@types'), 'junction')
  writeFile(path.join(made.repo, 'tsconfig.json'), `${TS_CONFIG}\n`)
  return made
}

function typecheck(root: string): string {
  const out = spawnSync(process.execPath, [TSC, '--noEmit', '-p', root], { encoding: 'utf8' })
  return `${out.stdout}${out.stderr}`
}

describe('tsc is the safety net', () => {
  it('catches every shape error the runtime deliberately does not', async () => {
    c = await repo()
    const dir = path.join(c.repo, '.ratoon')

    // each one is valid TypeScript *syntax* — only the type system can reject it
    writeFile(path.join(dir, 'nameless.ts'), `${HEADER}export default [{}] satisfies Plugin[]\n`)
    writeFile(path.join(dir, 'stray-key.ts'), `${HEADER}export default [{ name: 'x', onStart() {}, stray: true }] satisfies Plugin[]\n`)
    writeFile(path.join(dir, 'bad-ctx.ts'), `${HEADER}export default [{ name: 'x', onStart(ctx: number) { void ctx } }] satisfies Plugin[]\n`)

    const out = typecheck(c.repo)
    expect(out).toContain('nameless.ts')
    expect(out).toContain(`Property 'name' is missing`)
    expect(out).toContain('stray-key.ts')
    expect(out).toContain(`'stray' does not exist`)
    expect(out).toContain('bad-ctx.ts')
    expect(out).toContain(`Type '(ctx: number) => void' is not assignable`)
  })

  it('passes on the shape `ratoon init` generates', async () => {
    c = await repo()
    writeFile(
      path.join(c.repo, '.ratoon', 'hooks.ts'),
      `${HEADER}export default [{ name: 'ok', onStart() {} }] satisfies Plugin[]\n`,
    )
    expect(typecheck(c.repo)).toBe('')
  })
})
