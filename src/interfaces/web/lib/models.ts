import type { ModelOption, ModelProviderName, ModelsView } from './types.js'

/**
 * What the model chooser shows, apart from drawing it. Nobody types a model: it is chosen from a list the daemon gives
 * (see `main/web/models.ts`). Only a compatible server that gives no list lets a name be typed.
 *
 * - `loading`: the list was not answered yet.
 * - `needsKey`: the provider needs a saved key to list its models (the select is disabled, and says how to enable it).
 * - `select`: the list; for Anthropic it may be the known models (`fallback`) when the provider's own could not be read.
 * - `empty`: Ollama has no models, does not answer, its address is not valid or it needs the agreement first.
 * - `failed`: OpenAI or Gemini could not give the list (no fallback list exists for them): the error and "look again".
 * - `typing`: a compatible server that gave no list (or whose address is not saved yet): a name may be typed.
 */
export type PickerKind = 'loading' | 'needsKey' | 'select' | 'empty' | 'failed' | 'typing'

export interface PickerState {
  readonly kind: PickerKind
  /** What the select offers (the list of the daemon; the saved model first when it is not in it). */
  readonly options: readonly ModelOption[]
  /** The id the select shows as chosen: the one of the list that the saved value stands for ("llama3.2" is "llama3.2:latest"). */
  readonly selected: string
  /** The list is the short list of known models, not the provider's. */
  readonly fallback: boolean
  /** The value was saved before and is not in the list: it is kept as the current one, with a warning. */
  readonly foreign: boolean
  /** Why there is no live list, when the page says something about it. */
  readonly reason: ModelsView['error'] | null
}

/** The options of the settings whose value is a model chosen from a list, and the provider each belongs to. */
export const MODEL_FIELDS: Readonly<Record<string, ModelProviderName>> = {
  'provider.claudeCli.model': 'claude-cli',
  'provider.ollama.model': 'ollama',
  'provider.openai.model': 'openai',
  'provider.anthropic.model': 'anthropic',
  'provider.gemini.model': 'gemini',
}

/** Ollama says "llama3.2" for "llama3.2:latest". */
const sameModel = (provider: ModelProviderName, a: string, b: string): boolean =>
  a === b || (provider === 'ollama' && (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`))

export function pickerState(provider: ModelProviderName, view: ModelsView | null, value: string): PickerState {
  const none = { options: [], selected: value, fallback: false, foreign: false } as const
  if (view === null) return { ...none, kind: 'loading', reason: null }
  const current = value.trim()
  if (view.error === 'noKey') return { ...none, kind: 'needsKey', reason: 'noKey' }
  if (view.typing === true) return { ...none, kind: 'typing', reason: view.error ?? null }
  if (view.models.length === 0) {
    // Ollama (a message to fix it) or OpenAI and Gemini (the error): never a text box.
    return {
      ...none,
      kind: provider === 'ollama' ? 'empty' : 'failed',
      reason: view.error ?? (provider === 'ollama' ? 'empty' : 'failed'),
    }
  }
  const match = view.models.find((model) => sameModel(provider, model.id, current))
  const foreign = current !== '' && match === undefined
  return {
    kind: 'select',
    options: foreign ? [{ id: current }, ...view.models] : view.models,
    selected: match?.id ?? current,
    fallback: view.source === 'fallback',
    foreign,
    reason: view.error ?? null,
  }
}

/** The text of an option: the friendly name when there is one (and the id after it when the name is not the id itself). */
export function optionText(provider: ModelProviderName, option: ModelOption): string {
  if (option.name === undefined || option.name === option.id) return option.id
  return provider === 'claude-cli' ? option.name : `${option.name} (${option.id})`
}
