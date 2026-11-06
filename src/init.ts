import type { RatoonOptions } from './cli.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledDocs } from './docs.ts'
import { agentsMd, GITIGNORE, HOOKS, packageJson, TSCONFIG } from './templates.ts'

interface InitFlags {
  force: boolean
}

/**
 * The files ratoon owns inside a container: the types, the optional starter plugins and the
 * bundled guides. Every other scaffolded file is yours the moment it is written: `init` creates it
 * once and never touches it again — not even with `--force`.
 */
const TOOL_OWNED = new Set(['.ratoon/types.ts'])

const PLUGIN_FILES = [
  'npm-install.ts',
  'shared.ts',
  'task-notes.ts',
] as const

function isToolOwned(key: string): boolean {
  return TOOL_OWNED.has(key) || key.startsWith('.ratoon/plugins/') || key.startsWith('.ratoon/docs/')
}

export interface ScaffoldResult {
  /** created because the file did not exist */
  wrote: string[]
  /** ratoon-owned files replaced by `--force` */
  refreshed: string[]
  /** already there, left exactly as it was */
  kept: string[]
}

function packageNameFor(dir: string): string {
  const raw = path.basename(path.resolve(dir)).toLowerCase()
  const cleaned = raw.replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'ratoon-container'
}

function ratoonRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url))
}

function ratoonVersion(): string {
  try {
    const manifest = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    return JSON.parse(manifest).version ?? 'unknown'
  }
  catch {
    return 'unknown'
  }
}

/**
 * A file the container gets to own: `src/types.ts` and `src/plugins/*.ts` are copied verbatim, so
 * a container never imports the engine at runtime.
 *
 * Running from source, the file sits next to `init.ts`; running from the built `dist/`, only the
 * unbuilt sources are shipped for exactly these files, one directory up.
 */
function ownSource(name: string): string {
  for (const url of [`./${name}`, `../src/${name}`]) {
    const found = fileURLToPath(new URL(url, import.meta.url))
    if (existsSync(found))
      return readFileSync(found, 'utf8')
  }
  throw new Error(`cannot find ${name} to copy — the ratoon install looks incomplete`)
}

export function refuseSelf(dir: string): void {
  if (path.resolve(dir) === path.resolve(ratoonRoot()))
    throw new Error('refusing to init ratoon inside itself — point --root at a fresh directory')
}

/**
 * Everything `init` puts in the container root. A directory holding anything else — the repository
 * you cloned into it, notes, other checkouts — is the normal case, not a conflict.
 */
const SCAFFOLD_PATHS = [
  'package.json',
  'tsconfig.json',
  '.gitignore',
  'AGENTS.md',
  '.ratoon',
] as const

/**
 * `init`'s safety rule: it never writes over a file it did not write. So the question is not
 * whether the directory is empty but whether scaffolding would clash with something already there
 * — an unrelated file next to `<main-repo>/` blocks nothing.
 */
export function ensureWritable(dir: string, force: boolean): void {
  if (force)
    return
  const clashes = SCAFFOLD_PATHS.filter(name => existsSync(path.join(dir, name)))
  if (clashes.length === 0)
    return
  if (existsSync(path.join(dir, '.ratoon', 'types.ts')))
    return // an existing container: init fills in what is missing, never overwrites
  throw new Error(
    `${dir} already holds ${clashes.join(', ')}\n`
    + 'ratoon init would scaffold those — pass --force to add the missing files and keep yours.',
  )
}

/**
 * Write the container skeleton: manifest, tsconfig, gitignore, `AGENTS.md`, the hook entry and
 * types under `.ratoon/`, the optional starter plugins under `.ratoon/plugins/`, and the bundled
 * guides under `.ratoon/docs/`. Shared by `init` and `demo`; the caller owns the "may I write here
 * at all" decision, because the two commands disagree about what `--force` means.
 *
 * Nothing is overwritten unless it is ratoon-owned *and* `refresh` is set: `hooks.ts`, `AGENTS.md`
 * and the manifests are yours from the first write on. That makes a second `init` a no-op instead
 * of a reset, and `--force` a toolbox refresh instead of a wipe.
 *
 * Nothing is installed: the container has no runtime dependencies, so scaffolding is pure file
 * writing. `npm i` is only needed if you want `npm run typecheck`.
 */
export function writeScaffolding(dir: string, refresh = false): ScaffoldResult {
  const name = packageNameFor(dir)
  const version = ratoonVersion()
  mkdirSync(dir, { recursive: true })

  const files: [rel: string, content: string][] = [
    [
      'package.json',
      packageJson(name),
    ],
    ['tsconfig.json', TSCONFIG],
    ['.gitignore', GITIGNORE],
    [
      'AGENTS.md',
      agentsMd(name),
    ],
    [
      path.join('.ratoon', 'hooks.ts'),
      HOOKS,
    ],
    [
      path.join('.ratoon', 'types.ts'),
      `// ratoon ${version}\n${ownSource('types.ts')}`,
    ],
    ...PLUGIN_FILES.map((file): [string, string] => [
      path.join('.ratoon', 'plugins', file),
      `// ratoon ${version}\n${ownSource(`plugins/${file}`)}`,
    ]),
    ...bundledDocs().map(({ name: doc, text }): [string, string] => [
      path.join('.ratoon', 'docs', doc),
      text,
    ]),
  ]

  const result: ScaffoldResult = { wrote: [], refreshed: [], kept: [] }
  for (const [rel, content] of files) {
    const key = rel.replace(/\\/g, '/')
    const target = path.join(dir, rel)
    if (existsSync(target)) {
      if (refresh && isToolOwned(key)) {
        writeFileSync(target, content)
        result.refreshed.push(key)
      }
      else {
        result.kept.push(key)
      }
      continue
    }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
    result.wrote.push(key)
  }
  return result
}

export async function runInit(opts: RatoonOptions, flags: InitFlags): Promise<void> {
  const dir = path.resolve(opts.root)
  // first, before the clash check: a stray `init --root <ratoon>` must never touch ratoon
  refuseSelf(dir)
  ensureWritable(dir, flags.force)
  const { wrote, refreshed, kept } = writeScaffolding(dir, flags.force)

  const summary = [`\nscaffolding ${dir}`]
  if (wrote.length > 0)
    summary.push(`  wrote     ${wrote.join(', ')}`)
  if (refreshed.length > 0)
    summary.push(`  refreshed ${refreshed.join(', ')}`)
  if (kept.length > 0)
    summary.push(`  kept      ${kept.join(', ')}`)
  console.log(`${summary.join('\n')}\n`)

  const stale = kept.filter(file => isToolOwned(file))
  if (stale.length > 0)
    console.log(`(--force refreshes ${stale.join(', ')}; your hooks.ts is never touched)\n`)

  console.log(`
Done. Next steps:
  ${repositoryStep(dir)}
  2. edit .ratoon/hooks.ts — starter plugins live in .ratoon/plugins/ (taskNotes is on; npmInstall is opt-in), yours to edit
  3. run \`npm i\` if you want \`npm run typecheck\` (nothing else needs it)
  4. ratoon start <task> --root ${dir}
`)
}

/** The repository may already be in place — the natural order is clone first, scaffold second. */
function repositoryStep(dir: string): string {
  const repos = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(dir, entry.name, '.git')))
    .map(entry => entry.name)
  if (repos.length === 1)
    return `1. repository: ${repos[0]} — \`ratoon list\` shows the pool`
  return `1. put your repository somewhere under ${dir} (ratoon auto-detects the only dir whose .git is a directory)`
}
