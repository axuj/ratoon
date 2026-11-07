import type { HookContext } from '../types.ts'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Shared by the starter plugins, not a plugin itself. Everything here is a plain function, so a
 * project can edit or replace it without touching the engine.
 */

/**
 * `<root>/.state/<slot>/<name>` — where a hook keeps anything that belongs to the slot rather than
 * to the branch: logs, locks, scratch files. Mirrored here so a hook never has to spell out the
 * layout itself, and nothing lands inside a worktree where git would see it.
 */
export function statePath(ctx: Pick<HookContext, 'rootDir' | 'slotDir'>, name: string): string {
  return path.join(ctx.rootDir, '.state', path.basename(ctx.slotDir), name)
}

export const defaultManagers: readonly (readonly [lock: string, cmd: string])[] = [
  ['nub.lock', 'nub'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

/**
 * The manager a `package.json` asks for, if it does: `"packageManager": "nub@0.9.7"` or
 * `devEngines.packageManager.name`. Explicit intent beats a lockfile left over from another tool.
 */
function declaredManager(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      packageManager?: unknown
      devEngines?: { packageManager?: { name?: unknown } }
    }
    const raw = typeof pkg.packageManager === 'string'
      ? pkg.packageManager
      : typeof pkg.devEngines?.packageManager?.name === 'string'
        ? pkg.devEngines.packageManager.name
        : null
    if (!raw)
      return null
    // "nub@0.9.7" / "^pnpm@9.0.0+sha512…" → nub / pnpm
    return raw.replace(/^\^/, '').split('@')[0] || null
  }
  catch {
    return null // no package.json, or malformed JSON — the caller falls back to lockfiles
  }
}

/**
 * Which command installs this slot's dependencies.
 *
 * The JS ecosystem's detector (antfu's `package-manager-detector`, the one shadcn/ni use) reads the
 * explicit `packageManager` / `devEngines.packageManager` field first, then the lockfiles. This is
 * the same order in a few lines, with nothing to install in the pool. `nub.lock` leads the
 * default table, so a nub project still gets `nub install` if the field is missing.
 */
export function detectManager(
  dir: string,
  managers: readonly (readonly [lock: string, cmd: string])[] = defaultManagers,
): string {
  const declared = declaredManager(dir)
  const known = new Set([
    'npm',
    ...managers.map(([, cmd]) => cmd),
  ])
  if (declared && known.has(declared))
    return declared
  // The table order is the tie-breaker: nub before pnpm before npm.
  return managers.find(([lock]) => existsSync(path.join(dir, lock)))?.[1] ?? 'npm'
}

/**
 * Content hash of `package.json` plus every lockfile the manager table knows — the thing that
 * decides whether an install is needed. A custom table contributes its own lockfiles. The
 * fingerprint is taken *before* the install, so it answers "what is on disk now", not "what the
 * manifest says".
 */
export function manifestFingerprint(
  dir: string,
  managers: readonly (readonly [lock: string, cmd: string])[] = defaultManagers,
): string {
  const hash = createHash('md5')
  for (const name of [
    'package.json',
    ...managers.map(([lock]) => lock),
  ]) {
    const file = path.join(dir, name)
    if (!existsSync(file))
      continue
    hash.update(name)
    // latin1 maps bytes 1:1, so normalising line endings stays safe for binary locks too.
    // Skipping this makes `core.autocrlf` checkouts reinstall on every start under Windows.
    hash.update(readFileSync(file).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  }
  return hash.digest('hex')
}
