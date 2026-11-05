/**
 * Everything a lifecycle callback receives: where the slot is, which task it is doing, and which
 * base it was cut from. Facts only — running a command, reading a file or spawning a process is
 * the hook's own business (`node:fs`, `node:child_process`, or whatever you add to the container).
 *
 * While a callback runs the process cwd is the slot, so relative paths and `spawn` calls land
 * there without being told.
 */
export interface HookContext {
  /** worktrees container directory (holds the main repo, the slots, .ratoon) */
  rootDir: string
  mainDir: string
  slotDir: string
  branch: string
  task: string
  base: string
}

export type LifecycleHook = (ctx: HookContext) => unknown | Promise<unknown>

/**
 * A reusable unit of behaviour. `name` is not cosmetic: failures are reported as
 * `plugin "npmInstall" failed in onStart` so you know the stack points into ratoon's source
 * rather than into your own hooks file.
 */
export interface Plugin {
  name: string
  /**
   * `ratoon start` — the slot is claimed by this process, but **git has not touched the
   * directory**: it still holds whatever the previous task left there. This is the only moment you
   * can read that state (the checkout replaces it), and the last moment to clear anything that
   * would block git — a dev server holding the directory, a leftover lock.
   *
   * On a brand-new slot the directory does not exist yet — check `existsSync(ctx.slotDir)`.
   */
  onBeforeCheckout?: LifecycleHook
  /** `ratoon start` — the slot is checked out and cleaned; runs in array order. */
  onStart?: LifecycleHook
  /** `ratoon finish` — before the dirty check; runs in array order. */
  onFinish?: LifecycleHook
}

/**
 * `<root>/.ratoon/hooks.ts` default-exports an array of these:
 *
 *   export default [npmInstall(), progressFile()] satisfies Plugin[]
 *
 * Everything is a plugin — your own code included — so there is a single ordered list and no
 * special "host" position. Array order is execution order, independently for each lifecycle:
 *
 *   ratoon start : engine(claim) → plugins[].onBeforeCheckout → engine(branch → clean) → plugins[].onStart
 *   ratoon finish: engine(locate → claim) → plugins[].onFinish in array order → engine(land)
 *
 * An empty array — or no hooks file at all — means a pure worktree pool.
 *
 * State shared between callbacks inside one process is an ordinary module-level `let` — this
 * file is a module, loaded once per command.
 */
