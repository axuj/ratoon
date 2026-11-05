import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { refExists } from './git.ts'

export interface Layout {
  /** worktrees container directory: holds the main repo, the slots and their state */
  root: string
  /** the repository's own working tree (`.git` is a directory there, a file in every slot) */
  mainDir: string
}

export function resolveLayout(root: string, main: string): Layout {
  const resolvedRoot = path.resolve(root)
  const mainDir = main
    ? path.resolve(resolvedRoot, main)
    : discoverMainDir(resolvedRoot)
  return { root: resolvedRoot, mainDir }
}

function discoverMainDir(root: string): string {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  }
  catch {
    throw new Error(`worktrees root does not exist or is not readable: ${root}`)
  }

  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue
    try {
      // a worktree carries `.git` as a *file* pointing at the admin dir; only the main repo has a directory
      if (lstatSync(path.join(root, entry.name, '.git')).isDirectory())
        candidates.push(entry.name)
    }
    catch {}
  }

  if (candidates.length === 1)
    return path.join(root, candidates[0]!)
  if (candidates.length === 0) {
    throw new Error(
      `no main git repository found directly under ${root}\n`
      + 'ratoon expects <root>/<main-repo>/ plus <root>/slot-N/ worktrees. Use --root <dir>.',
    )
  }
  throw new Error(
    `multiple main git repositories found under ${root}: ${candidates.join(', ')}\n`
    + 'pass --main <dir> to pick one.',
  )
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
