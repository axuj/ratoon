import type { HookContext, LifecycleHook, Plugin } from '../types.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePath } from './shared.ts'

export type TaskNotesContext = Pick<HookContext, 'task' | 'branch' | 'slotDir' | 'rootDir' | 'base'>

export interface TaskNotesOptions {
  /** Filename under `<root>/.state/<slot>/`. Default `TASK.md`. */
  file?: string
  /** What to write in `onStart`. Default: a handoff sheet with one open box. */
  template?: (ctx: TaskNotesContext) => string
  /** Warn when the file still has `- [ ]` boxes left at `finish`. Default `true`. */
  warnUnchecked?: boolean
}

/**
 * The handoff sheet a human reads before approving `finish`. It lives outside the worktree, so it
 * cannot be committed, staged by accident, or seen as dirt; it is also the one surface an agent
 * with an isolated context can reach through the filesystem.
 *
 * The template starts with an open box on purpose: a sheet nobody touched still warns at `finish`,
 * which is the reminder to fill in and clear the plan.
 */
function defaultTemplate(ctx: TaskNotesContext): string {
  return [
    `# TASK: ${ctx.task} (${ctx.branch})`,
    '',
    `- slot: ${ctx.slotDir}`,
    `- base: ${ctx.base}`,
    '',
    '## Plan',
    '(one line per step; tick [x] as each one finishes)',
    '',
    '- [ ] <first step>',
    '',
    '## Findings',
    '(what git cannot record — why an approach was dropped, what not to retry. One line each)',
    '',
    '## Left open',
    '(decisions for the user; empty before finish)',
    '',
  ].join('\n')
}

/**
 * Written at `start` and left in place when a task ends — a paused `finish` or an `abandon` is
 * exactly when someone needs to read what was in progress. `clearTask` keeps the file; the next
 * task in that slot overwrites it, so it describes the current task only, not history.
 */
export function taskNotes(options: TaskNotesOptions = {}): Plugin {
  const file = options.file ?? 'TASK.md'
  const template = options.template ?? defaultTemplate

  const onStart: LifecycleHook = (ctx) => {
    const target = statePath(ctx, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, template({ ...ctx }))
    // the file is outside the worktree, so nothing else would ever tell you where it went
    console.log(`  notes   : ${target}\n`)
  }

  const onFinish: LifecycleHook = (ctx) => {
    const target = statePath(ctx, file)
    if (options.warnUnchecked !== false && existsSync(target) && readFileSync(target, 'utf8').includes('- [ ]'))
      console.warn(`warning: ${file} still has unchecked boxes — confirm with the user before merging`)
  }

  return { name: 'taskNotes', onStart, onFinish }
}
