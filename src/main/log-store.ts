import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { LOG_FILE_NAME, LOG_ROTATED_NAME } from './log-file.js'
import { type LogLevel, type LogRecord, parseLogLine } from './logger.js'

export const DEFAULT_LOG_CAPACITY = 5_000
/** The most read from the end of each file to fill the buffer at startup (about 5 000 lines of 300 bytes, doubled). */
const SEED_TAIL_BYTES = 2 * 1024 * 1024

/** One line of the log as the web shows it. `seq` grows by one for every line since the daemon started. */
export interface LogEntry {
  readonly seq: number
  readonly time: string
  readonly level: LogLevel
  readonly event: string
  /** The account the line is about; absent for the lines of the installation itself. */
  readonly account?: string
  /** The rest of the allowed fields. */
  readonly fields: Readonly<Record<string, string | number | boolean | null>>
}

export interface LogQuery {
  /** The lowest level shown: `warn` shows warnings and errors. */
  readonly level?: LogLevel
  /** An account id; `null` asks for the lines that have none (the installation's). Undefined: all. */
  readonly account?: string | null
  readonly limit: number
  /** Only lines older than this `seq`. */
  readonly before?: number
}

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 }

function toEntry(seq: number, record: LogRecord): LogEntry {
  const { time, level, event, account, ...rest } = record
  const fields = rest as Record<string, string | number | boolean | null>
  return {
    seq,
    time: time as string,
    level: level as LogLevel,
    event: event as string,
    ...(typeof account === 'string' ? { account } : {}),
    fields,
  }
}

/** The last bytes of a file as lines, without the first one when the read started in the middle of it. */
async function tailLines(file: string): Promise<string[]> {
  try {
    // A link or anything that is not a regular file is not read.
    const info = await lstat(file)
    if (!info.isFile() || info.size === 0) return []
    const length = Math.min(info.size, SEED_TAIL_BYTES)
    const start = info.size - length
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
      if (start > 0) lines.shift()
      return lines
    } finally {
      await handle.close()
    }
  } catch {
    // missing or unreadable (another owner, mode 000): an empty history, never a reason not to start
    return []
  }
}

/**
 * The last lines the daemon logged, in memory (RF-75). At startup it is filled from the tail of the log files (the
 * rotated one first), so a restart does not empty the page; after that, every line the daemon logs is added. Lines that
 * do not parse (a half-written last line) are skipped. The oldest lines are dropped beyond `capacity`.
 */
export class LogStore {
  private readonly entries: LogEntry[] = []
  private nextSeq = 1
  /** Tells this run of the daemon from another: `seq` starts again at 1 on each, so a page that sees it change starts over. */
  readonly boot: string = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  private readonly listeners = new Set<(seq: number) => void>()

  constructor(private readonly capacity: number = DEFAULT_LOG_CAPACITY) {}

  /** Reads the log files in `dir`. A missing or unreadable file is just an empty history. */
  async seed(dir: string): Promise<void> {
    const lines = [...(await tailLines(join(dir, LOG_ROTATED_NAME))), ...(await tailLines(join(dir, LOG_FILE_NAME)))]
    for (const line of lines) {
      const record = line === '' ? null : parseLogLine(line)
      if (record !== null) this.add(record, false)
    }
  }

  /** Adds a line. `notify` is false while seeding. */
  add(record: LogRecord, notify = true): void {
    const seq = this.nextSeq++
    this.entries.push(toEntry(seq, record))
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    if (notify) for (const listener of [...this.listeners]) listener(seq)
  }

  /** Calls `listener` with the `seq` of every line added from now on. */
  subscribe(listener: (seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The lines that match, newest first, at most `limit`. */
  query(query: LogQuery): LogEntry[] {
    const minimum = RANK[query.level ?? 'info']
    const found: LogEntry[] = []
    for (let index = this.entries.length - 1; index >= 0 && found.length < query.limit; index--) {
      const entry = this.entries[index] as LogEntry
      if (query.before !== undefined && entry.seq >= query.before) continue
      if (RANK[entry.level] < minimum) continue
      if (query.account !== undefined && (entry.account ?? null) !== query.account) continue
      found.push(entry)
    }
    return found
  }
}
