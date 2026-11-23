import type { MessageKind } from '../../domain/model.js'
import type { PromptPresetId } from '../../domain/prompt.js'
import type { ScheduleIssue } from '../../domain/schedule.js'
import type { SettingsIssueCode } from '../../domain/settings.js'
import type { SetupStep } from '../../domain/setup.js'
import type { WindowError } from '../../domain/window.js'
import type { ProviderCharge, ProviderInfoKind } from '../llm/provider-info.js'

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
  | 'blankPrompt'
  | 'promptTooLong'
  | 'unknownVariable'
  | 'consentRequired'
  | 'notLinked'
  | 'testRunning'
  | 'invalidKey'
  | 'unknownModel'
  | 'invalidSecretsFile'
  | 'setupCompleted'
  | 'wrongStep'
  | 'emptyQuestion'
  | 'tooManyChats'
  | 'questionTooLong'

/** Why a configuration option is not valid (`issues` of a 422 `invalidConfig`): codes, never text. The same as the CLI's. */
export type WebConfigIssueCode =
  | SettingsIssueCode
  | 'invalidJson'
  | 'unknownOption'
  | 'notOneOf'
  | 'required'
  | 'invalidTimezone'
  | 'invalidPort'
  | 'invalidHostName'
  | 'belowMinimum'
  | 'invalidUrl'
  | 'concurrentEdit'
  | 'installationOnly'

