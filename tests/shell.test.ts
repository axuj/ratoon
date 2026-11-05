import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exec, exists, rmrf, run } from '../src/shell.ts'

let tmp = ''

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'ratoon shell 测试 '))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('run', () => {
  it('throws on a non-zero exit and names the failing command', async () => {
    await expect(run('node', ['-e', 'process.exit(3)'], { cwd: tmp }))
      .rejects
      .toThrow(/command failed \(3\): node -e process\.exit\(3\)/)
  })

  it('reports the cwd it ran in when it fails', async () => {
    await expect(run('node', ['-e', 'process.exit(1)'], { cwd: tmp }))
      .rejects
      .toThrow(new RegExp(`cwd: ${tmp.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')}`))
  })

  it('resolves with nothing on success', async () => {
    await expect(run('node', ['-e', 'process.exit(0)'], { cwd: tmp })).resolves.toBeUndefined()
  })

  it('passes a directory containing spaces and CJK characters as the cwd', async () => {
    const nested = path.join(tmp, 'has space', '中文目录')
    mkdirSync(nested, { recursive: true })
    const result = await exec('node', ['-p', 'process.cwd()'], { cwd: nested })
    expect(result.status).toBe(0)
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(nested))
  })

  it('swallows the output when quiet, but still puts it in the message on failure', async () => {
    const err = await run('node', ['-e', 'console.log("captured"); process.exit(4)'], { quiet: true })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('command failed (4)')
    expect((err as Error).message).toContain('captured')
  })
})

describe('exec', () => {
  it('captures stdout and stderr without throwing', async () => {
    const result = await exec('node', ['-e', 'console.log("out"); console.error("err"); process.exit(7)'])
    expect(result.status).toBe(7)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
  })

  it('round-trips arguments with spaces, quotes and CJK through the shell', async () => {
    const args = [
      'plain',
      'with space',
      '中文参数',
      'quote"inside',
      'single\'inside',
    ]
    const result = await exec('node', ['-p', 'JSON.stringify(process.argv.slice(1))', ...args])
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual(args)
  })

  it('reports a missing command as 127 rather than throwing', async () => {
    const result = await exec('ratoon-definitely-missing-binary')
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('command not found')
  })

  it('applies env overrides', async () => {
    const result = await exec('node', ['-p', 'process.env.RATOON_TEST_VALUE'], {
      env: { RATOON_TEST_VALUE: '值-with space' },
    })
    expect(result.stdout.trim()).toBe('值-with space')
  })
})

describe('fs helpers', () => {
  it('exists / rmrf work without POSIX tools on PATH', async () => {
    const dir = path.join(tmp, 'a b', '中')
    mkdirSync(dir, { recursive: true })
    expect(exists(dir)).toBe(true)

    const file = path.join(dir, 'f.txt')
    writeFileSync(file, 'payload')

    await rmrf(dir)
    expect(exists(dir)).toBe(false)

    await rmrf(path.join(tmp, 'never existed'))
    expect(exists(path.join(tmp, 'never existed'))).toBe(false)
  })
})
