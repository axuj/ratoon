import type { ArgsDef, CommandDef, SubCommandsDef } from 'citty'
import type { CommandArgs, Plugin, PluginCommandSpec, PluginContext } from './types.ts'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { PausedError } from './errors.ts'
import { hookFiles } from './hooks.ts'
import { layoutOf } from './layout.ts'
import { renderPoolTable, slotViews } from './pool-table.ts'
import { scanPool } from './state.ts'

let diagnostics: string[] = []

/** Why a plugin command is missing — reported under `ratoon --help` and on a usage error. */
export function pluginDiagnostics(): readonly string[] {
  return diagnostics
}

function message(err: unknown): string {
  return err instanceof Error
    ? err.message
    : String(err)
}

/** A plugin command's errors get the engine's one-line treatment; a pause keeps exit code 2. */
async function guard(owner: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await run()
  }
  catch (err) {
    console.error(`\nratoon: plugin "${owner}" command failed: ${message(err)}`)
    process.exit(err instanceof PausedError
      ? err.exitCode
      : 1)
  }
}

function toCommandDef(
  name: string,
  spec: PluginCommandSpec,
  ctx: PluginContext,
  owner: string,
): CommandDef {
  const command: CommandDef = {
    meta: { name, description: spec.description },
    // A plugin declares only the flags it reads. The engine's --base, --into and --branch-prefix
    // belong to the commands that use them, so they are not injected into a plugin's command tree.
    args: { ...spec.args } as unknown as ArgsDef,
  }
  if (spec.subCommands) {
    const subs: SubCommandsDef = {}
    for (const [sub, child] of Object.entries(spec.subCommands))
      subs[sub] = toCommandDef(sub, child, ctx, owner)
    command.subCommands = subs
  }
  if (spec.run) {
    const run = spec.run
    command.run = ({ args, rawArgs }) => guard(owner, () => run({
      ...ctx,
      args: args as CommandArgs,
      rawArgs,
    }))
  }
  return command
}

/**
 * The commands plugins contribute, keyed by their top-level name. Hook files are imported
 * without a slot context and without changing the process cwd: command discovery has no task,
 * branch or slot to hand a lifecycle hook, and `loadHooks` remains the only path that runs with
 * a slot as the working directory.
 *
 * A broken plugin must not take the built-in commands down with it, so every failure is
 * collected in `pluginDiagnostics()` instead of being thrown.
 */
export async function pluginCommands(reserved: readonly string[]): Promise<SubCommandsDef> {
  diagnostics = []
  const layout = await layoutOf().catch(() => undefined)
  if (!layout)
    return {} // outside a git repository there is no pool and no hooks file

  const files = hookFiles(layout.root, layout.mainDir)
  if (files.length === 0)
    return {}

  let pool
  try {
    pool = await scanPool(layout.root, layout.mainDir)
  }
  catch (err) {
    diagnostics.push(`pool could not be read: ${message(err)}`)
    return {}
  }

  const ctx: PluginContext = {
    rootDir: layout.root,
    mainDir: layout.mainDir,
    slots: slotViews(pool),
    renderPool: columns => renderPoolTable({
      root: layout.root,
      mainDir: layout.mainDir,
      configuredBy: layout.configuredBy,
      pool,
    }, columns),
  }

  const taken = new Set(reserved)
  const found: SubCommandsDef = {}
  for (const file of files) {
    let mod: Record<string, unknown>
    try {
      mod = await import(pathToFileURL(file).href)
    }
    catch (err) {
      diagnostics.push(`${file} failed to load: ${message(err)}`)
      continue
    }
    if (!Array.isArray(mod.default))
      continue
    for (const plugin of mod.default as Plugin[]) {
      if (typeof plugin?.commands !== 'function')
        continue
      let table
      try {
        table = await plugin.commands(ctx)
      }
      catch (err) {
        diagnostics.push(`plugin "${plugin.name}" commands failed: ${message(err)}`)
        continue
      }
      for (const [name, spec] of Object.entries(table ?? {})) {
        if (taken.has(name)) {
          diagnostics.push(`command "${name}" from plugin "${plugin.name}" was skipped: name already in use`)
          continue
        }
        taken.add(name)
        found[name] = toCommandDef(name, spec, ctx, plugin.name)
      }
    }
  }
  return found
}
