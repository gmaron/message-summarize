import { join } from 'node:path'
import { type LogFile, openLogFile } from './log-file.js'
import { LogStore } from './log-store.js'
import { isTappable, type Logger, teeLogger } from './logger.js'
import { type DataLayout, NotARealDirectoryError } from './paths.js'

export const LOGS_DIR_NAME = 'logs'

export const logsDirOf = (layout: Pick<DataLayout, 'dataDir'>): string => join(layout.dataDir, LOGS_DIR_NAME)

export interface DaemonLogs {
  /** Does what the base logger does (stdout and stderr, unchanged) and also keeps the line in the file and the store. */
  readonly logger: Logger
  readonly store: LogStore
  /** Stops tapping the base logger and writes what is queued (within a budget). */
  close(): Promise<void>
}

/**
 * The daemon's log (RNF-12, RF-75): every line that goes to stdout or stderr also goes, through the same allowlist, to
 * `<dataDir>/logs/daemon.log` (rotated by size) and to an in-memory buffer seeded from what the files already hold.
 * Nothing is logged that was not before. Only the daemon calls this: the other commands keep stdout and stderr only.
 *
 * Logging never stops the daemon: when the file cannot be used (`logs/` is a link, the disk or the permissions refuse)
 * it says so once on stderr and carries on with the web's in-memory buffer only. When `base` is the process logger
 * (tappable), the lines of the process guards and of the crash handler are tapped too, and the tap is removed on close.
 */
export async function startDaemonLogs(
  base: Logger,
  layout: Pick<DataLayout, 'dataDir'>,
  maxBytes: number,
  options: { readonly now?: () => number; readonly closeTimeoutMs?: number } = {},
): Promise<DaemonLogs> {
  const dir = logsDirOf(layout)
  let file: LogFile | null = null
  let readable = true
  try {
    file = await openLogFile({
      dir,
      maxBytes,
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    })
  } catch (error) {
    const unsafe = error instanceof NotARealDirectoryError
    // A link is not read either: the history would come from somewhere else.
    if (unsafe) readable = false
    base.warn('logs.fileDisabled', { reason: unsafe ? 'unsafePath' : 'failed' })
  }
  const store = new LogStore()
  if (readable) await store.seed(dir).catch(() => undefined)
  const tap = (record: Parameters<typeof store.add>[0]): void => {
    file?.write(`${JSON.stringify(record)}\n`)
    store.add(record)
  }
  if (isTappable(base)) {
    base.setTap(tap)
    return {
      logger: base,
      store,
      close: async () => {
        base.setTap(null)
        await file?.close()
      },
    }
  }
  return {
    logger: teeLogger(base, tap, options.now ?? Date.now),
    store,
    close: async () => {
      await file?.close()
    },
  }
}
