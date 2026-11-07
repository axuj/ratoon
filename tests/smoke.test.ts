import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cli, hoistGlobalOptions, nodeVersionError } from '../src/cli.ts'

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

function runCli(...args: string[]): { status: number, stdout: string, stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('citty command tree', () => {
  it('exposes the five commands through meta', () => {
    expect(Object.keys(cli.subCommands as Record<string, unknown>)).toEqual([
      'init',
      'start',
      'finish',
      'abandon',
      'list',
    ])
  })

  it('renders --help with every command and every shared flag', () => {
    const help = runCli('--help')
    expect(help.status).toBe(0)
    for (const command of [
      'init',
      'start',
      'finish',
      'abandon',
      'list',
    ])
      expect(help.stdout).toContain(command)
    for (const flag of [
      '--base',
      '--branch-prefix',
    ])
      expect(help.stdout).toContain(flag)
  })

  it('prints the package version', () => {
    const version = runCli('--version')
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('fails with usage when nothing is invoked', () => {
    const bare = runCli()
    expect(bare.status).toBe(1)
    expect(bare.stderr).toContain('No command specified')
  })

  it('fails on an unknown command', () => {
    const unknown = runCli('teleport')
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('Unknown command teleport')
  })

  it('fails when the task positional is missing', () => {
    const missing = runCli('start')
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('Missing required positional argument: TASK')
  })

  it('survives a consumer that closes the pipe early', async () => {
    const child = spawn(process.execPath, [CLI, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk)
    })
    // the reader is gone long before node has even finished booting, so every write lands on a
    // broken pipe — this used to dump `EPIPE` plus a raw stack and exit non-zero
    child.stdout!.destroy()

    const code = await new Promise<number | null>(resolve => child.on('close', resolve))
    expect(stderr).not.toContain('EPIPE')
    expect(stderr).not.toContain('node:events')
    expect(code).toBe(0)
  })
})

describe('hoistGlobalOptions', () => {
  const cases: [name: string, input: string[], expected: string[]][] = [
    [
      'leaves options that already follow the command alone',
      ['start', 'demo', '--base', 'X'],
      ['start', 'demo', '--base', 'X'],
    ],
    [
      'moves options written before the command',
      ['--base', 'X', 'start', 'demo'],
      ['start', 'demo', '--base', 'X'],
    ],
    [
      'moves value-less flags too',
      ['--help', 'list'],
      ['list', '--help'],
    ],
    [
      'keeps = style values together',
      ['--base=X', 'list'],
      ['list', '--base=X'],
    ],
    [
      'keeps a trailing help flag untouched',
      ['-h'],
      ['-h'],
    ],
    [
      'keeps a lone version flag untouched',
      ['--version'],
      ['--version'],
    ],
    ['returns an empty argv unchanged', [], []],
    [
      'does not confuse a flag value for the command',
      [
        '--branch-prefix',
        'nested/repo',
        'finish',
        'demo',
      ],
      [
        'finish',
        'demo',
        '--branch-prefix',
        'nested/repo',
      ],
    ],
  ]

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(hoistGlobalOptions(input)).toEqual(expected)
    })
  }
})

describe('node version guard', () => {
  it('refuses the majors that cannot strip types out of .ts hook files', () => {
    expect(nodeVersionError('22.11.0')).toBe('ratoon requires Node >= 26 (found v22.11.0)')
    expect(nodeVersionError('v24.1.0')).toBe('ratoon requires Node >= 26 (found v24.1.0)')
  })

  it('lets everything from 26 on through', () => {
    expect(nodeVersionError('26.12.1')).toBeUndefined()
    expect(nodeVersionError('v26.0.0')).toBeUndefined()
    expect(nodeVersionError('28.1.0')).toBeUndefined()
  })

  it('stays out of the way when the version string is unparseable', () => {
    expect(nodeVersionError('')).toBeUndefined()
    expect(nodeVersionError('not-a-version')).toBeUndefined()
  })
})
