import type { Message, MessageKind } from './model.js'

/** What a message shows in a transcript. The renderer turns it into localized text. */
export type MessageBody =
  | { readonly type: 'text'; readonly text: string }
  /** The caption is ignored; an empty transcript counts as none. */
  | { readonly type: 'audio'; readonly transcript: string | null }
  /** An image whose text was read: what came with it (label and caption) and what the image says. */
  | { readonly type: 'image'; readonly text: string; readonly transcript: string }
  /** A message without text that is not an audio: shown by its kind (RF-10). */
  | { readonly type: 'placeholder'; readonly kind: MessageKind }

export function messageBody(message: Pick<Message, 'kind' | 'text' | 'transcript'>): MessageBody {
  if (message.kind === 'audio') return { type: 'audio', transcript: message.transcript || null }
  // An image the reader found nothing in has no transcript: it shows as before ("[image]" and its caption).
  if (message.kind === 'image' && message.text && message.transcript) {
    return { type: 'image', text: message.text, transcript: message.transcript }
  }
  if (!message.text) return { type: 'placeholder', kind: message.kind }
  return { type: 'text', text: message.text }
}
