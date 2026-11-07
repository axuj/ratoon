#!/usr/bin/env node
import type { ArgsDef } from 'citty'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runMain } from 'citty'
import { runAbandon } from './abandon.ts'
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
  /** base ref: starting point on start, rebase target on finish (finish still merges into main's HEAD) */
  base: string
  /** base ref was not given explicitly, discovered from the repository */
  baseAuto: boolean
  branchPrefix: string
}

/** Shared by the root command and every subcommand — see `hoistGlobalOptions` for why both. */
export const sharedArgs = {
  'base': {
    type: 'string',
    description: 'starting point / rebase target (finish still merges into the main worktree\'s checked-out branch)',
  },
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
  [key: string]: unknown
}

function toOptions(args: SharedArgValues): RatoonOptions {
  return {
    base: args.base ?? '',
    baseAuto: args.base === undefined,
    branchPrefix: args['branch-prefix'] ?? 'feature/',
  }
}

/** Our own errors exit 1 with a single line; a pause (see `PausedError`) exits 2. */
async function guard<T>(args: SharedArgValues, run: (opts: RatoonOptions) => Promise<T>): Promise<T> {
  try {
    return await run(toOptions(args))
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
    ...sharedArgs,
  },
  run: ({ args }) => guard(args, async (opts) => {
    const task: string = args.task
    validateTask(task, 'start')
    await runStart(opts, task)
  }),
})

const finishCommand = defineCommand({
  meta: {
    name: 'finish',
    description: 'verify -> onFinish -> squash into one commit (title from -m) -> rebase base -> ff-merge -> park detached -> delete branch -> free slot',
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
    ...sharedArgs,
  },
  run: ({ args }) => guard(args, async (opts) => {
    const task: string = args.task
    validateTask(task, 'finish')
    await runFinish(opts, task, (args.message ?? '').trim())
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
    ...sharedArgs,
  },
  run: ({ args }) => guard(args, async (opts) => {
    const task: string = args.task
    validateTask(task, 'abandon')
    await runAbandon(opts, task)
  }),
})

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'show the slot table (busy / task / checked-out branch)',
  },
  args: sharedArgs,
  run: ({ args }) => guard(args, opts => runList(opts)),
})

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description: 'create the optional hook toolbox: hooks.ts, types and starter plugins (slots work without it)',
  },
  args: {
    force: {
      type: 'boolean',
      default: false,
      description: 'removed — init only writes files that are missing (delete one to take a newer copy)',
    },
  },
  run: ({ args }) => guard(args, () => {
    if (args.force === true) {
      throw new Error(
        '--force was removed: init only writes files that are missing\n'
        + 'to take a newer copy of a generated file, delete it and run init again.',
      )
    }
    return runInit()
  }),
})

export const cli = defineCommand({
  meta: {
    name: 'ratoon',
    version: version(),
    description: 'Parallel git worktrees for long-running tasks and agents',
  },
  args: sharedArgs,
  subCommands: {
    init: initCommand,
    start: startCommand,
    finish: finishCommand,
    abandon: abandonCommand,
    list: listCommand,
  },
})

const VALUE_FLAGS = new Set(
  Object.entries(sharedArgs)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => name),
)

/**
 * citty hands a subcommand everything *after* its name, so `ratoon --base trunk list` would drop
 * `--base` on the floor and fall back to cwd. Move leading options behind the subcommand so both
 * orders behave the same.
 */
export function hoistGlobalOptions(rawArgs: string[]): string[] {
  let index = 0
  while (index < rawArgs.length) {
    const arg = rawArgs[index]!
    if (arg === '--')
      break
    if (!arg.startsWith('-'))
      break
    if (!arg.includes('=') && VALUE_FLAGS.has(arg.replace(/^-+/, '')))
      index++ // the value that follows the flag
    index++
  }
  if (index === 0 || index >= rawArgs.length)
    return rawArgs
  return [
    ...rawArgs.slice(index),
    ...rawArgs.slice(0, index),
  ]
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
  await runMain(cli, {
    rawArgs: hoistGlobalOptions(rawArgs),
  })
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
