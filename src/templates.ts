/** Files `ratoon init` writes into a repository. Kept apart from the command so the CLI stays readable. */

export const HOOKS = `import type { Plugin } from './types.ts'
import { taskNotes } from './plugins/task-notes.ts'

/**
 * Project hooks — one ordered plugin array. \`ratoon start\` and \`ratoon finish\` are separate
 * processes, so each lifecycle runs its own pass over the array, in array order.
 *
 * \`taskNotes()\` writes a short \`TASK.md\` handoff sheet under the pool's \`.state/\` for whoever
 * picks the slot up next; it cannot touch the repository. \`npmInstall()\` runs a package manager, so
 * it stays opt-in. To enable it, add its import next to \`taskNotes\` and replace the array below:
 *
 *   import { npmInstall } from './plugins/npm-install.ts'
 *   export default [taskNotes(), npmInstall()] satisfies Plugin[]
 *
 * The workflow rules live in the ratoon skill, not in this file.
 */
export default [taskNotes()] satisfies Plugin[]
`

/**
 * The hook toolbox is TypeScript the CLI imports directly. A project tsconfig usually does not
 * collect dot-directories, so an editor opening one of these files falls back to an inferred
 * project — a config of its own makes the toolbox a project that names the types it wants.
 *
 * Naming `node` in `types` means an editor reports TS2688 until `@types/node` is installed. That
 * is the intended state, not a gap: types are an editor's business, while Node loads these files
 * by stripping them. Nothing about running a hook changes without `@types/node`, and switching
 * checking off to silence the message would also silence the real mistakes in a plugin. The
 * message names its own fix, and the manifest below is where to run it.
 *
 * `exclude` must name `worktrees`: a busy slot is a full copy of the project, and without it the
 * pool would be typechecked as part of the toolbox.
 */
export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node"],
    "typeRoots": ["./node_modules/@types"],
    "skipLibCheck": true
  },
  "include": ["./**/*.ts"],
  "exclude": ["./node_modules", "./worktrees"]
}
`

/**
 * A package boundary of its own, so an install stays inside `.ratoon/`. Without it, npm walks up to
 * the host project's manifest and either resolves its whole dependency tree (and their peer
 * conflicts) or installs into the project's `node_modules`. `type` has to be `module` or Node warns
 * on every hook load.
 *
 * ratoon never runs the install — the manifest is here for whoever wants types in the editor, and
 * the major tracks `engines.node`'s minimum major, so change them together.
 */
export const PACKAGE_JSON = `{
  "private": true,
  "type": "module",
  "devDependencies": {
    "@types/node": "^26"
  }
}
`
