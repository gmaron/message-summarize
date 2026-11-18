import { describe, expect, it } from 'vitest'
import { parseCommandLine } from '../../../src/interfaces/cli/args.js'
import { parseDaysSpec } from '../../../src/interfaces/cli/days.js'

const sorted = (days: number[] | null): number[] | null => (days === null ? null : [...days].sort((a, b) => a - b))

describe('parseDaysSpec', () => {
  it('knows the groups, in English and Spanish', () => {
    expect(sorted(parseDaysSpec('daily'))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(sorted(parseDaysSpec('Diario'))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(sorted(parseDaysSpec('weekdays'))).toEqual([1, 2, 3, 4, 5])
    expect(sorted(parseDaysSpec('laborables'))).toEqual([1, 2, 3, 4, 5])
    expect(sorted(parseDaysSpec('weekends'))).toEqual([0, 6])
    expect(sorted(parseDaysSpec('finde'))).toEqual([0, 6])
  })

  it('reads lists of day names in both languages, with or without accents', () => {
    expect(sorted(parseDaysSpec('mon,wed,fri'))).toEqual([1, 3, 5])
    expect(sorted(parseDaysSpec('lun,mar,mie,jue,vie,sab,dom'))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(sorted(parseDaysSpec('lun, mié, sáb'))).toEqual([1, 3, 6])
    expect(sorted(parseDaysSpec('Miércoles,SÁBADO,Domingo'))).toEqual([0, 3, 6])
    expect(sorted(parseDaysSpec('monday,thursday'))).toEqual([1, 4])
  })

  it('reads ranges, mixes, and ranges that wrap around the week', () => {
    expect(sorted(parseDaysSpec('mon-fri'))).toEqual([1, 2, 3, 4, 5])
    expect(sorted(parseDaysSpec('lun-vie'))).toEqual([1, 2, 3, 4, 5])
    expect(sorted(parseDaysSpec('mon,wed-fri'))).toEqual([1, 3, 4, 5])
    expect(sorted(parseDaysSpec('fri-mon'))).toEqual([0, 1, 5, 6])
    expect(sorted(parseDaysSpec('mon-sun'))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('refuses what is not a day', () => {
    for (const bad of ['', '  ', 'funday', 'mon,', ',mon', 'mon-', 'mon-tue-wed', '1,2', 'monday-', 'all']) {
      expect(parseDaysSpec(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('msum import arguments', () => {
  const parse = (...argv: string[]) => parseCommandLine(['import', ...argv])

  it('takes --from and the options, with defaults', () => {
    expect(parse('--from', '/old')).toEqual({
      ok: true,
      value: {
        name: 'import',
        from: '/old',
        account: null,
        instance: null,
        all: false,
        yes: false,
        schedules: [],
        data: null,
        sessionOnly: false,
        force: false,
      },
    })
    expect(
      parse('--from', '/old', '--account', 'main', '--instance', 'taller', '--yes', '--schedule', '7:00, 19:30,07:00'),
    ).toEqual({
      ok: true,
      value: {
        name: 'import',
        from: '/old',
        account: 'main',
        instance: 'taller',
        all: false,
        yes: true,
        schedules: ['07:00', '19:30'],
        data: null,
        sessionOnly: false,
        force: false,
      },
    })
    expect(parse('--from', '/old', '--data', '/moved', '--force')).toMatchObject({
      ok: true,
      value: { data: '/moved', force: true, sessionOnly: false },
    })
    expect(parse('--from', '/old', '--session-only')).toMatchObject({ ok: true, value: { sessionOnly: true } })
    expect(parse('--from', '/old', '--data', '/moved', '--all')).toEqual({
      ok: false,
      error: { kind: 'conflictingOptions', value: '--all' },
    })
    expect(parse('--from', '/old', '--data', '/moved', '--session-only')).toEqual({
      ok: false,
      error: { kind: 'conflictingOptions', value: '--session-only' },
    })
    expect(parse('--from', '/old', '--data', ' ')).toEqual({
      ok: false,
      error: { kind: 'missingValue', value: '--data' },
    })
    expect(parse('--from', '/old', '--all')).toMatchObject({ ok: true, value: { all: true } })
  })

  it('needs --from, refuses --all with --account or --instance, and bad times or ids', () => {
    expect(parse()).toEqual({ ok: false, error: { kind: 'missingValue', value: '--from' } })
    expect(parse('--from', ' ')).toEqual({ ok: false, error: { kind: 'missingValue', value: '--from' } })
    expect(parse('--from', '/old', '--all', '--account', 'x')).toEqual({
      ok: false,
      error: { kind: 'conflictingOptions', value: '--all' },
    })
    expect(parse('--from', '/old', '--all', '--instance', 'taller')).toEqual({
      ok: false,
      error: { kind: 'conflictingOptions', value: '--all' },
    })
    expect(parse('--from', '/old', '--schedule', '25:00')).toEqual({
      ok: false,
      error: { kind: 'invalidTime', value: '25:00' },
    })
    expect(parse('--from', '/old', '--account', 'Bad Id')).toEqual({
      ok: false,
      error: { kind: 'invalidAccountId', value: 'Bad Id' },
    })
  })

  it('the options belong to import only', () => {
    expect(parseCommandLine(['link', '--from', '/old'])).toEqual({
      ok: false,
      error: { kind: 'unknownOption', value: '--from' },
    })
    expect(parseCommandLine(['status', '--instance', 'taller'])).toEqual({
      ok: false,
      error: { kind: 'unknownOption', value: '--instance' },
    })
    expect(parseCommandLine(['digest', '--all'])).toEqual({
      ok: false,
      error: { kind: 'unknownOption', value: '--all' },
    })
  })
})

describe('msum schedule arguments', () => {
  const parse = (...argv: string[]) => parseCommandLine(['schedule', ...argv])

  it('lists by default and with ls', () => {
    expect(parse()).toEqual({ ok: true, value: { name: 'schedule', action: 'ls', account: null } })
    expect(parse('ls', '--account', 'work')).toEqual({
      ok: true,
      value: { name: 'schedule', action: 'ls', account: 'work' },
    })
  })

  it('adds with a time, every day by default', () => {
    expect(parse('add', '--time', '7:30')).toEqual({
      ok: true,
      value: { name: 'schedule', action: 'add', days: [0, 1, 2, 3, 4, 5, 6], time: '07:30', account: null },
    })
    expect(parse('add', '--time', '19:00', '--days', 'mon-fri', '--account', 'a')).toEqual({
      ok: true,
      value: { name: 'schedule', action: 'add', days: [1, 2, 3, 4, 5], time: '19:00', account: 'a' },
    })
  })

  it('needs a valid time and valid days for add', () => {
    expect(parse('add')).toEqual({ ok: false, error: { kind: 'missingValue', value: '--time' } })
    expect(parse('add', '--time', '25:00')).toEqual({ ok: false, error: { kind: 'invalidTime', value: '25:00' } })
    expect(parse('add', '--time', '09:00', '--days', 'funday')).toEqual({
      ok: false,
      error: { kind: 'invalidDays', value: 'funday' },
    })
  })

  it('removes by a positive whole id', () => {
    expect(parse('rm', '3')).toEqual({ ok: true, value: { name: 'schedule', action: 'rm', id: 3, account: null } })
    expect(parse('rm')).toEqual({ ok: false, error: { kind: 'missingValue', value: '<id>' } })
    for (const bad of ['0', 'x', '1.5']) {
      expect(parse('rm', bad), bad).toEqual({ ok: false, error: { kind: 'invalidNumber', value: '<id>' } })
    }
    expect(parse('rm', '1', '2')).toEqual({ ok: false, error: { kind: 'unexpectedArgument', value: '2' } })
  })

  it('refuses an unknown subcommand, and flags that do not belong to the subcommand', () => {
    expect(parse('edit')).toEqual({ ok: false, error: { kind: 'unknownSubcommand', value: 'edit' } })
    expect(parse('ls', '--time', '09:00')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--time' } })
    expect(parse('rm', '1', '--days', 'mon')).toEqual({ ok: false, error: { kind: 'unknownOption', value: '--days' } })
    expect(parse('ls', 'extra')).toEqual({ ok: false, error: { kind: 'unexpectedArgument', value: 'extra' } })
  })
})
