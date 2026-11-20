/**
 * Rules of the prompt a user writes (RF-38). The template the digest renders has exactly one variable, `{{name}}` (the
 * owner's name); the output schema is never part of it (the summarizers send it apart), so a user cannot break the format
 * of the answer by editing the text. Shared by the daemon (authoritative) and the web page (instant feedback).
 */

/**
 * The templates the editor offers to start from. `full` is the built-in prompt (the catalog's `defaultSystemPrompt`, never
 * changed by this list); the others are variants (two profiles and a short one) written in the same style. All of them only use `{{name}}`.
 */
export const PROMPT_PRESET_IDS = ['full', 'personal', 'work', 'brief'] as const
export type PromptPresetId = (typeof PROMPT_PRESET_IDS)[number]

/** The variables the template may use, as they are written. */
export const PROMPT_VARIABLES: readonly string[] = ['{{name}}']

/**
 * The longest prompt that is accepted, in characters (UTF-16 units, what `String.length` says). The default prompt is about
 * one thousand: 20 000 leaves room for long instructions and examples, while the text is sent with EVERY conversation
 * (cost and context window) and the request must fit in the web's 64 KiB body limit even for text that takes two or
 * three bytes per character.
 */
export const PROMPT_MAX_LENGTH = 20_000

export type PromptIssue = 'blank' | 'tooLong' | 'unknownVariable'

const COMMENT = /<!--[\s\S]*?-->/g
const PLACEHOLDER = /\{\{[^{}]*\}\}/g

/** The text as the renderer sees it: without the notes for the editor. Run it only on text of a bounded length. */
export const stripComments = (text: string): string => text.replace(COMMENT, '')

/**
 * The `{{...}}` placeholders of the text that are not variables (a typo such as `{{ name }}` counts), each once. What is
 * inside a comment does not count: the renderer removes the comments before it replaces anything.
 */
export function unknownPromptVariables(text: string): string[] {
  const found = new Set<string>()
  for (const match of stripComments(text).matchAll(PLACEHOLDER)) {
    if (!PROMPT_VARIABLES.includes(match[0])) found.add(match[0])
  }
  return [...found]
}

/**
 * What is wrong with a prompt, or null. The length is checked first, so a huge text never reaches the comment pattern.
 * Blank means nothing is left once the comments (notes for the editor, which the renderer removes) and the spaces are
 * gone: such a prompt would send the model no instructions at all.
 */
export function promptIssue(text: string): { readonly code: PromptIssue; readonly variables?: string[] } | null {
  if (text.length > PROMPT_MAX_LENGTH) return { code: 'tooLong' }
  if (stripComments(text).trim() === '') return { code: 'blank' }
  const variables = unknownPromptVariables(text)
  if (variables.length > 0) return { code: 'unknownVariable', variables }
  return null
}
