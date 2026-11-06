import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { refuseSelf, writeScaffolding } from '../src/init.ts'
import { exec, run } from '../src/shell.ts'

/**
 * `nub run demo` — a throwaway container with a one-commit repository inside it, so the plugin flow
 * can be exercised without a real project. This is scaffolding for *developing* ratoon, which is
 * why it lives behind a package script rather than on the command surface: `init` is the product,
 * this is the workbench.
 *
 * Usage: `nub run demo [-- --root <dir>] [--force]`
 * Default root is `<cwd>/wt-demo` — never the directory you are standing in, because `--force`
 * wipes whatever it points at.
 */

function arg(name: string): string | undefined {
  const inline = process.argv.find(value => value.startsWith(`--${name}=`))
  if (inline)
    return inline.slice(name.length + 3)
  const at = process.argv.indexOf(`--${name}`)
  return at === -1
    ? undefined
    : process.argv[at + 1]
}

async function demo(): Promise<void> {
  const dir = path.resolve(arg('root') ?? path.join(process.cwd(), 'wt-demo'))
  const force = process.argv.includes('--force')

  // before the wipe: `--force --root <ratoon>` must not be able to delete ratoon
  refuseSelf(dir)

  if (listEntries(dir).length > 0) {
    if (!force)
      throw new Error(`${dir} already exists — pass --force to wipe it and start over.`)
    if (!isContainer(dir))
      throw new Error(`refusing to delete ${dir}: it is not a ratoon container (no .ratoon/hooks.ts).`)
    rmSync(dir, { recursive: true, force: true })
    console.log(`wiping ${dir}`)
  }

  const { wrote } = writeScaffolding(dir)
  console.log(`\nscaffolding ${dir}\n  wrote     ${wrote.join(', ')}\n`)

  writeDemoHooks(dir)

  const mainDir = path.join(dir, 'demo')
  await makeMainRepo(mainDir)

  console.log(`
demo ready:
  main repo   ${mainDir}
  hooks       ${path.join(dir, '.ratoon', 'hooks.ts')}

try:
  ratoon start first --root ${dir}
  ratoon list         --root ${dir}
  ratoon finish first -m "feat: the first task" --root ${dir}
`)
}

function listEntries(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir)
}

/** Only a directory this tool wrote may be wiped by `--force`. */
function isContainer(dir: string): boolean {
  return existsSync(path.join(dir, '.ratoon', 'hooks.ts')) && existsSync(path.join(dir, 'package.json'))
}

/**
 * The demo is a workbench, not `init`: it explicitly enables the starter plugins and a build
 * plugin so one run exercises install, task notes and build.
 */
function writeDemoHooks(dir: string): void {
  const hooks = `import type { Plugin } from './types.ts'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { npmInstall } from './plugins/npm-install.ts'
import { taskNotes } from './plugins/task-notes.ts'

export default [
  npmInstall(),
  taskNotes(),
  {
    name: 'build',
    onStart({ slotDir }) {
      if (!existsSync(path.join(slotDir, 'package.json')))
        return
      execSync('npm run build', { cwd: slotDir, stdio: 'inherit' })
    },
  },
] satisfies Plugin[]
`
  writeFileSync(path.join(dir, '.ratoon', 'hooks.ts'), hooks)
}

/**
 * Enough to exercise every enabled plugin: a local `file:` dependency so `npmInstall()` has
 * something to install (and fingerprint) without touching a registry, a `build` script so the
 * demo's build plugin produces `dist/out.js`, and `dist/` gitignored so a built slot still passes
 * `finish`'s dirty check.
 *
 * `package-lock.json` is committed on purpose — a lockfile the package manager creates *inside the
 * slot* would be untracked and `finish` would refuse to land. It is byte-identical to what
 * `npm install --package-lock-only` emits here, so a reinstall does not dirty the tree.
 */
async function makeMainRepo(dir: string): Promise<void> {
  const pkg = {
    name: 'demo',
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts: { build: 'node build.mjs' },
    dependencies: { tiny: 'file:./vendor/tiny' },
  }
  const lock = {
    name: 'demo',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'demo',
        version: '0.1.0',
        dependencies: { tiny: 'file:./vendor/tiny' },
      },
      'node_modules/tiny': { resolved: 'vendor/tiny', link: true },
      'vendor/tiny': { version: '1.0.0' },
    },
  }

  const files: [rel: string, content: string][] = [
    [
      'README.md',
      [
        '# demo',
        '',
        'A throwaway project for exercising ratoon\'s starter plugins:',
        '',
        '- `npmInstall()` installs the local `file:./vendor/tiny` dependency (no registry) and',
        '  fingerprints it under `<root>/.state/`, so a warm slot skips the next `start`.',
        '- the `build` plugin runs `npm run build` in `onStart` → `dist/out.js`.',
        '- `dist/` is gitignored, so building does not make `finish` refuse to land.',
        '',
      ].join('\n'),
    ],
    ['package.json', `${JSON.stringify(pkg, null, 2)}\n`],
    ['package-lock.json', `${JSON.stringify(lock, null, 2)}\n`],
    ['index.js', `import { value } from 'tiny'

export const banner = \`demo \${value}\`
`],
    ['build.mjs', `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
mkdirSync(new URL('./dist', import.meta.url), { recursive: true })
writeFileSync(new URL('./dist/out.js', import.meta.url), \`// generated by build.mjs\\n\${source}\`)
console.log('build ok')
`],
    ['.gitignore', 'node_modules/\ndist/\n'],
    // pin eol so a Windows checkout cannot produce line-ending-only dirt in a slot
    ['.gitattributes', '* text=auto eol=lf\n'],
    ['vendor/tiny/package.json', '{ "name": "tiny", "version": "1.0.0", "type": "module", "main": "index.js" }\n'],
    ['vendor/tiny/index.js', 'export const value = 42\n'],
  ]

  for (const [rel, content] of files) {
    const target = path.join(dir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
  }

  await run('git', ['init', '-q', '-b', 'master', dir])
  // commit needs an identity; only borrow the user's global one when there is one
  if ((await exec('git', ['-C', dir, 'config', 'user.email'])).status !== 0) {
    await run('git', [
      '-C',
      dir,
      'config',
      'user.email',
      'ratoon@demo.local',
    ])
    await run('git', [
      '-C',
      dir,
      'config',
      'user.name',
      'ratoon',
    ])
  }
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-m', 'demo'])
}

void demo().catch((err: unknown) => {
  console.error(`\nratoon demo: ${err instanceof Error
    ? err.message
    : String(err)}`)
  process.exit(1)
})
