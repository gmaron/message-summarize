import { parseArgs as nodeParseArgs } from 'node:util'
import { isValidAccountId } from '../../domain/account-id.js'
import { err, ok, type Result } from '../../domain/result.js'
import { formatTime, parseTime, type Weekday } from '../../domain/schedule.js'
import {
  isProviderInfoKind,
  PROVIDER_INFO_KINDS,
  type ProviderInfoKind,
} from '../../infrastructure/llm/provider-info.js'
import { isKeyProvider, type KeyProvider } from '../../infrastructure/secrets/index.js'
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
  /** `skipModelCheck` (only present when given) leaves out the call that asks the configured Ollama for its models. */
  | ({ readonly name: 'doctor'; readonly skipModelCheck?: true } & AccountArg)
  | ({ readonly name: 'retry' } & AccountArg)
  | ({ readonly name: 'import' } & ImportArgs)
  | { readonly name: 'accounts' }
  /** `msum whisper models`: the known models. `msum whisper download <name>`: one of them, verified. */
  | { readonly name: 'whisper'; readonly action: 'models' }
  | { readonly name: 'whisper'; readonly action: 'download'; readonly model: string }
  /** `msum secret set|rm <provider>` and `msum secret ls`: the API keys (the key itself is never an argument). */
  | ({ readonly name: 'secret'; readonly action: 'set' | 'rm'; readonly provider: KeyProvider } & AccountArg)
  | ({ readonly name: 'secret'; readonly action: 'ls' } & AccountArg)
  /** `msum provider ls`: what each provider is and whether it is usable here. */
  | ({ readonly name: 'provider'; readonly action: 'ls' } & AccountArg)
  /** `msum provider use <kind>`: choose it (RF-41), after telling what it receives (RNF-02). */
  | ({
      readonly name: 'provider'
      readonly action: 'use'
      readonly kind: ProviderInfoKind
      readonly model: string | null
      readonly backup: boolean
      readonly yes: boolean
      /** Only for `openai-compatible`. */
      readonly baseUrl: string | null
    } & AccountArg)
  /** `msum provider test`: one real call with a made-up conversation (RF-41, "test the connection"). */
  | ({
      readonly name: 'provider'
      readonly action: 'test'
      readonly backup: boolean
      readonly kind: ProviderInfoKind | null
    } & AccountArg)
  /** `msum ollama recommend [--all]`: the local models that fit this machine's RAM, for the user to choose (RF-45). */
  | { readonly name: 'ollama'; readonly action: 'recommend'; readonly all: boolean }
  /** `msum ollama pull <tag>`: download a model into the configured Ollama (RF-45). */
  | ({
      readonly name: 'ollama'
      readonly action: 'pull'
      readonly tag: string
      readonly allowRemote: boolean
    } & AccountArg)
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
  | { readonly kind: 'unknownProvider' }
  | { readonly kind: 'unknownProviderKind'; readonly value: string }

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
  'secret',
  'provider',
  'ollama',
] as const
/** The flags each command accepts (besides --help). */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  link: ['account'],
  unlink: ['yes', 'account'],
  daemon: ['retry', 'account'],
  digest: ['dry-run', 'from', 'to', 'hours', 'account'],
  status: ['account'],
  doctor: ['account', 'skip-model-check'],
  retry: ['account'],
  ollama: ['account', 'allow-remote', 'all'],
  secret: ['account'],
  provider: ['account', 'model', 'backup', 'yes', 'kind', 'base-url'],
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
  model: { type: 'string' },
  backup: { type: 'boolean' },
  kind: { type: 'string' },
  'base-url': { type: 'string' },
  'skip-model-check': { type: 'boolean' },
  'allow-remote': { type: 'boolean' },
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
  if (
    command !== 'schedule' &&
    command !== 'whisper' &&
    command !== 'secret' &&
    command !== 'provider' &&
    command !== 'ollama' &&
    rest.length > 0
  ) {
    return err({ kind: 'unexpectedArgument', value: rest[0] as string })
  }

  const accepted =
    command === 'schedule'
      ? (FLAGS.schedule ?? []).filter(
          (flag) => flag === 'account' || (rest[0] === 'add' && ['time', 'days'].includes(flag)),
        )
      : command === 'ollama'
        ? (FLAGS.ollama ?? []).filter((flag) =>
            rest[0] === 'pull'
              ? ['account', 'allow-remote'].includes(flag)
              : (rest[0] ?? 'recommend') === 'recommend' && flag === 'all',
          )
        : command === 'provider'
          ? (FLAGS.provider ?? []).filter(
              (flag) =>
                flag === 'account' ||
                (rest[0] === 'use' && ['model', 'backup', 'yes', 'base-url'].includes(flag)) ||
                (rest[0] === 'test' && ['backup', 'kind'].includes(flag)),
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
    case 'secret':
      return parseSecret(rest, account)
    case 'provider':
      return parseProvider(rest, values, account)
    case 'import':
      return parseImport(values, account)
    case 'ollama':
      return parseOllama(rest, values['allow-remote'] === true, values.all === true, account)
    case 'doctor':
      return ok(
        values['skip-model-check'] === true
          ? { name: 'doctor', skipModelCheck: true, account }
          : { name: 'doctor', account },
      )
    case 'link':
    case 'status':
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

/** `msum provider ls`, `msum provider use <kind> [--model m] [--backup] [--yes] [--base-url u]`, `msum provider test [--backup] [--kind k]`. */
function parseProvider(
  rest: readonly string[],
  values: {
    readonly model?: string | undefined
    readonly backup?: boolean | undefined
    readonly yes?: boolean | undefined
    readonly kind?: string | undefined
    readonly 'base-url'?: string | undefined
  },
  account: string | null,
): Result<Command, ArgError> {
  const [action = 'ls', ...more] = rest
  if (action !== 'ls' && action !== 'use' && action !== 'test') return err({ kind: 'unknownSubcommand', value: action })
  if (action === 'ls' || action === 'test') {
    if (more.length > 0) return err({ kind: 'unexpectedArgument', value: more[0] as string })
    if (action === 'ls') return ok({ name: 'provider', action: 'ls', account })
    let kind: ProviderInfoKind | null = null
    if (values.kind !== undefined) {
      if (!isProviderInfoKind(values.kind)) return err({ kind: 'unknownProviderKind', value: values.kind })
      kind = values.kind
    }
    if (kind !== null && values.backup === true) return err({ kind: 'conflictingOptions', value: '--kind' })
    return ok({ name: 'provider', action: 'test', backup: values.backup === true, kind, account })
  }
  const [kind, ...extra] = more
  if (kind === undefined || kind.trim() === '') return err({ kind: 'missingValue', value: '<provider>' })
  if (!isProviderInfoKind(kind)) return err({ kind: 'unknownProviderKind', value: kind })
  if (extra.length > 0) return err({ kind: 'unexpectedArgument', value: extra[0] as string })
  for (const flag of ['model', 'base-url'] as const) {
    if (values[flag] !== undefined && values[flag].trim() === '')
      return err({ kind: 'missingValue', value: `--${flag}` })
  }
  return ok({
    name: 'provider',
    action: 'use',
    kind,
    model: values.model ?? null,
    backup: values.backup === true,
    yes: values.yes === true,
    baseUrl: values['base-url'] ?? null,
    account,
  })
}

/** `msum ollama recommend` and `msum ollama pull <tag> [--allow-remote]`. */
function parseOllama(
  rest: readonly string[],
  allowRemote: boolean,
  all: boolean,
  account: string | null,
): Result<Command, ArgError> {
  const [action = 'recommend', ...more] = rest
  if (action !== 'recommend' && action !== 'pull') return err({ kind: 'unknownSubcommand', value: action })
  if (action === 'recommend') {
    if (more.length > 0) return err({ kind: 'unexpectedArgument', value: more[0] as string })
    return ok({ name: 'ollama', action: 'recommend', all })
  }
  const [tag, ...extra] = more
  if (tag === undefined || tag.trim() === '') return err({ kind: 'missingValue', value: '<tag>' })
  if (extra.length > 0) return err({ kind: 'unexpectedArgument', value: extra[0] as string })
  return ok({ name: 'ollama', action: 'pull', tag: tag.trim(), allowRemote, account })
}

/** All the kinds `msum provider` knows, for the message that lists them. */
export const PROVIDER_KIND_NAMES = PROVIDER_INFO_KINDS.join(', ')

/** `msum secret set|rm <provider>` and `msum secret ls`. The key is not an argument: it is read from the input. */
function parseSecret(rest: readonly string[], account: string | null): Result<Command, ArgError> {
  const [action = 'ls', ...more] = rest
  if (action !== 'set' && action !== 'rm' && action !== 'ls') return err({ kind: 'unknownSubcommand', value: action })
  if (action === 'ls') {
    if (more.length > 0) return err({ kind: 'unexpectedArgument', value: more[0] as string })
    return ok({ name: 'secret', action: 'ls', account })
  }
  const [provider, ...extra] = more
  if (provider === undefined || provider.trim() === '') return err({ kind: 'missingValue', value: '<provider>' })
  // The word is not echoed in the error: it may be the key itself, typed where the provider goes.
  if (!isKeyProvider(provider)) return err({ kind: 'unknownProvider' })
  // A second word could be somebody typing the key as an argument: it is refused, and never echoed back.
  if (extra.length > 0) return err({ kind: 'unexpectedArgument', value: '(...)' })
  return ok({ name: 'secret', action, provider, account })
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
