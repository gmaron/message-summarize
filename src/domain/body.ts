import type { Message, MessageKind } from './model.js'

/** What a message shows in a transcript. The renderer turns it into localized text. */
export type MessageBody =
  | { readonly type: 'text'; readonly text: string }
  /** The caption is ignored; an empty transcript counts as none. */
  | { readonly type: 'audio'; readonly transcript: string | null }
  /** A message without text that is not an audio: shown by its kind (RF-10). */
  | { readonly type: 'placeholder'; readonly kind: MessageKind }

export function messageBody(message: Pick<Message, 'kind' | 'text' | 'transcript'>): MessageBody {
  if (message.kind === 'audio') return { type: 'audio', transcript: message.transcript || null }
  if (!message.text) return { type: 'placeholder', kind: message.kind }
  return { type: 'text', text: message.text }
}
