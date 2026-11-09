import type { ArgDef, ArgsDef } from 'citty'

/**
 * Rejecting the flags a command does not declare.
 *
 * citty parses with `strict: false`: node's `parseArgs` accepts anything, so `--int v2` is read as
 * a boolean and the command runs on its defaults — a misspelled flag silently does something else.
 * Upstream has not taken a fix (unjs/citty#201, its PR #202), so the check lives here, and it runs
 * before the command touches anything.
 *
 * The whitelist is derived from the `args` definition citty itself parses with, so there is no
 * second list to keep in sync. Only how citty spells a name is duplicated, and the tests pin it.
 */

/** citty answers these itself, before any command runs, so every command takes them. */
const BUILTIN = new Set(['help', 'h', 'version', 'v'])

export interface FlagSet {
  /** every name the command takes, without leading dashes */
  known: Set<string>
  /** the ones that swallow the next argv entry as their value */
  takesValue: Set<string>
}

/** citty registers a kebab name in camelCase too, and a camel name in kebab-case. */
function spellings(name: string): string[] {
  const camel = name.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase())
  const kebab = name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
  return [name, camel, kebab].filter((spelling, i, all) => all.indexOf(spelling) === i)
}

function names(def: ArgDef): string[] {
  if (!('alias' in def) || def.alias === undefined)
    return []
  if (Array.isArray(def.alias))
    return def.alias
  return [def.alias]
}

export function flagSetOf(argsDef: ArgsDef): FlagSet {
  const known = new Set(BUILTIN)
  const takesValue = new Set<string>()
  for (const [name, def] of Object.entries(argsDef)) {
    if (def.type === 'positional')
      continue
    const all = [
      ...spellings(name),
      ...names(def).flatMap(spellings),
    ]
    for (const spelling of all) {
      known.add(spelling)
      if (def.type === 'string' || def.type === 'enum')
        takesValue.add(spelling)
    }
  }
  return { known, takesValue }
}

/**
 * The first flag the command does not take, spelled the way it was typed.
 *
 * Scanning left to right, rather than filtering, is what makes values safe: after a flag known to
 * take one, the next entry is skipped without being inspected, so `-m "-not a flag"` stays a title.
 */
export function firstUnknownFlag(argv: string[], flags: FlagSet): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    // Everything after `--` is positional by definition.
    if (token === '--')
      return undefined
    if (token === '-' || !token.startsWith('-'))
      continue

    const long = token.startsWith('--')
    const body = token.slice(long ? 2 : 1)
    const inline = body.includes('=')
    const name = body.split('=')[0]!

    if (!flags.known.has(name))
      return `${long ? '--' : '-'}${name}`
    if (!inline && flags.takesValue.has(name))
      i++ // the next entry is this flag's value, whatever it looks like
  }
  return undefined
}

export interface FlagCheck {
  /** argv as citty handed it to the command: everything after the command's name */
  rawArgs: string[]
  /** the command's `args` definition, as citty resolved it; undefined when it declares none */
  args: unknown
  /** the command's name, only used in the hint */
  command: string
}

/**
 * The message for an unknown flag, or `undefined` when every flag is one the command declares.
 *
 * A definition that is still a function (citty accepts those and resolves them itself before the
 * command runs) is not inspected: guessing from an unresolved definition would reject legal flags.
 * A command that declares no args at all takes none of them, so it is checked against an empty set.
 */
export function unknownFlagMessage({ rawArgs, args, command }: FlagCheck): string | undefined {
  if (args !== undefined && (typeof args !== 'object' || args === null))
    return undefined
  const bad = firstUnknownFlag(rawArgs, flagSetOf((args ?? {}) as ArgsDef))
  if (bad === undefined)
    return undefined
  return `unknown option ${bad}\n`
    + `run ratoon ${command} --help for the flags it takes`
}
