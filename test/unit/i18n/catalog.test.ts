import { describe, expect, it } from 'vitest'
import { getCatalog, LANGUAGES } from '../../../src/infrastructure/i18n/index.js'

const es = getCatalog('es')
const en = getCatalog('en')

type Tree = { readonly [key: string]: unknown }

/** Paths of every leaf (string or function) with its type. */
function leaves(root: object, prefix = ''): [string, 'string' | 'function'][] {
  return Object.entries(root as Tree).flatMap(([key, value]): [string, 'string' | 'function'][] => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') return [[path, 'string']]
    if (typeof value === 'function') return [[path, 'function']]
    return leaves(value as Tree, path)
  })
}

const get = (root: object, path: string): unknown => path.split('.').reduce<unknown>((n, key) => (n as Tree)[key], root)

/** Arguments to call each function of the catalog with. A new function without an entry fails the test below. */
const SAMPLES: Record<string, unknown[][]> = {
  'ask.systemPrompt': [['What did Ana say?', 'Pao']],
  'ask.contactStatus': [['saved'], ['unsaved'], ['group']],
  'transcript.header': [
    [true, 'N'],
    [false, 'N'],
  ],
  'transcript.ownerLabel': [['N']],
  'transcript.massMessage': [['E']],
  'transcript.audio': [['T']],
  'transcript.copies': [[1], [2]],
  'digest.title': [['P', 'D']],
  'digest.headline': [
    [{ total: 1, unreadOnly: false, since: 'D', needsReply: 1, unsaved: 0 }],
    [{ total: 2, unreadOnly: true, since: 'D', needsReply: 2, unsaved: 3 }],
  ],
  'digest.unsavedTitle': [[1], [2]],
  'digest.hiddenRest': [[1], [2]],
  'digest.failedChats': [[1], [2]],
  'errors.settings.notString': [['opt']],
  'errors.settings.emptyString': [['opt']],
  'errors.settings.notArray': [['opt']],
  'errors.settings.notStringList': [['opt']],
  'errors.settings.emptyPattern': [['opt']],
  'errors.settings.emptyIdPattern': [['opt']],
  'errors.settings.notNumber': [['opt']],
  'errors.settings.notPositive': [['opt']],
  'errors.settings.notInteger': [['opt']],
  'errors.settings.notBoolean': [['opt']],
  'errors.settings.notObject': [['opt']],
  'cli.argErrors.unknownCommand': [['x']],
  'cli.argErrors.unknownOption': [['--x']],
  'cli.argErrors.missingValue': [['--x']],
  'cli.argErrors.unexpectedArgument': [['x']],
  'cli.argErrors.invalidNumber': [['--x']],
  'cli.argErrors.invalidDate': [['--x']],
  'cli.argErrors.invalidAccountId': [['X y']],
  'cli.argErrors.unknownSubcommand': [['x']],
  'cli.argErrors.invalidTime': [['x']],
  'cli.argErrors.conflictingOptions': [['--all']],
  'cli.import.notLegacy': [['/p']],
  'cli.import.instanceNotFound': [['x']],
  'cli.import.noSession': [['/p']],
  'cli.import.invalidDerivedId': [['x']],
  'cli.import.duplicateId': [['x']],
  'cli.import.targetLinked': [['x']],
  'cli.import.targetHasData': [['x']],
  'cli.import.daemonUsing': [['x', 1]],
  'cli.import.beingLinked': [['x', 1, '/d/link.lock']],
  'cli.import.legacyLive': [
    ['/p', ['wal', 'shm', 'recentWrite', 'recentSession']],
    ['/p', ['recentWrite']],
  ],
  'cli.import.dataMissing': [['/p', '/p/data/whatsapp.db']],
  'cli.import.privacyList': [
    ['/p', 'soloLocal', 'needsOllamaModel'],
    ['/p', 'soloLocal', 'invalid'],
    ['/p', 'excluir', 'invalid'],
  ],
  'cli.doctor.staleImport': [['.import-x, .import-y']],
  'cli.import.warning': [['  /p  ->  x']],
  'cli.import.starting': [['/p', 'x']],
  'cli.import.failed': [['x', 'E']],
  'cli.import.summary': [
    [
      {
        id: 'x',
        source: '/p',
        masked: '+99****9818',
        sessionFiles: 3,
        conversations: 2,
        participants: 1,
        messages: 4,
        skippedKinds: 1,
        excluded: 2,
        edited: 1,
        unreadCounted: 1,
        unreadMarked: 1,
        pointer: 'now',
        configWritten: ['hideRest'],
        configUnmapped: ['web'],
        configInvalid: ['excluir'],
        promptCopied: true,
        schedules: 0,
        mediaFiles: 1,
        imageTexts: 1,
        transcribeErrors: 1,
        pendingOutbox: 1,
        digestFiles: 1,
        otherState: ['k'],
      },
    ],
    [
      {
        id: 'x',
        source: '/p',
        masked: '+99****9818',
        sessionFiles: 1,
        conversations: 0,
        participants: 0,
        messages: 0,
        skippedKinds: 0,
        excluded: 0,
        edited: 0,
        unreadCounted: 0,
        unreadMarked: 0,
        pointer: null,
        configWritten: [],
        configUnmapped: [],
        configInvalid: [],
        promptCopied: false,
        schedules: 2,
        mediaFiles: 0,
        imageTexts: 0,
        transcribeErrors: 0,
        pendingOutbox: 0,
        digestFiles: 0,
        otherState: [],
      },
    ],
  ],
  'cli.argErrors.invalidDays': [['x']],
  'cli.argErrors.unknownProvider': [['openai, anthropic, gemini']],
  'cli.argErrors.unknownProviderKind': [['x', 'openai, gemini']],
  'cli.provider.ls.title': [['default']],
  'cli.provider.ls.kind': [['openai', 'd']],
  'cli.provider.ls.info': [['c', 'd', 'h', 'p']],
  'cli.provider.ls.state': [['r', 'k', 'u']],
  'cli.provider.ls.keyFrom': [['openai', 's']],
  'cli.provider.ls.keyMissing': [['openai']],
  'cli.provider.ls.keyOptional': [['openai-compatible']],
  'cli.provider.ls.usableNoKey': [['openai']],
  'cli.provider.ls.usableVerifyFailed': [['d']],
  'cli.provider.ls.consent': [['2026-11-17']],
  'cli.provider.ls.ollamaRemote': [['http://10.0.0.5:11434']],
  'cli.provider.use.disclosureCommand': [['["tool"]']],
  'cli.provider.use.changedWhileEditing': [['f']],
  'cli.doctor.ollamaRemote': [['http://10.0.0.5:11434']],
  'cli.doctor.ollamaModelOk': [['qwen3:4b']],
  'cli.doctor.ollamaModelMissing': [['qwen3:4b']],
  'cli.doctor.ollamaModelMissingFix': [['qwen3:4b']],
  'cli.doctor.ollamaModelUnknown': [['ollama did not answer in time']],
  'cli.ollama.ramLine': [['16']],
  'cli.ollama.candidateRow': [
    ['qwen3:4b', '2.5 GB', '8 GB', true, 'not evaluated'],
    ['qwen3:8b', '5.2 GB', '16 GB', false, 'not evaluated'],
  ],
  'cli.ollama.evaluationDone': [
    ['2026-11-18', '100%', '93%', '3.6 s', true],
    ['2026-11-18', '98%', '80%', '2.1 s', false],
  ],
  'cli.ollama.hidden': [[1], [3]],
  'cli.ollama.noneFits': [[8]],
  'cli.ollama.invalidTag': [['bad tag']],
  'cli.ollama.remoteRefused': [['http://10.0.0.5:11434']],
  'cli.ollama.pulling': [['qwen3:4b', 'http://127.0.0.1:11434']],
  'cli.ollama.progress': [[40, '60 MB', '148 MB']],
  'cli.ollama.status': [['writing manifest']],
  'cli.ollama.done': [['qwen3:4b']],
  'cli.ollama.doneHint': [['qwen3:4b']],
  'cli.ollama.failed': [['disk full']],
  'cli.doctor.consentMissing': [['openai', 'api.openai.com']],
  'cli.doctor.consentMissingFix': [['openai']],
  'cli.provider.use.notWritten': [['f']],
  'cli.provider.use.fileNotJson': [['f']],
  'cli.provider.use.disclosureTitle': [['openai']],
  'cli.provider.use.disclosureHosts': [['h']],
  'cli.provider.use.disclosurePolicy': [['https://x']],
  'cli.provider.use.confirm': [['openai']],
  'cli.provider.use.wrote': [['f', 'primary', 'openai']],
  'cli.provider.use.keyReminder': [['openai']],
  'cli.provider.test.noneConfigured': [['primary']],
  'cli.provider.test.noModel': [['openai']],
  'cli.provider.test.noticeExternal': [['h']],
  'cli.provider.test.noticeLocal': [['http://x']],
  'cli.provider.test.running': [['openai']],
  'cli.provider.test.ok': [['openai', 5, 'yes', 'high']],
  'cli.provider.test.failed': [['openai', 'r']],
  'cli.provider.test.hints.missingKey': [['openai']],
  'cli.secret.keyPrompt': [['openai']],
  'cli.secret.stored': [['openai', 'f']],
  'cli.service.alreadyInstalled': [['/p/unit']],
  'cli.service.failed': [['bootstrap', 'denied']],
  'cli.service.hintManualDaemon': [[4242]],
  'cli.service.installed': [['/p/unit']],
  'cli.service.notBuilt': [['/p/cli.js']],
  'cli.service.removed': [['/p/unit']],
  'cli.service.statusDaemon': [[4242], [null]],
  'cli.service.statusInstalled': [
    ['/p/unit', true],
    ['/p/unit', false],
    ['/p/unit', null],
  ],
  'cli.service.unsupported': [['freebsd']],
  'cli.secret.envWins': [['OPENAI_API_KEY']],
  'cli.secret.removed': [['openai', 'f']],
  'cli.secret.notStored': [['openai', 'f']],
  'cli.secret.invalidFile': [['f']],
  'cli.secret.row': [['openai', 'file']],
  'cli.secret.sourceEnv': [['OPENAI_API_KEY']],
  'cli.secret.sourceAccountFile': [['f']],
  'cli.secret.sourceFile': [['f']],
  'cli.config.secretInConfig': [['provider.openai.apiKey']],
  'cli.config.invalidPort': [['web.port']],
  'cli.config.invalidHostName': [['web.allowedHosts']],
  'cli.config.belowMinimum': [['logs.maxBytes']],
  'cli.config.invalidUrl': [['provider.ollama.baseUrl']],
  'cli.config.installationOnly': [['web']],
  'cli.web.listening': [['127.0.0.1', 8787]],
  'cli.web.failed': [['127.0.0.1', 8787, 'EADDRINUSE']],
  'cli.web.exposed': [['0.0.0.0']],
  'cli.open.url': [['http://127.0.0.1:8787/#token=x']],
  'cli.open.openFailed': [['ENOENT']],
  'cli.config.inFile': [['f', 't']],
  'cli.config.unknownOption': [['opt']],
  'cli.config.notOneOf': [['opt', 'a, b']],
  'cli.config.required': [['opt']],
  'cli.config.invalidTimezone': [['opt']],
  'cli.config.promptFile': [['p']],
  'cli.unexpectedError': [['E']],
  'cli.cannotCreateDataDir': [['p']],
  'cli.init.created': [['d', 'c', 'UTC']],
  'cli.init.exists': [['c']],
  'cli.daemonRunning': [[1]],
  'cli.legacyDaemonRunning': [[1]],
  'cli.accounts.unknown': [
    ['x', 'a, b'],
    ['x', ''],
  ],
  'cli.accounts.ambiguous': [['a, b']],
  'cli.accounts.missingDir': [['x']],
  'cli.accounts.notADirectory': [['x']],
  'cli.accounts.row': [['id', 'whatsapp', 's']],
  'cli.accounts.linked': [['+99****1432']],
  'cli.accounts.blocked': [['r']],
  'cli.unlink.confirm': [['x']],
  'cli.unlink.done': [['x']],
  'cli.link.mismatch': [['x']],
  'cli.link.loggedOut': [['x']],
  'cli.blockedReasons.loggedOut': [['x']],
  'cli.blockedReasons.forbidden': [['x']],
  'cli.blockedReasons.replaced': [['x']],
  'cli.blockedReasons.socketFailed': [['x']],
  'cli.blockedReasons.notLinked': [['x']],
  'cli.blockedReasons.mismatch': [['x']],
  'cli.blockedReasons.noAccount': [['x']],
  'cli.link.alreadyLinked': [['x', 'a']],
  'cli.link.scanQr': [['q']],
  'cli.link.done': [['a']],
  'cli.link.failed': [['r']],
  'cli.daemon.running': [['d']],
  'cli.daemon.notLinked': [['x']],
  'cli.daemon.noSchedules': [['x']],
  'cli.link.activeInDaemon': [['x', 1]],
  'cli.link.beingLinked': [['x', 1, '/d/link.lock']],
  'cli.link.needsRetry': [['x']],
  'cli.unlink.activeInDaemon': [['x', 1]],
  'cli.unlink.beingLinked': [['x', 1, '/d/link.lock']],
  'cli.retry.beingLinked': [['x', 1, '/d/link.lock']],
  'cli.retry.notBlocked': [['x']],
  'cli.retry.needsRelink': [['x']],
  'cli.retry.done': [['x']],
  'cli.status.connection': [['s', 'w']],
  'cli.status.stateName': [['connecting'], ['connected'], ['reconnecting'], ['blocked'], ['idle']],
  'cli.daemon.blocked': [['r']],
  'cli.status.blocked': [['r', 'w']],
  'cli.digest.committed': [[1, 0, 2]],
  'cli.status.dataDir': [['p']],
  'cli.status.account': [
    ['x', 'a'],
    ['x', null],
  ],
  'cli.status.lastDigest': [['d'], [null]],
  'cli.status.pending': [[0]],
  'cli.status.configBroken': [['x']],
  'cli.status.daemon': [[1], [null]],
  'cli.status.schedule': [
    [1, 'd', '07:00', 'n'],
    [1, 'd', '07:00', null],
  ],
  'cli.schedule.dayName': [[0], [6]],
  'cli.schedule.row': [
    [1, 'd', '07:00', 'n'],
    [1, 'd', '07:00', null],
  ],
  'cli.schedule.added': [
    [1, 'd', '07:00', 'n'],
    [1, 'd', '07:00', null],
  ],
  'cli.schedule.removed': [[1]],
  'cli.schedule.notFound': [[1]],
  'cli.doctor.warn': [['n', 'd', 'f']],
  'cli.doctor.schedulesOk': [[2]],
  'cli.doctor.schedulesNotImported': [['* * * * *']],
  'cli.doctor.ok': [['n', 'd']],
  'cli.doctor.fail': [['n', 'd', 'f']],
  'cli.doctor.node': [['22.16.0']],
  'cli.doctor.nodeFix': [['22.16']],
  'cli.doctor.dataDirBad': [['p', '755']],
  'cli.doctor.dataDirFix': [['p']],
  'cli.doctor.providerOk': [['p', 'd']],
  'cli.doctor.providerMissing': [['c']],
  'cli.doctor.providerFix': [['ollama'], ['claude-cli']],
  'cli.doctor.secretsLoose': [['f', '644']],
  'cli.doctor.secretsLooseFix': [['f']],
  'cli.doctor.providerApiOk': [['openai', 'm', 'openai', 's']],
  'cli.doctor.providerApiKeyOptional': [['openai', 'm', 'openai-compatible']],
  'cli.doctor.providerApiNoKey': [['openai', 'openai']],
  'cli.doctor.cliVerified': [
    ['claude-cli', '1.0'],
    ['claude-cli', null],
  ],
  'cli.doctor.cliMissingFlags': [['claude-cli', '--tools']],
  'cli.doctor.cliMissingFlagsFix': [['claude-cli']],
  'cli.doctor.cliUnrunnable': [['claude-cli']],
  'cli.doctor.cliUnrunnableFix': [['claude']],
  'cli.doctor.cliDisabled': [['gemini-cli']],
  'cli.doctor.cliDisabledFix': [['gemini-cli']],
  'cli.doctor.genericRisk': [['my-cli']],
  'cli.config.invalidCommandTemplate': [['provider.genericCli.command']],
  'cli.config.genericCliWarning': [[true], [false]],
  'cli.doctor.providerApiNoKeyFix': [['openai', 'OPENAI_API_KEY']],
  'cli.doctor.providerApiNoModel': [['openai']],
  'cli.doctor.providerApiNoModelFix': [['openai']],
  'cli.doctor.accountName': [['n', 'x']],
  'cli.doctor.accountsOk': [[2]],
  'cli.doctor.accountsMissingDir': [['x']],
  'cli.doctor.accountsMissingDirFix': [['x']],
  'cli.doctor.accountsInvalid': [['a, b']],
  'cli.doctor.accountsIgnored': [['a, b']],
  'cli.config.invalidLanguage': [['transcription.language']],
  'cli.whisper.modelRow': [
    ['base', '148 MB', true],
    ['base', '148 MB', false],
  ],
  'cli.whisper.modelsHint': [['/d/models']],
  'cli.whisper.downloading': [['base', '148 MB', 'huggingface.co']],
  'cli.whisper.progress': [[40, '60 MB', '148 MB']],
  'cli.whisper.done': [['base', '/d/models/ggml-base.bin']],
  'cli.whisper.alreadyThere': [['base', '/d/models/ggml-base.bin']],
  'cli.whisper.enableHint': [['base']],
  'cli.whisper.unknownModel': [['x', 'tiny, base']],
  'cli.whisper.httpError': [[404]],
  'cli.whisper.writeError': [['/d/models']],
  'cli.doctor.transcriptionOn': [['auto'], ['es']],
  'cli.doctor.whisperOk': [['1.7.0'], [null]],
  'cli.doctor.whisperMissing': [['whisper-cli']],
  'cli.doctor.ffmpegOk': [['7.0'], [null]],
  'cli.doctor.ffmpegMissing': [['ffmpeg']],
  'cli.doctor.modelMissing': [['/d/models/ggml-base.bin']],
  'cli.doctor.modelVerified': [['/d/models/ggml-base.bin']],
  'cli.doctor.modelUnverified': [['/d/my.bin']],
  'cli.doctor.modelBadChecksum': [['/d/models/ggml-base.bin']],
  'cli.doctor.mediaFull': [[480, 500]],
}

