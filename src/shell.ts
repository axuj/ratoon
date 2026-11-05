import { $, CommandBuilder } from 'dax'

/**
 * dax does the process work; this module exists for two things dax does not give us:
 *
 * 1. **The command in the error.** `ShellError.#baseMessage` is hard-coded to
 *    `Exited with code: N` — no command, no cwd. Every failure here is wrapped as
 *    `command failed (<code>): <cmd> <args> (cwd: <dir>)`, which is the difference between
 *    "something failed" and knowing which of the twenty git calls it was.
 * 2. **`quiet` when a caller wants the output *out of the way but not lost.*** `.quiet()` (in
 *    `@dsherret/shell`, not dax's own .d.ts) captures both streams; the captured text is then
 *    appended to the error, so a failing command reports what it printed. Fixture setup uses this
 *    to keep git/npm chatter out of the test log. `.errorTail()` is deliberately *not* — it only
 *    attaches output on the throwing path, while this module reads the result and builds the
 *    message itself, so the two cannot be combined.
 *
 * Both `run` and `exec` take an argument array instead of a template literal because virtually
 * every call site already has one: `['-C', dir, 'rev-parse', …]`.
 */

export interface RunOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** capture output instead of inheriting it — on failure the captured text joins the error */
  quiet?: boolean
}

export interface ExecResult {
  status: number
  stdout: string
  stderr: string
}

function build(opts: RunOptions): CommandBuilder {
  let builder = new CommandBuilder()
  if (opts.cwd !== undefined)
    builder = builder.cwd(opts.cwd)
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value !== undefined)
      builder = builder.env(key, value)
  }
  return builder
}

function describe(cmd: string, args: readonly string[], opts: RunOptions): string {
  const suffix = opts.cwd
    ? ` (cwd: ${opts.cwd})`
    : ''
  return `${cmd} ${args.join(' ')}${suffix}`
}

/** Inherit stdio, throw on a non-zero exit. One path, one error shape: the result is the truth. */
export async function run(
  cmd: string,
  args: readonly string[] = [],
  opts: RunOptions = {},
): Promise<void> {
  const builder = build(opts).command([cmd, ...args])
  const result = await (opts.quiet
    ? builder.quiet()
    : builder).noThrow()
  if (result.code === 0)
    return
  // quiet already swallowed the output — put it back into the message instead
  const tail = opts.quiet
    ? `\n${result.stdout}${result.stderr}`.trimEnd()
    : ''
  throw new Error(`command failed (${result.code}): ${describe(cmd, args, opts)}${tail}`)
}

/** Never throws on the exit code; captures both streams. */
export async function exec(
  cmd: string,
  args: readonly string[] = [],
  opts: RunOptions = {},
): Promise<ExecResult> {
  const result = await build(opts).command([cmd, ...args]).noThrow().quiet()
  return { status: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** `rm -rf`, but platform-native — no PATH dependency on POSIX tools. */
export async function rmrf(target: string): Promise<void> {
  await $.path(target).ensureRemove({ recursive: true })
}

export function exists(target: string): boolean {
  return $.path(target).existsSync()
}
