import type { HookContext, LifecycleHook, Plugin } from '../types.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePath } from './shared.ts'

export type TaskNotesContext = Pick<HookContext, 'task' | 'branch' | 'slotDir' | 'rootDir' | 'base'>

export interface TaskNotesOptions {
  /** Filename under `<root>/.state/<slot>/`. Default `TASK.md`. */
  file?: string
  /** What to write in `onStart`. Default: a minimal task skeleton. */
  template?: (ctx: TaskNotesContext) => string
  /** Warn when the file still has `- [ ]` boxes left at `finish`. Default `true`. */
  warnUnchecked?: boolean
}

function defaultTemplate(ctx: TaskNotesContext): string {
  // Facts are only for orientation — `ratoon list` can re-derive them. The plan is what a killed
  // session loses, so it comes first; findings get appended below it as they are learned.
  return [
    `# TASK: ${ctx.task}（${ctx.branch}）`,
    '',
    `- 任务：${ctx.task}`,
    `- 分支：${ctx.branch}`,
    `- 槽位：${ctx.slotDir}`,
    '',
    '## Plan',
    '（开工前写，一行一步；边做边改，别留着过期的那版）',
    '',
  ].join('\n')
}

/**
 * Task notes live next to the slot's other state (`task`, `busy`, `install`), never in the
 * worktree: nothing to gitignore, nothing `finish` can see as dirt, nothing that can end up in a
 * commit — so there is no deletion step to get wrong either.
 *
 * Written when a task starts and left in place when it ends. Reading "what was I doing" after a
 * paused finish or an `abandon` is the point; the next task in that slot overwrites the file.
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
