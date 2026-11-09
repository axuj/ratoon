/**
 * Everything a lifecycle callback receives: where the slot is, which task it is doing, and the
 * branch this run revolves around. Facts only — running a command, reading a file or spawning a
 * process is the hook's own business (`node:fs`, `node:child_process`, or whatever the project
 * installs).
 *
 * While a callback runs the process cwd is the slot, so relative paths and `spawn` calls land
 * there without being told.
 */
export interface HookContext {
  /** the pool — `<repo>/.ratoon/worktrees/` by default, movable with `ratoon.poolPath` — holds the slots and `.state/` */
  rootDir: string
  /** the repository's own working tree */
  mainDir: string
  slotDir: string
  branch: string
  task: string
  /**
   * `start`: the ref the branch was cut from.
   * `finish`: the branch the work is landing on — `--into`, or the main worktree's checked-out one.
   */
  base: string
}

export type LifecycleHook = (ctx: HookContext) => unknown | Promise<unknown>

/** One slot as a command sees it. Read-only: a command reports on the pool, the engine owns it. */
export interface SlotView {
  dir: string
  path: string
  task: string
  branch: string
  worktree: boolean
  missing: boolean
}

/** Facts available when a plugin declares its commands, and again when one of them runs. */
export interface PluginContext {
  /** the pool — slots live here, notes and claims under `.state/` */
  rootDir: string
  /** the repository's own working tree */
  mainDir: string
  /** a snapshot of every slot, in pool order */
  slots: readonly SlotView[]
}

export type CommandArgs = Record<string, string | number | boolean | string[] | undefined>

/** What a command's `run` receives: the parsed arguments together with the pool facts. */
export interface CommandRunContext extends PluginContext {
  args: CommandArgs
  rawArgs: string[]
}

/**
 * An argument definition with the same shape as the CLI's own. Declared here so a hooks file
 * needs no dependency on ratoon's packages: it runs from the project's `.ratoon/` directory.
 */
export interface PluginArgDef {
  type: 'string' | 'boolean' | 'positional' | 'enum'
  description?: string
  valueHint?: string
  alias?: string
  default?: string | boolean
  required?: boolean
  options?: string[]
}

/** One command, optionally a group. `run` is optional on a group. */
export interface PluginCommandSpec {
  description?: string
  args?: Record<string, PluginArgDef>
  subCommands?: Record<string, PluginCommandSpec>
  run?: (ctx: CommandRunContext) => unknown | Promise<unknown>
}

export type PluginCommands = Record<string, PluginCommandSpec>

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
  /**
   * Commands this plugin adds to `ratoon`. Called when the CLI builds its command tree; every
   * key becomes a top-level subcommand. A name already used by the engine or an earlier plugin
   * is skipped, with a line on stderr. Each command declares only the flags it reads; `run`
   * receives the parsed args and a read-only pool snapshot instead of a slot context.
   */
  commands?: (ctx: PluginContext) => PluginCommands | Promise<PluginCommands>
}

/**
 * `<repo>/.ratoon/hooks.ts` default-exports an array of these:
 *
 *   export default [taskNotes(), npmInstall()] satisfies Plugin[]
 *
 * An optional `<pool>/hooks.ts` is loaded first as a machine-local override — the pool is
 * gitignored, so it never enters version control. The arrays are concatenated: everything is a
 * plugin, your own code included, with one ordered list and no special "host" position. Array
 * order is execution order, independently for each lifecycle:
 *
 *   ratoon start : engine(claim) → plugins[].onBeforeCheckout → engine(branch → clean) → plugins[].onStart
 *   ratoon finish: engine(locate → claim) → plugins[].onFinish in array order → engine(land)
 *
 * An empty array — or no hooks file at all — means a pure worktree pool.
 *
 * State shared between callbacks inside one process is an ordinary module-level `let` — this
 * file is a module, loaded once per command.
 */
