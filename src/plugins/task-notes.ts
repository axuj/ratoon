import type { HookContext, LifecycleHook, Plugin } from '../types.ts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { statePath } from './shared.ts'

export type TaskNotesContext = Pick<HookContext, 'task' | 'branch' | 'slotDir' | 'rootDir' | 'base'>

export interface TaskNotesOptions {
  /** Filename under `<root>/.state/<slot>/`. Default `TASK.md`. */
  file?: string
  /** What to write in `onStart`. Default: a short handoff sheet. */
  template?: (ctx: TaskNotesContext) => string
}

/**
 * A short sheet for whoever picks the slot up — the user at approval, or a new subagent after a
 * broken context. It lives outside the worktree, so it cannot be committed, staged by accident,
 * or seen as dirt. Progress lives in the slot's draft commits; this file carries only what git
 * cannot record. The first line repeats the two gates from the skill because the sheet is written
 * at `start`, just before the first edit is made.
 */
function defaultTemplate(ctx: TaskNotesContext): string {
  return [
    `# TASK: ${ctx.task} (${ctx.branch})`,
    '',
    'commit in this slot only · finish only after approval',
    '',
    `- slot: ${ctx.slotDir}`,
    `- base: ${ctx.base}`,
    '',
    '## Goal',
    '(one line: what this task is for)',
    '',
    '## Findings',
    '(what git cannot record: where you are stuck, the next step, what you tried and dropped, what not to retry, what is still unverified. Not a changelog — no "added X", no file names)',
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

  /** `ratoon task list` — the sheet's filename is this plugin's own choice, so the command is too. */
  const commands: NonNullable<Plugin['commands']> = ({ rootDir, slots }) => ({
    task: {
      description: `handoff sheets (${file})`,
      subCommands: {
        list: {
          description: `show where each ${file} lives`,
          run: () => {
            const rows = slots
              .filter(slot => (slot.task || slot.branch) && !slot.missing)
              .map((slot) => {
                const notes = statePath({ rootDir, slotDir: slot.path }, file)
                return [
                  slot.task || slot.branch,
                  slot.dir,
                  existsSync(notes)
                    ? notes
                    : `${notes}  (missing)`,
                ]
              })
            if (rows.length === 0) {
              console.log(`no active tasks in ${rootDir}`)
              return
            }

            const header = ['TASK', 'SLOT', 'NOTES']
            const widths = header.map((title, index) =>
              Math.max(title.length, ...rows.map(row => row[index]!.length)))
            const line = (row: string[]): string =>
              row.map((value, index) => value.padEnd(widths[index]!)).join('  ')
            console.log(line(header))
            console.log(widths.map(width => '-'.repeat(width)).join('  '))
            for (const row of rows)
              console.log(line(row))
          },
        },
      },
    },
  })

  return { name: 'taskNotes', onStart, commands }
}
