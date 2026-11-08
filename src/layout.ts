import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { refExists } from './git.ts'
import { exec } from './shell.ts'

export interface Layout {
  /** where slots and their state live: `.state/` and `slot-N/` */
  root: string
  /** the repository's own working tree (`.git` is a directory there, a file in every slot) */
  mainDir: string
  /** `--show-origin` value when `ratoon.poolPath` moved the pool; empty for the built-in default */
  configuredBy: string
}

/**
 * The default pool lives under `.ratoon/`, so the repository gains exactly one new top-level entry.
 * Stored in `.gitignore` spelling (forward slashes) because the same string becomes an ignore rule.
 */
const POOL_PARTS = ['.ratoon', 'worktrees'] as const
export const POOL_DIR = POOL_PARTS.join('/')

export function poolForRepo(mainDir: string): string {
  return path.join(mainDir, ...POOL_PARTS)
}

export const POOL_CONFIG_KEY = 'ratoon.poolPath'

/**
 * The pool a configured **base** directory gives this repository: the repository's own path with
 * the drive folded into the first segment, so `D:/worktree` + `D:/code/app` becomes
 * `<base>/d/code/app`. The mirror is unique by construction, which is what lets one base serve
 * every repository — a bare directory name collides the moment two checkouts are called `app`,
 * and a hash needs an algorithm to stay stable across versions.
 *
 * The path is mirrored after resolving it: Windows can spell one directory two ways (8.3 short
 * names, a subst drive), and two spellings must not become two pools.
 */
function derivePool(base: string, mainDir: string): string {
  let canonical = mainDir
  try {
    canonical = realpathSync.native(mainDir)
  }
  catch {}
  const { root: volume } = path.parse(canonical)
  const rest = path.relative(volume, canonical)
  const drive = volume.replace(/[:/\\]/g, '').toLowerCase()
  return drive === ''
    ? path.join(base, rest)
    : path.join(base, drive, rest)
}

/**
 * Let git resolve its own config: one call covers local over global, includes, and GIT_CONFIG_*
 * injections, and `--show-origin` says where a surprising path came from. Hand-parsing
 * `.git/config` would miss all of that — including a slot whose `.git` file points at a common
 * dir somewhere else. A missing key (exit 1) simply means "use the default".
 *
 * The value is a base directory, not the pool itself: each repository lands under its own mirrored
 * path (see `derivePool`), so a global setting can name one directory for every project without
 * two of them sharing slots. A relative value is resolved against the main working tree, so a base
 * beside the repository survives moving both.
 */
async function configuredPool(mainDir: string): Promise<{ root: string, origin: string } | undefined> {
  const result = await exec('git', [
    '-C',
    mainDir,
    'config',
    '--show-origin',
    '--get',
    POOL_CONFIG_KEY,
  ])
  if (result.status !== 0)
    return undefined

  const line = result.stdout.replace(/\r?\n+$/, '')
  const tab = line.indexOf('\t')
  if (tab < 0)
    throw new Error(`could not parse ${POOL_CONFIG_KEY}: ${line}`)
  const origin = line.slice(0, tab)
  const value = line.slice(tab + 1).trim()
  if (value === '')
    throw new Error(`${POOL_CONFIG_KEY} is empty — set a path or unset the key`)

  const base = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(mainDir, value)
  const root = derivePool(base, mainDir)

  // A base that puts the pool on the repository itself or above it would hand `start` a directory
  // holding its own checkout. Refuse here rather than failing later inside `git worktree add`.
  const rest = path.relative(root, mainDir)
  if (rest === '' || (!rest.startsWith('..') && !path.isAbsolute(rest))) {
    throw new Error(
      `${POOL_CONFIG_KEY} must not put the pool on the repository or above it: ${root}`,
    )
  }

  // Inside the repository the pool has to sit under `.ratoon/`, the only directory the one ignore
  // rule covers. Anywhere else inside it the slots would be untracked files, and one `git add -A`
  // would commit every worktree into the project.
  const inside = path.relative(mainDir, root)
  if (inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)
    && !poolIsIgnoredByRule(root, mainDir)) {
    throw new Error(
      `${POOL_CONFIG_KEY} must point outside the repository or into ${POOL_PARTS[0]}/: ${root}\n`
      + `only ${POOL_PARTS[0]}/* is ignored — unset the key to use ${POOL_DIR}`,
    )
  }
  return { root, origin }
}

/**
 * Whether the built-in `.ratoon/*` ignore rule already covers a pool. Every other pool is outside
 * the repository: a pool inside it and outside `.ratoon/` is refused where the base is resolved.
 */
export function poolIsIgnoredByRule(root: string, mainDir: string): boolean {
  const rel = path.relative(path.join(mainDir, '.ratoon'), root)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Every command resolves the same pool: ask git where the repository is, then read the one key
 * that may move it — a base directory each repository mirrors itself under. Running from the main
 * worktree, a nested project directory or inside a slot all lead here, so no flags are needed — a
 * flag would be missing exactly when `finish` runs from inside a slot. The source is persisted in
 * git config, not in the environment.
 *
 * Nothing has to be installed first. The default pool is a fixed path under the repository,
 * created by the first `start`, which also adds the single `.gitignore` line that keeps it out of
 * git. A repository with no slots yet is not an error — it is a repository before its first task.
 */
export async function layoutOf(hints: { cwd?: string } = {}): Promise<Layout> {
  const cwd = path.resolve(hints.cwd ?? process.cwd())
  const repo = mainRepoOf(cwd)
  if (!repo) {
    throw new Error(
      `not inside a git repository: ${cwd}\n`
      + 'run ratoon from inside the repository you want to manage.',
    )
  }
  const configured = await configuredPool(repo)
  return {
    root: configured?.root ?? poolForRepo(repo),
    mainDir: repo,
    configuredBy: configured?.origin ?? '',
  }
}

/**
 * The main working tree for `cwd`, found without spawning git: walk up to the nearest `.git`, then
 * follow a worktree's `gitdir:` pointer through `commondir` back to the repository that owns the
 * history. Pure fs keeps this lookup cheap; the only subprocess in the layout is the config read.
 * It also works when a slot lives outside the repository, because git's admin dir stays put.
 */
function mainRepoOf(startDir: string): string | undefined {
  for (let dir = path.resolve(startDir); ;) {
    const dot = path.join(dir, '.git')
    try {
      const stat = lstatSync(dot)
      if (stat.isDirectory())
        return dir
      if (stat.isFile()) {
        const text = readFileSync(dot, 'utf8').trim()
        const prefix = 'gitdir:'
        if (!text.toLowerCase().startsWith(prefix))
          return undefined
        const gitDir = path.resolve(dir, text.slice(prefix.length).trim())
        let common = path.resolve(gitDir, '..', '..')
        try {
          common = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())
        }
        catch {}
        return path.dirname(common)
      }
    }
    catch {}
    const parent = path.dirname(dir)
    if (parent === dir)
      return undefined
    dir = parent
  }
}

/** `--base` wins; otherwise master, then main. */
export async function resolveBaseRef(opts: { base: string, baseAuto: boolean }, mainDir: string): Promise<string> {
  if (!opts.baseAuto) {
    if (!await refExists(mainDir, opts.base))
      throw new Error(`base ref not found: ${opts.base}`)
    return opts.base
  }
  for (const candidate of ['master', 'main']) {
    if (await refExists(mainDir, candidate))
      return candidate
  }
  throw new Error(`no base branch (master/main) found in ${mainDir} — pass --base <ref>`)
}
