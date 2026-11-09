import type { ArgsDef } from 'citty'
import { describe, expect, it } from 'vitest'
import { firstUnknownFlag, flagSetOf } from '../src/args.ts'
import { builtInCommands } from '../src/cli.ts'

/** The definition the CLI actually runs with — the point is that there is only one. */
function flagsOf(command: string) {
  const sub = (builtInCommands as unknown as Record<string, { args: ArgsDef }>)[command]!
  return flagSetOf(sub.args)
}

describe('unknown flag check', () => {
  it('reads the whitelist off the command, so a flag removed there is rejected', () => {
    expect(firstUnknownFlag(['t', '--base', 'master'], flagsOf('start'))).toBeUndefined()
    expect(firstUnknownFlag(['t', '--into', 'v2'], flagsOf('finish'))).toBeUndefined()
    // finish does not declare --base: it is a start flag
    expect(firstUnknownFlag(['t', '--base', 'master'], flagsOf('finish'))).toBe('--base')
  })

  it('accepts every spelling citty itself accepts', () => {
    const start = flagsOf('start')
    const accepted = [
      ['--branch-prefix', 'x'],
      ['--branchPrefix', 'x'],
      ['-h'],
      ['--help'],
      ['--version'],
    ]
    for (const argv of accepted)
      expect(firstUnknownFlag(argv, start), argv.join(' ')).toBeUndefined()
    // `--no-x` is not a spelling citty knows: it lands as its own key, so `x` keeps its default
    expect(firstUnknownFlag(['--no-into'], flagsOf('finish'))).toBe('--no-into')
  })

  it('never reads a value as a flag', () => {
    const finish = flagsOf('finish')
    expect(firstUnknownFlag(['t', '-m', '--into'], finish)).toBeUndefined()
    expect(firstUnknownFlag(['t', '--message=--into'], finish)).toBeUndefined()
    expect(firstUnknownFlag(['t', '--', '--whatever'], finish)).toBeUndefined()
  })
})
