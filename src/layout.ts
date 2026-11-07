import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { refExists } from './git.ts'

export interface Layout {
  /** where slots and their state live: `.state/` and `slot-N/` */
  root: string
  /** the repository's own working tree (`.git` is a directory there, a file in every slot) */
  mainDir: string
}

/**
 * The pool lives under `.ratoon/`, so the repository gains exactly one new top-level entry.
 * Stored in `.gitignore` spelling (forward slashes) because the same string becomes an ignore rule.
 */
const POOL_PARTS = ['.ratoon', 'worktrees'] as const
export const POOL_DIR = POOL_PARTS.join('/')

export function poolForRepo(mainDir: string): string {
  return path.join(mainDir, ...POOL_PARTS)
}

/**
 * Every command resolves the same pool: ask git where the repository is, then append the one path
 * ratoon owns. Running from the main worktree, a nested project directory or inside a slot all
 * lead here, so no flags are needed.
 *
 * Nothing has to be installed first. The pool is a fixed path under the repository, created by the
 * first `start`, and `start` also adds the single `.gitignore` line that keeps it out of git. A
 * repository with no slots yet is not an error — it is a repository before its first task.
 */
export function layoutOf(hints: { cwd?: string } = {}): Layout {
  const cwd = path.resolve(hints.cwd ?? process.cwd())
  const repo = mainRepoOf(cwd)
  if (!repo) {
    throw new Error(
      `not inside a git repository: ${cwd}\n`
      + 'run ratoon from inside the repository you want to manage.',
    )
  }
  return {
    root: poolForRepo(repo),
    mainDir: repo,
  }
}

/**
 * The main working tree for `cwd`, found without spawning git: walk up to the nearest `.git`, then
 * follow a worktree's `gitdir:` pointer through `commondir` back to the repository that owns the
 * history. Pure fs keeps `layoutOf` synchronous for every command that calls it.
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
