import type { Repo } from '../helpers/repo.ts'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finish, makeRepo, ratoon, start, writeHooks } from '../helpers/repo.ts'

let repo: Repo | undefined

afterEach(() => {
  repo?.dispose()
  repo = undefined
})

async function fixture(): Promise<Repo> {
  repo = await makeRepo()
  return repo
}

/** The three columns every pool listing shares, regardless of the extra columns a command adds. */
function sharedColumns(out: string): string[] {
  return out.split('\n')
    .filter(line => /^slot-\d/.test(line))
    .map(line => line.trim().split(/\s{2,}/).slice(0, 3).join(' | '))
}

function summary(out: string): string | undefined {
  return out.trim().split('\n').at(-1)
}

describe('plugin commands', () => {
  it('lists a plugin command in help, one level down too', async () => {
    const r = await fixture()

    const root = await ratoon(['--help'], { cwd: r.repo })
    expect(root.status, root.stderr).toBe(0)
    expect(root.stdout).toContain('task')
    expect(root.stdout).toContain('handoff sheets (TASK.md)')

    const group = await ratoon(['task', '--help'], { cwd: r.repo })
    expect(group.status, group.stderr).toBe(0)
    expect(group.stdout).toContain('list')
    expect(group.stdout).toContain(`show where every slot's TASK.md lives`)
  })

  it('renders the pool table when no slots exist yet', async () => {
    const r = await fixture()

    const out = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('SLOT')
    expect(out.stdout).toContain('STATUS')
    expect(out.stdout).toContain('NOTES')
    expect(out.stdout).toContain('0 slot(s)')
    expect(out.stdout).not.toContain('no active tasks')
  })

  it('shows where the handoff sheet of a running task lives', async () => {
    const r = await fixture()
    expect((await start(r, 'add-banner')).status).toBe(0)

    const out = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('add-banner')
    expect(out.stdout).toContain('slot-0')
    expect(out.stdout).toContain(path.join('.state', 'slot-0', 'TASK.md'))
  })

  it('lists every busy slot, not just one', async () => {
    const r = await fixture()
    expect((await start(r, 'alpha')).status).toBe(0)
    expect((await start(r, 'beta')).status).toBe(0)

    const out = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/slot-0\s+busy\s+alpha/)
    expect(out.stdout).toMatch(/slot-1\s+busy\s+beta/)
    expect(out.stdout).toContain('2 slot(s) · 2 busy · 0 free')
  })

  it('still lists a slot after its task has landed', async () => {
    const r = await fixture()
    expect((await start(r, 'alpha')).status).toBe(0)
    expect((await finish(r, 'alpha', ['-m', 'feat: alpha'])).status).toBe(0)

    const out = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/slot-0\s+free/)
    expect(out.stdout).toContain(path.join('.state', 'slot-0', 'TASK.md'))
    expect(out.stdout).toContain('(last task)')
  })

  it('uses the same rows, status labels and summary as ratoon list', async () => {
    const r = await fixture()
    expect((await start(r, 'alpha')).status).toBe(0)
    expect((await finish(r, 'alpha', ['-m', 'feat: alpha'])).status).toBe(0)
    expect((await start(r, 'beta')).status).toBe(0)

    const pool = await ratoon(['list'], { cwd: r.repo })
    const notes = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(pool.status, pool.stderr).toBe(0)
    expect(notes.status, notes.stderr).toBe(0)

    expect(sharedColumns(notes.stdout)).toEqual(sharedColumns(pool.stdout))
    expect(summary(notes.stdout)).toBe(summary(pool.stdout))
    expect(notes.stdout).toContain('NOTES')
    expect(pool.stdout).toContain('HEAD')
  })

  it('uses the filename the plugin was configured with', async () => {
    const r = await fixture()
    writeHooks(r, `import { taskNotes } from './plugins/task-notes.ts'

export default [taskNotes({ file: 'NOTES.md' })]
`)
    expect((await start(r, 'custom-notes')).status).toBe(0)

    const out = await ratoon(['task', 'list'], { cwd: r.repo })
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('NOTES.md')
    expect(out.stdout).not.toContain('TASK.md')
  })

  it('keeps the engine\'s option-order rule in front of plugin commands', async () => {
    const r = await fixture()

    const out = await ratoon(['--base', 'master', 'task', 'list'], { cwd: r.repo })
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('goes after the command')
  })

  it('does not import hooks for a built-in command', async () => {
    const r = await fixture()
    writeHooks(r, `import { writeFileSync } from 'node:fs'

writeFileSync('top-level-ran.txt', 'yes')
export default []
`)
    const marker = path.join(r.repo, 'top-level-ran.txt')

    const list = await ratoon(['list'], { cwd: r.repo })
    expect(list.status, list.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false)

    const help = await ratoon(['--help'], { cwd: r.repo })
    expect(help.status, help.stderr).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  it('reports a name collision and a broken hooks file without losing the built-ins', async () => {
    const r = await fixture()
    writeHooks(r, `export default [
  { name: 'dup', commands: () => ({ list: { description: 'clash', run() {} } }) },
]
`)

    const help = await ratoon(['--help'], { cwd: r.repo })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('start')
    expect(help.stderr).toContain('name already in use')

    writeHooks(r, `export default [(((\n`)
    const broken = await ratoon(['--help'], { cwd: r.repo })
    expect(broken.status, broken.stderr).toBe(0)
    expect(broken.stdout).toContain('abandon')
    expect(broken.stderr).toContain('failed to load')

    const stillWorks = await ratoon(['list'], { cwd: r.repo })
    expect(stillWorks.status, stillWorks.stderr).toBe(0)
  })
})