describe('catalogs', () => {
  it('exist for every language', () => {
    expect(LANGUAGES).toEqual(['es', 'en'])
  })

  it('have the same keys, with the same kind of value, in Spanish and English', () => {
    expect(leaves(en)).toEqual(leaves(es))
  })

  it('have no empty text', () => {
    for (const [path, kind] of leaves(es)) {
      if (kind === 'string') {
        for (const catalog of [es, en]) expect((get(catalog, path) as string).trim(), path).not.toBe('')
      }
    }
  })

  it('give every function a sample call, and the samples match real functions', () => {
    const functions = leaves(es)
      .filter(([, kind]) => kind === 'function')
      .map(([path]) => path)
    expect(Object.keys(SAMPLES).sort()).toEqual(functions.sort())
  })

  it('have functions that return non-empty text, in both languages', () => {
    for (const [path, calls] of Object.entries(SAMPLES)) {
      for (const catalog of [es, en]) {
        for (const args of calls) {
          const text = (get(catalog, path) as (...a: unknown[]) => string)(...args)
          expect(typeof text, path).toBe('string')
          expect(text.trim(), path).not.toBe('')
        }
      }
    }
  })

  it('have a label for every kind of message', () => {
    const kinds = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'poll', 'event']
    for (const catalog of [es, en]) {
      expect(Object.keys(catalog.transcript.kinds).sort()).toEqual([...kinds].sort())
      for (const label of Object.values(catalog.transcript.kinds)) expect(label).toMatch(/^\[.+\]$/)
    }
  })

  it('differ between languages where the text is language-specific', () => {
    expect(en.defaultSystemPrompt).not.toBe(es.defaultSystemPrompt)
    expect(en.unnamedGroup).not.toBe(es.unnamedGroup)
    expect(en.defaultOwnerName).not.toBe(es.defaultOwnerName)
    expect(en.transcript.audioUntranscribed).not.toBe(es.transcript.audioUntranscribed)
  })

  it('write the owner tag of each language', () => {
    expect(es.transcript.ownerLabel('Sofía')).toBe('Sofía [VOS]')
    expect(en.transcript.ownerLabel('Sam')).toBe('Sam [YOU]')
  })

  it('use valid BCP 47 date locales', () => {
    expect(es.dateLocale).toBe('es-AR')
    expect(en.dateLocale).toBe('en-GB')
    for (const catalog of [es, en]) expect(() => new Intl.DateTimeFormat(catalog.dateLocale)).not.toThrow()
  })

  it('have the Spanish texts the golden files depend on', () => {
    expect(es.transcript.header(true, 'G')).toBe('Grupo: G')
    expect(es.transcript.header(false, 'G')).toBe('Chat con: G')
    expect(es.digest.title('WhatsApp', 'D')).toBe('Resumen WhatsApp — D')
    expect(es.digest.hiddenRest(2)).toBe('*⚪ El resto:* 2 chats sin nada para vos')
    expect(es.digest.hiddenRest(1)).toBe('*⚪ El resto:* 1 chat sin nada para vos')
  })
})