/** Why the test of a provider failed (RF-41): codes, never the text the provider answered. */
export type ProviderTestErrorCode =
  | 'notFound'
  | 'timeout'
  | 'invalidSummary'
  | 'unreachable'
  | 'noKey'
  | 'rejected'
  | 'apiUnreachable'
  | 'failed'

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
  /** The other templates of the prompt editor (`full` is `defaultSystemPrompt`): same style, only the `{{name}}` variable. */
  readonly promptPresets: Readonly<Record<Exclude<PromptPresetId, 'full'>, string>>

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

  /** The free requests of the owner over the chats (the "Ask" tab of the web). */
  readonly ask: {
    /** The system prompt of one conversation for a request: the cleaned question and the owner name. */
    systemPrompt(question: string, ownerName: string): string
    /** One line before the transcript of a chat: whether the contact is in the owner's address book, or that it is a group. */
    contactStatus(status: 'saved' | 'unsaved' | 'group'): string
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
      /** `msum secret set|rm <provider>` with a provider that has no key; `allowed` is the list of the ones that do. */
      unknownProvider(allowed: string): string
      /** `msum provider use|test` with a kind that does not exist; `allowed` lists the ones that do. */
      unknownProviderKind(value: string, allowed: string): string
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
      /** A transcription language that is neither "auto" nor an ISO 639 code (RF-23). */
      invalidLanguage(option: string): string
      invalidPort(option: string): string
      invalidHostName(option: string): string
      belowMinimum(option: string): string
      invalidUrl(option: string): string
      readonly concurrentEdit: string
      /** An option of the installation's config.json that an account's file cannot set. */
      installationOnly(option: string): string
      readonly noProvider: string
      promptFile(path: string): string
      /** An API key written in config.json: keys are secrets and go in secrets.json or the environment (RNF-04). */
      secretInConfig(option: string): string
      /** `provider.genericCli.command`: it needs a program first, and `{{prompt}}` only as a whole element. */
      invalidCommandTemplate(option: string): string
      /**
       * Printed when a command starts with the generic CLI chosen (RF-47, RF-49): the command may run tools on text written
       * by third parties. `acknowledged` says whether the user accepted that, which is what lets it run.
       */
      genericCliWarning(acknowledged: boolean): string
    }
    /** `msum provider ls|use|test` (RF-41, RNF-02): choosing a provider and trying it. */
    readonly provider: {
      readonly descriptions: Readonly<Record<ProviderInfoKind, string>>
      readonly charge: Readonly<Record<ProviderCharge, string>>
      readonly dataLeaves: string
      readonly dataStays: string
      /** No host to list: Ollama, which stays on the machine. */
      readonly hostsNone: string
      /** `openai-compatible`: the host of `provider.openai.baseUrl`. */
      readonly hostsYourServer: string
      readonly hostsYourCommand: string
      /** A preset that is disabled and contacts nothing. */
      readonly hostsDisabled: string
      readonly policyNone: string
      readonly roles: { readonly primary: string; readonly backup: string; readonly none: string }
      readonly ls: {
        title(account: string): string
        kind(kind: string, description: string): string
        info(charge: string, data: string, hosts: string, policy: string): string
        state(role: string, key: string, usable: string): string
        /** `source` is already translated (`secret.source*`); the key itself is never shown. */
        keyFrom(name: string, source: string): string
        keyMissing(name: string): string
        readonly keyNotNeeded: string
        keyOptional(name: string): string
        readonly usableYes: string
        readonly usableNoModel: string
        usableNoKey(name: string): string
        readonly usableDisabled: string
        readonly usableNoCommand: string
        readonly usableNotAcknowledged: string
        readonly usableNotChecked: string
        /** `detail` is the reason `doctor` gives for a CLI that failed `verify`. */
        usableVerifyFailed(detail: string): string
        /** RNF-02, for a configured provider that sends the chats out: when it was accepted (`date` is YYYY-MM-DD). */
        consent(date: string): string
        readonly consentNone: string
        /** Ollama at an address that is not this machine: the chats go to that server (a line under its data). */
        ollamaRemote(origin: string): string
        readonly footer: string
      }
      readonly use: {
        readonly baseUrlRequired: string
        readonly baseUrlIsOpenAi: string
        readonly baseUrlOnlyCompatible: string
        readonly modelNotForGeneric: string
        readonly noModelHint: string
        /** `file` was not touched. */
        notWritten(file: string): string
        fileNotJson(file: string): string
        disclosureTitle(provider: string): string
        readonly disclosureSends: string
        disclosureHosts(hosts: string): string
        /** The generic CLI: the command that receives the chats, as a JSON list, `{{prompt}}` shown literally. */
        disclosureCommand(command: string): string
        /** The config file was modified while the user was being asked: nothing was written. */
        changedWhileEditing(file: string): string
        disclosurePolicy(url: string): string
        readonly disclosureNoPolicy: string
        readonly disclosureLocalOnly: string
        /** The generic CLI: what `acknowledgeRisk` is, before anything is activated. */
        readonly genericExplain: string
        confirm(provider: string): string
        readonly noTerminal: string
        readonly cancelled: string
        wrote(file: string, role: string, provider: string): string
        keyReminder(name: string): string
        readonly genericNotAcknowledged: string
        readonly testReminder: string
      }
      readonly test: {
        noneConfigured(role: string): string
        noModel(kind: string): string
        noticeExternal(hosts: string): string
        noticeLocal(url: string): string
        running(kind: string): string
        ok(kind: string, ms: number, needsReply: string, priority: string): string
        failed(kind: string, reason: string): string
        readonly yes: string
        readonly no: string
        readonly priorities: { readonly high: string; readonly medium: string; readonly low: string }
        readonly hints: {
          missingKey(name: string): string
          readonly authFailed: string
          readonly unknownModel: string
          readonly rateLimit: string
          readonly noCredit: string
          readonly timeout: string
          readonly disabled: string
          readonly verifyFailed: string
          readonly unreachable: string
          readonly redirect: string
          readonly geminiSchemaShape: string
          readonly generic: string
        }
      }
    }
    /** `msum secret set|rm|ls`: the API keys (RNF-04). A key is never printed, not even partly. */
    readonly secret: {
      /** The question on a terminal; the typing is not shown. */
      keyPrompt(provider: string): string
      readonly emptyKey: string
      readonly invalidKey: string
      stored(provider: string, file: string): string
      /** A variable of the environment wins over the stored key; `names` is the list of variables. */
      envWins(names: string): string
      removed(provider: string, file: string): string
      notStored(provider: string, file: string): string
      /** The file exists and is not a JSON object: it is not touched. */
      invalidFile(file: string): string
      readonly header: string
      /** `provider` is already padded to the width of the column; `source` comes from the `source*` texts. */
      row(provider: string, source: string): string
      readonly precedence: string
      sourceEnv(name: string): string
      sourceAccountFile(file: string): string
      sourceFile(file: string): string
      readonly sourceNone: string
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
    /** `msum whisper models|download` (RF-22): the whisper.cpp models of the installation. */
    readonly whisper: {
      readonly modelsHeader: string
      /** `name` and `size` are already padded to the width of their column. */
      modelRow(name: string, size: string, installed: boolean): string
      /** Printed under the list: how to download one, and where from (RNF-01). */
      modelsHint(dir: string): string
      downloading(name: string, size: string, from: string): string
      /** One line of progress, at every tenth of the file. The sizes are already formatted. */
      progress(percent: number, received: string, total: string): string
      done(name: string, path: string): string
      alreadyThere(name: string, path: string): string
      /** What to do next, after a download: turn it on in the configuration. */
      enableHint(name: string): string
      unknownModel(name: string, known: string): string
      httpError(status: number): string
      readonly networkError: string
      readonly sizeError: string
      readonly checksumError: string
      writeError(dir: string): string
    }
    /** `msum ollama recommend|pull` (RF-45): the small local models to choose from, and the download of one. */
    readonly ollama: {
      /** `gb` is already formatted ("16"). */
      ramLine(gb: string): string
      readonly candidatesHeader: string
      /** `size` and `ram` are already formatted; `evaluation` is the text of `evaluationDone` or `evaluationNone`. */
      candidateRow(tag: string, size: string, ram: string, fits: boolean, evaluation: string): string
      readonly evaluationNone: string
      /** `agreement` is on the clear cases; `latency` is already formatted. */
      evaluationDone(date: string, validJson: string, agreement: string, latency: string, passed: boolean): string
      /** Candidates that need more RAM than this machine has are hidden unless `--all`. */
      hidden(count: number): string
      noneFits(minGb: number): string
      /** The user chooses: nothing is picked or written. The commands to run next. */
      readonly choose: string
      invalidTag(tag: string): string
      /** Pulling needs an Ollama on this machine, unless `--allow-remote` says otherwise. */
      remoteRefused(origin: string): string
      pulling(tag: string, origin: string): string
      /** One line of progress. The sizes are already formatted. */
      progress(percent: number, received: string, total: string): string
      status(status: string): string
      done(tag: string): string
      doneHint(tag: string): string
      failed(reason: string): string
    }
    readonly unlink: {
      confirm(id: string): string
      activeInDaemon(id: string, pid: number): string
      beingLinked(id: string, pid: number, lockFile: string): string
      readonly cancelled: string
      done(id: string): string
    }
    /** `msum service install|uninstall|status` (RF-80): the daemon as a service of the user's session. */
    readonly service: {
      installed(location: string): string
      alreadyInstalled(location: string): string
      removed(location: string): string
      readonly notInstalled: string
      /** `running` is null when the system cannot tell. */
      statusInstalled(location: string, running: boolean | null): string
      readonly statusNotInstalled: string
      /** What the daemon lock says, whatever started the daemon: `pid` is null when none runs. */
      statusDaemon(pid: number | null): string
      readonly hintEnableLinger: string
      readonly hintStartAtNextLogin: string
      readonly hintStopRunningDaemon: string
      /** A daemon started by hand holds the installation, so the service was registered but not started now. */
      hintManualDaemon(pid: number): string
      /** The node of the service is inside a version manager's directory. */
      readonly hintVersionManager: string
      failed(step: string, detail: string): string
      unsupported(platform: string): string
      /** The compiled entry point is missing (running from the sources): there is nothing to register. */
      notBuilt(entry: string): string
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
        readonly transcription: string
        readonly whisper: string
        readonly ffmpeg: string
        readonly whisperModel: string
        readonly mediaFiles: string
        readonly secrets: string
      }
      /** A file with API keys that other users can read (RNF-04). `mode` is octal text. */
      secretsLoose(file: string, mode: string): string
      secretsLooseFix(file: string): string
      /** The downloaded audios of the account take (nearly) all the space they are allowed (`transcription.maxMediaMb`). */
      mediaFull(usedMb: number, capMb: number): string
      readonly mediaFullFix: string
      /** Transcription is off: audios show as not transcribed, and that is fine (RF-21). */
      readonly transcriptionOff: string
      transcriptionOn(language: string): string
      whisperOk(version: string | null): string
      whisperMissing(command: string): string
      readonly whisperFix: string
      ffmpegOk(version: string | null): string
      ffmpegMissing(command: string): string
      readonly ffmpegFix: string
      readonly modelNone: string
      readonly modelNoneFix: string
      modelMissing(path: string): string
      readonly modelMissingFix: string
      /** The file is there and its SHA-256 is the pinned one of a known model. */
      modelVerified(path: string): string
      /** The file is there but no checksum is pinned for it (a model of your own). */
      modelUnverified(path: string): string
      readonly modelUnverifiedFix: string
      modelBadChecksum(path: string): string
      readonly modelBadChecksumFix: string
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
      /** An API provider with its model and the key found (`source` is already translated). No request is made (RNF-01). */
      providerApiOk(provider: string, model: string, keyName: string, source: string): string
      /** A compatible server that needs no key and has none. `keyName` is the stored key it would use. */
      providerApiKeyOptional(provider: string, model: string, keyName: string): string
      providerApiNoKey(provider: string, keyName: string): string
      /** `keyName` is the argument of `msum secret set`. */
      providerApiNoKeyFix(keyName: string, envNames: string): string
      providerApiNoModel(provider: string): string
      providerApiNoModelFix(provider: string): string
      /** A CLI provider after `verify` (RF-49): found, with its version, and the flags of the hardening are all there. */
      cliVerified(provider: string, version: string | null): string
      /** `--help` does not list a flag the hardening relies on: this version cannot be run without tools. */
      cliMissingFlags(provider: string, flags: string): string
      cliMissingFlagsFix(provider: string): string
      cliUnrunnable(provider: string): string
      cliUnrunnableFix(provider: string): string
      /** A preset shipped disabled: its documentation has no way to run it without tools that can be verified. */
      cliDisabled(provider: string): string
      cliDisabledFix(provider: string): string
      /** The generic CLI without `acknowledgeRisk`: refused. */
      readonly genericNotAcknowledged: string
      readonly genericNotAcknowledgedFix: string
      /** The generic CLI with the risk acknowledged: it runs, and this is said every time. */
      genericRisk(command: string): string
      readonly genericRiskFix: string
      /** The command has `{{prompt}}`: the chat is in the arguments, which other local users can read with `ps`. */
      readonly genericPromptInArgv: string
      readonly genericPromptInArgvFix: string
      /** RNF-02: a provider that sends the chats out with no recorded consent. A warning, never a block. */
      consentMissing(provider: string, hosts: string): string
      consentMissingFix(provider: string): string
      /** Ollama at an address that is not this machine: the chats go to a server of the user's, but out of this computer. */
      ollamaRemote(origin: string): string
      readonly ollamaRemoteFix: string
      /** The configured Ollama has the model (a call to the user's own server, `/api/tags`, with a short timeout). */
      ollamaModelOk(model: string): string
      /** Ollama answers and has no such model: the digests would fail with it. */
      ollamaModelMissing(model: string): string
      ollamaModelMissingFix(model: string): string
      /** The list of models could not be read (a warning: the server answered the reachability check). */
      ollamaModelUnknown(reason: string): string
      readonly ollamaModelUnknownFix: string
      /** After the providers: the way to try them for real, which `doctor` never does (RNF-01). */
      readonly providerTestHint: string
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
  | 'openaiModel'
  | 'openaiBaseUrl'
  | 'anthropicModel'
  | 'geminiModel'

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
    /** Said before the command `msum open`. */
    readonly unauthorizedText: string
    readonly unauthorizedNote: string
    readonly offline: string
    /** Punctuation that joins pieces of text, here because it is not the same in every language. */
    readonly text: {
      /** Between facts in a line: "Last digest · today 9:00". */
      readonly separator: string
      /** Between the items of a list: "Mon, Tue". */
      readonly listSeparator: string
      /** `{label}`, `{value}`. */
      readonly labelled: string
      /** Where there is nothing to say (a duration that is not known yet). */
      readonly none: string
      /** `{text}`: said to a screen reader after a name. */
      readonly aside: string
    }
    /** Asked when leaving a page with changes that are not saved. */
    readonly guard: {
      readonly title: string
      readonly text: string
      readonly discard: string
      readonly keep: string
    }
    readonly accountsTitle: string
    /** The title of the empty list of accounts. */
    readonly noAccounts: string
    /** The rail (or the strip on a small screen) with the accounts. */
    readonly shell: {
      readonly navLabel: string
      readonly home: string
      readonly accounts: string
      /** `{when}`: "Next today 19:00". */
      readonly next: string
      readonly noSchedules: string
      readonly running: string
    }
    /** What the pill of an account says beside the unit states. */
    readonly pills: { readonly sessionClosed: string; readonly invalidConfig: string; readonly running: string }
    readonly tabs: {
      readonly label: string
      readonly summary: string
      readonly conversations: string
      readonly schedules: string
      readonly history: string
      readonly settings: string
      readonly ask: string
    }
    readonly ask: {
      readonly title: string
      readonly questionLabel: string
      readonly placeholder: string
      readonly periodLabel: string
      readonly periods: { readonly today: string; readonly h24: string; readonly d3: string; readonly d7: string }
      readonly chatsLabel: string
      readonly chatsPlaceholder: string
      readonly shortcutsLabel: string
      readonly shortcuts: readonly { readonly label: string; readonly question: string }[]
      readonly submit: string
      readonly running: string
      /** `{read}`, `{answered}`: the pieces below, already with their plural. */
      readonly stats: string
      /** `{read}`, `{answered}`, `{failed}`. */
      readonly statsFailed: string
      /** Pieces of the stats: `{count}` in the plural forms. */
      readonly statsReadOne: string
      readonly statsReadMany: string
      readonly statsAnsweredOne: string
      readonly statsAnsweredMany: string
      readonly statsFailedOne: string
      readonly statsFailedMany: string
      readonly nothing: string
      readonly needsReply: string
      readonly copy: string
      readonly copied: string
      readonly remove: string
      readonly historyTitle: string
      readonly privateNote: string
      readonly mic: string
      readonly micListening: string
      readonly micUnsupported: string
      readonly micNote: string
      readonly notRunning: string
    }
    readonly home: {
      readonly summaryOne: string
      /** `{count}`. */
      readonly summaryMany: string
      readonly allFine: string
      readonly attentionOne: string
      /** `{count}`. */
      readonly attentionMany: string
      readonly next: string
      readonly emptyText: string
      readonly privacy: string
    }
    /** The page that adds an account, in four steps. */
    readonly addAccount: {
      readonly button: string
      readonly stepsLabel: string
      readonly steps: { readonly name: string; readonly link: string; readonly sync: string; readonly schedule: string }
      readonly idLabel: string
      readonly idPlaceholder: string
      readonly idHint: string
      /** `{id}`: what the name typed becomes (lowercase, no accents, hyphens for spaces), shown while typing. */
      readonly idPreview: string
      /** `{id}`: the name typed is the one of an account that already exists and is not linked: the wizard uses it. */
      readonly idPreviewExisting: string
      /** Nothing valid is left in the name (empty, or only symbols). */
      readonly idNothing: string
      readonly submit: string
      readonly scheduleTitle: string
      readonly finish: string
      readonly later: string
    }
    readonly account: {
      readonly noNumber: string
      readonly lastDigest: string
      readonly never: string
      readonly noSchedules: string
      readonly invalidConfig: string
      /** `{when}`. */
      readonly blockedSince: string
      /** `{when}`: when the web's retry becomes available. */
      readonly retryAvailable: string
      /** Heading of the list of problems of an invalid configuration. */
      readonly configIssues: string
      readonly fixSettings: string
      readonly configProblem: string
      readonly configProblemText: string
      /** Said with a session that only linking again fixes. */
      readonly closedNote: string
    }
    readonly retryConfirm: {
      readonly title: string
      readonly confirm: string
      readonly yes: string
      readonly no: string
    }
    readonly states: Readonly<Record<WebStateName, string>>
    readonly blockedReasons: Readonly<Record<BlockedReason, string>>
    readonly actions: {
      readonly digestNow: string
      readonly preview: string
      readonly open: string
      readonly link: string
      readonly relink: string
      readonly retry: string
    }
    /** The summary tab: the last digest and what is next. */
    readonly overview: {
      /** `{when}`. */
      readonly lastDigest: string
      /** `{count}`. */
      readonly conversations: string
      readonly conversationsOne: string
      readonly seeHistory: string
      readonly emptyTitle: string
      readonly emptyText: string
      /** An account that has made digests, none of them among the last runs. */
      readonly recentTitle: string
      readonly recentText: string
      readonly next: string
      readonly paused: string
      readonly changeSchedules: string
      readonly addSchedules: string
      readonly progressTitle: string
      readonly previewHelp: string
      readonly needsRelink: string
    }
    /** The message bubble that shows a digest as it lands in the chat. */
    readonly bubble: {
      readonly digest: string
      /** `{n}`, `{total}`. */
      readonly part: string
      readonly preparing: string
      readonly sent: string
      /** A digest read from the history: it was made, and the page cannot say that it arrived. */
      readonly generated: string
      readonly pending: string
      readonly queued: string
      readonly draft: string
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
      /** `{account}`. */
      readonly relinkTitle: string
      readonly starting: string
      readonly waitingQr: string
      /** `{account}`: the three steps to scan the code. */
      readonly first: string
      readonly second: string
      readonly third: string
      readonly renews: string
      readonly qrAlt: string
      readonly syncing: string
      readonly syncTitle: string
      readonly leaveNote: string
      /** `{count}`. */
      readonly chats: string
      /** `{count}`. */
      readonly messages: string
      readonly syncDone: string
      /** `{percent}` is a whole number from 0 to 100. */
      readonly percent: string
      readonly done: string
      readonly doneText: string
      /** `{account}`. */
      readonly goTo: string
      readonly failed: string
      readonly tryAgain: string
      readonly cancel: string
    }
    /** The legal notice shown before a WhatsApp account is linked for the first time (README, "Important warning" section). */
    readonly risk: {
      readonly heading: string
      readonly unofficial: string
      readonly readOnly: string
      readonly notAffiliated: string
      readonly responsibility: string
      readonly learnMore: string
      /** The README section of the language, on GitHub (a plain link: the page makes no request for it). */
      readonly learnMoreUrl: string
      readonly checkbox: string
      readonly start: string
    }
    readonly schedules: {
      /** `{zone}`: the time zone the times are in (read from the system, not chosen here). */
      readonly zoneLine: string
      /** Said only when the zone is UTC (a container): where to change it. */
      readonly zoneUtcHint: string
      readonly emptyTitle: string
      readonly empty: string
      readonly daysLabel: string
      readonly timeLabel: string
      readonly everyDay: string
      readonly weekdays: string
      /** `{when}`. */
      readonly nextRun: string
      /** `{days}`, `{times}`. */
      readonly summary: string
      /** `{time}`, `{days}`. */
      readonly summaryItem: string
      readonly summarySeparator: string
      /** Joins the last two times: "9:00 and 19:00". */
      readonly and: string
      readonly add: string
      readonly addTitle: string
      readonly editTitle: string
      readonly save: string
      readonly edit: string
      readonly delete: string
      /** `{time}`. */
      readonly deleteLabel: string
      readonly deleteTitle: string
      /** `{time}`, `{days}`. */
      readonly deleteText: string
      readonly saving: string
      readonly upcoming: string
      readonly paused: string
    }
    readonly settings: {
      /** Said once on top: changes apply without restarting or reconnecting. */
      readonly appliesLive: string
      readonly groups: { readonly digest: string; readonly languageTime: string; readonly provider: string }
      readonly fields: Readonly<Record<SettingsFieldKey, { readonly label: string; readonly hint?: string }>>
      /** Written inside the number fields. */
      readonly units: { readonly chars: string; readonly hours: string; readonly seconds: string }
      readonly languageNames: Readonly<Record<Language, string>>
      readonly providerNames: Readonly<Record<'claude-cli' | 'ollama' | 'openai' | 'anthropic' | 'gemini', string>>
      /** The choice of "no provider" (primary) or "no backup". */
      readonly none: string
      /** The small tag next to the title of a setting: where the value in force comes from. */
      readonly sources: { readonly account: string; readonly installation: string; readonly default: string }
      /** Under the Ollama address when its host is not this machine. */
      readonly remoteOllama: string
      /** Under the text fields that inherit when they are left empty. */
      readonly emptyInherits: string
      readonly privacyTitle: string
      /** One or two sentences on where the text of the chats goes with a provider; `{host}` for a remote Ollama. */
      readonly privacySummary: {
        readonly 'claude-cli': string
        readonly ollama: string
        readonly openai: string
        /** `{host}`. */
        readonly openaiCompatible: string
        /** The address is the installation's and cannot be seen from here. */
        readonly openaiInherited: string
        readonly anthropic: string
        readonly gemini: string
        readonly ollamaRemote: string
        readonly none: string
      }
      readonly privacyDetail: string
      readonly promptGroup: string
      readonly promptLabel: string
      readonly promptOriginal: string
      readonly promptModified: string
      readonly promptEdit: string
      readonly unsaved: string
      readonly discard: string
      readonly save: string
      readonly saving: string
      readonly saved: string
      /** `{option}`, `{reason}`: a problem that belongs to no field of the form. */
      readonly issue: string
      readonly issuesHeading: string
    }
    readonly prompt: {
      readonly title: string
      /** `{account}`. */
      readonly back: string
      /** What the text is: the instructions the model receives for each conversation. */
      readonly intro: string
      /** `{variable}` (the placeholder as it is written), `{name}`: what it is replaced with. */
      readonly nameNote: string
      /** `{variable}`: the owner has no name set, so a generic word is used. */
      readonly nameUnset: string
      readonly formatTitle: string
      /** The response format is fixed and added by the program. */
      readonly formatNote: string
      readonly label: string
      /** The picker of templates above the editor. */
      readonly templates: {
        readonly label: string
        readonly names: Readonly<Record<PromptPresetId, string>>
        /** Said after one is loaded: it is not saved until the user saves. */
        readonly loaded: string
        readonly confirmTitle: string
        readonly confirmText: string
        readonly confirmYes: string
        readonly confirmNo: string
      }
      readonly sources: { readonly account: string; readonly installation: string; readonly default: string }
      /** The pill: the prompt is not the original one. */
      readonly differs: string
      readonly sameAsOriginal: string
      /** `{count}`, `{max}`. */
      readonly counter: string
      /** The prompt file of the account is set and cannot be read. */
      readonly fileMissing: string
      /** `{variables}`: placeholders that are not variables (checked while typing). */
      readonly unknownVariable: string
      /** `{max}`. */
      readonly tooLong: string
      readonly blank: string
      readonly save: string
      readonly saving: string
      readonly saved: string
      readonly noChanges: string
      readonly restore: string
      readonly restoreTitle: string
      readonly restoreConfirm: string
      /** Said under the confirmation: an installation prompt file, when there is one, takes the place of the original. */
      readonly restoreInherits: string
      readonly restoreYes: string
      readonly restoreNo: string
      readonly restoring: string
      readonly restored: string
      /** Said after a restore when the account inherits the installation's prompt. */
      readonly restoredInherited: string
      /** The button that runs a preview with this prompt. */
      readonly preview: string
    }
    readonly conversations: {
      /** What the two marks do, said once on top; each goes after the name of the mark in bold. */
      readonly explainExclude: string
      readonly explainLocalOnly: string
      readonly searchLabel: string
      readonly searchPlaceholder: string
      readonly filterLabel: string
      readonly filters: { readonly all: string; readonly excluded: string; readonly local: string }
      readonly empty: string
      readonly noResults: string
      readonly noResultsHint: string
      readonly showAll: string
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
      readonly summarize: string
      readonly exclude: string
      readonly localOnly: string
      /** Under an excluded chat: "local only" does not apply to it. */
      readonly excludedNote: string
      /** Said once: a mark covers the ids known for this chat; a second chat of the same person is marked on its own. */
      readonly aliasNote: string
      /** Under a mark that comes from a pattern of the configuration (not removable here). */
      readonly fromPattern: string
      /** Said when the "local only" mark cannot be turned on: no Ollama model. */
      readonly localUnavailable: string
      /** `{count}`: asked before excluding a chat with stored messages. */
      readonly confirmDelete: string
      readonly confirmYes: string
      readonly unlistedHeading: string
      readonly unlistedHint: string
      /** `{shown}`, `{total}`. */
      readonly shown: string
      /** `{shown}`, `{loaded}`: with a filter on, of the conversations loaded so far. */
      readonly shownOfLoaded: string
      readonly loadMore: string
      readonly saving: string
    }
    readonly history: {
      readonly empty: string
      /** `{shown}`, `{total}`. */
      readonly shown: string
      readonly loadMore: string
      readonly columns: {
        readonly number: string
        readonly date: string
        readonly origin: string
        readonly conversations: string
        readonly failed: string
        readonly duration: string
        readonly state: string
      }
      /** `{n}`: the label of the link of a row. */
      readonly openRun: string
      readonly trigger: Readonly<Record<'schedule' | 'missed' | 'manual' | 'cli', string>>
      readonly outcome: Readonly<Record<'committed' | 'empty' | 'failed' | 'running' | 'partial', string>>
      /** `{n}`. */
      readonly seconds: string
      /** `{m}`, `{s}`. */
      readonly minutes: string
      readonly underSecond: string
      /** `{duration}`. */
      readonly took: string
      readonly noProviders: string
      /** `{provider}`, `{count}`. */
      readonly providerCount: string
      /** The label of a provider the adapter reported as `unknown`. */
      readonly unknownProvider: string
      /** `{count}`. */
      readonly conversationsCount: string
      readonly conversationsOne: string
      /** A run that was cut off by a restart. */
      readonly interrupted: string
      /** `{account}`. */
      readonly back: string
      /** `{n}`. */
      readonly runTitle: string
      /** `{account}`. */
      readonly viewLogs: string
      readonly loadingDetail: string
      /** `{since}`, `{until}`. */
      readonly window: string
      readonly noDigest: string
      readonly emptyRun: string
      readonly runningRun: string
      readonly failedTitleOne: string
      /** `{count}`. */
      readonly failedTitleMany: string
      readonly allSummarized: string
      readonly reason: Readonly<Record<'localOnlyUnavailable' | 'timeout' | 'invalidSummary' | 'failed', string>>
      /** Said once at the bottom: what the history keeps and where. */
      readonly privateNote: string
    }
    readonly logs: {
      /** The link of the rail that opens the page. */
      readonly open: string
      readonly title: string
      /** Said once on top: what the log holds and does not. */
      readonly note: string
      readonly levelLabel: string
      /** The chips: a level and the more serious ones. */
      readonly levels: Readonly<Record<'info' | 'warn' | 'error', string>>
      readonly badge: Readonly<Record<'info' | 'warn' | 'error', string>>
      readonly accountLabel: string
      readonly allAccounts: string
      /** The lines that belong to no account, and the account column of them. */
      readonly installation: string
      readonly empty: string
      readonly loadOlder: string
      /** Said while the view follows the daemon. */
      readonly live: string
    }
    readonly preview: {
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
      readonly send: string
      readonly sendNote: string
      readonly copy: string
      readonly copied: string
      readonly adjustPrompt: string
      readonly generate: string
    }
    /** What each provider costs and does with the text of the chats (RF-41, RNF-02): shown before it is used. */
    readonly disclosure: {
      readonly sendsLabel: string
      /** What is sent, in the words of `msum provider use` (`DISCLOSURE_SENDS`): the text `CONSENT_TEXT_VERSION` stands for. */
      readonly sends: string
      readonly costLabel: string
      readonly leavesLabel: string
      readonly whoLabel: string
      readonly whatLabel: string
      readonly providers: Readonly<
        Record<
          'claude-cli' | 'ollama' | 'openai' | 'openai-compatible' | 'anthropic' | 'gemini',
          {
            readonly name: string
            readonly cost: string
            readonly leaves: string
            readonly who: string
            readonly what: string
            /** Only for the providers that run a program with tools (RF-49). */
            readonly tools?: string
            /** A caution that is not about cost or destination (the free tier of Gemini, RF-41). */
            readonly warning?: string
          }
        >
      >
      /** An Ollama server that is not on this machine: `{host}` in `leaves` and `who`. */
      readonly ollamaRemote: {
        readonly cost: string
        readonly leaves: string
        readonly who: string
        readonly what: string
        /** The conversations marked "local only" (RF-43) go to that host too. */
        readonly localOnly: string
      }
      readonly consentTitle: string
      /** `{provider}`: the name of the external provider. */
      readonly consentCheckbox: string
      readonly consentNeeded: string
      readonly consentAgree: string
      readonly consentSaving: string
      /** `{provider}`: the server answered that the recipient is another than the one on screen. */
      readonly consentChanged: string
      /** The API providers: conversations marked "local only" never go to an external provider (RF-43). */
      readonly apiLocalOnly: string
      /** The API key of a provider: stored on this computer, never shown again. */
      readonly keys: {
        readonly label: string
        /** `{destination}`. */
        readonly hint: string
        readonly placeholder: string
        /** `{host}`: the key of a server that is not OpenAI is kept apart from the OpenAI key. */
        readonly compatibleNote: string
        readonly destinations: {
          readonly openai: string
          readonly anthropic: string
          readonly gemini: string
          /** `{host}`. */
          readonly compatible: string
        }
        readonly status: {
          readonly checking: string
          readonly none: string
          readonly noneCompatible: string
          /** `{name}`. */
          readonly env: string
          readonly accountFile: string
          readonly file: string
        }
        readonly save: string
        readonly replace: string
        readonly remove: string
        readonly working: string
        readonly saved: string
        readonly removed: string
        /** `{name}`: the variable that wins. */
        readonly overriddenEnv: string
        readonly overriddenAccountFile: string
        readonly stillInForce: string
        readonly lockedAddress: string
        readonly clearedNote: string
      }
      readonly test: {
        readonly button: string
        readonly running: string
        readonly note: string
        /** `{ms}`. */
        readonly ok: string
        readonly needsConsent: string
        readonly errors: Readonly<Record<ProviderTestErrorCode, string>>
      }
    }
    /** The name of the language switch (Español | English) of the wizard and of the page that has no access. */
    readonly languageLabel: string
    /** The choice of a model from a list (the wizard and the settings): nobody types a model. */
    readonly models: {
      readonly choose: string
      /** The empty choice of Claude Code: the model the configuration has by default. */
      readonly byDefault: string
      readonly loading: string
      readonly needsKey: string
      /** The provider could not be reached to ask its models. */
      readonly listUnreachable: string
      /** The provider answered with something that is not a usable list. */
      readonly listFailed: string
      /** The Ollama address is not on this machine: its models are asked only after the agreement. */
      readonly needsConsent: string
      /** The list of the provider could not be read: these are the known models. */
      readonly fallback: string
      /** The provider did not accept the saved key. */
      readonly rejected: string
      /** Ollama answers and has no model, or does not answer. */
      readonly emptyOllama: string
      readonly invalidAddress: string
      readonly retry: string
      /** `{model}`: it was saved before and is not in the list. */
      readonly foreign: string
      /** The one typed name: a compatible server that gives no list. */
      readonly typingLabel: string
      readonly typingHint: string
      /** The address of the server is not saved yet, so its models cannot be asked. */
      readonly typingUnsaved: string
    }
    /** The first-use wizard (RF-70). */
    readonly wizard: {
      readonly title: string
      /** `{n}`, `{total}`. */
      readonly stepOf: string
      readonly stepsLabel: string
      readonly steps: Readonly<Record<SetupStep, string>>
      readonly back: string
      readonly next: string
      readonly saving: string
      readonly skip: string
      readonly skipConfirm: string
      readonly skipYes: string
      readonly skipNo: string
      readonly you: {
        readonly heading: string
        readonly intro: string
        readonly ownerLabel: string
        readonly ownerHint: string
        readonly ownerBlank: string
        readonly ownerTooLong: string
        readonly accountLabel: string
        readonly accountHint: string
        readonly accountLocked: string
      }
      readonly provider: {
        readonly heading: string
        readonly intro: string
        readonly laterNote: string
        readonly apiModelLabel: string
        readonly apiModelHint: string
        readonly openaiBaseUrlLabel: string
        readonly openaiBaseUrlHint: string
        /** Shown instead of the notice while the address is not a web address. */
        readonly openaiBaseUrlInvalid: string
        readonly modelLabel: string
        readonly baseUrlLabel: string
        readonly ollamaModelLabel: string
        readonly ollamaModelHint: string
        readonly remoteOllama: string
      }
      readonly link: {
        readonly heading: string
        readonly intro: string
        readonly needsLink: string
      }
      readonly done: {
        readonly heading: string
        readonly text: string
        /** What finishing does about the schedules. */
        readonly schedules: string
        readonly finish: string
      }
    }
  }
}
