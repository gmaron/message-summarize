import type { MessageKind } from '../../domain/model.js'
import type { ScheduleIssue } from '../../domain/schedule.js'
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

/** The codes of the errors the local web answers with (`{ "error": code }`): the web shows the text of each. */
export type WebErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'methodNotAllowed'
  | 'payloadTooLarge'
  | 'invalidJson'
  | 'internal'
  | 'invalidRequest'
  | 'invalidAccountId'
  | 'accountExists'
  | 'invalidConfig'
  | 'unavailable'
  | 'inUse'
  | 'beingLinked'
  | 'alreadyLinking'
  | 'needsRetry'
  | 'needsRelink'
  | 'notBlocked'
  | 'notLinking'
  | 'busy'
  | 'restricted'
  | 'invalidSchedule'
  | 'notRunning'
  | 'tooSoon'
  | 'concurrentEdit'
  | 'matchedByPattern'
  | 'confirmRequired'
  | 'notApplied'

/** Why a configuration option is not valid (`issues` of a 422 `invalidConfig`): codes, never text. The same as the CLI's. */
export type WebConfigIssueCode =
  | SettingsIssueCode
  | 'invalidJson'
  | 'unknownOption'
  | 'notOneOf'
  | 'required'
  | 'invalidTimezone'
  | 'invalidPort'
  | 'invalidUrl'
  | 'concurrentEdit'
  | 'installationOnly'

/** Why a digest asked from the web (or a scheduled one) produced nothing: codes, never text (`digest` and `preview` events). */
export type DigestErrorCode = 'noProvider' | 'promptFile' | 'concurrentRun' | 'invalidWindow' | 'failed'

/** Why a link made from the web ended without linking (`link` event and `GET /api/accounts/:id/link`): codes, never text. */
export type LinkErrorCode =
  | 'timeout'
  | 'loggedOut'
  | 'mismatch'
  | 'noAccount'
  | 'socketFailed'
  | 'forbidden'
  | 'replaced'
  | 'cancelled'
  | 'failed'

/** The signs that the previous tool is running (see `legacyLiveSignals`). */
export type ImportLiveSignal = 'wal' | 'shm' | 'recentWrite' | 'recentSession'

