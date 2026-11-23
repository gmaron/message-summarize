import { MAX_QUESTION_CHARS } from '../application/ask-chats.js'
import { HttpError, type Route } from '../interfaces/http/router.js'
import { ASK_PERIODS, type AskPeriod, type AskService, type StartAskInput } from './ask.js'
import { type AccountRoutesSource, knownAccount } from './web-routes.js'

export interface AskRoutesSource extends AccountRoutesSource {
  readonly asks: AskService
}

/** The most chat filters of a request and the longest one. */
const MAX_FILTERS = 20
const MAX_FILTER_CHARS = 100

function parseRequest(body: unknown): StartAskInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'invalidRequest')
  const continueFrom = (body as { continueFrom?: unknown }).continueFrom
  if (continueFrom !== undefined) {
    // The next page of an earlier request: it carries nothing else, the service reuses the question, filters and window.
    if ((body as { question?: unknown }).question !== undefined) throw new HttpError(400, 'invalidRequest')
    if (typeof continueFrom !== 'number' || !Number.isInteger(continueFrom) || continueFrom < 1) {
      throw new HttpError(400, 'invalidRequest')
    }
    return { continueFrom }
  }
  const { question, period, chats } = body as { question?: unknown; period?: unknown; chats?: unknown }
  if (typeof question !== 'string') throw new HttpError(400, 'invalidRequest')
  if (question.trim() === '') throw new HttpError(400, 'emptyQuestion')
  if (question.trim().length > MAX_QUESTION_CHARS) throw new HttpError(400, 'questionTooLong')
  if (typeof period !== 'string' || !(ASK_PERIODS as readonly string[]).includes(period)) {
    throw new HttpError(400, 'invalidRequest')
  }
  let filters: string[] = []
  if (chats !== undefined) {
    if (!Array.isArray(chats) || !chats.every((c) => typeof c === 'string') || chats.length > MAX_FILTERS) {
      throw new HttpError(400, 'invalidRequest')
    }
    filters = (chats as string[]).map((c) => c.trim().slice(0, MAX_FILTER_CHARS)).filter((c) => c !== '')
  }
  return { question, period: period as AskPeriod, chats: filters }
}

/**
 * The free requests over the chats (the "Ask" tab). `POST .../ask` answers 202 at once and the page learns how it ended
 * from an `ask` event; `GET .../asks` hands over the requests with their answers (private text, behind the token).
 */
export function askRoutes(source: AskRoutesSource): Route[] {
  const { asks } = source
  return [
    {
      method: 'POST',
      path: '/api/accounts/:id/ask',
      handler: ({ params, body }) => {
        const id = knownAccount(source, params)
        const started = asks.start(id, parseRequest(body))
        if (started.ok) return { status: 202, body: { id: started.id } }
        switch (started.reason) {
          case 'busy':
          case 'notRunning':
            throw new HttpError(409, started.reason)
          case 'noProvider':
            throw new HttpError(422, 'invalidConfig')
          case 'emptyQuestion':
            throw new HttpError(400, 'emptyQuestion')
          case 'nothingToContinue':
            throw new HttpError(409, 'nothingToContinue')
          default:
            throw new HttpError(503, 'unavailable')
        }
      },
    },
    {
      method: 'GET',
      path: '/api/accounts/:id/asks',
      handler: ({ params }) => ({ body: { asks: asks.list(knownAccount(source, params)) } }),
    },
    {
      method: 'DELETE',
      path: '/api/accounts/:id/asks/:askId',
      handler: ({ params }) => {
        const id = knownAccount(source, params)
        const askId = Number(params.askId)
        if (!Number.isInteger(askId) || !asks.remove(id, askId)) throw new HttpError(404, 'notFound')
        return { status: 204 }
      },
    },
  ]
}
