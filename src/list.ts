import type { RatoonOptions } from './cli.ts'
import { layoutOf } from './layout.ts'
import { renderPoolTable } from './pool-table.ts'
import { scanPool } from './state.ts'

/**
 * The pool is git's worktree list plus the directories on disk — never a document. A directory git
 * does not know, or a binding whose directory is gone, is shown as `unknown` instead of being
 * hidden: `start` will not use either one, so they are drift to look at, not slots to allocate.
 */
export async function runList(opts: RatoonOptions): Promise<void> {
  const layout = await layoutOf()
  const pool = await scanPool(layout.root, layout.mainDir)

  renderPoolTable(
    {
      root: layout.root,
      mainDir: layout.mainDir,
      configuredBy: layout.configuredBy,
      pool,
      branchPrefix: opts.branchPrefix,
    },
    [
      {
        header: 'HEAD',
        cell: slot => slot.missing
          ? '(missing)'
          : slot.worktree
            ? (slot.branch || '(detached)')
            : '(not a git worktree)',
      },
      {
        header: 'DIR',
        cell: slot => slot.path,
      },
    ],
  )
}
