/**
 * Hook-file fixtures written to `<repo>/.ratoon/hooks.ts` by the e2e suites.
 *
 * Everything — including your own code — is a plugin in one ordered array, matching the file
 * `ratoon init` generates:
 *
 *   export default [{ name: 'x', onStart(ctx) {}, onFinish(ctx) {} }]
 */

/** Records which lifecycle ran, in order, together with the task that triggered it. */
export const MARKER = `import { appendFileSync } from 'node:fs'
import path from 'node:path'

const mark = (rootDir, label, task) =>
  appendFileSync(path.join(rootDir, 'stages.log'), label + ':' + task + String.fromCharCode(10))

export default [{
  name: 'marker',
  onStart({ rootDir, task }) { mark(rootDir, 'onStart', task) },
  onFinish({ rootDir, task }) { mark(rootDir, 'onFinish', task) },
}]
`

/** Two plugins whose array order is the execution order. */
export const ORDERED = `import { appendFileSync } from 'node:fs'
import path from 'node:path'

const mark = (rootDir, label) =>
  appendFileSync(path.join(rootDir, 'stages.log'), label + String.fromCharCode(10))

export default [
  { name: 'alpha', onStart({ rootDir }) { mark(rootDir, 'A') } },
  { name: 'beta', onStart({ rootDir }) { mark(rootDir, 'B') } },
]
`

/** The real `npmInstall` starter plugin — fingerprint, skip, install. Observed via `.state/`. */
export const INSTALL = `import { npmInstall } from './plugins/npm-install.ts'

export default [npmInstall()]
`

/** The real `taskNotes` starter plugin — notes under `.state/`, never in the worktree. */
export const TASK_FILE = `import { taskNotes } from './plugins/task-notes.ts'

export default [taskNotes()]
`

/** Fails during `ratoon start`, before the slot is handed over. */
export const FAIL_ON_START = `export default [
  { name: 'boom', onStart() { throw new Error('start boom') } },
]
`

/** Fails during `ratoon finish`, before the dirty check — must leave no git state behind. */
export const FAIL_ON_FINISH = `export default [
  { name: 'boom', onFinish() { throw new Error('finish boom') } },
]
`

/**
 * A deliberately slow `onBeforeCheckout`: announces itself, then waits for a release file. It runs
 * after the slot is claimed, so another start must be able to claim a second slot meanwhile. Keyed
 * to the first task, or the second start would block in the same hook.
 */
export const BLOCKING_ALLOCATE = `import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default [{
  name: 'blocking-allocate',
  async onBeforeCheckout({ rootDir, task }) {
    if (task !== 'slow-claim') return
    writeFileSync(path.join(rootDir, 'hook-running'), '')
    while (!existsSync(path.join(rootDir, 'hook-release')))
      await new Promise(resolve => setTimeout(resolve, 50))
  },
}]
`

/**
 * A deliberately slow `onFinish`: announces itself, then waits for a release file that the test
 * writes later. Hooks run outside the pool lock, so another task must be able to start while this
 * one waits.
 */
export const BLOCKING_FINISH = `import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export default [{
  name: 'blocking',
  async onFinish({ rootDir }) {
    writeFileSync(path.join(rootDir, 'hook-running'), '')
    while (!existsSync(path.join(rootDir, 'hook-release')))
      await new Promise(resolve => setTimeout(resolve, 50))
  },
}]
`

/** A plugin that throws mid-list — later plugins must not run. */
export const FAILING_PLUGIN = `import { appendFileSync } from 'node:fs'
import path from 'node:path'

export default [
  { name: 'exploder', onStart() { throw new Error('plugin boom') } },
  { name: 'after', onStart({ rootDir }) {
    appendFileSync(path.join(rootDir, 'should-not-run'), 'x')
  } },
]
`

/** Writes to stdout from inside a hook — must land on stdout next to the step log. */
export const NOISY = `export default [
  { name: 'noisy', onStart() { console.log('noisy hook output') } },
]
`

/** Dumps the context so a test can assert the facts it carries — and nothing else. */
export const SPY = `import { writeFileSync } from 'node:fs'
import path from 'node:path'

export default [{
  name: 'spy',
  onStart(ctx) {
    writeFileSync(path.join(ctx.rootDir, 'spy.json'), JSON.stringify({
      keys: Object.keys(ctx).sort(),
      ...ctx,
    }, null, 2))
  },
}]
`

/** Syntax error: the module must fail to load, before any lifecycle runs. */
export const BROKEN = `export default [{ name: 'broken', onStart() { const oops = ((() } }]
`

/** Default export has the wrong shape — a function instead of an array. */
export const NOT_AN_OBJECT = `export default function () {}
`
