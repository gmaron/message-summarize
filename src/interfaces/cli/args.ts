import { parseArgs as nodeParseArgs } from 'node:util'
import { isValidAccountId } from '../../domain/account-id.js'
import { err, ok, type Result } from '../../domain/result.js'
import { formatTime, parseTime, type Weekday } from '../../domain/schedule.js'
import { parseDaysSpec } from './days.js'
import { type LocalDateTime, parseLocalDateTime } from './local-time.js'

/** `--account <id>`: null when the user gave none (the command then picks the only account, or asks). */
export interface AccountArg {
  readonly account: string | null
}

export interface DigestArgs extends AccountArg {
  /** Show the digest and save or send nothing (RF-64). */
  readonly dryRun: boolean
  /** Wall-clock times in the time zone of the configuration. */
  readonly from: LocalDateTime | null
  readonly to: LocalDateTime | null
  readonly hours: number | null
}

/** `msum import --from <path> [--account <id>] [--instance <name>] [--all] [--schedule HH:MM,HH:MM] [--yes]`. */
export interface ImportArgs extends AccountArg {
  /** The installation of the previous tool, as given. */
  readonly from: string
  /** The name of an instance of the previous tool to import instead of the main installation. */
  readonly instance: string | null
  /** The main installation and every instance, each as its own account. */
  readonly all: boolean
  readonly yes: boolean
  /** Times ("HH:MM") for the schedules of the imported account: the previous tool kept its own outside its data. */
  readonly schedules: readonly string[]
  /** Where the data of the previous tool is, when it was moved with `WA_DATA_DIR` (read only). Null: `data/`. */
  readonly data: string | null
  /** Import the session, the settings and the prompt only, not the messages. */
  readonly sessionOnly: boolean
  /** Go ahead although the previous tool looks as if it is running (the warning and the question remain). */
  readonly force: boolean
}

export type Command =
  | { readonly name: 'help' }
  | { readonly name: 'init' }
  | ({ readonly name: 'link' } & AccountArg)
  | ({ readonly name: 'unlink'; readonly yes: boolean } & AccountArg)
  | ({ readonly name: 'daemon'; readonly retry: boolean } & AccountArg)
  | ({ readonly name: 'digest' } & DigestArgs)
  | ({ readonly name: 'status' } & AccountArg)
  | ({ readonly name: 'doctor' } & AccountArg)
  | ({ readonly name: 'retry' } & AccountArg)
  | ({ readonly name: 'import' } & ImportArgs)
  | { readonly name: 'accounts' }
  /** `msum whisper models`: the known models. `msum whisper download <name>`: one of them, verified. */
  | { readonly name: 'whisper'; readonly action: 'models' }
  | { readonly name: 'whisper'; readonly action: 'download'; readonly model: string }
  | ({ readonly name: 'schedule'; readonly action: 'ls' } & AccountArg)
  | ({
      readonly name: 'schedule'
      readonly action: 'add'
      readonly days: readonly Weekday[]
      /** "HH:MM". */
      readonly time: string
    } & AccountArg)
  | ({ readonly name: 'schedule'; readonly action: 'rm'; readonly id: number } & AccountArg)

/** Why the arguments are wrong. Codes with the offending text: `cli.argErrors` explains each one. */
export type ArgError =
  | { readonly kind: 'unknownCommand'; readonly value: string }
  | { readonly kind: 'unknownOption'; readonly value: string }
  | { readonly kind: 'missingValue'; readonly value: string }
  | { readonly kind: 'unexpectedArgument'; readonly value: string }
  | { readonly kind: 'invalidNumber'; readonly value: string }
  | { readonly kind: 'invalidDate'; readonly value: string }
  | { readonly kind: 'invalidAccountId'; readonly value: string }
  | { readonly kind: 'unknownSubcommand'; readonly value: string }
  | { readonly kind: 'invalidTime'; readonly value: string }
  | { readonly kind: 'invalidDays'; readonly value: string }
  | { readonly kind: 'conflictingOptions'; readonly value: string }

