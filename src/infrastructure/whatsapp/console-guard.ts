/**
 * RNF-04: libsignal (a dependency of Baileys) prints Signal session records, which include private keys, straight to
 * the console ("Opening session:", "Closing session:", ...), and Baileys prints some errors the same way. None of it
 * goes through the Baileys logger, so silencing the logger does not stop it. This guard drops exactly those calls.
 *
 * It drops a call only when its FIRST argument is a string that starts with one of the fixed messages below. Anything
 * else passes through untouched. It is installed once (idempotent) when the adapter loads.
 */
export const DROPPED_PREFIXES: readonly string[] = [
  'Opening session',
  'Closing session',
  'Session already',
  'Removing old closed session',
  'Failed to decrypt',
  'Session error',
  'Decrypted message with closed session',
  'Closing open session in favor',
  'Migrating session',
  'V1 session storage',
  'WARNING: Expected pubkey',
  'Unhandled bucket type',
  'Error parsing group metadata',
]

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
const GUARDED = Symbol.for('message-summarize.console-guard')

type Method = (typeof METHODS)[number]
type Guarded = ((...args: unknown[]) => void) & { [GUARDED]?: true }

export const isDropped = (args: readonly unknown[]): boolean =>
  typeof args[0] === 'string' && DROPPED_PREFIXES.some((prefix) => (args[0] as string).startsWith(prefix))

/** Wraps the console methods once. Calling it again changes nothing. */
export function installConsoleGuard(target: Pick<Console, Method> = console): void {
  for (const method of METHODS) {
    const original = target[method] as Guarded
    if (original[GUARDED]) continue
    const guarded: Guarded = function (this: unknown, ...args: unknown[]): void {
      if (isDropped(args)) return
      original.apply(target, args)
    }
    guarded[GUARDED] = true
    target[method] = guarded as Console[Method]
  }
}

installConsoleGuard()
