/**
 * Structured logs (RNF-12): one JSON object per line, with a level, an event name and a FIXED set of fields.
 *
 * Privacy (RNF-04, AGENTS.md): a log line never carries message text, conversation or contact names, transcripts,
 * phone numbers, keys or error messages (those can quote chat text or secrets). It carries codes, counts and times.
 * That is enforced here and not left to the callers: a field that is not in `FIELDS` is dropped, and a value must be a
 * short string, a number or a boolean. Events and fields are fixed English words; they are not translated.
 */

export type LogLevel = 'info' | 'warn' | 'error'

/** The only fields a log line may have. Each is a code, a count, a time or an identifier of the installation. */
const FIELDS = [
  'code',
  'state',
  'reason',
  'failure',
  'trigger',
  'schedule',
  'attempt',
  'delayMs',
  'count',
  'delivered',
  'summarized',
  'failed',
  'parts',
  'pointer',
  'nextRun',
  'pid',
  // The id of an account of the installation (a short name the user chose, validated: it is not a secret).
  'account',
] as const

export type LogField = (typeof FIELDS)[number]
export type LogFields = Partial<Record<LogField, string | number | boolean | null>>

const MAX_VALUE_LENGTH = 120
const allowed = new Set<string>(FIELDS)

export interface LogSink {
  write(text: string): unknown
}

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** Info goes to `out`; warnings and errors to `err`. */
export function createLogger(out: LogSink, err: LogSink, now: () => number = Date.now): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line: Record<string, unknown> = { time: new Date(now()).toISOString(), level, event }
    for (const [key, value] of Object.entries(fields)) {
      if (!allowed.has(key)) continue
      if (typeof value === 'string') line[key] = value.slice(0, MAX_VALUE_LENGTH)
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) line[key] = value
    }
    ;(level === 'info' ? out : err).write(`${JSON.stringify(line)}\n`)
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

/**
 * A logger whose lines all carry `fields` (the account of a unit of the daemon). The fields of a call win over them,
 * and the allowlist of the underlying logger still applies.
 */
export function scopedLogger(logger: Logger, fields: LogFields): Logger {
  return {
    info: (event, more) => logger.info(event, { ...fields, ...more }),
    warn: (event, more) => logger.warn(event, { ...fields, ...more }),
    error: (event, more) => logger.error(event, { ...fields, ...more }),
  }
}

/** A logger that writes nothing. */
export const silentLogger: Logger = { info() {}, warn() {}, error() {} }

/**
 * A fixed code for an error, safe to log: the system error code ("ENOENT", "SQLITE_BUSY") when it looks like one,
 * else the class name. Never the message.
 */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code
  return error instanceof Error ? error.name : 'unknown'
}
