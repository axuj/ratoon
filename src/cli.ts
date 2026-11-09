#!/usr/bin/env node
import type { ArgsDef } from 'citty'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runMain } from 'citty'
import { runAbandon } from './abandon.ts'
import { flagSetOf, unknownFlagMessage } from './args.ts'
import { PausedError } from './errors.ts'
import { runFinish } from './finish.ts'
import { runInit } from './init.ts'
import { runList } from './list.ts'
import { runStart } from './start.ts'

/**
 * A consumer that stops reading — `| head`, `| grep -m1`, a nushell pipeline that errors out —
 * closes the pipe while we are still writing. Node turns that into an *unhandled* 'error' event on
 * the socket: a raw stack trace and an immediate exit, which for `finish` lands mid-lock and used
 * to leave the pool permanently locked. Output the reader no longer wants is not something we
 * can act on, so swallow it and let the command run to completion (and release its lock).
 */
function discardBrokenPipe(err: NodeJS.ErrnoException): void {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')
    return
  process.exitCode = 1
}

process.stdout.on('error', discardBrokenPipe)
process.stderr.on('error', discardBrokenPipe)

export interface RatoonOptions {
  /** where a new task is cut from — `start` only, no other command declares it */
  base?: string
  branchPrefix: string
  /** `finish` only: the branch the work lands on; absent means the main worktree's checked-out one */
  into?: string
}

/** Every command that turns a task name into a branch needs the prefix, so every command takes it. */
const branchPrefixFlag = {
  'branch-prefix': {
    type: 'string',
    default: 'feature/',
    description: 'task branch prefix',
  },
} as const satisfies ArgsDef

const TASK_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return String(pkg.version ?? '0.0.0')
  }
  catch {
    return '0.0.0'
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function validateTask(task: string, command: string): void {
  if (!TASK_NAME_RE.test(task)) {
    fail(
      `Usage: ratoon ${command} <task-name>\n`
      + `task-name must be kebab-case, e.g. ratoon ${command} add-bento-grid`,
    )
  }
}

/** The subset of citty's parsed args ratoon reads. Subcommands add their own keys. */
interface SharedArgValues {
  'base'?: string
  'branch-prefix'?: string
  'into'?: string
  [key: string]: unknown
}

/**
 * The part of citty's command context this file reads. Structural on purpose: `CommandContext<T>`
 * is parameterised by each command's own args, so no two commands share one context type.
 */
interface RunContext {
  /** argv after the command name — what the unknown-flag check inspects */
  rawArgs: string[]
  args: SharedArgValues
  cmd: { args?: unknown, meta?: unknown }
}

function toOptions(args: SharedArgValues): RatoonOptions {
  return {
    base: args.base,
    branchPrefix: args['branch-prefix'] ?? 'feature/',
    into: args.into,
  }
}

/** Our own errors exit 1 with a single line; a pause (see `PausedError`) exits 2. */
async function guard<T>(ctx: RunContext, run: (opts: RatoonOptions) => Promise<T>): Promise<T> {
  try {
    const unknown = unknownFlagMessage({
      rawArgs: ctx.rawArgs,
      args: ctx.cmd.args,
      command: (ctx.cmd.meta as { name?: string } | undefined)?.name ?? 'ratoon',
    })
    if (unknown !== undefined)
      throw new Error(unknown)
    return await run(toOptions(ctx.args))
  }
  catch (err) {
    console.error(`\nratoon: ${err instanceof Error
      ? err.message
      : String(err)}`)
    process.exit(err instanceof PausedError
      ? err.exitCode
      : 1)
  }
}

const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'allocate slot -> onBeforeCheckout -> branch -> clean -> onStart',
  },
  args: {
    task: {
      type: 'positional',
      required: true,
      description: 'kebab-case task name, e.g. add-bento-grid',
    },
    base: {
      type: 'string',
      description: 'starting point for a new task',
    },
    ...branchPrefixFlag,
  },
  run: ctx => guard(ctx, async (opts) => {
    const task: string = ctx.args.task
    validateTask(task, 'start')
    await runStart(opts, task)
  }),
})

const finishCommand = defineCommand({
  meta: {
    name: 'finish',
    description: 'verify -> onFinish -> squash into one commit (title from -m) -> rebase onto the target -> fast-forward it -> park detached -> delete branch -> free slot',
  },
  args: {
    task: {
      type: 'positional',
      required: true,
      description: 'kebab-case task name, e.g. add-bento-grid',
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'title of the landing commit — the squash subject, like a PR title (required when the branch has commits)',
    },
    into: {
      type: 'string',
      description: 'branch to land on, instead of the one checked out in the main worktree (e.g. a long-lived v2 branch)',
    },
    ...branchPrefixFlag,
  },
  run: ctx => guard(ctx, async (opts) => {
    const task: string = ctx.args.task
    validateTask(task, 'finish')
    await runFinish(opts, task, (ctx.args.message ?? '').trim())
  }),
})

