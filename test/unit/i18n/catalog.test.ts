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
        masked: '+54****0011',
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
        masked: '+54****0011',
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
  'cli.config.invalidPort': [['web.port']],
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
  'cli.accounts.linked': [['+54****0009']],
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
  'cli.doctor.accountName': [['n', 'x']],
  'cli.doctor.accountsOk': [[2]],
  'cli.doctor.accountsMissingDir': [['x']],
  'cli.doctor.accountsMissingDirFix': [['x']],
  'cli.doctor.accountsInvalid': [['a, b']],
  'cli.doctor.accountsIgnored': [['a, b']],
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
