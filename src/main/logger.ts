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
  // Counts of a web request ("Ask"): conversations in the period, the page start, read, answered and left out.
  'candidates',
  'offset',
  'consulted',
  'answered',
  'skipped',
  'nextRun',
  'pid',
  // Which adapter event or step a warning is about: a fixed word, never an id.
  'wsEvent',
  'step',
  // Counters of the capture (capture.stats): numbers of events received, stored and dropped by reason.
  'evMessagesUpsert',
  'evHistorySet',
  'evMessagesUpdate',
  'evOther',
  'upsertBatches',
  'upsertMessages',
  'historyMessages',
  'stored',
  'edited',
  'editedByUpdate',
  'droppedNoKey',
  'droppedNoMessage',
  'droppedNotLocated',
  'droppedNoContent',
  'droppedNoTimestamp',
  'droppedNotParsed',
  'droppedDuplicateEdit',
  'ignoredChat',
  'ownChat',
  'itemFailed',
  'eventTimeout',
  'eventFailed',
  // Progress of the audio queues (`transcription.stats`): counts only.
  'pending',
  'downloading',
  'running',
  'done',
  'failed',
  'reuploadRequested',
  // Where the local web listens: an address and a port, never a token.
  'host',
  'port',
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

export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']

/** One log line as an object: `time`, `level`, `event` and the allowed fields, in that order. */
export type LogRecord = Record<string, unknown>

/** Builds the line of a log call. The only place that applies the allowlist and the limits of values. */
export function buildLogRecord(level: LogLevel, event: string, fields: LogFields, epochMs: number): LogRecord {
  const line: LogRecord = { time: new Date(epochMs).toISOString(), level, event }
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue
    if (typeof value === 'string') line[key] = value.slice(0, MAX_VALUE_LENGTH)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) line[key] = value
  }
  return line
}

/** Info goes to `out`; warnings and errors to `err`. */
export function createLogger(out: LogSink, err: LogSink, now: () => number = Date.now): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line = buildLogRecord(level, event, fields, now())
    ;(level === 'info' ? out : err).write(`${JSON.stringify(line)}\n`)
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

/** A logger whose lines can also be handed to one observer at a time (the daemon's log file and the web's view). */
export interface TappableLogger extends Logger {
  /** Sets (or, with null, removes) the observer. It gets every line that already went through the allowlist. */
  setTap(tap: ((line: LogRecord) => void) | null): void
}

export const isTappable = (logger: Logger): logger is TappableLogger =>
  typeof (logger as Partial<TappableLogger>).setTap === 'function'

/**
 * Like `createLogger`, with an observer that can be set and removed while the process runs. The process guards and the
 * commands hold this one object, so what the daemon starts to keep (a file) also gets the fatal errors they log.
 * An observer that throws never reaches the caller of the log.
 */
export function createTappableLogger(out: LogSink, err: LogSink, now: () => number = Date.now): TappableLogger {
  let tap: ((line: LogRecord) => void) | null = null
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line = buildLogRecord(level, event, fields, now())
    ;(level === 'info' ? out : err).write(`${JSON.stringify(line)}\n`)
    try {
      tap?.(line)
    } catch {
      // a log must never break what it reports on
    }
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    setTap: (next) => {
      tap = next
    },
  }
}

/**
 * A logger that does what `base` does and also hands every line (already through the allowlist) to `tap`: the daemon's
 * log file and the web's view of it. A tap that throws never reaches the caller of the log.
 */
export function teeLogger(base: Logger, tap: (line: LogRecord) => void, now: () => number = Date.now): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    base[level](event, fields)
    try {
      tap(buildLogRecord(level, event, fields ?? {}, now()))
    } catch {
      // a log must never break what it reports on
    }
  }
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  }
}

/**
 * A line of a log file read back. Null when it is not one of ours (not JSON, a line cut in half by a crash, missing
 * its time, level or event). What is not in the allowlist is dropped again: the file is not trusted more than a log call.
 */
export function parseLogLine(text: string): LogRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const { time, level, event } = raw
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) return null
  if (typeof level !== 'string' || !LOG_LEVELS.includes(level as LogLevel)) return null
  if (typeof event !== 'string' || event === '' || event.length > 200) return null
  return buildLogRecord(level as LogLevel, event, raw as LogFields, Date.parse(time))
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