/** What an import tells the user afterwards (nothing secret: counts, names of options, a masked number). */
export interface ImportSummary {
  /** The account created. */
  readonly id: string
  /** What was imported, as the user named it: the path of the installation, plus the instance when there is one. */
  readonly source: string
  /** The linked number, masked. */
  readonly masked: string
  readonly sessionFiles: number
  readonly conversations: number
  readonly participants: number
  readonly messages: number
  /** Messages of a kind this program does not know: not imported. */
  readonly skippedKinds: number
  /** Messages of chats the account excludes (RF-14): not stored. */
  readonly excluded: number
  /** Messages whose text was edited (kept as the previous tool stored them, with the "edited" marker). */
  readonly edited: number
  readonly unreadCounted: number
  readonly unreadMarked: number
  /** The pointer of the last digest, formatted, or null when there was none. */
  readonly pointer: string | null
  /** Options set in the config.json of the account (our names). */
  readonly configWritten: readonly string[]
  /** Options of the previous tool with no equivalent here (their names). */
  readonly configUnmapped: readonly string[]
  /** Options whose value was not valid here: not imported. */
  readonly configInvalid: readonly string[]
  readonly promptCopied: boolean
  readonly schedules: number
  /** What was left behind, counted: */
  readonly mediaFiles: number
  readonly imageTexts: number
  readonly transcribeErrors: number
  readonly pendingOutbox: number
  readonly digestFiles: number
  readonly otherState: readonly string[]
}

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

  /** Texts of the local web: the page shown while it is not built, the errors of its API and the whole interface. */
  readonly web: WebTexts

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
      invalidAccountId(value: string): string
      conflictingOptions(option: string): string
      unknownSubcommand(value: string): string
      invalidTime(value: string): string
      invalidDays(value: string): string
    }
    /** Problems of config.json that the digest settings do not cover (RF-73). */
    readonly config: {
      /** Printed once before the problems; each problem names its file (`inFile`). */
      readonly heading: string
      inFile(file: string, text: string): string
      readonly invalidJson: string
      unknownOption(option: string): string
      notOneOf(option: string, allowed: string): string
      required(option: string): string
      invalidTimezone(option: string): string
      invalidPort(option: string): string
      invalidUrl(option: string): string
      readonly concurrentEdit: string
      /** An option of the installation's config.json that an account's file cannot set. */
      installationOnly(option: string): string
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
    /** The old single-account layout must be migrated and a daemon holds the installation. */
    legacyDaemonRunning(pid: number): string
    /** Choosing and listing the accounts of the installation (RF-03). */
    readonly accounts: {
      unknown(id: string, known: string): string
      readonly none: string
      ambiguous(known: string): string
      missingDir(id: string): string
      /** The directory of the account (or its auth/) is a link or a file: nothing is touched. */
      notADirectory(id: string): string
      /** `msum accounts`. */
      readonly empty: string
      readonly header: string
      /** `id` is already padded to the width of the longest id. */
      row(id: string, platform: string, state: string): string
      linked(masked: string): string
      readonly notLinked: string
      /** `reason` is already translated. */
      blocked(reason: string): string
      readonly missingDirState: string
    }
    readonly link: {
      alreadyLinked(id: string, account: string): string
      scanQr(qrFile: string): string
      readonly connected: string
      readonly receivingHistory: string
      done(account: string): string
      /** Printed after a successful link when the account has no schedule yet. */
      readonly scheduleHint: string
      /** The running daemon is using this account (linked, not blocked): stop it before linking again. */
      activeInDaemon(id: string, pid: number): string
      /** Another `link` or `unlink` holds this account; `lockFile` is the file to delete if that process is gone. */
      beingLinked(id: string, pid: number, lockFile: string): string
      /** A blocked state that `msum retry` fixes and linking does not. */
      needsRetry(id: string): string
      mismatch(id: string): string
      loggedOut(id: string): string
      failed(reason: string): string
      readonly timeout: string
    }
    readonly unlink: {
      confirm(id: string): string
      activeInDaemon(id: string, pid: number): string
      beingLinked(id: string, pid: number, lockFile: string): string
      readonly cancelled: string
      done(id: string): string
    }
    readonly daemon: {
      running(dataDir: string): string
      /** An account the daemon leaves idle because nothing is linked to it. */
      notLinked(id: string): string
      noSchedules(id: string): string
      /** The daemon runs but the installation has no account yet. */
      readonly noAccounts: string
      readonly stopped: string
      /** The daemon is idle because the account is blocked: `reason` is already translated. */
      blocked(reason: string): string
    }
    /** The local web (RF-82, RNF-03). */
    readonly web: {
      listening(host: string, port: number): string
      /** The web could not start (`code` is a system error code); the accounts keep running. */
      failed(host: string, port: number, code: string): string
      /** The web listens beyond this machine: anyone who can reach it and has the token sees every chat. */
      exposed(host: string): string
    }
    /** `msum open`. */
    readonly open: {
      readonly daemonNotRunning: string
      /** The daemon runs but its web does not listen (it is off, or it could not start). */
      readonly webNotListening: string
      /** The URL with the token: it is a secret, so it is printed only to the terminal of the user. */
      url(url: string): string
      openFailed(code: string): string
    }
    /** Why the daemon stopped working with the account, and what to do about it. */
    readonly blockedReasons: Readonly<Record<BlockedReason, (id: string) => string>>
    readonly digest: {
      readonly empty: string
      readonly dryRun: string
      committed(summarized: number, failed: number, parts: number): string
      readonly concurrentRun: string
      /** What to tell the user about each window error, naming the flags of the CLI. */
      readonly flagHint: Readonly<Record<WindowError, string>>
    }
    /** `msum import` (RF-06): the previous tool's installation, copied into accounts. */
    readonly import: {
      notLegacy(path: string): string
      instanceNotFound(name: string): string
      noSession(source: string): string
      /** The account id derived from an instance name is not valid: say which flag to use. */
      invalidDerivedId(name: string): string
      duplicateId(id: string): string
      targetLinked(id: string): string
      targetHasData(id: string): string
      daemonUsing(id: string, pid: number): string
      beingLinked(id: string, pid: number, lockFile: string): string
      /** The previous tool looks as if it runs: which signs say so, and that stopping it clears them (or `--force`). */
      legacyLive(source: string, signals: readonly ImportLiveSignal[]): string
      /** Its database is not where it should be: the data directory may have been moved (`WA_DATA_DIR`). */
      dataMissing(source: string, dbFile: string): string
      /** A privacy list of the previous tool cannot be imported: nothing is imported, and what to fix. */
      privacyList(source: string, legacyKey: 'soloLocal' | 'excluir', reason: 'invalid' | 'needsOllamaModel'): string
      /** The warning before the session is copied: `plan` lists "source -> account". */
      warning(plan: string): string
      readonly confirm: string
      readonly cancelled: string
      starting(source: string, id: string): string
      /** The multi-line summary printed after an import. */
      summary(summary: ImportSummary): string
      failed(id: string, code: string): string
    }
    /** `msum retry`. */
    readonly retry: {
      notBlocked(id: string): string
      beingLinked(id: string, pid: number, lockFile: string): string
      /** The block can only be fixed by linking again. */
      needsRelink(id: string): string
      /** `reason` is already translated. */
      done(id: string): string
    }
    /** `msum schedule` (RF-60..62). */
    readonly schedule: {
      /** Short name of a day, 0 being Sunday. */
      dayName(day: number): string
      readonly everyDay: string
      readonly workdays: string
      readonly weekend: string
      /** `next` is already formatted in the time zone of the account. */
      row(id: number, days: string, time: string, next: string | null): string
      readonly empty: string
      added(id: number, days: string, time: string, next: string | null): string
      removed(id: number): string
      notFound(id: number): string
    }
    readonly status: {
      dataDir(path: string): string
      account(id: string, masked: string | null): string
      /** What the running daemon says about the connection: `state` is already translated. */
      connection(state: string, since: string): string
      stateName(state: 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'idle' | 'linking'): string
      /** The block of an account whose configuration is invalid; the problems follow. */
      configBroken(id: string): string
      readonly noAccounts: string
      lastDigest(when: string | null): string
      pending(count: number): string
      daemon(pid: number | null): string
      /** Shown when the account is blocked: `reason` is already translated, `when` formatted. */
      blocked(reason: string, when: string): string
      readonly noSchedules: string
      /** There are schedules and no provider to run them. */
      readonly schedulesNoProvider: string
      schedule(id: number, days: string, time: string, next: string | null): string
    }
    readonly doctor: {
      readonly title: string
      ok(name: string, detail: string): string
      /** A warning does not make `doctor` fail. */
      warn(name: string, detail: string, fix: string): string
      fail(name: string, detail: string, fix: string): string
      readonly names: {
        readonly node: string
        readonly dataDir: string
        readonly config: string
        readonly provider: string
        readonly whatsapp: string
        readonly accounts: string
        readonly schedules: string
      }
      /** Work directories of imports that died, which hold a copy of a WhatsApp session. */
      staleImport(names: string): string
      readonly staleImportFix: string
      schedulesOk(count: number): string
      readonly schedulesNone: string
      readonly schedulesNoneFix: string
      readonly schedulesNoProvider: string
      schedulesNotImported(expressions: string): string
      readonly schedulesNotImportedFix: string
      readonly schedulesIgnored: string
      readonly schedulesIgnoredFix: string
      /** Names a check of one account when several are checked. */
      accountName(name: string, id: string): string
      accountsOk(count: number): string
      accountsMissingDir(id: string): string
      accountsMissingDirFix(id: string): string
      accountsInvalid(ids: string): string
      readonly accountsInvalidFix: string
      accountsIgnored(names: string): string
      readonly accountsIgnoredFix: string
      readonly legacyConflict: string
      readonly legacyConflictFix: string
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

/** The unit states the web labels (`UnitState` plus `notLinked`, which an idle account without a number shows). */
/**
 * The fields of the settings form, as keys of the catalog (the options they edit are the dotted names of
 * `PUT /api/accounts/:id/settings`: `providerPrimary` is `provider.primary`).
 */
export type SettingsFieldKey =
  | 'unreadOnly'
  | 'flagUnsaved'
  | 'hideRest'
  | 'maxCharsPerConversation'
  | 'defaultWindowHours'
  | 'language'
  | 'timezone'
  | 'ownerName'
  | 'providerPrimary'
  | 'providerBackup'
  | 'claudeModel'
  | 'claudeTimeoutMs'
  | 'ollamaBaseUrl'
  | 'ollamaModel'

export type WebStateName = 'connecting' | 'connected' | 'reconnecting' | 'blocked' | 'idle' | 'linking' | 'notLinked'

/**
 * Everything the web shows (RNF-13). Templates use `{name}` placeholders that the page fills in. Kept in its own
 * module per language (`web-es.ts`, `web-en.ts`) so the bundle of the page does not carry the prompts or the CLI texts.
 */
export interface WebTexts {
  /** BCP 47 locale for dates and weekday names. */
  readonly locale: string
  readonly notBuilt: { readonly title: string; readonly message: string }
  readonly errors: Readonly<Record<WebErrorCode, string>>
  readonly linkErrors: Readonly<Record<LinkErrorCode, string>>
  readonly digestErrors: Readonly<Record<DigestErrorCode, string>>
  /** Why a schedule sent to `POST /api/accounts/:id/schedules` was refused (`issue`). */
  readonly scheduleIssues: Readonly<Record<ScheduleIssue, string>>
  /** Why an option of the settings was refused: the reason alone (the page puts it next to the field). `{allowed}` for `notOneOf`. */
  readonly configIssues: Readonly<Record<WebConfigIssueCode, string>>
  readonly ui: {
    readonly title: string
    readonly loading: string
    readonly loadFailed: string
    readonly retry: string
    readonly close: string
    readonly cancel: string
    readonly unauthorizedTitle: string
    readonly offline: string
    readonly accountsTitle: string
    readonly noAccounts: string
    readonly addAccount: {
      readonly button: string
      readonly idLabel: string
      readonly idHint: string
      readonly submit: string
    }
    readonly account: {
      readonly number: string
      readonly noNumber: string
      readonly lastDigest: string
      readonly never: string
      readonly nextRun: string
      readonly noSchedules: string
      readonly timezone: string
      readonly invalidConfig: string
      /** `{when}`. */
      readonly blockedSince: string
      /** `{when}`: when the web's retry becomes available. */
      readonly retryAvailable: string
      /** Heading of the list of problems of an invalid configuration. */
      readonly configIssues: string
    }
    readonly retryConfirm: { readonly confirm: string; readonly yes: string; readonly no: string }
    readonly states: Readonly<Record<WebStateName, string>>
    readonly blockedReasons: Readonly<Record<BlockedReason, string>>
    readonly actions: {
      readonly digestNow: string
      readonly preview: string
      readonly schedules: string
      readonly conversations: string
      readonly settings: string
      readonly link: string
      readonly relink: string
      readonly retry: string
    }
    readonly digest: {
      readonly running: string
      readonly started: string
      readonly deferred: string
      /** `{summarized}`, `{parts}`. */
      readonly done: string
      /** `{summarized}`, `{failed}`. */
      readonly doneFailed: string
      readonly empty: string
      readonly failed: string
      readonly busy: string
    }
    readonly link: {
      /** `{account}`. */
      readonly title: string
      readonly starting: string
      readonly waitingQr: string
      readonly scan: string
      readonly qrAlt: string
      readonly connected: string
      readonly syncing: string
      /** `{count}`. */
      readonly chats: string
      /** `{count}`. */
      readonly messages: string
      readonly syncDone: string
      /** `{percent}` is a whole number from 0 to 100. */
      readonly percent: string
      readonly done: string
      readonly failed: string
      readonly tryAgain: string
      readonly cancel: string
    }
    readonly schedules: {
      /** `{account}`. */
      readonly title: string
      /** `{timezone}`. */
      readonly timezone: string
      readonly empty: string
      readonly daysLabel: string
      readonly timeLabel: string
      /** `{when}`. */
      readonly nextRun: string
      readonly everyDay: string
      readonly weekdays: string
      readonly add: string
      readonly save: string
      readonly edit: string
      readonly delete: string
      readonly saving: string
    }
    readonly settings: {
      /** `{account}`. */
      readonly title: string
      /** Said once on top: changes apply without restarting or reconnecting. */
      readonly appliesLive: string
      readonly groups: { readonly digest: string; readonly languageTime: string; readonly provider: string }
      readonly fields: Readonly<Record<SettingsFieldKey, { readonly label: string; readonly hint?: string }>>
      readonly languageNames: Readonly<Record<Language, string>>
      readonly providerNames: Readonly<Record<'claude-cli' | 'ollama', string>>
      /** The choice of "no provider" (primary) or "no backup". */
      readonly none: string
      /** How the page says where a value comes from. */
      readonly sources: { readonly account: string; readonly installation: string; readonly default: string }
      /** Under the text fields that inherit when they are left empty. */
      readonly emptyInherits: string
      /** Under the Ollama address when its host is not this machine. */
      readonly remoteOllama: string
      readonly save: string
      readonly saving: string
      readonly saved: string
      readonly noChanges: string
      /** `{option}`, `{reason}`: a problem that belongs to no field of the form. */
      readonly issue: string
      readonly issuesHeading: string
    }
    readonly conversations: {
      /** `{account}`. */
      readonly title: string
      /** What the two marks do, said once on top. */
      readonly explainExclude: string
      readonly explainLocalOnly: string
      readonly searchLabel: string
      readonly searchPlaceholder: string
      readonly empty: string
      readonly noResults: string
      readonly group: string
      readonly individual: string
      /** `{when}`. */
      readonly lastMessage: string
      readonly noMessages: string
      /** `{count}`: how many messages are stored. */
      readonly messages: string
      /** `{count}`. */
      readonly unread: string
      readonly markedUnread: string
      readonly exclude: string
      readonly localOnly: string
      /** Said once: a mark covers the ids known for this chat; a second chat of the same person is marked on its own. */
      readonly aliasNote: string
      /** Under a mark that comes from a pattern of the configuration (not removable here). */
      readonly fromPattern: string
      /** Under the "local only" mark that cannot be turned on: no Ollama model. */
      readonly localUnavailable: string
      /** `{count}`: asked before excluding a chat with stored messages. */
      readonly confirmDelete: string
      readonly confirmYes: string
      readonly unlistedHeading: string
      readonly unlistedHint: string
      /** `{shown}`, `{total}`. */
      readonly shown: string
      readonly loadMore: string
      readonly saving: string
    }
    readonly preview: {
      /** `{account}`. */
      readonly title: string
      readonly running: string
      readonly notSent: string
      /** `{when}`. */
      readonly generatedAt: string
      /** `{summarized}`, `{failed}`. */
      readonly stats: string
      /** `{summarized}`. */
      readonly statsClean: string
      readonly empty: string
      readonly failed: string
      readonly none: string
      /** `{n}`, `{total}`. */
      readonly part: string
      readonly copy: string
      readonly copied: string
      readonly generate: string
    }
  }
}
