import type { LifecycleHook, Plugin } from '../types.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultManagers, detectManager, manifestFingerprint, statePath } from './shared.ts'

/** Run a package manager through the platform shell — on Windows it is a `.cmd` shim. */
function run(cmd: string, args: string[], cwd: string): void {
  const quote = (arg: string): string => (/[\s"]/.test(arg)
    ? `"${arg.replace(/"/g, '\\"')}"`
    : arg)
  const line = [cmd, ...args].map(quote).join(' ')
  const result = spawnSync(line, { cwd, stdio: 'inherit', shell: true })
  if (result.status !== 0)
    throw new Error(`command failed (${result.status ?? 'signal'}): ${line} (cwd: ${cwd})`)
}

export interface NpmInstallOptions {
  /**
   * Override the lockfile → command table. `packageManager` / `devEngines.packageManager` still
   * wins when it names a command in this table, so a custom manager can declare itself in
   * `package.json`.
   */
  managers?: readonly (readonly [lock: string, cmd: string])[]
  /**
   * Arguments after the package manager. Defaults to `['install']`, plus `--no-audit --no-fund`
   * when the manager turns out to be npm — try `['ci']` for a clean one.
   */
  args?: string[]
}

/**
 * Fingerprint the slot's manifests, skip when nothing changed and `node_modules` is present,
 * otherwise install with the project's own package manager (`packageManager` field first, then
 * `nub.lock` / pnpm / npm / yarn / bun). State lives in `<root>/.state/<slot>…` under the pool,
 * which the project's `.gitignore` keeps out of git, so no worktree needs its own rule for it.
 */
export function npmInstall(options: NpmInstallOptions = {}): Plugin {
  const managers = options.managers ?? defaultManagers

  const onStart: LifecycleHook = async (ctx) => {
    if (!existsSync(path.join(ctx.slotDir, 'package.json')))
      return // not a JS project — this plugin simply does nothing

    const fingerprint = manifestFingerprint(ctx.slotDir, managers)
    const state = statePath(ctx, 'install')
    const ready = existsSync(path.join(ctx.slotDir, 'node_modules'))
    if (ready && readState(state) === fingerprint)
      return

    const pm = detectManager(ctx.slotDir, managers)
    // npm is the only manager here that audits, and `npm audit` is a registry round trip on every
    // start of a cold slot — the one thing an install plugin must not do by accident
    const args = options.args ?? (pm === 'npm'
      ? ['install', '--no-audit', '--no-fund']
      : ['install'])
    await run(pm, args, ctx.slotDir)

    mkdirSync(path.dirname(state), { recursive: true })
    writeFileSync(state, fingerprint)
  }

  return { name: 'npmInstall', onStart }
}

function readState(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return ''
  }
}