const abandonCommand = defineCommand({
  meta: {
    name: 'abandon',
    description: 'discard a task: abort a paused rebase, drop its commits and dirt, park the slot, delete the branch, free it',
  },
  args: {
    task: {
      type: 'positional',
      required: true,
      description: 'kebab-case task name, e.g. add-bento-grid',
    },
    ...branchPrefixFlag,
  },
  run: ctx => guard(ctx, async (opts) => {
    const task: string = ctx.args.task
    validateTask(task, 'abandon')
    await runAbandon(opts, task)
  }),
})

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'show the slot table (busy / task / checked-out branch)',
  },
  args: branchPrefixFlag,
  run: ctx => guard(ctx, opts => runList(opts)),
})

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'create the optional hook toolbox: hooks.ts, types and starter plugins (slots work without it)',
  },
  run: ctx => guard(ctx, () => runInit()),
})

export const cli = defineCommand({
  meta: {
    name: 'ratoon',
    version: version(),
    description: 'Parallel git worktrees for long-running tasks and agents',
  },
  subCommands: {
    init: initCommand,
    start: startCommand,
    finish: finishCommand,
    abandon: abandonCommand,
    list: listCommand,
  },
})

/** The command that declares `flag`, or `undefined` when none does. Reads the same definitions citty does. */
function commandDeclaring(flag: string): string | undefined {
  for (const [name, command] of Object.entries(cli.subCommands ?? {})) {
    const def: unknown = command.args
    if (typeof def !== 'object' || def === null)
      continue
    if (flagSetOf(def as ArgsDef).known.has(flag))
      return name
  }
}

/**
 * Options follow the command: `ratoon start t --base X`, not `ratoon --base X start t`.
 *
 * citty parses what precedes the command name on the root command and never hands it down, so a
 * leading option either vanishes into a value nobody reads or swallows the command name itself
 * (`Unknown command X`). Both lie about what happened, so refuse the order instead of rewriting it.
 */
export function leadingOptionError(rawArgs: string[]): string | undefined {
  const first = rawArgs[0]
  if (first === undefined || !first.startsWith('-') || first === '--')
    return undefined
  if (/^--?(?:h|help|v|version)$/.test(first))
    return undefined
  const [name = '', inline] = first.split('=')
  const owner = commandDeclaring(name.replace(/^-+/, ''))
  if (owner === undefined)
    return `${name} is not an option of any command`
  return `${name} is a \`${owner}\` option and goes after the command\n`
    + `try: ratoon ${owner} <task> ${first}${inline === undefined
      ? ' <value>'
      : ''}`
}

/**
 * The compiled CLI runs on whatever Node the user has, so an old one fails late and cryptically —
 * `ERR_UNKNOWN_FILE_EXTENSION` while importing `.ratoon/hooks.ts`, which says nothing about the
 * version. Decide from the version string here, before any command touches the disk.
 */
export function nodeVersionError(current: string): string | undefined {
  const major = Number.parseInt(current.replace(/^v/, '').split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major >= 26)
    return undefined
  return `ratoon requires Node >= 26 (found ${current.startsWith('v')
    ? current
    : `v${current}`})`
}

export async function main(rawArgs = process.argv.slice(2)): Promise<void> {
  const tooOld = nodeVersionError(process.versions.node)
  if (tooOld) {
    console.error(tooOld)
    process.exitCode = 1
    return
  }
  const misplaced = leadingOptionError(rawArgs)
  if (misplaced) {
    console.error(`\nratoon: ${misplaced}`)
    process.exitCode = 1
    return
  }
  await runMain(cli, { rawArgs })
}

// Entry guard: `nub src/cli.ts <cmd>` runs this file directly; importing it (tests) must not.
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(`\nratoon: ${err instanceof Error
      ? err.message
      : String(err)}`)
    process.exit(err instanceof PausedError
      ? err.exitCode
      : 1)
  })
}

function isDirectRun(self: string): boolean {
  const argv1 = process.argv[1]
  if (!argv1)
    return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(self))
  }
  catch {
    return path.resolve(argv1) === fileURLToPath(self)
  }
}
