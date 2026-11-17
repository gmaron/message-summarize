import type { MessageKind } from '../../domain/model.js'
import type { SettingsIssueCode } from '../../domain/settings.js'
import type { WindowError } from '../../domain/window.js'

export type Language = 'es' | 'en'

/**
 * Why the daemon stopped using the account and went idle (the marker `account/blocked.json`). Fixed words, never
 * error messages.
 */
export type BlockedReason =
  | 'loggedOut'
  | 'forbidden'
  | 'replaced'
  | 'socketFailed'
  | 'notLinked'
  | 'mismatch'
  | 'noAccount'

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
    /** Name of a document that has none, inside the text of a document message (legacy "sin nombre"). */
    readonly unnamedDocument: string
    /** Label of a message that shares several contacts (the singular is `transcript.kinds.contact`). */
    readonly contacts: string
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

  /** Texts of the command line (RNF-13). Log lines are not here: they are fixed English codes (RNF-12). */
  readonly cli: {
    /** The whole help text. */
    readonly usage: string
    readonly argErrors: {
      unknownCommand(value: string): string
      unknownOption(value: string): string
      missingValue(option: string): string
      unexpectedArgument(value: string): string
      invalidNumber(option: string): string
      invalidDate(option: string): string
    }
    /** Problems of config.json that the digest settings do not cover (RF-73). */
    readonly config: {
      heading(file: string): string
      readonly invalidJson: string
      unknownOption(option: string): string
      notOneOf(option: string, allowed: string): string
      required(option: string): string
      invalidTimezone(option: string): string
      invalidCron(option: string): string
      readonly noProvider: string
      promptFile(path: string): string
    }
    readonly unexpectedError: (code: string) => string
    cannotCreateDataDir(path: string): string
    readonly init: {
      created(dataDir: string, configFile: string, timezone: string): string
      exists(configFile: string): string
      readonly next: string
    }
    /** Shared by link, unlink and daemon. */
    daemonRunning(pid: number): string
    readonly link: {
      alreadyLinked(account: string): string
      scanQr(qrFile: string): string
      readonly connected: string
      readonly receivingHistory: string
      done(account: string): string
      readonly mismatch: string
      readonly loggedOut: string
      failed(reason: string): string
      readonly timeout: string
    }
    readonly unlink: {
      readonly confirm: string
      readonly cancelled: string
      readonly done: string
    }
    readonly daemon: {
      running(dataDir: string): string
      readonly notLinked: string
      readonly noSchedules: string
      readonly stopped: string
      /** The daemon is idle because the account is blocked: `reason` is already translated. */
      blocked(reason: string): string
    }
    /** Why the daemon stopped working with the account, and what to do about it. */
    readonly blockedReasons: Readonly<Record<BlockedReason, string>>
    readonly digest: {
      readonly empty: string
      readonly dryRun: string
      committed(summarized: number, failed: number, parts: number): string
      readonly concurrentRun: string
      /** What to tell the user about each window error, naming the flags of the CLI. */
      readonly flagHint: Readonly<Record<WindowError, string>>
    }
    readonly status: {
      dataDir(path: string): string
      account(masked: string | null): string
      lastDigest(when: string | null): string
      pending(count: number): string
      daemon(pid: number | null): string
      /** Shown when the account is blocked: `reason` is already translated, `when` formatted. */
      blocked(reason: string, when: string): string
      readonly noSchedules: string
      schedule(expression: string, next: string | null): string
    }
    readonly doctor: {
      readonly title: string
      ok(name: string, detail: string): string
      fail(name: string, detail: string, fix: string): string
      readonly names: {
        readonly node: string
        readonly dataDir: string
        readonly config: string
        readonly provider: string
        readonly whatsapp: string
      }
      node(found: string): string
      nodeFix(required: string): string
      readonly dataDirOk: string
      dataDirBad(path: string, mode: string): string
      dataDirFix(path: string): string
      readonly configOk: string
      readonly configFix: string
      providerOk(provider: string, detail: string): string
      providerMissing(command: string): string
      providerFix(provider: string): string
      readonly providerNone: string
      readonly whatsappOk: string
      readonly whatsappNone: string
      readonly whatsappFix: string
      readonly summaryOk: string
      readonly summaryFail: string
    }
  }
}
