import { describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { parseCommandLine } from '../../../src/interfaces/cli/args.js'
import { parseLocalDateTime, zonedToEpoch } from '../../../src/interfaces/cli/local-time.js'
import { type CliHandlers, describeArgError, runCli } from '../../../src/interfaces/cli/run.js'

const parse = (...argv: string[]) => parseCommandLine(argv)

describe('parseCommandLine', () => {
  it('knows every command', () => {
    for (const name of ['init', 'accounts']) {
      expect(parse(name)).toEqual({ ok: true, value: { name } })
    }
    for (const name of ['link', 'status', 'doctor']) {
      expect(parse(name)).toEqual({ ok: true, value: { name, account: null } })
    }
    expect(parse('daemon')).toEqual({ ok: true, value: { name: 'daemon', retry: false, account: null } })
    expect(parse('daemon', '--retry')).toEqual({ ok: true, value: { name: 'daemon', retry: true, account: null } })
    expect(parse('status', '--retry')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--retry' } })
    expect(parse('unlink')).toEqual({ ok: true, value: { name: 'unlink', yes: false, account: null } })
    expect(parse('unlink', '--yes')).toEqual({ ok: true, value: { name: 'unlink', yes: true, account: null } })
    expect(parse('unlink', '-y')).toEqual({ ok: true, value: { name: 'unlink', yes: true, account: null } })
  })

  it('takes --account on link, unlink, daemon, digest, status and doctor, and nowhere else', () => {
    for (const name of ['link', 'unlink', 'daemon', 'digest', 'status', 'doctor']) {
      expect(parse(name, '--account', 'work-2')).toMatchObject({ ok: true, value: { name, account: 'work-2' } })
      expect(parse(name, '--account=work')).toMatchObject({ ok: true, value: { name, account: 'work' } })
    }
    for (const name of ['init', 'accounts']) {
      expect(parse(name, '--account', 'work')).toEqual({
        ok: false,
        error: { kind: 'unknownOption', value: '--account' },
      })
    }
    expect(parse('link', '--account')).toEqual({ ok: false, error: { kind: 'missingValue', value: '--account' } })
  })

  it('parses whisper: the list of models by default, and download with a model name', () => {
    expect(parse('whisper')).toEqual({ ok: true, value: { name: 'whisper', action: 'models' } })
    expect(parse('whisper', 'models')).toEqual({ ok: true, value: { name: 'whisper', action: 'models' } })
    expect(parse('whisper', 'download', 'base')).toEqual({
      ok: true,
      value: { name: 'whisper', action: 'download', model: 'base' },
    })
    expect(parse('whisper', 'download')).toEqual({ ok: false, error: { kind: 'missingValue', value: '<name>' } })
    expect(parse('whisper', 'download', 'base', 'small')).toEqual({
      ok: false,
      error: { kind: 'unexpectedArgument', value: 'small' },
    })
    expect(parse('whisper', 'models', 'x')).toEqual({ ok: false, error: { kind: 'unexpectedArgument', value: 'x' } })
    expect(parse('whisper', 'remove')).toEqual({ ok: false, error: { kind: 'unknownSubcommand', value: 'remove' } })
    expect(parse('whisper', 'models', '--account', 'x')).toEqual({
      ok: false,
      error: { kind: 'unknownOption', value: '--account' },
    })
  })

  it('refuses an account id that is not safe as a directory name', () => {
    const bad = ['', 'Work', '-a', 'a b', '../x', 'a/b', 'a.b', '.', '..', 'a'.repeat(33), 'ñandú', 'a\nb']
    for (const id of bad) {
      expect(parse('link', `--account=${id}`), JSON.stringify(id)).toEqual({
        ok: false,
        error: { kind: 'invalidAccountId', value: id },
      })
    }
    expect(parse('link', '--account', 'a'.repeat(32))).toMatchObject({ ok: true })
    expect(parse('link', '--account', '0-9')).toMatchObject({ ok: true })
  })

  it('shows help for no command, help, --help and -h', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h'], ['digest', '--help']]) {
      expect(parseCommandLine(argv)).toEqual({ ok: true, value: { name: 'help' } })
    }
  })

  it('parses digest with its flags', () => {
    expect(parse('digest')).toEqual({
      ok: true,
      value: { name: 'digest', dryRun: false, from: null, to: null, hours: null, account: null },
    })
    expect(parse('digest', '--dry-run', '--hours', '6')).toEqual({
      ok: true,
      value: { name: 'digest', dryRun: true, from: null, to: null, hours: 6, account: null },
    })
    expect(parse('digest', '--from', '2026-11-17 08:00', '--to', '2026-11-17 10:30')).toEqual({
      ok: true,
      value: {
        name: 'digest',
        dryRun: false,
        from: { year: 2026, month: 11, day: 17, hour: 8, minute: 0 },
        to: { year: 2026, month: 11, day: 17, hour: 10, minute: 30 },
        hours: null,
        account: null,
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
    accounts: handler('accounts'),
    schedule: handler('schedule'),
    retry: handler('retry'),
    import: handler('import'),
    whisper: handler('whisper'),
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
      'invalidAccountId',
      'unknownSubcommand',
      'invalidTime',
      'invalidDays',
      'conflictingOptions',
    ] as const
    for (const language of ['es', 'en'] as const) {
      for (const kind of kinds) {
        expect(describeArgError(getCatalog(language).cli, { kind, value: 'x' })).toContain('x')
      }
    }
  })
})
