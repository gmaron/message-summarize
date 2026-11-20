import { readFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** The providers that need an API key. */
export const KEY_PROVIDERS = ['openai', 'openai-compatible', 'anthropic', 'gemini'] as const
export type KeyProvider = (typeof KEY_PROVIDERS)[number]

export const isKeyProvider = (value: string): value is KeyProvider =>
  (KEY_PROVIDERS as readonly string[]).includes(value)

/**
 * The environment variable a key may come from. `openai` is the user's key for OpenAI itself (`OPENAI_API_KEY`), and
 * `openai-compatible` is the key of any other server behind `provider.openai.baseUrl` (LM Studio, OpenRouter...;
 * `MSUM_OPENAI_API_KEY`). They are separate names, in the files too, so the OpenAI key is never sent to another server
 * because `baseUrl` points there. Which one a configuration uses is decided by its `baseUrl` (see `openAiKeyProvider`).
 */
export function envNames(provider: KeyProvider): readonly string[] {
  switch (provider) {
    case 'openai':
      return ['OPENAI_API_KEY']
    case 'openai-compatible':
      return ['MSUM_OPENAI_API_KEY']
    case 'anthropic':
      return ['ANTHROPIC_API_KEY']
    case 'gemini':
      return ['GEMINI_API_KEY']
  }
}

/** A key is one token: no spaces, line breaks or control characters (a pasted line with extra text would never work). */
export const isPlausibleKey = (key: string): boolean => !/[\s\p{Cc}]/u.test(key)

/** Where a key comes from. Never carries the key. */
export type KeySource =
  | { readonly kind: 'env'; readonly name: string }
  | { readonly kind: 'accountFile'; readonly file: string }
  | { readonly kind: 'file'; readonly file: string }

export interface KeyLookup {
  readonly env: NodeJS.ProcessEnv
  /** `accounts/<id>/secrets.json`, when the lookup is for an account. */
  readonly accountFile?: string | undefined
  /** `<data directory>/secrets.json`. */
  readonly file: string
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** The keys stored in a secrets file. A missing or unreadable file has none (it is not an error to have no keys). */
export function readKeysSync(file: string): Partial<Record<KeyProvider, string>> {
  try {
    return keysOf(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

function keysOf(json: unknown): Partial<Record<KeyProvider, string>> {
  const keys: Partial<Record<KeyProvider, string>> = {}
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return keys
  for (const provider of KEY_PROVIDERS) {
    const value = (json as Record<string, unknown>)[provider]
    if (nonEmpty(value)) keys[provider] = value
  }
  return keys
}

/**
 * The key of a provider and where it comes from (RNF-04). Precedence: the environment, then the secrets file of the
 * account, then the one of the installation. Null when there is none.
 */
export function resolveApiKey(
  provider: KeyProvider,
  lookup: KeyLookup,
): { readonly key: string; readonly source: KeySource } | null {
  for (const name of envNames(provider)) {
    const value = lookup.env[name]
    if (nonEmpty(value)) return { key: value.trim(), source: { kind: 'env', name } }
  }
  if (lookup.accountFile !== undefined) {
    const key = readKeysSync(lookup.accountFile)[provider]
    if (key !== undefined) return { key, source: { kind: 'accountFile', file: lookup.accountFile } }
  }
  const key = readKeysSync(lookup.file)[provider]
  return key === undefined ? null : { key, source: { kind: 'file', file: lookup.file } }
}

/** The secrets file exists but is not a JSON object: it is never overwritten, the user fixes it. */
export class InvalidSecretsFileError extends Error {
  constructor(readonly file: string) {
    super('invalid secrets file')
    this.name = 'InvalidSecretsFileError'
  }
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const json: unknown = JSON.parse(raw)
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) return json as Record<string, unknown>
  } catch {
    // falls through
  }
  throw new InvalidSecretsFileError(file)
}

/** Which providers have a key in a secrets file (never the keys). */
export async function listStoredProviders(file: string): Promise<KeyProvider[]> {
  const keys = keysOf(await readObject(file))
  return KEY_PROVIDERS.filter((provider) => keys[provider] !== undefined)
}

/** Writes the whole file atomically with mode 0600: a temporary file in the same directory, then a rename. */
async function writeObject(file: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(file), `.secrets-${process.pid}-${Date.now()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Stores the key of a provider in a secrets file, keeping the other keys of the file. */
export async function storeApiKey(file: string, provider: KeyProvider, key: string): Promise<void> {
  const data = await readObject(file)
  await writeObject(file, { ...data, [provider]: key })
}

/** Removes the key of a provider. False when there was none. */
export async function removeApiKey(file: string, provider: KeyProvider): Promise<boolean> {
  const data = await readObject(file)
  if (!nonEmpty(data[provider])) return false
  const { [provider]: _removed, ...rest } = data
  await writeObject(file, rest)
  return true
}
