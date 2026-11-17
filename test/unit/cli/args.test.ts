import { describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { parseCommandLine } from '../../../src/interfaces/cli/args.js'
import { parseLocalDateTime, zonedToEpoch } from '../../../src/interfaces/cli/local-time.js'
import { type CliHandlers, describeArgError, runCli } from '../../../src/interfaces/cli/run.js'

const parse = (...argv: string[]) => parseCommandLine(argv)

describe('parseCommandLine', () => {
  it('knows every command', () => {
    for (const name of ['init', 'link', 'status', 'doctor']) {
      expect(parse(name)).toEqual({ ok: true, value: { name } })
    }
    expect(parse('daemon')).toEqual({ ok: true, value: { name: 'daemon', retry: false } })
    expect(parse('daemon', '--retry')).toEqual({ ok: true, value: { name: 'daemon', retry: true } })
    expect(parse('status', '--retry')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--retry' } })
    expect(parse('unlink')).toEqual({ ok: true, value: { name: 'unlink', yes: false } })
    expect(parse('unlink', '--yes')).toEqual({ ok: true, value: { name: 'unlink', yes: true } })
    expect(parse('unlink', '-y')).toEqual({ ok: true, value: { name: 'unlink', yes: true } })
  })

  it('shows help for no command, help, --help and -h', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h'], ['digest', '--help']]) {
      expect(parseCommandLine(argv)).toEqual({ ok: true, value: { name: 'help' } })
    }
  })

  it('parses digest with its flags', () => {
    expect(parse('digest')).toEqual({
      ok: true,
      value: { name: 'digest', dryRun: false, from: null, to: null, hours: null },
    })
    expect(parse('digest', '--dry-run', '--hours', '6')).toEqual({
      ok: true,
      value: { name: 'digest', dryRun: true, from: null, to: null, hours: 6 },
    })
    expect(parse('digest', '--from', '2026-11-17 08:00', '--to', '2026-11-17 10:30')).toEqual({
      ok: true,
      value: {
        name: 'digest',
        dryRun: false,
        from: { year: 2026, month: 11, day: 17, hour: 8, minute: 0 },
        to: { year: 2026, month: 11, day: 17, hour: 10, minute: 30 },
        hours: null,
      },
    })
    expect(parse('digest', '--hours=1.5')).toMatchObject({ ok: true, value: { hours: 1.5 } })
  })

  it('reports an unknown command, option or extra argument', () => {
    expect(parse('frobnicate')).toEqual({ ok: false, error: { kind: 'unknownCommand', value: 'frobnicate' } })
    expect(parse('digest', '--bogus')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--bogus' } })
    expect(parse('init', '--dry-run')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--dry-run' } })
    expect(parse('digest', '--yes')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--yes' } })
    expect(parse('init', 'extra')).toEqual({ ok: false, error: { kind: 'unexpectedArgument', value: 'extra' } })
  })

  it('reports a flag with no value, and values that are not numbers or dates', () => {
    expect(parse('digest', '--hours')).toEqual({ ok: false, error: { kind: 'missingValue', value: '--hours' } })
    expect(parse('digest', '--hours', 'many')).toEqual({
      ok: false,
      error: { kind: 'invalidNumber', value: '--hours' },
    })
    expect(parse('digest', '--hours', '')).toEqual({ ok: false, error: { kind: 'invalidNumber', value: '--hours' } })
    expect(parse('digest', '--from', 'yesterday')).toEqual({
      ok: false,
      error: { kind: 'invalidDate', value: '--from' },
    })
    expect(parse('digest', '--to', '2026-02-30 10:00')).toEqual({
      ok: false,
      error: { kind: 'invalidDate', value: '--to' },
    })
  })

  it('leaves the range of --hours to the domain (zero reaches the window validation)', () => {
    expect(parse('digest', '--hours', '0')).toMatchObject({ ok: true, value: { hours: 0 } })
  })
})

describe('local times', () => {
  it('parses "YYYY-MM-DD HH:MM" and rejects things that are not real moments', () => {
    expect(parseLocalDateTime('2026-11-17 09:05')).toEqual({ year: 2026, month: 11, day: 17, hour: 9, minute: 5 })
    expect(parseLocalDateTime('2026-11-17T09:05')).not.toBeNull()
    for (const bad of [
      '2026-11-17',
      '2026-13-01 10:00',
      '2026-02-29 10:00',
      '2026-11-17 24:00',
      '2026-11-17 10:60',
      'x',
    ]) {
      expect(parseLocalDateTime(bad), bad).toBeNull()
    }
  })

  it('converts the wall clock of a time zone to an instant', () => {
    const local = { year: 2026, month: 11, day: 17, hour: 9, minute: 0 }
    expect(new Date(zonedToEpoch(local, 'America/Argentina/Buenos_Aires')).toISOString()).toBe(
      '2026-11-17T12:00:00.000Z',
    )
    expect(new Date(zonedToEpoch(local, 'Europe/Madrid')).toISOString()).toBe('2026-11-17T08:00:00.000Z')
    expect(new Date(zonedToEpoch(local, 'UTC')).toISOString()).toBe('2026-11-17T09:00:00.000Z')
  })

  it('follows daylight saving time', () => {
    const noon = { year: 2026, month: 7, day: 1, hour: 12, minute: 0 }
    expect(new Date(zonedToEpoch(noon, 'Europe/Madrid')).toISOString()).toBe('2026-07-01T10:00:00.000Z')
    const winter = { year: 2026, month: 1, day: 15, hour: 12, minute: 0 }
    expect(new Date(zonedToEpoch(winter, 'Europe/Madrid')).toISOString()).toBe('2026-01-15T11:00:00.000Z')
  })
})

describe('runCli', () => {
  const calls: string[] = []
  const handler = (name: string) => async () => {
    calls.push(name)
    return 7
  }
  const handlers: CliHandlers = {
    init: handler('init'),
    link: handler('link'),
    unlink: async ({ yes }) => {
      calls.push(`unlink:${yes}`)
      return 0
    },
    daemon: async ({ retry }) => {
      calls.push(`daemon:${retry}`)
      return 7
    },
    digest: async (args) => {
      calls.push(`digest:${args.dryRun}`)
      return 0
    },
    status: handler('status'),
    doctor: handler('doctor'),
  }
  const texts = getCatalog('en').cli
  const run = async (...argv: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(argv, handlers, { out: (l) => out.push(l), err: (l) => err.push(l) }, texts)
    return { code, out, err }
  }

  it('runs the handler and returns its exit code', async () => {
    calls.length = 0
    expect((await run('status')).code).toBe(7)
    expect((await run('unlink', '--yes')).code).toBe(0)
    expect((await run('digest', '--dry-run')).code).toBe(0)
    expect(calls).toEqual(['status', 'unlink:true', 'digest:true'])
  })

  it('prints the help on stdout with exit 0', async () => {
    const result = await run('--help')
    expect(result).toEqual({ code: 0, out: [texts.usage], err: [] })
    expect(texts.usage).toContain('msum')
  })

  it('explains wrong usage on stderr with exit 2, in the language of the catalog', async () => {
    expect(await run('nope')).toEqual({ code: 2, out: [], err: ['Unknown command: "nope". Try "msum help".'] })
    expect((await run('digest', '--hours', 'x')).err[0]).toContain('--hours')
  })

  it('has a message for every kind of argument error, in both languages', () => {
    const kinds = [
      'unknownCommand',
      'unknownOption',
      'missingValue',
      'unexpectedArgument',
      'invalidNumber',
      'invalidDate',
    ] as const
    for (const language of ['es', 'en'] as const) {
      for (const kind of kinds) {
        expect(describeArgError(getCatalog(language).cli, { kind, value: 'x' })).toContain('x')
      }
    }
  })
})
