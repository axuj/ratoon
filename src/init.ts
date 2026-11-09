import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { layoutOf } from './layout.ts'
import { HOOKS, PACKAGE_JSON, TSCONFIG } from './templates.ts'

const PLUGIN_FILES = [
  'npm-install.ts',
  'shared.ts',
  'task-notes.ts',
] as const

export interface ScaffoldResult {
  /** created because the file did not exist */
  wrote: string[]
  /** already there, left exactly as it was */
  kept: string[]
}

function ratoonRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url))
}

/**
 * A file the project gets to own: `src/types.ts` and `src/plugins/*.ts` are copied verbatim, so a
 * project never imports the engine at runtime — and can edit any of them.
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
    throw new Error('refusing to init ratoon inside itself — run init from a different repository')
}

/**
 * The one line that keeps ratoon's local state out of git. It is a glob on purpose: with plain
 * `.ratoon/`, git never descends into the ignored directory, so `!.ratoon/hooks.ts` could not
 * re-include a file a team wants to share. `.ratoon/*` ignores everything today and leaves that
 * door open.
 *
 * `start` calls this on every run, so a plain `git init` is already enough to begin; `init` calls
 * it too, for people who start there. Idempotent: a second call never appends a duplicate. An older
 * `.ratoon/worktrees/` rule counts as installed, so existing repositories are left as they are.
 *
 * The rule gets a paragraph of its own. Appended straight onto the last entry it reads as a member
 * of whatever group ends the file (`# scratch`, `# editors`, …), and a line the project never wrote
 * is the first one a reader deletes by mistake. It is still one rule — only the blank line above it
 * is new.
 */
export const IGNORE_RULE = '.ratoon/*'

export function ensureRatoonIgnored(repo: string): 'added' | 'created' | 'present' {
  const file = path.join(repo, '.gitignore')
  const text = existsSync(file)
    ? readFileSync(file, 'utf8')
    : ''
  const lines = text.split(/\r?\n/).map(line => line.trim())
  const installed = lines.some(line =>
    [IGNORE_RULE, '.ratoon/', '.ratoon/worktrees/'].some(rule => line === rule || line === `/${rule}`))
  if (installed)
    return 'present'

  // `text` is kept byte for byte: the gap only closes a last line that lacks its newline and adds
  // the blank one. A file that already ends in a blank line needs neither.
  const eol = text.includes('\r\n')
    ? '\r\n'
    : '\n'
  writeFileSync(file, `${text}${gapAbove(text, eol)}${IGNORE_RULE}${eol}`)
  return text === ''
    ? 'created'
    : 'added'
}

/** What goes between the project's last line and the rule: close it, then blank one line. */
function gapAbove(text: string, eol: string): string {
  if (text === '')
    return ''
  if (!text.endsWith(eol))
    return eol + eol
  if (text.endsWith(eol + eol))
    return ''
  return eol
}

/**
 * `init` only creates missing files, so an existing `.ratoon/` is never a reason to refuse — not
 * one you made yourself, not one already holding your own plugins or a `hooks.ts` you wrote. The
 * single case worth stopping for is a `.ratoon` that is a file: every write below would fail with
 * a raw errno instead of saying what is wrong.
 */
export function ensureWritable(repo: string): void {
  const dir = path.join(repo, '.ratoon')
  if (existsSync(dir) && !statSync(dir).isDirectory())
    throw new Error(`${dir} is a file, not a directory — move it aside and run init again`)
}

/**
 * Write the executable configuration into the repository: `hooks.ts`, the types, the starter
 * plugins and an editor setup of their own (`tsconfig.json` plus a private `package.json`), all
 * under `.ratoon/`. Rules for agents live in the ratoon skill and are never copied into a
 * repository, where they would freeze at the version that ran `init`.
 *
 * Only missing files are written. An existing one is never overwritten, so editing a starter
 * plugin, a type, or `hooks.ts` is safe: the next `init` leaves it byte for byte. The way to take
 * a newer copy after upgrading ratoon is to delete that file and run `init` again.
 *
 * The project's `package.json` and `tsconfig.json` are never touched; `.gitignore` gets one line
 * from `ensureRatoonIgnored`.
 */
export function writeScaffolding(dir: string): ScaffoldResult {
  mkdirSync(path.join(dir, '.ratoon'), { recursive: true })

  const files: [rel: string, content: string][] = [
    [
      path.join('.ratoon', 'hooks.ts'),
      HOOKS,
    ],
    [
      path.join('.ratoon', 'types.ts'),
      ownSource('types.ts'),
    ],
    ...PLUGIN_FILES.map((file): [string, string] => [
      path.join('.ratoon', 'plugins', file),
      ownSource(`plugins/${file}`),
    ]),
    [
      path.join('.ratoon', 'package.json'),
      PACKAGE_JSON,
    ],
    [
      path.join('.ratoon', 'tsconfig.json'),
      TSCONFIG,
    ],
  ]

  const result: ScaffoldResult = { wrote: [], kept: [] }
  for (const [rel, content] of files) {
    const key = rel.replace(/\\/g, '/')
    const target = path.join(dir, rel)
    if (existsSync(target)) {
      result.kept.push(key)
      continue
    }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content)
    result.wrote.push(key)
  }
  return result
}

/**
 * `init` writes files and nothing else: no subprocess, no network, no package manager. Installing
 * `@types/node` is the project's call and only affects an editor — the hooks run either way.
 */
export async function runInit(): Promise<void> {
  const cwd = process.cwd()
  // first: a stray `init` in ratoon's own checkout must never write into it
  refuseSelf(cwd)

  const repo = (await layoutOf()).mainDir
  ensureWritable(repo)
  const { wrote, kept } = writeScaffolding(repo)
  const ignored = ensureRatoonIgnored(repo)

  // `start` creates the pool on demand. An empty ignored directory is not an installation marker:
  // `git clean -fdx` removes it, and `resolveLayout` reads committed traces instead.
  const { root: pool } = await layoutOf({ cwd })

  const summary = [`\ninstalling ratoon into ${repo}`]
  if (wrote.length > 0)
    summary.push(`  wrote     ${wrote.join(', ')}`)
  else if (kept.length > 0)
    summary.push('  exists    all files — nothing to write')
  if (kept.length > 0 && wrote.length > 0)
    summary.push(`  exists    ${kept.join(', ')}`)
  if (ignored !== 'present')
    summary.push(`  ${ignored}   .gitignore (${IGNORE_RULE})`)
  console.log(`${summary.join('\n')}\n`)

  if (kept.length > 0)
    console.log('(files under "exists" were already there and were left untouched. Delete one and run init again to take the newer copy.)\n')

  console.log(`
Done. Everything here is optional — \`ratoon start\` already works in this repository.

Next steps:
  1. edit .ratoon/hooks.ts — starter plugins live in .ratoon/plugins/ (taskNotes is on; npmInstall is opt-in)
  2. ratoon start <task>            # pool: ${pool}
  3. npx skills add axuj/ratoon --skill ratoon   # give your agent the workflow rules

@types/node is not installed: an editor shows TS2688 here, \`ratoon start\` does not care.
For completions while writing plugins: \`cd .ratoon && npm i\`.
`)
}
