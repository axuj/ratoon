import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/shell.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface Repo {
  tmp: string
  /** the repository ratoon is installed into */
  repo: string
  /** `<repo>/.ratoon/worktrees/` — the default, ignored pool */
  pool: string
  dispose: () => void
}

export interface CliResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * A standalone repository. By default `ratoon init` runs inside it before the first commit, so
 * `.ratoon/` and `.gitignore` are committed and a freshly checked-out slot sees the same
 * configuration as the main working tree. `{ init: false }` skips that step: the fixture is then a
 * plain git repository, which is what a user who only wants slots starts from.
 * Every command is run from the repository (or a slot) with no flags, the way users run them.
 *
 * `.gitattributes` pins eol=lf so a package manager rewriting package-lock.json does not leave a
 * line-ending-only dirty tree. Dependencies are not installed by default: `installDeps` is the
 * opt-in for the few cases that need a real `node_modules`.
 */
export async function makeRepo(opts: { withPackageJson?: boolean, install?: boolean, init?: boolean } = {}): Promise<Repo> {
  const withPackageJson = opts.withPackageJson ?? true
  const install = opts.install ?? false
  const withInit = opts.init ?? true
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon e2e '))
  const repo = path.join(tmp, 'repo')
  mkdirSync(path.join(repo, 'vendor', 'tiny'), { recursive: true })

  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(path.join(repo, '.gitattributes'), '* text=auto eol=lf\n')
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n')
  writeFileSync(path.join(repo, 'index.js'), 'export const x = 1\n')
  writeFileSync(path.join(repo, 'vendor', 'tiny', 'package.json'), '{"name":"tiny","version":"1.0.0","main":"index.js"}\n')
  writeFileSync(path.join(repo, 'vendor', 'tiny', 'index.js'), 'module.exports = 42\n')
  if (withPackageJson) {
    writeFileSync(
      path.join(repo, 'package.json'),
      '{"name":"demo","version":"0.0.0","type":"module","private":true,"dependencies":{"tiny":"file:./vendor/tiny"}}\n',
    )
  }

  for (const args of [
    ['init', '-b', 'master'],
    ['config', 'user.email', 'ratoon@test'],
    ['config', 'user.name', 'ratoon'],
  ])
    await run('git', ['-C', repo, ...args], { quiet: true })

  // Install before the first commit: the fixture then has one base commit, and every slot checks
  // out the same `.ratoon/` configuration the main working tree has.
  if (withInit) {
    const installed = await ratoon(['init'], { cwd: repo })
    if (installed.status !== 0)
      throw new Error(`fixture init failed: ${installed.stderr}`)
  }
  await run('git', ['-C', repo, 'add', '-A'], { quiet: true })
  await run('git', ['-C', repo, 'commit', '-m', 'init'], { quiet: true })

  const made: Repo = {
    tmp,
    repo,
    pool: path.join(repo, '.ratoon', 'worktrees'),
    dispose: () => disposeDir(tmp),
  }
  if (withPackageJson && install)
    await installDeps(made)
  return made
}

/**
 * Install the fixture's dependencies on demand. Most cases only exercise git and the CLI, so the
 * default fixture is dependency-free; the few that need a real `node_modules` ask for it here.
 * The lockfile is committed, so the slot starts from a clean tree.
 */
export async function installDeps(repo: Repo): Promise<void> {
  await run('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: repo.repo,
    quiet: true,
  })
  await run('git', ['-C', repo.repo, 'add', '-A'], { quiet: true })
  await run('git', [
    '-C',
    repo.repo,
    'commit',
    '-m',
    'install deps',
  ], { quiet: true })
}

/**
 * Best-effort: a stray subprocess can still hold a handle open on Windows, and a leftover temp
 * directory must never fail a test that otherwise passed.
 */
export function disposeDir(dir: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    }
    catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  }
  catch {}
}

export function ratoon(args: string[], opts: { cwd?: string } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    // never leave an orphan behind: it would keep the temp fixture's handles open
    const killer = setTimeout(() => child.kill(), 100_000)
    child.on('error', (err) => {
      clearTimeout(killer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killer)
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })
}

export function start(repo: Repo, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon(['start', task, ...extra], { cwd: repo.repo })
}

export function finish(repo: Repo, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon(['finish', task, ...extra], { cwd: repo.repo })
}

export function abandon(repo: Repo, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon(['abandon', task, ...extra], { cwd: repo.repo })
}

/**
 * The `  plugins : …` line both lifecycles print: which plugins ran, in array order. It is the
 * one place a test reads a structured answer out of the command output.
 */
export function hooksLine(stdout: string): string {
  return stdout.split(/\r?\n/).find(line => line.startsWith('  plugins'))?.trim() ?? ''
}

/** The versioned hook file: `<repo>/.ratoon/hooks.ts`, read from the main working tree. */
export function writeHooks(repo: Repo, source: string): void {
  writeFile(path.join(repo.repo, '.ratoon', 'hooks.ts'), source)
}

/** Poll for a file another process creates — a handshake, not a sleep-and-hope. */
export async function waitForFile(file: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${file}`)
    await sleep(50)
  }
}

/** Read a file a hook wrote to `rootDir`, which is the pool. */
export function readRootFile(repo: Repo, rel: string): string {
  return readFileSync(path.join(repo.pool, rel), 'utf8')
}

/** Whatever the slot is currently working on, "" when it is free. */
export function slotTask(repo: Repo, dir = 'slot-0'): string {
  try {
    return readFileSync(path.join(repo.pool, '.state', dir, 'task'), 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** The branch checked out in the slot, "" when it is parked (detached). */
export function slotBranch(repo: Repo, dir = 'slot-0'): string {
  try {
    return gitOut(slotDir(repo, dir), 'symbolic-ref', '--short', 'HEAD')
  }
  catch {
    return ''
  }
}

/** The slot directories on disk, in pool order. */
export function slotDirs(repo: Repo): string[] {
  if (!existsSync(repo.pool))
    return []
  return readdirSync(repo.pool)
    .filter(name => /^slot-\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** Park a slot the way `finish` does, without merging — enough to make it reusable again. */
export function parkSlot(repo: Repo, dir = 'slot-0'): void {
  gitOut(slotDir(repo, dir), 'checkout', '--detach', 'master')
  rmSync(path.join(repo.pool, '.state', dir, 'task'), { force: true })
  rmSync(path.join(repo.pool, '.state', dir, 'busy'), { force: true })
}

export function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function gitOut(cwd: string, ...args: string[]): string {
  return execSync('git', ['-C', cwd, ...args])
}

function execSync(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  return result.stdout.trim()
}

export function gitStatus(cwd: string): string[] {
  const out = gitOut(cwd, 'status', '--porcelain')
  return out === ''
    ? []
    : out.split('\n')
}

export function slotDir(repo: Repo, dir: string): string {
  return path.join(repo.pool, dir)
}

export function writeFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await run('git', ['-C', repo, 'add', '-A'], { quiet: true })
  await run('git', ['-C', repo, 'commit', '-m', message], { quiet: true })
}
