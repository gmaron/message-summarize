import { HttpError, type Route } from '../../interfaces/http/router.js'
import type { DaemonHost } from '../daemon/host.js'
import type { PreviewService } from './preview.js'
import { type AccountRoutesSource, knownAccount } from './routes.js'

export interface DigestRoutesSource extends AccountRoutesSource {
  readonly host: DaemonHost
  readonly previews: PreviewService
}

/**
 * "Summarize now" and the preview (RF-63, RF-64, RF-66).
 *
 * `POST .../digest` needs a unit of the account that is running (409 `notRunning` otherwise): the digest is generated and
 * queued, and the unit's connection delivers it, so without one there would be nothing to deliver with (`msum digest` is
 * for offline use). It answers 202 at once; how it goes comes as `digest` events. While the connection is not settled
 * it is `deferred` (still 202) to the catch-up, as a scheduled run is, so the messages of the offline sync are not lost. A digest of the account already in
 * progress, a scheduled one included, is a 409 `busy`, known at once.
 *
 * `POST .../preview` generates the digest without saving it or moving the pointer and keeps the result in memory;
 * `GET .../preview` hands it to the page (behind the token). Its events say only how it ended.
 */
export function digestRoutes(source: DigestRoutesSource): Route[] {
  const { host, previews } = source
  return [
    {
      method: 'POST',
      path: '/api/accounts/:id/digest',
      handler: ({ params }) => {
        const id = knownAccount(source, params)
        const started = host.digestNow(id)
        if (!started.ok) throw new HttpError(409, started.reason)
        return { status: 202, body: { state: started.deferred ? 'deferred' : 'started' } }
      },
    },
    {
      method: 'POST',
      path: '/api/accounts/:id/preview',
      handler: async ({ params }) => {
        const id = knownAccount(source, params)
        // A daemon limited to one account (--account) does not work on the others, a preview included.
        if (host.onlyAccountId !== null && host.onlyAccountId !== id) throw new HttpError(422, 'restricted')
        const started = await previews.start(id)
        if (started.ok) return { status: 202, body: { state: 'running' } }
        switch (started.reason) {
          case 'invalidConfig':
            throw new HttpError(422, 'invalidConfig')
          case 'unavailable':
            throw new HttpError(503, 'unavailable')
          case 'unsafePath':
            throw new HttpError(500, 'internal')
          default:
            throw new HttpError(409, started.reason)
        }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts/:id/preview',
      handler: ({ params }) => ({ body: previews.get(knownAccount(source, params)) }),
    },
  ]
}
