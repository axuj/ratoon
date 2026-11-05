import type { LifecycleHook, Plugin } from '../types.ts'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { defaultManagers } from './shared.ts'

/** Run a real executable (`git`) without a shell — arguments survive paths with spaces. */
function exec(cmd: string, args: string[]): { status: number, stdout: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '' }
}

/**
 * A lockfile the package manager rewrote is not dirt you can discard: it is the record of what you
 * just installed, and `git checkout -- package-lock.json` leaves the next slot installing something
 * else. The generic dirty check says "commit them, or discard them" without saying which of the
 * two is right — this only fires on the asymmetric case, where the answer is unambiguous.
 *
 * `onFinish` only, so it runs before the dirty check and no package manager ever has to guess.
 */
export function checkLock(): Plugin {
  const onFinish: LifecycleHook = async (ctx) => {
    if (!existsSync(path.join(ctx.slotDir, 'package.json')))
      return // not a JS project

    const status = exec('git', [
      '-C',
      ctx.slotDir,
      'status',
      '--porcelain',
      '-uall',
    ])
    if (status.status !== 0)
      return

    // porcelain is `XY <path>` — the path starts at index 3
    const touched = new Set(
      status.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean),
    )
    const changedLock = defaultManagers.map(([lock]) => lock).find(lock => touched.has(lock))

    // both moved → the plain dirty check already says "commit them", and discarding both is a
    // valid choice there too; only the one-sided case needs a verdict
    if (!changedLock || touched.has('package.json'))
      return

    throw new Error(
      `${changedLock} was updated by the package manager — this is not dirt you can discard.\n`
      + 'Dropping it would make the next slot install something else, so commit it:\n'
      + `  git -C ${ctx.slotDir} add ${changedLock} && git -C ${ctx.slotDir} commit -m "chore: sync ${changedLock}"`,
    )
  }

  return { name: 'checkLock', onFinish }
}
