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
