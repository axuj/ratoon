import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/shell.ts'

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url))
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface Container {
  tmp: string
  /** worktrees container directory handed to `--root` */
  root: string
  /** the main repository inside root */
  proj: string
  dispose: () => void
}

export interface CliResult {
  status: number
  stdout: string
  stderr: string
}

/**
 * A throwaway `<root>/<main-repo>` container.
 * `.gitattributes` pins eol=lf so a package manager rewriting package-lock.json does not leave a
 * line-ending-only dirty tree — the exact trap lynx-solid documents for its generated files.
 */
export async function makeContainer(opts: { withPackageJson?: boolean } = {}): Promise<Container> {
  const withPackageJson = opts.withPackageJson ?? true
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon e2e '))
  const root = path.join(tmp, 'root')
  const proj = path.join(root, 'proj')
  mkdirSync(path.join(proj, 'vendor', 'tiny'), { recursive: true })

  // hooks import `./plugins/*.ts`, which is what `ratoon init` copies in — same files, no install
  mkdirSync(path.join(root, '.ratoon'), { recursive: true })
  copyFileSync(path.join(SRC, 'types.ts'), path.join(root, '.ratoon', 'types.ts'))
  cpSync(path.join(SRC, 'plugins'), path.join(root, '.ratoon', 'plugins'), { recursive: true })

  writeFileSync(path.join(proj, '.gitignore'), 'node_modules/\n')
  writeFileSync(path.join(proj, '.gitattributes'), '* text=auto eol=lf\n')
  writeFileSync(path.join(proj, 'README.md'), '# fixture\n')
  writeFileSync(path.join(proj, 'index.js'), 'export const x = 1\n')
  writeFileSync(path.join(proj, 'vendor', 'tiny', 'package.json'), '{"name":"tiny","version":"1.0.0","main":"index.js"}\n')
  writeFileSync(path.join(proj, 'vendor', 'tiny', 'index.js'), 'module.exports = 42\n')
  if (withPackageJson) {
    writeFileSync(
      path.join(proj, 'package.json'),
      '{"name":"demo","version":"0.0.0","type":"module","private":true,"dependencies":{"tiny":"file:./vendor/tiny"}}\n',
    )
  }

  await run('git', ['-C', proj, 'init', '-b', 'master'], { quiet: true })
  await run('git', [
    '-C',
    proj,
    'config',
    'user.email',
    'ratoon@test',
  ], { quiet: true })
  await run('git', [
    '-C',
    proj,
    'config',
    'user.name',
    'ratoon',
  ], { quiet: true })
  if (withPackageJson)
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: proj, quiet: true })
  await run('git', ['-C', proj, 'add', '-A'], { quiet: true })
  await run('git', ['-C', proj, 'commit', '-m', 'init'], { quiet: true })

  return {
    tmp,
    root,
    proj,
    dispose: () => disposeDir(tmp),
  }
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
    // never leave an orphan behind: it would keep the temp container's handles open
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

export function start(container: Container, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon([
    'start',
    task,
    '--root',
    container.root,
    ...extra,
  ])
}

export function finish(container: Container, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon([
    'finish',
    task,
    '--root',
    container.root,
    ...extra,
  ])
}

export function abandon(container: Container, task: string, extra: string[] = []): Promise<CliResult> {
  return ratoon([
    'abandon',
    task,
    '--root',
    container.root,
    ...extra,
  ])
}

/**
 * The `  plugins : …` line both lifecycles print: which plugins ran, in array order. It is the
 * one place a test reads a structured answer out of the command output.
 */
export function hooksLine(stdout: string): string {
  return stdout.split(/\r?\n/).find(line => line.startsWith('  plugins'))?.trim() ?? ''
}

/** Container-level hooks: `<root>/.ratoon/hooks.ts` — outside every git worktree. */
export function writeHooks(container: Container, source: string): void {
  writeFile(path.join(container.root, '.ratoon', 'hooks.ts'), source)
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

export function readRootFile(container: Container, rel: string): string {
  return readFileSync(path.join(container.root, rel), 'utf8')
}

/** Whatever the slot is currently working on, "" when it is free. */
export function slotTask(container: Container, dir = 'slot-0'): string {
  try {
    return readFileSync(path.join(container.root, '.state', dir, 'task'), 'utf8').trim()
  }
  catch {
    return ''
  }
}

/** The branch checked out in the slot, "" when it is parked (detached). */
export function slotBranch(container: Container, dir = 'slot-0'): string {
  try {
    return gitOut(slotDir(container, dir), 'symbolic-ref', '--short', 'HEAD')
  }
  catch {
    return ''
  }
}

/** The slot directories on disk, in pool order. */
export function slotDirs(container: Container): string[] {
  return readdirSync(container.root)
    .filter(name => /^slot-\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/** Park a slot the way `finish` does, without merging — enough to make it reusable again. */
export function parkSlot(container: Container, dir = 'slot-0'): void {
  gitOut(slotDir(container, dir), 'checkout', '--detach', 'master')
  rmSync(path.join(container.root, '.state', dir, 'task'), { force: true })
  rmSync(path.join(container.root, '.state', dir, 'busy'), { force: true })
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

export function slotDir(container: Container, dir: string): string {
  return path.join(container.root, dir)
}

export function writeFile(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

export async function commitAll(proj: string, message: string): Promise<void> {
  await run('git', ['-C', proj, 'add', '-A'], { quiet: true })
  await run('git', ['-C', proj, 'commit', '-m', message], { quiet: true })
}
