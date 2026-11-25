import {
  InvalidSecretsFileError,
  isKeyProvider,
  isPlausibleKey,
  KEY_PROVIDERS,
  type KeyProvider,
  removeApiKey,
  resolveApiKey,
  storeApiKey,
} from '../../infrastructure/secrets/index.js'
import { HttpError, type Route } from '../../interfaces/http/router.js'
import { isObject } from '../config/config.js'
import { serialized } from '../config/config-writer.js'
import type { CommandContext } from '../context.js'
import { accountLayoutOf, ensureDataDirs } from '../installation/paths.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'

export interface KeysRoutesSource extends AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout' | 'env'>
}

/** The most a key may have: real keys are well under a kilobyte; anything bigger is a paste of something else. */
export const KEY_MAX_LENGTH = 4096

/**
 * The key typed in a body, trimmed. 400 `invalidKey` when it is not a string, is empty, is too long or is not one token
 * (see `isPlausibleKey`). The text of the key is never part of an error.
 */
export function readKey(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'invalidKey')
  const key = value.trim()
  if (key === '' || key.length > KEY_MAX_LENGTH || !isPlausibleKey(key)) throw new HttpError(400, 'invalidKey')
  return key
}

/** Where a key that exists comes from, as the API says it. Never the key, and never a path. */
export type KeyStatus =
  | { readonly present: false }
  | { readonly present: true; readonly source: 'env'; readonly name: string }
  | { readonly present: true; readonly source: 'accountFile' | 'file' }

/**
 * The key of a provider as the account sees it: the environment, then the account's own file, then the installation's.
 * Shared by the listing and by what the writes answer, so the page always hears what is really in force.
 */
function statusOf(source: KeysRoutesSource, id: string, provider: KeyProvider): KeyStatus {
  const found = resolveApiKey(provider, {
    env: source.ctx.env,
    accountFile: accountLayoutOf(source.ctx.layout, id).secretsFile,
    file: source.ctx.layout.secretsFile,
  })
  if (found === null) return { present: false }
  if (found.source.kind === 'env') return { present: true, source: 'env', name: found.source.name }
  return { present: true, source: found.source.kind }
}

/**
 * The API keys (RNF-04), stored the way `msum secret` stores them: in `<data directory>/secrets.json` (the installation's
 * file, mode 0600, written atomically), which every account uses unless it has a key of its own in
 * `accounts/<id>/secrets.json` (only the command line writes those: `msum secret set --account`) or an environment
 * variable names one. Every route is of an account (404 when unknown, 422 `restricted` when the daemon does not run it):
 * the writes go to the installation's file, and the answer says what the account has now.
 *
 * - `GET /api/accounts/:id/keys`: for each key provider (`openai`, `openai-compatible`, `anthropic`, `gemini`) whether the
 *   account has a key and where it comes from (`env` with the name of the variable, `accountFile` or `file`).
 * - `PUT /api/accounts/:id/keys/:provider` with `{ key }`: stores it in the installation's file. Answers
 *   `{ stored: true, key: KeyStatus, overriddenBy }`; `overriddenBy` is `env` or `accountFile` when the key in force for
 *   this account is not the one just stored, and null when it is.
 * - `DELETE /api/accounts/:id/keys/:provider`: removes it from the installation's file. Answers `{ removed, key: KeyStatus }`
 *   (the account may still have a key from the environment or its own file).
 *
 * The key is never in any answer, log or error: the page can only know that there is one.
 */
export function keysRoutes(source: KeysRoutesSource): Route[] {
  const { ctx, host } = source
  /** The account of the path (404, or 422 `restricted` when this daemon does not run it) and, when asked, the provider. */
  function target(params: Readonly<Record<string, string>>, withProvider: false): { id: string }
  function target(params: Readonly<Record<string, string>>): { id: string; provider: KeyProvider }
  function target(
    params: Readonly<Record<string, string>>,
    withProvider = true,
  ): { id: string; provider?: KeyProvider } {
    const id = knownAccount(source, params)
    if (host.onlyAccountId !== null && host.onlyAccountId !== id) throw new HttpError(422, 'restricted')
    if (!withProvider) return { id }
    const name = params.provider ?? ''
    if (!isKeyProvider(name)) throw new HttpError(404, 'notFound')
    return { id, provider: name }
  }
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      // A secrets file that is not a JSON object is never overwritten: the user fixes it (its path stays out of the answer).
      if (error instanceof InvalidSecretsFileError) throw new HttpError(409, 'invalidSecretsFile')
      throw error
    }
  }
  return [
    {
      method: 'GET',
      path: '/api/accounts/:id/keys',
      handler: async ({ params }) => {
        const { id } = target(params, false)
        const keys: Record<string, KeyStatus> = {}
        for (const provider of KEY_PROVIDERS) keys[provider] = statusOf(source, id, provider)
        return { body: { keys } }
      },
    },
    {
      method: 'PUT',
      path: '/api/accounts/:id/keys/:provider',
      handler: async ({ params, body }) => {
        const { id, provider } = target(params)
        if (!isObject(body)) throw new HttpError(400, 'invalidRequest')
        const key = readKey(body.key)
        await guarded(() =>
          serialized('secrets', async () => {
            await ensureDataDirs(ctx.layout)
            await storeApiKey(ctx.layout.secretsFile, provider, key)
          }),
        )
        const status = statusOf(source, id, provider)
        const overriddenBy = status.present && status.source !== 'file' ? status.source : null
        return { body: { stored: true, key: status, overriddenBy } }
      },
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/keys/:provider',
      handler: async ({ params }) => {
        const { id, provider } = target(params)
        const removed = await guarded(() => serialized('secrets', () => removeApiKey(ctx.layout.secretsFile, provider)))
        return { body: { removed, key: statusOf(source, id, provider) } }
      },
    },
  ]
}
