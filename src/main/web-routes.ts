import { DEFAULT_ACCOUNT_ID, isValidAccountId } from '../domain/account-id.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import type { Installation } from './accounts.js'
import type { CommandContext } from './context.js'
import type { DaemonHost } from './daemon-host.js'
import { accountLayoutOf, unsafeAccountPath } from './paths.js'

export interface AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout'>
  readonly installation: Installation
  readonly host: DaemonHost
}

/** The account named in the path, or a 404: an id that is not valid is never looked up, let alone used as a path. */
function knownAccount(source: AccountRoutesSource, params: Readonly<Record<string, string>>): string {
  const id = params.id ?? ''
  if (!isValidAccountId(id) || !source.installation.accounts().some((row) => row.id === id)) {
    throw new HttpError(404, 'notFound')
  }
  return id
}

/**
 * The routes that change accounts (RF-01, RF-03, RF-04): create one, link it by scanning a QR (the daemon does the
 * linking, see `DaemonHost.startLink`), cancel that, and clear a block that retrying fixes. They answer with codes the
 * web translates; none of them returns a number, a name or a message.
 */
export function accountRoutes(source: AccountRoutesSource): Route[] {
  const { host, installation } = source
  /** Ids being created right now: two requests for the same id never both get to create it. */
  const creating = new Set<string>()
  return [
    {
      // The same creation `msum link` does for a new account (`Installation.createAccount`, after the same check of the
      // path), with the id `default` when none is given.
      method: 'POST',
      path: '/api/accounts',
      handler: async ({ body }) => {
        if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body))) {
          throw new HttpError(400, 'invalidRequest')
        }
        const given = (body as { id?: unknown } | undefined)?.id
        if (given !== undefined && typeof given !== 'string') throw new HttpError(400, 'invalidRequest')
        const id = given ?? DEFAULT_ACCOUNT_ID
        if (!isValidAccountId(id)) throw new HttpError(400, 'invalidAccountId')
        if (host.isStopping) throw new HttpError(503, 'unavailable')
        // An account this daemon does not run could not be linked (its link would be a 404): not created.
        if (host.onlyAccountId !== null && host.onlyAccountId !== id) throw new HttpError(422, 'restricted')
        if (installation.accounts().some((row) => row.id === id) || creating.has(id)) {
          throw new HttpError(409, 'accountExists')
        }
        creating.add(id)
        try {
          if ((await unsafeAccountPath(accountLayoutOf(source.ctx.layout, id))) !== null) {
            throw new HttpError(409, 'accountExists')
          }
          await installation.createAccount(id)
        } finally {
          creating.delete(id)
        }
        void host.reconcile()
        return { status: 201, body: { id } }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/link',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const started = await host.startLink(id)
        if (started.ok) return { status: 202, body: { state: 'waitingQr' } }
        switch (started.reason) {
          case 'unknown':
            throw new HttpError(404, 'notFound')
          case 'unavailable':
            throw new HttpError(503, 'unavailable')
          case 'invalidConfig':
            throw new HttpError(422, 'invalidConfig')
          case 'unsafePath':
            throw new HttpError(500, 'internal')
          case 'cancelled':
            throw new HttpError(409, 'notLinking')
          default:
            throw new HttpError(409, started.reason)
        }
      },
    },
    {
      // What a page that (re)connects needs to show the current QR without waiting for the next one.
      method: 'GET',
      path: '/api/accounts/:id/link',
      handler: ({ params }) => {
        const id = knownAccount(source, params)
        const snapshot = host.linkSnapshot(id)
        return { body: snapshot ?? { state: 'idle' } }
      },
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/link',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        if (!(await host.cancelLink(id))) throw new HttpError(409, 'notLinking')
        return { body: { ok: true } }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/retry',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const retried = await host.retryAccount(id)
        if (retried.ok) return { body: { ok: true } }
        switch (retried.reason) {
          case 'unknown':
            throw new HttpError(404, 'notFound')
          case 'unsafePath':
            throw new HttpError(500, 'internal')
          default:
            throw new HttpError(409, retried.reason)
        }
      },
    },
  ]
}
