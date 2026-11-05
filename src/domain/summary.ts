import { err, ok, type Result } from './result.js'

export type Priority = 'high' | 'medium' | 'low'

export interface ChatSummary {
  readonly summary: string
  readonly todos: readonly string[]
  readonly needsReply: boolean
  readonly priority: Priority
}

/** Wire format of the LLM answer. It keeps the legacy Spanish keys and values. */
const PRIORITIES: Readonly<Record<string, Priority>> = { alta: 'high', media: 'medium', baja: 'low' }

/**
 * Validates the JSON an LLM returned for one conversation (RF-30). Expected shape:
 * `{ resumen: string, pendientes: string[], necesita_respuesta: boolean, prioridad: 'alta' | 'media' | 'baja' }`.
 * Errors are internal strings, never shown to users. Any missing key, wrong type or unknown priority is an error. Extra keys are ignored.
 */
export function parseSummaryResponse(json: unknown): Result<ChatSummary, string[]> {
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return err(['the response must be a JSON object'])
  const o = json as Record<string, unknown>
  const errors: string[] = []
  if (typeof o.resumen !== 'string') errors.push('resumen must be a string')
  if (!Array.isArray(o.pendientes) || !o.pendientes.every((p) => typeof p === 'string')) {
    errors.push('pendientes must be a list of strings')
  }
  if (typeof o.necesita_respuesta !== 'boolean') errors.push('necesita_respuesta must be true or false')
  const priority =
    typeof o.prioridad === 'string' && Object.hasOwn(PRIORITIES, o.prioridad) ? PRIORITIES[o.prioridad] : undefined
  if (priority === undefined) errors.push('prioridad must be alta, media or baja')
  if (errors.length > 0 || priority === undefined) return err(errors)
  return ok({
    summary: o.resumen as string,
    todos: [...(o.pendientes as string[])],
    needsReply: o.necesita_respuesta as boolean,
    priority,
  })
}
