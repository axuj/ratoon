/** Files `ratoon init` writes into a repository. Kept apart from the command so the CLI stays readable. */

export const HOOKS = `import type { Plugin } from './types.ts'
import { taskNotes } from './plugins/task-notes.ts'

/**
 * Project hooks — one ordered plugin array. \`ratoon start\` and \`ratoon finish\` are separate
 * processes, so each lifecycle runs its own pass over the array, in array order.
 *
 * \`taskNotes()\` writes the handoff sheet under the pool's \`.state/\` and warns at \`finish\` when
 * boxes are still open; it cannot touch the repository. \`npmInstall()\` runs a package manager, so
 * it stays opt-in. To enable it, add its import next to \`taskNotes\` and replace the array below:
 *
 *   import { npmInstall } from './plugins/npm-install.ts'
 *   export default [taskNotes(), npmInstall()] satisfies Plugin[]
 *
 * The workflow rules live in the ratoon skill, not in this file.
 */
export default [taskNotes()] satisfies Plugin[]
`
