import { DEFAULT_ACCOUNT_ID, isValidAccountId } from '../../domain/account-id.js'
import { HttpError, type Route } from '../../interfaces/http/router.js'
import type { CommandContext } from '../context.js'
import type { DaemonHost } from '../daemon/host.js'
import type { Installation } from '../installation/accounts.js'
import { accountLayoutOf, unsafeAccountPath } from '../installation/paths.js'
import { qrAsSvg } from '../link/qr.js'

export interface AccountRoutesSource {
  readonly ctx: Pick<CommandContext, 'layout'>
  readonly installation: Installation
  readonly host: DaemonHost
}

/** The account named in the path, or a 404: an id that is not valid is never looked up, let alone used as a path. */
export function knownAccount(source: AccountRoutesSource, params: Readonly<Record<string, string>>): string {
  const id = params.id ?? ''
  if (!isValidAccountId(id) || !source.installation.accounts().some((row) => row.id === id)) {
    throw new HttpError(404, 'notFound')
  }
  return id
}

/**
 * The creation of an account as the web does it, shared by `POST /api/accounts` and the setup wizard: the same checks, in
 * the same order, and the same creation `msum link` does for a new account (`Installation.createAccount`, after the
 * same check of the path). Two requests for the same id never both get to create it. Throws an `HttpError`.
 */
export function accountCreator(source: AccountRoutesSource): (id: string) => Promise<void> {
  const { host, installation } = source
  /** Ids being created right now. */
  const creating = new Set<string>()
  return async (id) => {
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
  }
}

/**
 * The routes that change accounts (RF-01, RF-03, RF-04): create one, link it by scanning a QR (the daemon does the
 * linking, see `DaemonHost.startLink`), cancel that, and clear a block that retrying fixes. They answer with codes the
 * web translates; none of them returns a number, a name or a message.
 */
export function accountRoutes(
  source: AccountRoutesSource,
  create: (id: string) => Promise<void> = accountCreator(source),
): Route[] {
  const { host } = source
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
        await create(id)
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
      // Where a page that (re)connects finds the link: the phase, the sync and the error. The QR is not in it: it is an
      // image at `.../link/qr.svg`, so the pairing credential travels as little as possible.
      method: 'GET',
      path: '/api/accounts/:id/link',
      handler: ({ params }) => {
        const id = knownAccount(source, params)
        const snapshot = host.linkSnapshot(id)
        if (snapshot === null) return { body: { state: 'idle' } }
        const { qr: _qr, ...rest } = snapshot
        return { body: rest }
      },
    },
    {
      // The CURRENT QR of a link in progress, drawn from memory on each request (never stored, never cached).
      method: 'GET',
      path: '/api/accounts/:id/link/qr.svg',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        const snapshot = host.linkSnapshot(id)
        if (snapshot?.state !== 'qr' || snapshot.qr === undefined) throw new HttpError(404, 'notFound')
        return { raw: { type: 'image/svg+xml', text: await qrAsSvg(snapshot.qr) } }
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
        if (retried.reason === 'tooSoon') {
          return { status: 409, body: { error: 'tooSoon', retryAfter: retried.retryAfter } }
        }
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
