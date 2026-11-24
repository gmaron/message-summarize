/**
 * Why a model call of the "Ask" tab failed, as a fixed class. The adapters report a reason as text that can carry
 * provider words; only this class is kept and logged (RNF-04), never the text.
 */
export type AnswerFailureClass =
  | 'timeout'
  | 'rateLimit'
  | 'auth'
  | 'unavailable'
  | 'verifyFailed'
  | 'tooLarge'
  | 'other'

/** Reads the few fixed phrases the adapters use. For a reason of a fallback ("a; fallback: b") the first phrase found wins. */
export function classifyAnswerFailure(reason: string): AnswerFailureClass {
  if (/timed out|total time limit/i.test(reason)) return 'timeout'
  if (/answered 429\b|gave up after|over the budget|rate limit/i.test(reason)) return 'rateLimit'
  if (/no API key|answered 40[13]\b|API key not valid/i.test(reason)) return 'auth'
  if (
    /cannot be run without tools|--help did not run|is disabled|was not found|acknowledgeRisk|was not run/i.test(reason)
  ) {
    return 'verifyFailed'
  }
  if (/context window|too large|size limit|response-too-large|as an argument/i.test(reason)) return 'tooLarge'
  if (/could not reach|answered 5\d\d\b|answered 529\b|overloaded/i.test(reason)) return 'unavailable'
  return 'other'
}
