import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { layoutOf } from './layout.ts'
import { exec } from './shell.ts'
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
 * The one line that keeps the toolbox out of git: `.ratoon/*` in this clone's `.git/info/exclude`,
 * never `.gitignore`, which is a project file. The rule is local, so a clone that versions the
 * toolbox still ignores the rest of the directory.
 *
 * The glob is deliberate: with plain `.ratoon/`, git never descends into the ignored directory, so
 * `!.ratoon/hooks.ts` could never re-include a file a project decides to share.
 *
 * Only `init` calls this. A plain `git init` is already enough to begin. Idempotent: a second call
 * never appends a duplicate, and `.ratoon/` — the same rule without the glob — counts as installed.
 * It only adds; nothing here removes a line.
 *
 * The rule gets a paragraph of its own. Appended straight onto the last entry it reads as a member
 * of whatever group ends the file, and a line the project never wrote is the first one a reader
 * deletes by mistake. It is still one rule — only the blank line above it is new.
 */
const IGNORE_RULE = '.ratoon/*'

const IGNORE_SPELLINGS = [IGNORE_RULE, '.ratoon/']

/** Whether a single ignore line is ratoon's own rule, in any spelling it has ever written. */
function isRatoonRule(line: string): boolean {
  const trimmed = line.trim()
  return IGNORE_SPELLINGS.some(rule => trimmed === rule || trimmed === `/${rule}`)
}

/** Whether an ignore file already covers `.ratoon/`. */
function coversRatoon(text: string): boolean {
  return text.split(/\r?\n/).some(isRatoonRule)
}

/**
 * `.git/info/exclude` the way git resolves it — right for linked worktrees, submodules and
 * `--separate-git-dir`, where `.git` may be a file or somewhere else entirely.
 */
async function excludeFile(repo: string): Promise<string> {
  const result = await exec('git', [
    '-C',
    repo,
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'info/exclude',
  ])
  if (result.status !== 0)
    throw new Error(`could not locate .git/info/exclude: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function ensureRatoonIgnored(repo: string): Promise<'added' | 'created' | 'present'> {
  const file = await excludeFile(repo)
  const text = existsSync(file)
    ? readFileSync(file, 'utf8')
    : ''

  if (coversRatoon(text))
    return 'present'

  // `text` is kept byte for byte: the gap only closes a last line that lacks its newline and adds
  // the blank one. A file that already ends in a blank line needs neither.
  const eol = text.includes('\r\n')
    ? '\r\n'
    : '\n'
  mkdirSync(path.dirname(file), { recursive: true })
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
 * It writes `.ratoon/` files and one line in this clone's `.git/info/exclude`. The project's own
 * `package.json` and `tsconfig.json` are left alone.
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
  const ignored = await ensureRatoonIgnored(repo)

  // `start` creates the pool on demand — an empty directory is not an installation marker
  const { root: pool } = await layoutOf({ cwd })

  const summary = [`\ninstalling ratoon into ${repo}`]
  if (wrote.length > 0)
    summary.push(`  wrote     ${wrote.join(', ')}`)
  else if (kept.length > 0)
    summary.push('  exists    all files — nothing to write')
  if (kept.length > 0 && wrote.length > 0)
    summary.push(`  exists    ${kept.join(', ')}`)
  if (ignored !== 'present')
    summary.push(`  ${ignored}   .git/info/exclude (${IGNORE_RULE}, local to this clone)`)
  console.log(`${summary.join('\n')}\n`)

  if (kept.length > 0)
    console.log('(files under "exists" were already there and were left untouched. Delete one and run init again to take the newer copy.)\n')

  console.log(`
Done. Everything here is optional — \`ratoon start\` already works in this repository.

Next steps:
  1. edit .ratoon/hooks.ts — starter plugins live in .ratoon/plugins/ (taskNotes is on; npmInstall is opt-in)
  2. ratoon start <task>            # pool: ${pool}
  3. npx skills add axuj/ratoon --skill ratoon -g   # global: a slot is a separate worktree

@types/node is not installed: an editor shows TS2688 here, \`ratoon start\` does not care.
For completions while writing plugins: \`cd .ratoon && npm i\`.
`)
}
