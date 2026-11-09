import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cli, leadingOptionError, nodeVersionError } from '../src/cli.ts'

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

  it('renders --help with every command', () => {
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
  })

  it('offers --base only on the command that reads it', () => {
    expect(runCli('start', '--help').stdout).toContain('--base')
    for (const args of [
      ['finish', '--help'],
      ['abandon', '--help'],
      ['list', '--help'],
      ['--help'],
    ]) {
      const help = runCli(...args)
      expect(help.status).toBe(0)
      expect(help.stdout).not.toContain('--base')
    }
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

describe('unknown options', () => {
  it('rejects a flag no command declares', () => {
    const out = runCli('finish', 'demo', '--int', 'v2')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('unknown option --int')
    expect(out.stderr).toContain('run ratoon finish --help')
  })

  it('rejects a flag a command used to have', () => {
    const out = runCli('finish', 'demo', '--base', 'master')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('unknown option --base')
  })

  it('says nothing about a value that looks like a flag', () => {
    const out = runCli('finish', 'demo', '-m', '--not-a-flag')
    // no flag complaint: it got as far as looking for the task, which does not exist here
    expect(out.stderr).not.toContain('unknown option')
    expect(out.stderr).toContain('no slot is working on task')
  })
})

describe('option order', () => {
  it('sends an option written before the command back to its command', () => {
    const out = runCli('--base', 'master', 'start', 'demo')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('--base is a `start` option and goes after the command')
    expect(out.stderr).toContain('ratoon start <task> --base <value>')
  })

  it('calls a leading option no command declares by what it is', () => {
    const out = runCli('--nonsense', 'list')
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('--nonsense is not an option of any command')
  })

  const accepted: [name: string, argv: string[]][] = [
    [
      'the supported order',
      ['start', 'demo', '--base', 'X'],
    ],
    [
      'an option between the command and the task',
      ['start', '--base', 'X', 'demo'],
    ],
    [
      'a lone help flag',
      ['--help'],
    ],
    [
      'a lone version flag',
      ['--version'],
    ],
    [
      'the end-of-options marker',
      ['--', 'start'],
    ],
    ['an empty argv', []],
  ]

  for (const [name, argv] of accepted) {
    it(`leaves ${name} to citty`, () => {
      expect(leadingOptionError(argv)).toBeUndefined()
    })
  }

  it('reads an = style value as the same option', () => {
    expect(leadingOptionError(['--into=v2', 'finish', 'demo']))
      .toContain('--into is a `finish` option')
  })
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
