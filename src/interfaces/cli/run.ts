import type { Catalog } from '../../infrastructure/i18n/index.js'
import { type ArgError, type Command, type DigestArgs, parseCommandLine } from './args.js'

/** Where the CLI writes. A line is written with its newline. Tests give their own. */
export interface CliIo {
  out(line: string): void
  err(line: string): void
}

/** What each command does. Each returns the exit code. The composition root implements them. */
export interface CliHandlers {
  init(): Promise<number>
  link(): Promise<number>
  unlink(args: { readonly yes: boolean }): Promise<number>
  daemon(args: { readonly retry: boolean }): Promise<number>
  digest(args: DigestArgs): Promise<number>
  status(): Promise<number>
  doctor(): Promise<number>
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
  }
}

function dispatch(command: Exclude<Command, { name: 'help' }>, handlers: CliHandlers): Promise<number> {
  switch (command.name) {
    case 'init':
      return handlers.init()
    case 'link':
      return handlers.link()
    case 'unlink':
      return handlers.unlink({ yes: command.yes })
    case 'daemon':
      return handlers.daemon({ retry: command.retry })
    case 'digest':
      return handlers.digest(command)
    case 'status':
      return handlers.status()
    case 'doctor':
      return handlers.doctor()
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
