import { PROMPT_VARIABLES, type PromptIssue, stripComments, unknownPromptVariables } from '../../../domain/prompt.js'
import type { WebTexts } from '../../../infrastructure/i18n/catalog.js'
import { ApiError } from './api.js'
import { fmt } from './i18n.js'
import type { PromptView } from './types.js'

/** What is wrong with the text, in the words of the check the daemon makes (the daemon stays the authority). */
export interface PromptProblem {
  readonly code: PromptIssue
  readonly variables?: readonly string[]
  readonly maxLength?: number
}

/** The text boxes of a browser give "\n" for every line break: the comparisons must not see "\r\n" as a change. */
export const normalizeText = (text: string): string => text.replace(/\r\n?/g, '\n')

/** What the page checks while the user types, with the same rules as the daemon (`domain/prompt.ts`). */
export function clientProblem(text: string, maxLength: number): PromptProblem | null {
  // The limit is the daemon's to say (it comes in the view): a newer daemon may allow more than this build knows. It is
  // checked first so a huge text never reaches the comment pattern.
  if (text.length > maxLength) return { code: 'tooLong', maxLength }
  if (stripComments(text).trim() === '') return { code: 'blank' }
  const variables = unknownPromptVariables(text)
  return variables.length > 0 ? { code: 'unknownVariable', variables } : null
}

/** The problem the daemon reported for a refused save (422), or null for any other error. */
export function problemOf(error: unknown): PromptProblem | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null
  switch (error.code) {
    case 'blankPrompt':
      return { code: 'blank' }
    case 'promptTooLong':
      return error.maxLength === undefined ? { code: 'tooLong' } : { code: 'tooLong', maxLength: error.maxLength }
    case 'unknownVariable':
      return { code: 'unknownVariable', variables: error.variables ?? [] }
    default:
      return null
  }
}

export function problemText(problem: PromptProblem, texts: WebTexts, fallbackMax: number): string {
  const t = texts.ui.prompt
  switch (problem.code) {
    case 'blank':
      return t.blank
    case 'tooLong':
      return fmt(t.tooLong, { max: problem.maxLength ?? fallbackMax })
    case 'unknownVariable':
      return fmt(t.unknownVariable, { variables: (problem.variables ?? []).join(', ') })
  }
}

/** True when the text is not the built-in one (the indicator of "differs from the original"). */
export const differsFromOriginal = (draft: string, view: PromptView): boolean =>
  normalizeText(draft).trim() !== normalizeText(view.defaultText).trim()

/** True when the text is not what the daemon has now (there is something to save). */
export const isDirty = (draft: string, view: PromptView): boolean => normalizeText(draft) !== normalizeText(view.text)

/** What the explanation of `{{name}}` says: the name, or that none is set. */
export function nameNote(view: PromptView, texts: WebTexts): string {
  const variable = view.variables[0] ?? PROMPT_VARIABLES[0] ?? ''
  const name = view.ownerName?.trim() ?? ''
  return name === '' ? fmt(texts.ui.prompt.nameUnset, { variable }) : fmt(texts.ui.prompt.nameNote, { variable, name })
}
