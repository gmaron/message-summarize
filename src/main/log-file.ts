import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { DIR_MODE, FILE_MODE, firstNotRealDirectory, NotARealDirectoryError } from './paths.js'

export const LOG_FILE_NAME = 'daemon.log'
export const LOG_ROTATED_NAME = 'daemon.log.1'

/** How long lines wait to be written together. Short enough to lose little in a crash, long enough to batch a burst. */
const FLUSH_MS = 100
/** The most that may wait in memory for the disk. Beyond it a line is dropped and counted (a disk that stalls cannot grow the process). */
export const MAX_QUEUE_BYTES = 1_048_576
/** How long `close()` waits for the disk before giving up on what is still queued (the shutdown has a budget). */
export const CLOSE_TIMEOUT_MS = 1_500

/** Never follow a link at the last component of a log file (a link there would make us write somewhere else). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW

export interface LogFileOptions {
  /** `<dataDir>/logs`. */
  readonly dir: string
  /** The most the two files may take together. Each holds at most half of it. */
  readonly maxBytes: number
  /** For tests. */
  readonly flushMs?: number
  readonly closeTimeoutMs?: number
  readonly maxQueueBytes?: number
  /** Called before each batch is written. For tests: they make the disk slow. */
  readonly beforeWrite?: () => Promise<void>
}

export interface LogFile {
  /** Queues a line (with its newline). Never throws and never waits for the disk. */
  write(text: string): void
  /** Writes what is queued. Resolves when it is on disk (or has been counted as lost). */
  flush(): Promise<void>
  /** Flushes, waiting at most `closeTimeoutMs`, and stops: later writes are ignored. */
  close(): Promise<void>
  /** Lines that could not be written (a full disk, a directory that went away, a queue that was full). Lost, never retried. */
  readonly lost: number
}

/**
 * The daemon's log file (RNF-12): `logs/daemon.log`, which becomes `daemon.log.1` (replacing the old one) when the next
 * line would take it over `maxBytes / 2`, so the two never add up to more than `maxBytes`. Directory 0700, files 0600.
 *
 * Throws `NotARealDirectoryError` when `logs/` (or a log file) is a link or not a regular file: nothing is created or
 * tightened through a link, and the files are opened without following one.
 *
 * Writing is asynchronous and batched: `write` only queues. A failed write (disk full, permissions) loses the lines of
 * that batch and counts them in `lost`: it does not throw, it does not log (a log about the log would loop) and the
 * next batch tries again. A failed rotation keeps the size, so the next line tries again, and lines are dropped rather
 * than let the file pass its half. A line cut in half by a crash is closed with a newline before anything new is appended.
 */
