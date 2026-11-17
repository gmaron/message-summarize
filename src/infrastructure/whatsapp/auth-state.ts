import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys'

/** RNF-04: the WhatsApp session is a credential. Only its owner can read it. */
export const AUTH_DIR_MODE = 0o700
export const AUTH_FILE_MODE = 0o600

export interface SecureAuthState {
  readonly state: AuthenticationState
  readonly saveCreds: () => Promise<void>
  /** Resolves when every pending write has finished. */
  readonly settle: () => Promise<void>
}

/** A temporary name no other writer (another instance, another process) can pick. */
export const temporaryName = (target: string): string => `${target}.${process.pid}.${randomUUID()}.tmp`

/** Same file names as Baileys' own multi-file store, so a session linked with it can be reused. */
const fileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Serializes the work on each file: reads and writes of one file never overlap. Module-level, so two states over the
 * same directory (a reconnection while the previous socket still writes) share it.
 */
const tails = new Map<string, Promise<unknown>>()

function runOnFile<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve()
  const result = previous.then(work, work)
  const tail = result.catch(() => undefined)
  tails.set(path, tail)
  void tail.then(() => {
    if (tails.get(path) === tail) tails.delete(path)
  })
  return result
}

/** Resolves when every write started so far, by any auth state, has finished. */
export async function settleAuthWrites(): Promise<void> {
  while (tails.size > 0) await Promise.all([...tails.values()])
}

/**
 * The authentication state of the WhatsApp session in a directory of JSON files (the format of Baileys' multi-file
 * store), with the permissions of RNF-04: the directory is created 0700 and every file is written 0600, through a
 * temporary file and a rename so a crash never leaves half a credential. Existing directories and files (from an
 * older version, or from another tool) are tightened when the state is loaded.
 *
 * It never logs and never prints a key.
 */
export async function loadSecureAuthState(directory: string): Promise<SecureAuthState> {
  const existing = await stat(directory).catch(() => null)
  if (existing !== null && !existing.isDirectory()) {
    throw new Error('The WhatsApp session path exists and is not a directory')
  }
  await mkdir(directory, { recursive: true, mode: AUTH_DIR_MODE })
  await chmod(directory, AUTH_DIR_MODE)
  for (const entry of await readdir(directory)) {
    await chmod(join(directory, entry), AUTH_FILE_MODE).catch(() => undefined)
  }

  const pathOf = (file: string): string => join(directory, fileName(file))

  const write = (file: string, data: unknown): Promise<void> => {
    const target = pathOf(file)
    return runOnFile(target, async () => {
      const temporary = temporaryName(target)
      await writeFile(temporary, JSON.stringify(data, BufferJSON.replacer), { mode: AUTH_FILE_MODE })
      await chmod(temporary, AUTH_FILE_MODE)
      await rename(temporary, target)
    })
  }
  const read = (file: string): Promise<unknown> => {
    const source = pathOf(file)
    return runOnFile(source, async () => {
      try {
        return JSON.parse(await readFile(source, 'utf-8'), BufferJSON.reviver) as unknown
      } catch {
        return null
      }
    })
  }
  const remove = (file: string): Promise<void> => {
    const target = pathOf(file)
    return runOnFile(target, () => unlink(target).catch(() => undefined))
  }

  const stored = (await read('creds.json')) as AuthenticationCreds | null
  const creds: AuthenticationCreds = stored ?? initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}.json`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value as object)
              }
              data[id] = value as SignalDataTypeMap[T]
            }),
          )
          return data
        },
        set: async (data: SignalDataSet) => {
          const tasks: Promise<void>[] = []
          for (const category of Object.keys(data) as (keyof SignalDataSet)[]) {
            const entries = data[category] ?? {}
            for (const id of Object.keys(entries)) {
              const value = entries[id]
              const file = `${category}-${id}.json`
              tasks.push(value ? write(file, value) : remove(file))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => write('creds.json', creds),
    settle: settleAuthWrites,
  }
}
