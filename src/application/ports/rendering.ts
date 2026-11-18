import type { WithCopies } from '../../domain/dedupe.js'
import type { Message, Participant } from '../../domain/model.js'
import type { ChatResult, DigestSections } from '../../domain/sections.js'
import type { SettingsIssue } from '../../domain/settings.js'
import type { WindowError } from '../../domain/window.js'

/** One message of a conversation as the LLM will read it. */
export interface TranscriptEntry {
  readonly message: WithCopies<
    Pick<Message, 'timestamp' | 'fromMe' | 'senderName' | 'senderAddress' | 'kind' | 'text' | 'transcript'>
  >
  /** The author, to pick the label of the line. Null when unknown. */
  readonly participant: Participant | null
  /** An own text found to be a mass message (RF-33). Shown as a short label instead of the text. */
  readonly isMass: boolean
}

export interface ConversationTranscript {
  /** Already resolved with `resolveConversationName`. */
  readonly name: string
  readonly isGroup: boolean
  /** Messages to summarize, oldest first. */
  readonly messages: readonly TranscriptEntry[]
  /** Already-read messages passed as context, oldest first. Empty: no context block. Not counted in the cut. */
  readonly context: readonly TranscriptEntry[]
  /** Null: the translated default name. */
  readonly ownerName: string | null
  /** Transcripts longer than this (UTF-16 units) lose their oldest messages (RF-37). */
  readonly maxChars: number
}

/** Builds the text sent to the LLM for one conversation (the "user message"). */
export interface TranscriptRenderer {
  /** The label of a group with no name, to pass to `resolveConversationName`. */
  readonly unnamedGroup: string
  render(input: ConversationTranscript): string
}

/** Builds the system prompt (RF-38). */
export interface SystemPromptRenderer {
  /** The default prompt of the language, as it is shown in the editor (comments and `{{name}}` included). */
  readonly defaultTemplate: string
  /** `template` null: the default one. HTML comments are removed and `{{name}}` is replaced by the owner name. */
  render(template: string | null, ownerName: string | null): string
}

export interface DigestInput {
  readonly sections: DigestSections<ChatResult>
  /** Conversations that could not be summarized. */
  readonly errors: number
  /** Window of the digest, epoch milliseconds. */
  readonly since: number
  readonly until: number
  readonly unreadOnly: boolean
  /** Replaces the detail of "the rest" with a count in the delivered version (RF-36). */
  readonly hideRest: boolean
  /** Shown in the title, for example "WhatsApp". */
  readonly platformName: string
}

export interface RenderedDigest {
  /** The complete digest, kept in the history. */
  readonly fullLines: readonly string[]
  /** What is delivered: the same as `fullLines`, or with the rest hidden. */
  readonly deliveryLines: readonly string[]
}

/** Lines of the digest. Splitting them into parts is done by `splitIntoParts` in the domain. */
export interface DigestRenderer {
  render(input: DigestInput): RenderedDigest
}

/** Explains the expected errors of settings and windows to the user (RF-32, RF-73). */
export interface ErrorMessages {
  settingsIssue(issue: SettingsIssue): string
  windowError(code: WindowError): string
}

export interface Renderers {
  readonly transcript: TranscriptRenderer
  readonly systemPrompt: SystemPromptRenderer
  readonly digest: DigestRenderer
  readonly errors: ErrorMessages
}
