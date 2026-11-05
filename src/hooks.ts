import type { HookContext, LifecycleHook, Plugin } from './types.ts'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { exists } from './shell.ts'

/**
 * The three moments a plugin can hook — the same names as the `Plugin` fields, so there is one
 * vocabulary: what a hook file declares is what the log and the errors call it.
 *
 * `onBeforeCheckout` and `onStart` are two points in one `start` process: the first before git is
 * allowed to touch the slot (the only place the previous task's files are still there), the second
 * once the checkout is clean.
 */
export type Lifecycle = 'onBeforeCheckout' | 'onStart' | 'onFinish'

/** Facts a hook file receives. Known before it is imported, so they ride on the context. */
export interface HookFacts {
  rootDir: string
  mainDir: string
  slotDir: string
  branch: string
  task: string
  base: string
}

export interface HookRunner {
  /** false when `<root>/.ratoon/hooks.ts` is absent — every call below becomes a no-op */
  present: boolean
  /** Run the plugins that implement `lifecycle`, in array order. Returns their names. */
  run: (lifecycle: Lifecycle) => Promise<string[]>
}

export function hookPath(rootDir: string): string {
  return path.join(rootDir, '.ratoon', 'hooks.ts')
}

/** The `plugins:` line every command prints — `none` / `loaded` / `loaded (a, b)`. */
export function describeHooks(present: boolean, ran: readonly string[]): string {
  if (!present)
    return 'none'
  return ran.length
    ? `loaded (${ran.join(', ')})`
    : 'loaded'
}

function stack(err: unknown): string {
  if (err instanceof Error && err.stack)
    return err.stack
  return String(err)
}

/**
 * A hook's working directory is the slot: relative `node:fs` paths and the commands it spawns all
 * land there without threading a path through. Failures are ignored (a directory that vanished
 * is the hook's problem to report, not the runner's) and the previous cwd is always restored.
 */
async function withSlotCwd<T>(slotDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd()
  let moved = false
  try {
    process.chdir(slotDir)
    moved = true
  }
  catch {}
  try {
    return await fn()
  }
  finally {
    if (moved) {
      try {
        process.chdir(previous)
      }
      catch {}
    }
  }
}

/**
 * Import `<root>/.ratoon/hooks.ts` once. Loading happens outside the slot claim; the caller
 * decides when to `run()` a lifecycle.
 */
export async function loadHooks(facts: HookFacts): Promise<HookRunner> {
  const file = hookPath(facts.rootDir)
  const inert: HookRunner = {
    present: false,
    run: async () => [],
  }
  if (!exists(file))
    return inert

  const ctx: HookContext = { ...facts }

  const plugins = await withSlotCwd(facts.slotDir, async (): Promise<Plugin[] | undefined> => {
    let mod: Record<string, unknown>
    try {
      mod = await import(pathToFileURL(file).href)
    }
    catch (err) {
      throw new Error(`hooks failed to load (${file}):\n${stack(err)}`)
    }
    // No array default → behave exactly like a missing file. The shape is `satisfies Plugin[]`'s
    // job: Node strips types instead of checking them, so typecheck is the only place it is
    // enforced, and re-checking it here would be a second source of truth.
    const candidate = mod.default
    return Array.isArray(candidate)
      ? candidate as Plugin[]
      : undefined
  })

  // present but idle: the file exists, nothing in it runs
  if (!plugins) {
    return {
      present: true,
      run: async () => [],
    }
  }

  return {
    present: true,
    async run(lifecycle) {
      const entries: { by: string, fn: LifecycleHook }[] = []
      for (const plugin of plugins) {
        const fn = plugin[lifecycle]
        if (fn)
          entries.push({ by: plugin.name, fn })
      }
      if (entries.length === 0)
        return []

      await withSlotCwd(facts.slotDir, async () => {
        for (const entry of entries) {
          try {
            await entry.fn(ctx)
          }
          catch (err) {
            // the stack points into whichever file defines this plugin — name it either way
            throw new Error(`plugin "${entry.by}" failed in ${lifecycle}:\n${stack(err)}`)
          }
        }
      })
      return entries.map(entry => entry.by)
    },
  }
}
