/** Files `ratoon init` writes into a container. Kept apart from the command so the CLI stays readable. */

/**
 * The container has no runtime dependencies: hooks, plugins and types are files under `.ratoon/`,
 * executed by Node's own type stripping. That is why `engines` demands Node >= 26, even though
 * `typescript` and `@types/node` are here only for `npm run typecheck` — nothing installs them
 * for you, `npm i` once if you want it.
 */
export function packageJson(name: string): string {
  return `${JSON.stringify({
    name,
    type: 'module',
    private: true,
    engines: {
      node: '>=26',
    },
    scripts: {
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      '@types/node': '^26.0.0',
      'typescript': '^5.5.0',
    },
  }, null, 2)}\n`
}

export const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2023',
    lib: ['ES2023'],
    module: 'ESNext',
    moduleResolution: 'bundler',
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    types: ['node'],
  },
  include: ['.ratoon/**/*.ts'],
}, null, 2)}\n`

export const GITIGNORE = `node_modules/
.state/
`

export function agentsMd(name: string): string {
  return `# ${name}

A ratoon container: \`<repo>/\` is the main working tree, \`slot-N/\` are reusable worktrees.

\`\`\`
ratoon start <task>           branch off master in a free slot
ratoon finish <task> -m "…"   squash, rebase, ff-merge into master, park the slot
ratoon abandon <task>         throw the task away
ratoon list
\`\`\`

\`--root <dir>\` \`--main <dir>\` \`--base <ref>\` \`--branch-prefix <p>\`

## Rules

1. Commit checkpoints inside the slot, never in the main worktree. Messages are drafts;
   \`finish\` lands its \`-m\`.
2. Never leave dirt: \`finish\` refuses a dirty tree and the next \`start\` runs \`git clean -fd\`.
   Untracked files count unless gitignored.
3. Anything that is not repo content — notes, logs, locks — goes to \`.state/<slot>/\`, never
   into the worktree.
4. \`--base\` is a starting point, not a merge target — keep dependent tasks in order.

## Container

\`\`\`
.ratoon/hooks.ts   the plugin list — the only place project-specific logic lives
.ratoon/plugins/   optional starters, not enabled
.ratoon/types.ts   hook types
.ratoon/docs/      workflows.md · plugins.md
\`\`\`

Read \`.ratoon/docs/\` before touching hooks or doing anything non-trivial with slots.
`
}

export const HOOKS = `import type { Plugin } from './types.ts'

/**
 * Container-level hooks — one ordered plugin array. \`ratoon start\` and \`ratoon finish\` are
 * separate processes, so each lifecycle runs its own pass over the array, in array order.
 *
 * Nothing is enabled by default. Optional starter plugins live in \`./plugins/\`; import only
 * what you want. State shared between callbacks inside one process is a module-level \`let\`.
 *
 * import { npmInstall } from './plugins/npm-install.ts'
 * import { progressFile } from './plugins/progress-file.ts'
 * import { checkLock } from './plugins/check-lock.ts'
 *
 * export default [
 *   npmInstall(),
 *   progressFile(),
 *   checkLock(),
 * ] satisfies Plugin[]
 */
export default [] satisfies Plugin[]
`
