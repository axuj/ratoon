import type { PoolSlot } from './state.ts'
import type { PoolColumn, SlotView } from './types.ts'
import { isFree } from './state.ts'

type SlotState = SlotView['state']

export interface PoolFacts {
  root: string
  mainDir: string
  /** where the pool path was configured; empty when the default is in use */
  configuredBy: string
  pool: readonly PoolSlot[]
  /** only `ratoon list` declares --branch-prefix; plugin listings use the default */
  branchPrefix?: string
}

/** The read-only view a plugin command gets, and the one a column's `cell` receives. */
export function slotViews(pool: readonly PoolSlot[]): SlotView[] {
  return pool.map((slot) => {
    const state: SlotState = isFree(slot)
      ? 'free'
      : slot.worktree && !slot.missing
        ? 'busy'
        : 'unknown'
    return {
      dir: slot.dir,
      path: slot.path,
      task: slot.task,
      branch: slot.branch,
      worktree: slot.worktree,
      missing: slot.missing,
      state,
    }
  })
}

function summary(states: readonly SlotState[]): string {
  if (states.length === 0)
    return '0 slot(s)'
  const count = (state: SlotState): number => states.filter(s => s === state).length
  const parts = [`${states.length} slot(s)`, `${count('busy')} busy`]
  if (count('unknown') > 0)
    parts.push(`${count('unknown')} unknown`)
  parts.push(count('free') === states.length
    ? 'all free'
    : `${count('free')} free`)
  return parts.join(' · ')
}

/**
 * The single pool table. `ratoon list` and every plugin listing render through here, so the pool
 * header, row set (busy, free and unknown alike), alignment and summary cannot drift apart.
 * Columns only append cells; they cannot decide which slots appear or how they are labelled.
 * An empty pool gets the same shape — a header and a `0 slot(s)` summary — not a prose fallback.
 */
export function renderPoolTable(facts: PoolFacts, columns: readonly PoolColumn[]): void {
  const origin = facts.configuredBy.replace(/^file:/, '')
  const poolLine = `pool: ${facts.root} · repo: ${facts.mainDir}`
  console.log(origin
    ? `${poolLine}\n  pool path set in ${origin}\n`
    : `${poolLine}\n`)

  const slots = slotViews(facts.pool)
  const prefix = facts.branchPrefix ?? 'feature/'
  const taskOf = (branch: string): string =>
    branch.startsWith(prefix)
      ? branch.slice(prefix.length)
      : ''
  const header = [
    'SLOT',
    'STATUS',
    'TASK',
    ...columns.map(column => column.header),
  ]
  const rows = slots.map(slot => [
    slot.dir,
    slot.state,
    slot.task || taskOf(slot.branch) || '—',
    ...columns.map(column => column.cell(slot)),
  ])

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (row: readonly string[]): string =>
    row.map((value, index) => (value ?? '').padEnd(widths[index]!)).join('  ')
  console.log(line(header))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows)
    console.log(line(row))
  console.log(`\n${summary(slots.map(slot => slot.state))}`)
}