const COMMANDS = [
  'init',
  'link',
  'unlink',
  'daemon',
  'digest',
  'status',
  'doctor',
  'accounts',
  'schedule',
  'retry',
  'import',
  'whisper',
] as const
/** The flags each command accepts (besides --help). */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  link: ['account'],
  unlink: ['yes', 'account'],
  daemon: ['retry', 'account'],
  digest: ['dry-run', 'from', 'to', 'hours', 'account'],
  status: ['account'],
  doctor: ['account'],
  retry: ['account'],
  schedule: ['account', 'time', 'days'],
  import: ['from', 'account', 'instance', 'all', 'yes', 'schedule', 'data', 'session-only', 'force'],
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  yes: { type: 'boolean', short: 'y' },
  retry: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  from: { type: 'string' },
  to: { type: 'string' },
  hours: { type: 'string' },
  account: { type: 'string' },
  time: { type: 'string' },
  days: { type: 'string' },
  instance: { type: 'string' },
  all: { type: 'boolean' },
  schedule: { type: 'string' },
  data: { type: 'string' },
  'session-only': { type: 'boolean' },
  force: { type: 'boolean' },
} as const

/** The "--name" a node:util error message talks about. */
const optionIn = (message: string): string => /-{1,2}[\w-]+/.exec(message)?.[0] ?? message

const readArgs = (argv: readonly string[]) =>
  nodeParseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })

