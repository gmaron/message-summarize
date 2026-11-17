import { ALL_WEEKDAYS, WEEKEND, type Weekday, WORKDAYS } from '../../domain/schedule.js'

/** Day names in English and Spanish, without accents and in lower case, to the cron number (0 is Sunday). */
const NAMES: Readonly<Record<string, Weekday>> = {
  sun: 0,
  sunday: 0,
  dom: 0,
  domingo: 0,
  mon: 1,
  monday: 1,
  lun: 1,
  lunes: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  mar: 2,
  martes: 2,
  wed: 3,
  wednesday: 3,
  mie: 3,
  miercoles: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  jue: 4,
  jueves: 4,
  fri: 5,
  friday: 5,
  vie: 5,
  viernes: 5,
  sat: 6,
  saturday: 6,
  sab: 6,
  sabado: 6,
}

const GROUPS: Readonly<Record<string, readonly Weekday[]>> = {
  daily: ALL_WEEKDAYS,
  diario: ALL_WEEKDAYS,
  weekdays: WORKDAYS,
  laborables: WORKDAYS,
  weekends: WEEKEND,
  finde: WEEKEND,
}

const normalize = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()

/**
 * The days of `--days`: `daily`, `weekdays`, `weekends` (or `diario`, `laborables`, `finde`), a list of day names
 * (`mon,wed,fri`) or a range (`mon-fri`; it may wrap, `fri-mon`), or a mix (`mon,wed-fri`). Names in English and
 * Spanish, with or without accents. Null when the text is not valid.
 */
export function parseDaysSpec(text: string): Weekday[] | null {
  const spec = normalize(text)
  if (spec === '') return null
  const group = GROUPS[spec]
  if (group !== undefined) return [...group]
  const days = new Set<Weekday>()
  for (const item of spec.split(',')) {
    const [from, to, extra] = item.split('-').map((part) => part.trim())
    if (extra !== undefined || from === undefined) return null
    const start = NAMES[from]
    const end = to === undefined ? start : NAMES[to]
    if (start === undefined || end === undefined) return null
    for (let day = start; ; day = ((day + 1) % 7) as Weekday) {
      days.add(day)
      if (day === end) break
    }
  }
  return [...days]
}
