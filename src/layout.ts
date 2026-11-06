import type { RatoonOptions } from './cli.ts'
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { refExists } from './git.ts'

export interface Layout {
  /** worktrees container directory: holds the main repo, the slots and their state */
  root: string
  /** the repository's own working tree (`.git` is a directory there, a file in every slot) */
  mainDir: string
}

/** The layout a command runs against, given how the user pointed at the container. */
export function layoutOf(opts: RatoonOptions): Layout {
  return resolveLayout(opts.root, opts.main, { walkUp: !opts.rootGiven })
}

/**
 * `root` is where the user pointed us: cwd, or `--root`. The directory you name is taken to be the
 * container when it holds exactly one main repository. If you are instead *inside* a repository,
 * the container is the directory above it — but only when that directory carries a container
 * marker, because a repository that merely lives somewhere must never make its parent a slot pool.
 * An explicit `--root` is used as given: naming it is an instruction, not a hint.
 */
export function resolveLayout(root: string, main: string, opts: { walkUp?: boolean } = {}): Layout {
  const resolvedRoot = path.resolve(root)
  if (main) {
    return {
      root: resolvedRoot,
      mainDir: path.resolve(resolvedRoot, main),
    }
  }
  return discoverLayout(resolvedRoot, opts.walkUp ?? false)
}

interface DirScan {
  /** child directories whose `.git` is a directory — the only shape a main repo takes */
  mains: string[]
  /** `.ratoon/`, `.state/` or a `slot-N/`: what separates a container root from a plain directory */
  container: boolean
}

function scanDir(dir: string): DirScan {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    throw new Error(`worktrees root does not exist or is not readable: ${dir}`)
  }

  const mains: string[] = []
  let container = false
  for (const entry of entries) {
    if (entry.name === '.ratoon' || entry.name === '.state' || /^slot-\d+$/.test(entry.name))
      container = true
    if (!entry.isDirectory())
      continue
    try {
      // a worktree carries `.git` as a *file* pointing at the admin dir; only the main repo has a directory
      if (lstatSync(path.join(dir, entry.name, '.git')).isDirectory())
        mains.push(entry.name)
    }
    catch {}
  }
  return { mains, container }
}

function discoverLayout(startDir: string, walkUp: boolean): Layout {
  const here = scanDir(startDir)
  if (here.mains.length === 1) {
    return {
      root: startDir,
      mainDir: path.join(startDir, here.mains[0]!),
    }
  }
  if (here.mains.length > 1) {
    throw new Error(
      `multiple main git repositories found under ${startDir}: ${here.mains.join(', ')}
`
      + 'pass --main <dir> to pick one.',
    )
  }

  if (walkUp) {
    const top = enclosingRepo(startDir)
    if (top) {
      const root = path.dirname(top)
      const above = scanDir(root)
      if (above.container && above.mains.length === 1) {
        return {
          root,
          mainDir: path.join(root, above.mains[0]!),
        }
      }
    }
  }

  const why = here.container
    ? `${startDir} is a container root but holds no repository: put it in <root>/<main-repo>/`
    : walkUp
      ? `no ratoon container found from ${startDir} upwards: it expects <root>/<main-repo>/ next to .ratoon/ and slot-N/`
      : `no main git repository found under ${startDir}: it expects <root>/<main-repo>/ plus <root>/slot-N/ worktrees`
  throw new Error(`${why}
Use --root <dir> to name the container yourself.`)
}

/** Nearest directory at or above `startDir` that is a git worktree — `.git` as a directory or a file. */
function enclosingRepo(startDir: string): string | undefined {
  for (let dir = startDir; ;) {
    try {
      lstatSync(path.join(dir, '.git'))
      return dir
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