/** Parses the arguments after `node script.js`. Pure: nothing is read or printed. */
export function parseCommandLine(argv: readonly string[]): Result<Command, ArgError> {
  let parsed: ReturnType<typeof readArgs>
  try {
    parsed = readArgs(argv)
  } catch (error) {
    const { code, message } = error as { code?: string; message: string }
    return err({
      kind: code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 'unknownOption' : 'missingValue',
      value: optionIn(message),
    })
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals

  if (values.help || command === undefined || command === 'help') return ok({ name: 'help' })
  if (!(COMMANDS as readonly string[]).includes(command)) return err({ kind: 'unknownCommand', value: command })
  // `schedule` and `whisper` have a subcommand (and `rm` an id, `download` a name); the other commands take no positional arguments.
  if (command !== 'schedule' && command !== 'whisper' && rest.length > 0) {
    return err({ kind: 'unexpectedArgument', value: rest[0] as string })
  }

  const accepted =
    command === 'schedule'
      ? (FLAGS.schedule ?? []).filter(
          (flag) => flag === 'account' || (rest[0] === 'add' && ['time', 'days'].includes(flag)),
        )
      : (FLAGS[command] ?? [])
  for (const flag of Object.keys(values)) {
    if (flag !== 'help' && !accepted.includes(flag)) return err({ kind: 'unknownOption', value: `--${flag}` })
  }

  // The id becomes a directory name: it is checked here, and again where the path is built.
  if (values.account !== undefined && !isValidAccountId(values.account)) {
    return err({ kind: 'invalidAccountId', value: values.account })
  }
  const account = values.account ?? null

  switch (command) {
    case 'unlink':
      return ok({ name: 'unlink', yes: values.yes === true, account })
    case 'daemon':
      return ok({ name: 'daemon', retry: values.retry === true, account })
    case 'digest': {
      const date = (flag: 'from' | 'to'): Result<LocalDateTime | null, ArgError> => {
        const text = values[flag]
        if (text === undefined) return ok(null)
        const parsedDate = parseLocalDateTime(text)
        return parsedDate === null ? err({ kind: 'invalidDate', value: `--${flag}` }) : ok(parsedDate)
      }
      const from = date('from')
      if (!from.ok) return err(from.error)
      const to = date('to')
      if (!to.ok) return err(to.error)
      let hours: number | null = null
      if (values.hours !== undefined) {
        hours = values.hours.trim() === '' ? Number.NaN : Number(values.hours)
        if (!Number.isFinite(hours)) return err({ kind: 'invalidNumber', value: '--hours' })
      }
      return ok({
        name: 'digest',
        dryRun: values['dry-run'] === true,
        from: from.value,
        to: to.value,
        hours,
        account,
      })
    }
    case 'schedule':
      return parseSchedule(rest, values, account)
    case 'whisper':
      return parseWhisper(rest)
    case 'import':
      return parseImport(values, account)
    case 'link':
    case 'status':
    case 'doctor':
    case 'retry':
      return ok({ name: command, account })
    default:
      return ok({ name: command as 'init' | 'accounts' })
  }
}

/** `msum whisper [models|download <name>]`. The name is checked against the table of models by the command. */
function parseWhisper(rest: readonly string[]): Result<Command, ArgError> {
  const [action = 'models', ...more] = rest
  if (action !== 'models' && action !== 'download') return err({ kind: 'unknownSubcommand', value: action })
  if (action === 'models') {
    if (more.length > 0) return err({ kind: 'unexpectedArgument', value: more[0] as string })
    return ok({ name: 'whisper', action: 'models' })
  }
  const [model, ...extra] = more
  if (model === undefined || model.trim() === '') return err({ kind: 'missingValue', value: '<name>' })
  if (extra.length > 0) return err({ kind: 'unexpectedArgument', value: extra[0] as string })
  return ok({ name: 'whisper', action: 'download', model })
}

/** `msum schedule [ls|add|rm]`: the subcommand, and its arguments validated. */
function parseSchedule(
  rest: readonly string[],
  values: { readonly time?: string | undefined; readonly days?: string | undefined },
  account: string | null,
): Result<Command, ArgError> {
  const [action = 'ls', ...more] = rest
  if (action !== 'ls' && action !== 'add' && action !== 'rm') return err({ kind: 'unknownSubcommand', value: action })
  if (action === 'rm') {
    const [idText, ...extra] = more
    if (idText === undefined) return err({ kind: 'missingValue', value: '<id>' })
    if (extra.length > 0) return err({ kind: 'unexpectedArgument', value: extra[0] as string })
    const id = /^\d+$/.test(idText) ? Number(idText) : Number.NaN
    if (!Number.isSafeInteger(id) || id <= 0) return err({ kind: 'invalidNumber', value: '<id>' })
    return ok({ name: 'schedule', action: 'rm', id, account })
  }
  if (more.length > 0) return err({ kind: 'unexpectedArgument', value: more[0] as string })
  if (action === 'ls') return ok({ name: 'schedule', action: 'ls', account })
  if (values.time === undefined) return err({ kind: 'missingValue', value: '--time' })
  const time = parseTime(values.time)
  if (time === null) return err({ kind: 'invalidTime', value: values.time })
  const days = values.days === undefined ? parseDaysSpec('daily') : parseDaysSpec(values.days)
  if (days === null) return err({ kind: 'invalidDays', value: values.days ?? '' })
  return ok({ name: 'schedule', action: 'add', days, time: formatTime(time), account })
}

/** `msum import`: the path of the previous installation, what to import, and the optional times for the schedules. */
function parseImport(
  values: {
    readonly from?: string | undefined
    readonly instance?: string | undefined
    readonly all?: boolean | undefined
    readonly yes?: boolean | undefined
    readonly schedule?: string | undefined
    readonly data?: string | undefined
    readonly 'session-only'?: boolean | undefined
    readonly force?: boolean | undefined
  },
  account: string | null,
): Result<Command, ArgError> {
  if (values.from === undefined || values.from.trim() === '') return err({ kind: 'missingValue', value: '--from' })
  if (values.all === true && (account !== null || values.instance !== undefined)) {
    return err({ kind: 'conflictingOptions', value: '--all' })
  }
  // One data directory belongs to one installation; and with no messages to read there is no data directory to name.
  if (values.data !== undefined) {
    if (values.data.trim() === '') return err({ kind: 'missingValue', value: '--data' })
    if (values.all === true) return err({ kind: 'conflictingOptions', value: '--all' })
    if (values['session-only'] === true) return err({ kind: 'conflictingOptions', value: '--session-only' })
  }
  const schedules: string[] = []
  for (const item of (values.schedule ?? '').split(',')) {
    if (item.trim() === '') continue
    const time = parseTime(item)
    if (time === null) return err({ kind: 'invalidTime', value: item })
    const text = formatTime(time)
    if (!schedules.includes(text)) schedules.push(text)
  }
  return ok({
    name: 'import',
    from: values.from,
    account,
    instance: values.instance ?? null,
    all: values.all === true,
    yes: values.yes === true,
    schedules,
    data: values.data ?? null,
    sessionOnly: values['session-only'] === true,
    force: values.force === true,
  })
}
