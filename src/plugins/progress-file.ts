import type { HookContext, LifecycleHook, Plugin } from '../types.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePath } from './shared.ts'

export type ProgressFileContext = Pick<HookContext, 'task' | 'branch' | 'slotDir' | 'rootDir' | 'base'>

export interface ProgressFileOptions {
  /** Filename under `<root>/.state/<slot>/`. Default `TASK.md`. */
  file?: string
  /** What to write in `onStart`. Default: a minimal task skeleton. */
  template?: (ctx: ProgressFileContext) => string
  /** Warn when the file still has `- [ ]` boxes left at `finish`. Default `true`. */
  warnUnchecked?: boolean
}

function defaultTemplate(ctx: ProgressFileContext): string {
  // Facts only: an empty `## Todo` with a placeholder box is something to delete before finish,
  // not something to fill in. Whoever works the task adds whatever structure they need.
  return [
    `# TASK: ${ctx.task}（${ctx.branch}）`,
    '',
    `- 任务：${ctx.task}`,
    `- 分支：${ctx.branch}`,
    `- 槽位：${ctx.slotDir}`,
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
export function progressFile(options: ProgressFileOptions = {}): Plugin {
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

  return { name: 'progressFile', onStart, onFinish }
}
