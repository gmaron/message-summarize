import type { MessageKind } from '../../domain/model.js'
import type { SettingsIssueCode } from '../../domain/settings.js'
import type { WindowError } from '../../domain/window.js'

export type Language = 'es' | 'en'

export interface HeadlineParts {
  readonly total: number
  readonly unreadOnly: boolean
  /** Formatted date. */
  readonly since: string
  readonly needsReply: number
  readonly unsaved: number
}

/** Every user-facing text of the core. Spanish and English implement the same interface. */
export interface Catalog {
  /** BCP 47 tag used to format dates and times. */
  readonly dateLocale: string
  /** Name of the owner when the settings give none. */
  readonly defaultOwnerName: string
  /** Name the default system prompt uses when the owner has no name. It must fit after "de"/"of" and as a subject. */
  readonly promptOwnerName: string
  /** Label of a group with no name. */
  readonly unnamedGroup: string
  /** Default system prompt (RF-38). Asks for the four fields of the answer. `{{name}}` is the owner name. */
  readonly defaultSystemPrompt: string

  readonly transcript: {
    header(isGroup: boolean, name: string): string
    readonly truncatedMarker: string
    readonly contextHeader: string
    readonly unreadHeader: string
    /** Label of the owner's own messages. */
    ownerLabel(name: string): string
    /** Body of an own mass message; `excerpt` is already collapsed and cut. */
    massMessage(excerpt: string): string
    audio(transcript: string): string
    readonly audioUntranscribed: string
    /** Suffix of a line whose message was repeated in `count` other groups (always 1 or more). */
    copies(count: number): string
    /** Shown instead of the text of a message that has none (RF-10). */
    readonly kinds: Readonly<Record<MessageKind, string>>
  }

  /** Texts the capture adapters put into stored messages (RF-10, RF-11). */
  readonly capture: {
    /** Goes before the text of an edited message, so the digest shows that it was edited (legacy "(editado) "). */
    readonly editedPrefix: string
  }

  readonly digest: {
    title(platformName: string, date: string): string
    headline(parts: HeadlineParts): string
    unsavedTitle(count: number): string
    readonly needsReplyTitle: string
    readonly withTodosTitle: string
    readonly restTitle: string
    /** The whole line that replaces the detail of the rest. */
    hiddenRest(count: number): string
    failedChats(count: number): string
  }

  readonly errors: {
    /** One message per issue code; each names the option and the reason (RF-73). */
    readonly settings: Readonly<Record<SettingsIssueCode, (option: string) => string>>
    /** One message per window error code; each explains the error (RF-32). */
    readonly window: Readonly<Record<WindowError, string>>
  }
}
