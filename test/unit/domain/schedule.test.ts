import { describe, expect, it } from 'vitest'
import {
  cronToSchedule,
  formatTime,
  makeSchedule,
  mergeByTime,
  parseTime,
  type Schedule,
  sameSchedule,
  scheduleToCron,
} from '../../../src/domain/schedule.js'

const made = (days: number[], time: string): Schedule => {
  const result = makeSchedule(days, time)
  if (!result.ok) throw new Error(`invalid: ${result.error}`)
  return result.value
}

describe('parseTime', () => {
  it('reads 24-hour times, with or without a leading zero', () => {
    expect(parseTime('07:30')).toEqual({ hour: 7, minute: 30 })
    expect(parseTime('7:05')).toEqual({ hour: 7, minute: 5 })
    expect(parseTime(' 23:59 ')).toEqual({ hour: 23, minute: 59 })
    expect(parseTime('00:00')).toEqual({ hour: 0, minute: 0 })
  })

  it('rejects what is not a time of day', () => {
    for (const bad of ['24:00', '12:60', '7', '7:5', '07:30:00', 'noon', '', '-1:00', '12.30']) {
      expect(parseTime(bad), bad).toBeNull()
    }
  })
})

describe('makeSchedule', () => {
  it('sorts the days, drops repeats and keeps the time', () => {
    const schedule = made([5, 1, 3, 1], '9:00')
    expect(schedule).toEqual({ days: [1, 3, 5], hour: 9, minute: 0 })
    expect(formatTime(schedule)).toBe('09:00')
  })

  it('needs at least one day, only days 0 to 6, and a real time', () => {
    expect(makeSchedule([], '09:00')).toEqual({ ok: false, error: 'noDays' })
    expect(makeSchedule([7], '09:00')).toEqual({ ok: false, error: 'invalidDay' })
    expect(makeSchedule([-1], '09:00')).toEqual({ ok: false, error: 'invalidDay' })
    expect(makeSchedule([1.5], '09:00')).toEqual({ ok: false, error: 'invalidDay' })
    expect(makeSchedule([1], '25:00')).toEqual({ ok: false, error: 'invalidTime' })
  })
})

describe('scheduleToCron', () => {
  it('gives minute, hour, any day of the month, any month and the days of the week', () => {
    expect(scheduleToCron(made([1, 2, 3, 4, 5], '07:30'))).toBe('30 7 * * 1,2,3,4,5')
    expect(scheduleToCron(made([0, 6], '19:00'))).toBe('0 19 * * 0,6')
    expect(scheduleToCron(made([3], '00:05'))).toBe('5 0 * * 3')
  })

  it('writes every day as a star', () => {
    expect(scheduleToCron(made([0, 1, 2, 3, 4, 5, 6], '09:00'))).toBe('0 9 * * *')
  })
})

describe('cronToSchedule', () => {
  it('reads what scheduleToCron writes', () => {
    for (const schedule of [made([0, 1, 2, 3, 4, 5, 6], '07:00'), made([1, 3, 5], '23:59'), made([6, 0], '00:00')]) {
      const back = cronToSchedule(scheduleToCron(schedule))
      expect(back && sameSchedule(back, schedule)).toBe(true)
    }
  })

  it('reads fixed times with any list or range of days of the week', () => {
    expect(cronToSchedule('0 7 * * *')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 0 })
    expect(cronToSchedule('30 19 * * 1-5')).toEqual({ days: [1, 2, 3, 4, 5], hour: 19, minute: 30 })
    expect(cronToSchedule('0 9 * * 1,3,5')).toEqual({ days: [1, 3, 5], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * mon-fri')).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * SAT,sun')).toEqual({ days: [0, 6], hour: 9, minute: 0 })
    expect(cronToSchedule('  5   8  *  * 0  ')).toEqual({ days: [0], hour: 8, minute: 5 })
  })

  it('treats 7 as Sunday, alone or at the end of a range', () => {
    expect(cronToSchedule('0 9 * * 7')).toEqual({ days: [0], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * 5-7')).toEqual({ days: [0, 5, 6], hour: 9, minute: 0 })
  })

  it('reads sun at the end of a range as the seventh day, and ? as a star in the day of the month', () => {
    expect(cronToSchedule('0 9 * * MON-SUN')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * mon-sun')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * fri-sun')).toEqual({ days: [0, 5, 6], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * 1-7')).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 })
    // sun at the START of a range, or alone, is still day 0
    expect(cronToSchedule('0 9 * * sun-tue')).toEqual({ days: [0, 1, 2], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 * * sun')).toEqual({ days: [0], hour: 9, minute: 0 })
    expect(cronToSchedule('0 9 ? * 1-5')).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
    // ? means nothing in the other fields
    expect(cronToSchedule('0 9 * ? 1-5')).toBeNull()
    expect(cronToSchedule('0 9 * * ?')).toBeNull()
  })

  it('refuses what a schedule cannot say', () => {
    const notRepresentable = [
      '*/5 * * * *', // steps
      '0 7,19 * * *', // two times
      '0 * * * *', // every hour
      '30 8 1 * *', // a day of the month
      '0 8 * 6 *', // a month
      '0 0 7 * * *', // a seconds field
      '@daily', // a nickname
      '0 9 * * 5-1', // a range that wraps
      '0 9 * * 8', // not a day
      '0 9 * * fun', // not a day name
      '60 9 * * *', // not a minute
      '0 24 * * *', // not an hour
      '',
    ]
    for (const expression of notRepresentable) expect(cronToSchedule(expression), expression).toBeNull()
  })
})

describe('mergeByTime', () => {
  it('makes one schedule per distinct time with the union of its days, ordered by time', () => {
    const merged = mergeByTime([
      made([1, 2], '19:00'),
      made([1, 3], '07:00'),
      made([2, 3, 4], '07:00'),
      made([5], '07:30'),
      made([6], '19:00'),
    ])
    expect(merged.map((s) => scheduleToCron(s))).toEqual(['0 7 * * 1,2,3,4', '30 7 * * 5', '0 19 * * 1,2,6'])
  })

  it('leaves distinct times alone, and an empty list empty', () => {
    expect(mergeByTime([])).toEqual([])
    expect(mergeByTime([made([1], '07:00')])).toEqual([made([1], '07:00')])
  })
})

describe('sameSchedule', () => {
  it('compares days and time', () => {
    expect(sameSchedule(made([1, 2], '07:00'), made([2, 1], '7:00'))).toBe(true)
    expect(sameSchedule(made([1, 2], '07:00'), made([1, 2], '07:01'))).toBe(false)
    expect(sameSchedule(made([1, 2], '07:00'), made([1], '07:00'))).toBe(false)
  })
})
