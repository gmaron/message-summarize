import { MAX_QUESTION_CHARS } from './ask-text.js'

/** A request the owner saved to ask again with one click. Trusted text: the owner wrote it. */
export interface AskPreset {
  readonly name: string
  readonly text: string
}

export const MAX_ASK_PRESETS = 20
export const MAX_ASK_PRESET_NAME_CHARS = 60
/** A preset fills the question box, so it can be as long as a question. */
export const MAX_ASK_PRESET_TEXT_CHARS = MAX_QUESTION_CHARS

export type AskPresetIssue =
  | 'invalidPreset'
  | 'emptyPresetName'
  | 'presetNameTooLong'
  | 'emptyPresetText'
  | 'presetTextTooLong'

/** Why a value is not a preset, or null when it is one. Only `name` and `text` are allowed. */
export function askPresetIssue(value: unknown): AskPresetIssue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalidPreset'
  if (Object.keys(value).some((key) => key !== 'name' && key !== 'text')) return 'invalidPreset'
  const { name, text } = value as { name?: unknown; text?: unknown }
  if (typeof name !== 'string' || typeof text !== 'string') return 'invalidPreset'
  if (name.trim() === '') return 'emptyPresetName'
  if (name.trim().length > MAX_ASK_PRESET_NAME_CHARS) return 'presetNameTooLong'
  if (text.trim() === '') return 'emptyPresetText'
  if (text.trim().length > MAX_ASK_PRESET_TEXT_CHARS) return 'presetTextTooLong'
  return null
}
