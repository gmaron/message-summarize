import { parseArgs as nodeParseArgs } from 'node:util'
import { isValidAccountId } from '../../domain/account-id.js'
import { err, ok, type Result } from '../../domain/result.js'
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

export type Command =
  | { readonly name: 'help' }
  | { readonly name: 'init' }
  | ({ readonly name: 'link' } & AccountArg)
  | ({ readonly name: 'unlink'; readonly yes: boolean } & AccountArg)
  | ({ readonly name: 'daemon'; readonly retry: boolean } & AccountArg)
  | ({ readonly name: 'digest' } & DigestArgs)
  | ({ readonly name: 'status' } & AccountArg)
  | ({ readonly name: 'doctor' } & AccountArg)
  | { readonly name: 'accounts' }

/** Why the arguments are wrong. Codes with the offending text: `cli.argErrors` explains each one. */
export type ArgError =
  | { readonly kind: 'unknownCommand'; readonly value: string }
  | { readonly kind: 'unknownOption'; readonly value: string }
  | { readonly kind: 'missingValue'; readonly value: string }
  | { readonly kind: 'unexpectedArgument'; readonly value: string }
  | { readonly kind: 'invalidNumber'; readonly value: string }
  | { readonly kind: 'invalidDate'; readonly value: string }
  | { readonly kind: 'invalidAccountId'; readonly value: string }

const COMMANDS = ['init', 'link', 'unlink', 'daemon', 'digest', 'status', 'doctor', 'accounts'] as const
/** The flags each command accepts (besides --help). */
const FLAGS: Readonly<Record<string, readonly string[]>> = {
  link: ['account'],
  unlink: ['yes', 'account'],
  daemon: ['retry', 'account'],
  digest: ['dry-run', 'from', 'to', 'hours', 'account'],
  status: ['account'],
  doctor: ['account'],
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
  if (rest.length > 0) return err({ kind: 'unexpectedArgument', value: rest[0] as string })

  const accepted = FLAGS[command] ?? []
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
    case 'link':
    case 'status':
    case 'doctor':
      return ok({ name: command, account })
    default:
      return ok({ name: command as 'init' | 'accounts' })
  }
}
