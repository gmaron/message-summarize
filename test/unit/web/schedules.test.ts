import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../src/interfaces/web/lib/api.js'
import {
  EVERY_DAY,
  inUiOrder,
  newDraft,
  presetOf,
  type ScheduleDraft,
  sameDays,
  scheduleIssueOf,
  toggleDay,
  UI_DAY_ORDER,
  validateDraft,
  WEEKDAYS,
} from '../../../src/interfaces/web/lib/schedules.js'

describe('schedule days', () => {
  it('shows Monday first and Sunday last, with the API numbering (0 is Sunday)', () => {
    expect(UI_DAY_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(inUiOrder([0, 6, 1])).toEqual([1, 6, 0])
  })

  it('toggles a day on and off, keeping the days sorted and without repeats', () => {
    let draft: ScheduleDraft = { days: [1, 3], time: '09:00' }
    draft = toggleDay(draft, 0)
    expect(draft.days).toEqual([0, 1, 3])
    draft = toggleDay(draft, 1)
    expect(draft.days).toEqual([0, 3])
  })

  it('names the shortcuts', () => {
    expect(presetOf(EVERY_DAY)).toBe('everyDay')
    expect(presetOf([...WEEKDAYS].reverse())).toBe('weekdays')
    expect(presetOf([1, 2])).toBeNull()
    expect(sameDays([1, 2], [2, 1])).toBe(true)
    expect(sameDays([1], [1, 2])).toBe(false)
  })
})

describe('validateDraft', () => {
  it('starts as every day at 09:00 and is valid', () => {
    expect(newDraft()).toEqual({ days: EVERY_DAY, time: '09:00' })
    expect(validateDraft(newDraft())).toBeNull()
  })

  it('says what the daemon would say', () => {
    expect(validateDraft({ days: [], time: '09:00' })).toBe('noDays')
    expect(validateDraft({ days: [1], time: '25:00' })).toBe('invalidTime')
    expect(validateDraft({ days: [1], time: '' })).toBe('invalidTime')
    expect(validateDraft({ days: [9], time: '09:00' })).toBe('invalidDay')
  })
})

describe('scheduleIssueOf', () => {
  it('reads the issue of a 422', () => {
    expect(scheduleIssueOf(new ApiError(422, 'invalidSchedule', 'noDays'))).toBe('noDays')
    expect(scheduleIssueOf(new ApiError(422, 'invalidSchedule', 'weird'))).toBeNull()
    expect(scheduleIssueOf(new ApiError(404, 'notFound'))).toBeNull()
    expect(scheduleIssueOf(new Error('x'))).toBeNull()
  })
})