export async function openLogFile(options: LogFileOptions): Promise<LogFile> {
  const { dir, maxBytes } = options
  const half = Math.floor(maxBytes / 2)
  const file = join(dir, LOG_FILE_NAME)
  const rotated = join(dir, LOG_ROTATED_NAME)
  const maxQueue = options.maxQueueBytes ?? MAX_QUEUE_BYTES
  let lost = 0
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue: string[] = []
  let queuedBytes = 0
  let running: Promise<void> = Promise.resolve()
  // What the file holds on disk; null while it is not known (the next batch finds out). Only `apply` changes it.
  let disk: number | null = 0
  let needNewline = false

  const bad = await firstNotRealDirectory([dir])
  if (bad !== null) throw new NotARealDirectoryError(bad)

  const prepare = async (): Promise<void> => {
    const notReal = await firstNotRealDirectory([dir])
    if (notReal !== null) throw new NotARealDirectoryError(notReal)
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    await chmod(dir, DIR_MODE).catch(() => undefined)
  }

  /** The size of the log file on disk: 0 when it does not exist; throws when it is a link or not a regular file. */
  const sizeOnDisk = async (): Promise<number> => {
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info === null) return 0
    if (!info.isFile()) throw new NotARealDirectoryError(file)
    return info.size
  }

  try {
    await prepare()
  } catch (error) {
    if (error instanceof NotARealDirectoryError) throw error
    // anything else: the first batch tries again
  }
  try {
    disk = await sizeOnDisk()
  } catch (error) {
    if (error instanceof NotARealDirectoryError) throw error
    disk = null
  }
  if (disk !== null && disk > 0) {
    // The last line may have been cut by a crash: if it is not closed (or cannot be told), a newline closes it.
    needNewline = true
    try {
      const handle = await open(file, constants.O_RDONLY | NOFOLLOW)
      try {
        const last = Buffer.alloc(1)
        await handle.read(last, 0, 1, disk - 1)
        needNewline = last[0] !== 0x0a
      } finally {
        await handle.close()
      }
    } catch {
      // unreadable: keep the newline
    }
  }

  /** Appends text and returns whether it is on disk. Never throws. */
  const append = async (text: string): Promise<boolean> => {
    const write = async (): Promise<void> => {
      const handle = await open(file, APPEND_FLAGS, FILE_MODE)
      try {
        // fchmod: through the open handle, never through a path that could be a link
        await handle.chmod(FILE_MODE).catch(() => undefined)
        await handle.appendFile(text)
      } finally {
        await handle.close()
      }
    }
    try {
      try {
        await write()
      } catch (error) {
        // The directory may have been removed meanwhile: one more try after making it again.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await prepare()
        await write()
      }
      return true
    } catch {
      return false
    }
  }

  const apply = async (lines: readonly string[]): Promise<void> => {
    if (options.beforeWrite !== undefined) await options.beforeWrite().catch(() => undefined)
    if (disk === null) {
      try {
        disk = await sizeOnDisk()
      } catch {
        lost += lines.length
        return
      }
    }
    let buffer = ''
    let bufferBytes = 0
    let count = 0
    const writeBuffer = async (): Promise<void> => {
      if (count === 0) return
      const text = needNewline ? `\n${buffer}` : buffer
      if (await append(text)) {
        disk = (disk ?? 0) + Buffer.byteLength(text)
        needNewline = false
      } else {
        lost += count
        // what the failed write left behind is not known: look again before the next decision
        disk = await sizeOnDisk().catch(() => null)
        if (disk === null) needNewline = true
      }
      buffer = ''
      bufferBytes = 0
      count = 0
    }
    for (const line of lines) {
      const bytes = Buffer.byteLength(line)
      if (disk !== null && disk + bufferBytes > 0 && disk + bufferBytes + bytes > half) {
        await writeBuffer()
        if (disk === null) {
          disk = await sizeOnDisk().catch(() => null)
          if (disk === null) {
            lost += 1
            continue
          }
        }
        if (disk > 0 && disk + bytes > half) {
          try {
            await rename(file, rotated)
            disk = 0
            needNewline = false
          } catch {
            // The size stays, so the next line tries again; this one is dropped rather than pass the bound.
            lost += 1
            continue
          }
        }
      }
      buffer += line
      bufferBytes += bytes
      count += 1
    }
    await writeBuffer()
  }

  const schedule = (): void => {
    if (timer !== null || closed) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, options.flushMs ?? FLUSH_MS)
    timer.unref()
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const lines = queue
    queue = []
    if (lines.length > 0) {
      const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0)
      running = running.then(() =>
        apply(lines)
          .catch(() => {
            lost += lines.length
          })
          .finally(() => {
            queuedBytes -= bytes
          }),
      )
    }
    return running
  }

  return {
    write(text) {
      if (closed) return
      const bytes = Buffer.byteLength(text)
      if (queuedBytes + bytes > maxQueue) {
        lost += 1
        return
      }
      queuedBytes += bytes
      queue.push(text)
      schedule()
    },
    flush,
    async close() {
      const budget = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS
      let giveUp: ReturnType<typeof setTimeout> | undefined
      const gaveUp = new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, budget)
        giveUp.unref()
      })
      try {
        await Promise.race([flush(), gaveUp])
      } finally {
        clearTimeout(giveUp)
        closed = true
      }
    },
    get lost() {
      return lost
    },
  }
}
