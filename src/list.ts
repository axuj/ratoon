import type { RatoonOptions } from './cli.ts'
import { resolveLayout } from './layout.ts'
import { isFree, scanPool } from './state.ts'

export type SlotState = 'busy' | 'free' | 'unknown'

/**
 * The pool is git's worktree list plus the directories on disk — never a document. A directory git
 * does not know, or a binding whose directory is gone, is shown as `unknown` instead of being
 * hidden: `start` will not use either one, so they are drift to look at, not slots to allocate.
 */
export async function runList(opts: RatoonOptions): Promise<void> {
  const layout = resolveLayout(opts.root, opts.main)
  const pool = await scanPool(layout.root, layout.mainDir)

  console.log(`root: ${layout.root} · main: ${layout.mainDir}\n`)

  if (pool.length === 0) {
    console.log(`no slots yet in ${layout.root}`)
    return
  }

  const rows = pool.map((slot) => {
    const state: SlotState = isFree(slot)
      ? 'free'
      : slot.worktree && !slot.missing
        ? 'busy'
        : 'unknown'
    const task = slot.task || taskOf(slot.branch, opts.branchPrefix)
    const head = slot.missing
      ? '(missing)'
      : slot.worktree
        ? (slot.branch || '(detached)')
        : '(not a git worktree)'
    return {
      state,
      cells: [
        slot.dir,
        state,
        task || '—',
        head,
        slot.path,
      ],
    }
  })

  const header = [
    'SLOT',
    'STATUS',
    'TASK',
    'HEAD',
    'DIR',
  ]
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map(row => row.cells[index]!.length)))

  const line = (row: string[]): string =>
    row.map((value, index) => value.padEnd(widths[index]!)).join('  ')
  console.log(line(header))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows)
    console.log(line(row.cells))

  const count = (state: SlotState): number => rows.filter(row => row.state === state).length
  const parts = [`${rows.length} slot(s)`, `${count('busy')} busy`]
  if (count('unknown') > 0)
    parts.push(`${count('unknown')} unknown`)
  parts.push(count('free') === rows.length
    ? 'all free'
    : `${count('free')} free`)
  console.log(`\n${parts.join(' · ')}`)
}

/** `feature/docs` → `docs`, without assuming anything about a branch outside the prefix. */
function taskOf(branch: string, prefix: string): string {
  return branch.startsWith(prefix)
    ? branch.slice(prefix.length)
    : ''
}
