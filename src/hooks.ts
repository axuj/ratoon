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
  /** false when neither the pool nor the repository has a hooks.ts — every call below is a no-op */
  present: boolean
  /** Plugins the file exports: 0 when it is absent, empty, or has no usable array default. */
  count: number
  /** Run the plugins that implement `lifecycle`, in array order. Returns their names. */
  run: (lifecycle: Lifecycle) => Promise<string[]>
}

/** Repository hooks: versioned, read from the main working tree. */
export function hookPath(dir: string): string {
  return path.join(dir, '.ratoon', 'hooks.ts')
}

/**
 * Two hook files may exist, and both are loaded. The pool-level one comes first: it sits at
 * `<pool>/hooks.ts` inside the ignored pool, so it is a machine-local override that never enters
 * version control. The repository's `.ratoon/hooks.ts` follows. It is read from the main working
 * tree only — a team may commit it to share the config, but the copy a slot checks out is never
 * consulted, so the file that runs is the one being edited.
 */
function hookFiles(facts: HookFacts): string[] {
  const candidates = [
    path.join(facts.rootDir, 'hooks.ts'),
    hookPath(facts.mainDir),
  ].map(file => path.resolve(file))
  return Array.from(new Set(candidates)).filter(exists)
}

/**
 * The `plugins:` line every command prints. Three states matter, and they used to collapse into
 * one: nothing installed, a file that enables nothing, and plugins that simply do not implement
 * this lifecycle. The first two look identical to a user who just ran `init` and is wondering why
 * nothing installed.
 */
export function describeHooks(present: boolean, ran: readonly string[], count: number): string {
  if (!present)
    return 'none'
  if (count === 0)
    return 'loaded (no plugins)'
  return ran.length
    ? `loaded (${ran.join(', ')})`
    : 'loaded (none)'
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
 * Import every hooks file once and concatenate their plugin arrays, pool-level first. Loading
 * happens outside the slot claim; the caller decides when to `run()` a lifecycle.
 */
export async function loadHooks(facts: HookFacts): Promise<HookRunner> {
  const files = hookFiles(facts)
  const inert: HookRunner = {
    present: false,
    count: 0,
    run: async () => [],
  }
  if (files.length === 0)
    return inert

  const ctx: HookContext = { ...facts }

  const plugins = await withSlotCwd(facts.slotDir, async (): Promise<Plugin[] | undefined> => {
    const all: Plugin[] = []
    let declared = false
    for (const file of files) {
      let mod: Record<string, unknown>
      try {
        mod = await import(pathToFileURL(file).href)
      }
      catch (err) {
        throw new Error(`hooks failed to load (${file}):\n${stack(err)}`)
      }
      // No array default → the file contributes nothing. The shape is `satisfies Plugin[]`'s job:
      // Node strips types instead of checking them, so typecheck is the only place it is enforced.
      const candidate = mod.default
      if (Array.isArray(candidate)) {
        declared = true
        all.push(...candidate as Plugin[])
      }
    }
    return declared
      ? all
      : undefined
  })

  // present but idle: the file exists, nothing in it runs
  if (!plugins) {
    return {
      present: true,
      count: 0,
      run: async () => [],
    }
  }

  return {
    present: true,
    count: plugins.length,
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
