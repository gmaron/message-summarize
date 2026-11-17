import type { Catalog } from '../../infrastructure/i18n/index.js'
import {
  type AccountArg,
  type ArgError,
  type Command,
  type DigestArgs,
  type ImportArgs,
  parseCommandLine,
} from './args.js'

/** The `schedule` command with its subcommand. */
export type ScheduleCommand = Extract<Command, { name: 'schedule' }>

/** Where the CLI writes. A line is written with its newline. Tests give their own. */
export interface CliIo {
  out(line: string): void
  err(line: string): void
}

/** What each command does. Each returns the exit code. The composition root implements them. */
export interface CliHandlers {
  init(): Promise<number>
  link(args: AccountArg): Promise<number>
  unlink(args: { readonly yes: boolean } & AccountArg): Promise<number>
  daemon(args: { readonly retry: boolean } & AccountArg): Promise<number>
  digest(args: DigestArgs): Promise<number>
  status(args: AccountArg): Promise<number>
  doctor(args: AccountArg): Promise<number>
  retry(args: AccountArg): Promise<number>
  import(args: ImportArgs): Promise<number>
  accounts(): Promise<number>
  open(args: { readonly print: boolean }): Promise<number>
  schedule(command: ScheduleCommand): Promise<number>
}

export const EXIT_OK = 0
export const EXIT_FAILURE = 1
/** Wrong usage or an invalid configuration. */
export const EXIT_USAGE = 2

export function describeArgError(texts: Catalog['cli'], error: ArgError): string {
  const messages = texts.argErrors
  switch (error.kind) {
    case 'unknownCommand':
      return messages.unknownCommand(error.value)
    case 'unknownOption':
      return messages.unknownOption(error.value)
    case 'missingValue':
      return messages.missingValue(error.value)
    case 'unexpectedArgument':
      return messages.unexpectedArgument(error.value)
    case 'invalidNumber':
      return messages.invalidNumber(error.value)
    case 'invalidDate':
      return messages.invalidDate(error.value)
    case 'invalidAccountId':
      return messages.invalidAccountId(error.value)
    case 'unknownSubcommand':
      return messages.unknownSubcommand(error.value)
    case 'invalidTime':
      return messages.invalidTime(error.value)
    case 'invalidDays':
      return messages.invalidDays(error.value)
    case 'conflictingOptions':
      return messages.conflictingOptions(error.value)
  }
}

function dispatch(command: Exclude<Command, { name: 'help' }>, handlers: CliHandlers): Promise<number> {
  switch (command.name) {
    case 'init':
      return handlers.init()
    case 'link':
      return handlers.link({ account: command.account })
    case 'unlink':
      return handlers.unlink({ yes: command.yes, account: command.account })
    case 'daemon':
      return handlers.daemon({ retry: command.retry, account: command.account })
    case 'digest':
      return handlers.digest(command)
    case 'status':
      return handlers.status({ account: command.account })
    case 'doctor':
      return handlers.doctor({ account: command.account })
    case 'retry':
      return handlers.retry({ account: command.account })
    case 'import':
      return handlers.import(command)
    case 'accounts':
      return handlers.accounts()
    case 'open':
      return handlers.open({ print: command.print })
    case 'schedule':
      return handlers.schedule(command)
  }
}

/** Parses `argv` (without node and the script) and runs the command. Returns the exit code. */
export async function runCli(
  argv: readonly string[],
  handlers: CliHandlers,
  io: CliIo,
  texts: Catalog['cli'],
): Promise<number> {
  const parsed = parseCommandLine(argv)
  if (!parsed.ok) {
    io.err(describeArgError(texts, parsed.error))
    return EXIT_USAGE
  }
  const command = parsed.value
  if (command.name === 'help') {
    io.out(texts.usage)
    return EXIT_OK
  }
  return dispatch(command, handlers)
}
