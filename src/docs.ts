import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BundledDoc {
  name: string
  text: string
}

/**
 * Guides shipped with the package. `init` copies them into `<root>/.ratoon/docs/`, which is the
 * path `AGENTS.md` points an agent at — the same way a project points at `node_modules` docs.
 * From `dist/docs.js` the path lands on the package root; from `src/docs.ts` it lands on the
 * repository root. Both have `docs/` at that level.
 */
export function bundledDocs(): BundledDoc[] {
  const dir = fileURLToPath(new URL('../docs/', import.meta.url))
  const names = readdirSync(dir).filter(name => name.endsWith('.md')).sort()
  if (names.length === 0)
    throw new Error('no bundled docs found — the ratoon install looks incomplete')
  return names.map(name => ({
    name,
    text: readFileSync(path.join(dir, name), 'utf8'),
  }))
}
