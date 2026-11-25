import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DeliverPending } from '../../../src/application/deliver-pending.js'
import { loadSecureAuthState } from '../../../src/infrastructure/whatsapp/auth-state.js'
import { WhatsAppSelfChatDelivery } from '../../../src/infrastructure/whatsapp/self-chat-delivery.js'
import { type Installation, openInstallation } from '../../../src/main/accounts.js'
import { runMain } from '../../../src/main/app.js'
import { loadEffectiveConfig } from '../../../src/main/config.js'
import { maskAccount } from '../../../src/main/context.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { acquireLinkLock } from '../../../src/main/link-lock.js'
import { disposeHarnesses, type Harness, makeHarness } from '../../support/cli-harness.js'
import {
  ANA,
  BETO,
  buildLegacy,
  CAMI,
  GROUP,
  hashTree,
  LEGACY_CONFIG,
  LEGACY_PROMPT,
  MAIN_ME,
  MAIN_ME_CHAT,
  MAIN_POINTER,
  makeOld,
  standardData,
  TALLER_ME,
  TALLER_ME_CHAT,
  tallerOptions,
} from '../../support/legacy-fixture.js'
import { isWindows } from '../../support/platform.js'

afterEach(() => {
  disposeHarnesses()
})

const CONFIG = { language: 'en', timezone: 'America/Argentina/Buenos_Aires' }
const run = (h: Harness, ...argv: string[]) => runMain(argv, h.ctx)
const text = (lines: string[]) => lines.join('\n')
const mode = (path: string): number => statSync(path).mode & 0o777

/** A harness with no accounts and a made-up previous installation next to it. */
async function setup(options: { config?: Record<string, unknown>; accounts?: string[]; confirm?: boolean } = {}) {
  const h = await makeHarness({
    config: options.config ?? CONFIG,
    accounts: options.accounts ?? [],
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  })
  const root = join(h.dir, 'legacy')
  return { h, root }
}

async function accounts(h: Harness): Promise<string[]> {
  const opened = await openInstallation({ layout: h.layout, clock: h.clock })
  if (!opened.ok) throw new Error('refused')
  try {
    return opened.installation.accounts().map((a) => a.id)
  } finally {
    opened.installation.close()
  }
}

async function withInstallation<T>(h: Harness, work: (installation: Installation) => T): Promise<T> {
  const opened = await openInstallation({ layout: h.layout, clock: h.clock })
  if (!opened.ok) throw new Error('refused')
  try {
    return work(opened.installation)
  } finally {
    opened.installation.close()
  }
}

const rows = <T>(h: Harness, id: string, sql: string): T[] => {
  const runtime = h.runtime(id)
  try {
    return runtime.db.prepare(sql).all() as T[]
  } finally {
    runtime.close()
  }
}

describe('msum import: the main installation (RF-06)', () => {
  it('brings in the session, the messages, the unread state, the pointer and the settings', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const before = hashTree(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)

    // the account exists, is linked (a registered session) and is bound to the number of the session (RF-51)
    expect(await accounts(h)).toEqual(['default'])
    const runtime = h.runtime('default')
    try {
      expect(runtime.identity.get()).toBe(MAIN_ME_CHAT)
      expect(await runtime.store.getPointer()).toBe(MAIN_POINTER)
    } finally {
      runtime.close()
    }

    // conversations (a group, individuals, the one that only messages mention), participants, messages
    const conversations = rows<{
      id: string
      is_group: number
      name: string | null
      address: string
      unread_kind: string
      unread_count: number | null
    }>(h, 'default', 'SELECT id, is_group, name, address, unread_kind, unread_count FROM conversations ORDER BY id')
    expect(conversations.map((c) => c.id).sort()).toEqual([ANA, BETO, CAMI, GROUP].sort())
    const byId = Object.fromEntries(conversations.map((c) => [c.id, c]))
    expect(byId[GROUP]).toMatchObject({ is_group: 1, name: 'Grupo Vecinos', unread_kind: 'count', unread_count: 0 })
    expect(byId[ANA]).toMatchObject({
      is_group: 0,
      name: 'Ana Prueba',
      address: '+9916915573293',
      unread_kind: 'count',
      unread_count: 2,
    })
    expect(byId[BETO]).toMatchObject({ name: null, unread_kind: 'markedUnread' })
    // a masked name is no name, and an unknown unread state stays unknown
    expect(byId[CAMI]).toMatchObject({ name: null, unread_kind: 'unknown' })

    const participants = rows<{ id: string; saved_name: string | null; public_name: string | null }>(
      h,
      'default',
      'SELECT id, saved_name, public_name FROM participants ORDER BY id',
    )
    expect(participants).toEqual([
      { id: ANA, saved_name: 'Ana Prueba', public_name: 'Anita' },
      { id: BETO, saved_name: null, public_name: 'Beto Sin Agenda' },
      { id: CAMI, saved_name: null, public_name: null },
    ])

    const messages = rows<{
      id: string
      sender_id: string | null
      sender_name: string | null
      from_me: number
      timestamp: number
      kind: string
      text: string | null
      transcript: string | null
      read: number
    }>(
      h,
      'default',
      'SELECT id, sender_id, sender_name, from_me, timestamp, kind, text, transcript, read FROM messages ORDER BY timestamp',
    )
    // nine of the ten: the one of an unknown kind is not imported
    expect(messages.map((m) => m.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'g1', 'g2'])
    const message = Object.fromEntries(messages.map((m) => [m.id, m]))
    expect(message.a1).toMatchObject({ read: 1, sender_id: ANA, sender_name: 'Anita', from_me: 0, kind: 'text' })
    expect(message.a2?.read).toBe(0)
    expect(message.a4).toMatchObject({ from_me: 1, sender_id: null, sender_name: null })
    expect(message.b1).toMatchObject({ kind: 'audio', transcript: 'DESPUES-AUDIO necesito cinco cajas' })
    expect(message.b2).toMatchObject({ kind: 'image', text: '[imagen] flyer de la feria' })
    expect(message.g2?.text).toBe('(editado) DESPUES-EDITADO reunión el viernes')
    expect(message.g1?.sender_id).toBe(BETO)

    // the source did not change by a byte
    expect(hashTree(root)).toEqual(before)
  })

  it('prints a summary with counts and a masked number, and what was left behind, never a secret or a message', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const output = text(h.out)
    expect(output).toContain('Imported')
    expect(output).toContain('as the account "default"')
    expect(output).toContain(maskAccount(MAIN_ME_CHAT))
    expect(output).toContain('9 in 4 conversations, 3 contacts')
    expect(output).toContain('2 conversations with a count, 1 marked unread by hand')
    expect(output).toContain('(the first digest starts from here)')
    expect(output).toContain('1 messages of a kind this program does not know')
    expect(output).toContain('3 audio or image files')
    expect(output).toContain('1 texts read from images')
    expect(output).toContain('1 audio transcription errors')
    expect(output).toContain('1 digests that were waiting to be sent')
    expect(output).toContain('internal state: agenda_resync_v1, eventos_last_ts')
    expect(output).toContain('settings without an equivalent: ')
    for (const name of ['opcionInventada', 'leerImagenes', 'whisper.modelo', 'web']) {
      expect(output).toContain(name)
    }
    expect(output).toContain('(1 messages were edited')
    expect(output).toContain('--schedule 07:00,19:00')
    const everything = [text(h.out), text(h.err), ...h.logs].join('\n')
    expect(everything).not.toContain('9915434879818')
    expect(everything).not.toContain('DESPUES-')
    expect(everything).not.toContain('Ana Prueba')
    expect(everything).not.toContain('AAAA-one')
  })

  it('copies the session byte for byte, private, and this program reads it as it is', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const account = h.accountOf('default')
    // byte for byte
    const source = hashTree(join(root, 'auth'))
    expect(Object.keys(source).sort()).toEqual(['creds.json', 'pre-key-1.json', 'session-9919357142173_1.0.json'])
    expect(hashTree(account.authDir)).toEqual(source)
    // private
    if (!isWindows) expect(mode(account.dir)).toBe(0o700)
    if (!isWindows) expect(mode(account.authDir)).toBe(0o700)
    if (!isWindows)
      for (const name of readdirSync(account.authDir)) expect(mode(join(account.authDir, name))).toBe(0o600)
    if (!isWindows) expect(mode(account.dbFile)).toBe(0o600)
    if (!isWindows) expect(mode(account.configFile)).toBe(0o600)
    if (!isWindows) expect(mode(join(account.dir, 'prompt.md'))).toBe(0o600)
    // our own auth state loads it unchanged
    const auth = await loadSecureAuthState(account.authDir)
    expect(auth.state.creds.me?.id).toBe(MAIN_ME)
    if (!isWindows) expect(mode(account.authDir)).toBe(0o700)
    // and nothing else was left in the account, or beside it
    expect(readdirSync(account.dir).sort()).toEqual(['auth', 'config.json', 'db.sqlite', 'prompt.md'])
    expect(readdirSync(h.layout.accountsDir)).toEqual(['default'])
  })

  it('keeps what is only in the write-ahead log of the previous database', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: LEGACY_CONFIG, prompt: LEGACY_PROMPT, walOnly: true })
    expect(existsSync(join(root, 'data', 'whatsapp.db-wal'))).toBe(true)
    const before = hashTree(root)
    // a -wal next to the database means the tool has it open (or crashed): --force is what says "it is not running"
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(await run(h, 'import', '--from', root, '--yes', '--force')).toBe(0)
    const count = rows<{ n: number }>(h, 'default', 'SELECT COUNT(*) AS n FROM messages')[0]?.n
    expect(count).toBe(9)
    expect(hashTree(root)).toEqual(before) // not opened in place: its -wal and -shm are as they were
    expect(existsSync(join(root, 'data', 'whatsapp.db-shm'))).toBe(false)
  })

  it('writes the settings the previous tool had, only what differs, and copies the prompt with this program placeholder', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const written = JSON.parse(readFileSync(h.accountOf('default').configFile, 'utf8'))
    expect(written).toEqual({
      ownerName: 'Pat Prueba',
      excludePatterns: ['chat-excluido'],
      defaultWindowHours: 12,
      unreadOnly: true,
      flagUnsaved: true,
      hideRest: true,
      maxCharsPerConversation: 5000,
      localOnlyPatterns: ['banco'],
      provider: {
        primary: 'claude-cli',
        backup: 'ollama',
        claudeCli: { model: 'opus' },
        ollama: { model: 'modelo-de-prueba', numCtx: 8192 },
      },
      // the language of whisper (RF-23): the 14 days of history audio are this program's default, so not written; the
      // model of the fixture is not a known one, so it is reported and not written; transcription is not turned on
      transcription: { language: 'es' },
      promptFile: 'prompt.md',
    })
    // the account really runs with them: the file is valid with the installation's
    const effective = await loadEffectiveConfig(h.layout.configFile, h.accountOf('default').configFile)
    expect(effective.ok).toBe(true)
    if (effective.ok) {
      expect(effective.value.digest.ownerName).toBe('Pat Prueba')
      expect(effective.value.provider.claudeCli.model).toBe('opus')
      expect(effective.value.promptFile).toBe(join(h.accountOf('default').dir, 'prompt.md'))
    }
    const prompt = readFileSync(join(h.accountOf('default').dir, 'prompt.md'), 'utf8')
    expect(prompt).toContain('Sos el asistente de {{name}}.')
    expect(prompt).not.toContain('{{nombre}}')
  })

  it('shows the user the warning about two places and the plan, before copying anything', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const output = text(h.out)
    expect(output.indexOf('WARNING')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('WARNING')).toBeLessThan(output.indexOf('Imported'))
    expect(output).toContain('must NOT run in two places')
    expect(output).toContain('"replaced"')
    expect(output).toContain(`${root}  ->  default`)
    expect(h.questions).toEqual([]) // --yes: no question
  })

  it('speaks Spanish when the configuration says so', async () => {
    const { h, root } = await setup({ config: { ...CONFIG, language: 'es' } })
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(text(h.out)).toContain('ATENCIÓN')
    expect(text(h.out)).toContain('Se importó')
    expect(text(h.out)).toContain('NO se importó')
  })
})

describe('msum import: a digest over the imported data', () => {
  it('summarizes what came after the pointer and not what came before, with the imported settings and prompt', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: { ...LEGACY_CONFIG, soloNoLeidos: false }, prompt: LEGACY_PROMPT })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    h.out.length = 0
    expect(await run(h, 'digest', '--dry-run', '--account', 'default')).toBe(0)
    const sent = h.summarizer.requests.map((r) => r.transcript).join('\n')
    for (const expected of ['DESPUES-A2', 'DESPUES-A3', 'DESPUES-AUDIO', 'DESPUES-GRUPO', 'DESPUES-EDITADO']) {
      expect(sent, expected).toContain(expected)
    }
    expect(sent).not.toContain('ANTES-DEL-PUNTERO')
    expect(sent).not.toContain('tipo desconocido')
    // the imported prompt, with the name from miNombre
    const prompt = h.summarizer.requests[0]?.systemPrompt ?? ''
    expect(prompt).toContain('Sos el asistente de Pat Prueba.')
    expect(prompt).not.toContain('{{')
    expect(prompt).not.toContain('nota para quien edita')
    // the owner's own message is labelled as the owner's
    expect(sent).toContain('Pat Prueba [YOU]')
    expect(text(h.err)).toContain('Preview')
  })

  it('with unreadOnly from the previous settings, only the unread tails and the manually unread chats', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(await run(h, 'digest', '--dry-run', '--account', 'default')).toBe(0)
    const sent = h.summarizer.requests.map((r) => r.transcript).join('\n')
    expect(sent).toContain('DESPUES-A2') // two unread messages of Ana
    expect(sent).toContain('DESPUES-AUDIO') // Beto was marked unread by hand
    expect(sent).not.toContain('DESPUES-GRUPO') // the group has nothing unread
    // the message from before the pointer is only context for the unread ones, under its own heading
    expect(sent.indexOf('ANTES-DEL-PUNTERO')).toBeGreaterThan(sent.indexOf('Earlier messages, already read'))
    expect(sent.indexOf('ANTES-DEL-PUNTERO')).toBeLessThan(sent.indexOf('Unread messages (summarize these)'))
  })

  it('moves nothing of the carried pointer by a dry run, and a real digest continues from it', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: { ...LEGACY_CONFIG, soloNoLeidos: false }, prompt: null })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    await run(h, 'digest', '--dry-run')
    let runtime = h.runtime('default')
    expect(await runtime.store.getPointer()).toBe(MAIN_POINTER)
    runtime.close()
    expect(await run(h, 'digest')).toBe(0)
    runtime = h.runtime('default')
    expect(await runtime.store.getPointer()).toBe(h.clock.time)
    runtime.close()
  })
})

describe('msum import: schedules', () => {
  it('adds the times it is given, daily, once each, and says nothing about missing ones then', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes', '--schedule', '07:00,19:30,07:00')).toBe(0)
    h.out.length = 0
    expect(await run(h, 'schedule', 'ls')).toBe(0)
    expect(text(h.out)).toMatch(/every day at 07:00/)
    expect(text(h.out)).toMatch(/every day at 19:30/)
    expect(h.out).toHaveLength(2)
  })

  it('says that the previous tool kept its schedules outside its data, and imports none, when none are given', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(text(h.out)).toContain('cron of its sandbox, or launchd')
    expect(await withInstallation(h, (i) => i.schedules.list('default'))).toEqual([])
  })

  it('refuses a time that is not a time, before anything', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes', '--schedule', '25:00')).toBe(2)
    expect(await accounts(h)).toEqual([])
  })
})

describe('msum import: instances', () => {
  it('--instance imports that instance as an account named after it, with the root settings under its own', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: LEGACY_CONFIG, prompt: LEGACY_PROMPT }, { taller: tallerOptions() })
    const before = hashTree(root)
    expect(await run(h, 'import', '--from', root, '--instance', 'taller', '--yes')).toBe(0)
    expect(await accounts(h)).toEqual(['taller'])
    const runtime = h.runtime('taller')
    try {
      expect(runtime.identity.get()).toBe(TALLER_ME_CHAT)
      expect(await runtime.store.getPointer()).toBe(h.clock.time - 5 * 3_600_000)
    } finally {
      runtime.close()
    }
    expect(rows<{ n: number }>(h, 'taller', 'SELECT COUNT(*) AS n FROM messages')[0]?.n).toBe(2)
    const written = JSON.parse(readFileSync(h.accountOf('taller').configFile, 'utf8'))
    // its own values over the root's, `ollama` merged key by key (the url and context come from the root)
    expect(written).toMatchObject({
      ownerName: 'Taller Prueba',
      defaultWindowHours: 6,
      excludePatterns: ['otro-excluido'],
      maxCharsPerConversation: 5000,
      provider: { backup: 'ollama', ollama: { model: 'otro-modelo', numCtx: 8192 } },
      promptFile: 'prompt.md',
    })
    expect(readFileSync(join(h.accountOf('taller').dir, 'prompt.md'), 'utf8')).toBe('Prompt propio de {{name}}.')
    expect(hashTree(join(h.accountOf('taller').authDir))).toEqual(hashTree(join(root, 'instancias', 'taller', 'auth')))
    expect(hashTree(root)).toEqual(before)
  })

  it('an instance without a prompt of its own takes the root one; --account names the account', async () => {
    const { h, root } = await setup()
    buildLegacy(
      root,
      { config: LEGACY_CONFIG, prompt: LEGACY_PROMPT },
      { taller: { ...tallerOptions(), prompt: null } },
    )
    expect(
      await run(h, 'import', '--from', root, '--instance', 'taller', '--account', 'celular-de-taller', '--yes'),
    ).toBe(0)
    expect(await accounts(h)).toEqual(['celular-de-taller'])
    expect(readFileSync(join(h.accountOf('celular-de-taller').dir, 'prompt.md'), 'utf8')).toContain(
      'Sos el asistente de {{name}}.',
    )
  })

  it('--all imports the main installation and every instance, each as its own account', async () => {
    const { h, root } = await setup()
    buildLegacy(
      root,
      { config: LEGACY_CONFIG, prompt: LEGACY_PROMPT },
      { taller: tallerOptions(), Casa_Dos: { ...tallerOptions(), me: '9915842349337:1@s.whatsapp.net', prompt: null } },
    )
    const before = hashTree(root)
    expect(await run(h, 'import', '--from', root, '--all', '--yes')).toBe(0)
    expect(await accounts(h)).toEqual(['casa-dos', 'default', 'taller'])
    for (const [id, number] of [
      ['default', MAIN_ME_CHAT],
      ['taller', TALLER_ME_CHAT],
      ['casa-dos', '9915842349337@s.whatsapp.net'],
    ] as const) {
      const runtime = h.runtime(id)
      expect(runtime.identity.get(), id).toBe(number)
      runtime.close()
      expect(existsSync(join(h.accountOf(id).authDir, 'creds.json')), id).toBe(true)
    }
    expect(hashTree(root)).toEqual(before)
    // one question and one warning for all of them
    expect(text(h.out).match(/WARNING/g)).toHaveLength(1)
  })

  it('refuses --all with --account or --instance, and an instance that does not exist or cannot be an id', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: LEGACY_CONFIG, prompt: null }, { taller: tallerOptions() })
    expect(await run(h, 'import', '--from', root, '--all', '--account', 'x')).toBe(2)
    expect(text(h.err)).toContain('cannot be combined')
    h.err.length = 0
    expect(await run(h, 'import', '--from', root, '--instance', 'nadie', '--yes')).toBe(2)
    expect(text(h.err)).toContain('no instance named "nadie"')
    const long = 'x'.repeat(40)
    buildLegacy(join(h.dir, 'legacy2'), { config: LEGACY_CONFIG }, { [long]: tallerOptions() })
    h.err.length = 0
    expect(await run(h, 'import', '--from', join(h.dir, 'legacy2'), '--instance', long, '--yes')).toBe(2)
    expect(text(h.err)).toContain('Choose one with --account <id>')
    expect(await accounts(h)).toEqual([])
  })
})

describe('msum import: refusals', () => {
  it('refuses an account that is already linked, and changes nothing', async () => {
    const { h, root } = await setup({ accounts: ['default'] })
    buildLegacy(root)
    writeFileSync(
      join(h.account.authDir, 'creds.json'),
      JSON.stringify({ me: { id: '9915981279634:1@s.whatsapp.net' } }),
    )
    const before = hashTree(h.account.dir)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('already linked')
    expect(text(h.err)).toContain('msum unlink --account default')
    expect(hashTree(h.account.dir)).toEqual(before)
    expect(readdirSync(h.layout.accountsDir)).toEqual(['default'])
  })

  it('refuses an account the running daemon is using, naming how to stop it', async () => {
    const { h, root } = await setup({ accounts: ['default'] })
    buildLegacy(root)
    writeFileSync(
      join(h.account.authDir, 'creds.json'),
      JSON.stringify({ me: { id: '9915981279634:1@s.whatsapp.net' } }),
    )
    const lock = await acquireDaemonLock(h.layout.lockFile, process.pid)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain(`being used by the running daemon (pid ${process.pid})`)
    expect(text(h.err)).toContain('Ctrl+C')
    if (lock.ok) await lock.release()
  })

  it('refuses an account that is not linked but holds messages', async () => {
    const { h, root } = await setup({ accounts: ['default'] })
    buildLegacy(root)
    const runtime = h.runtime('default')
    await runtime.capture.receiveMessage({
      origin: 'history',
      isGroup: false,
      message: {
        id: 'x1',
        conversationId: ANA,
        senderId: ANA,
        senderName: null,
        senderAddress: '+9916915573293',
        fromMe: false,
        timestamp: 1,
        kind: 'text',
        text: 'ya estaba',
        transcript: null,
        read: false,
      },
    })
    runtime.close()
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('already exists and has data')
    expect(existsSync(join(root, 'auth', 'creds.json'))).toBe(true)
  })

  it('replaces an empty account left by a failed link', async () => {
    const { h, root } = await setup({ accounts: ['default'] })
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(existsSync(join(h.account.authDir, 'creds.json'))).toBe(true)
  })

  it('refuses while another process holds the account lock, naming the file', async () => {
    const { h, root } = await setup({ accounts: ['default'] })
    buildLegacy(root)
    const lock = await acquireLinkLock(h.account, process.ppid)
    expect(lock.ok).toBe(true)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain(h.account.linkLockFile)
    if (lock.ok) await lock.release()
  })

  it('refuses while the previous tool looks alive: its database was written a moment ago', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const now = new Date()
    const { utimesSync } = await import('node:fs')
    utimesSync(join(root, 'data', 'whatsapp.db'), now, now)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('looks like it is still running')
    expect(await accounts(h)).toEqual([])
    // once it is quiet, it goes ahead
    makeOld(root)
    h.err.length = 0
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
  })

  it('does nothing without the confirmation, and asks after showing the warning', async () => {
    const { h, root } = await setup({ confirm: false })
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root)).toBe(1)
    expect(h.questions).toEqual(['Import now? [y/N] '])
    expect(text(h.out)).toContain('WARNING')
    expect(text(h.err)).toContain('Nothing was imported')
    expect(await accounts(h)).toEqual([])
    expect(existsSync(h.accountOf('default').dir)).toBe(false)
  })

  it('imports after a yes', async () => {
    const { h, root } = await setup({ confirm: true })
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root)).toBe(0)
    expect(h.questions).toHaveLength(1)
    expect(await accounts(h)).toEqual(['default'])
  })

  it('refuses a path that is not an installation of the previous tool, and one with no session', async () => {
    const { h, root } = await setup()
    mkdirSync(root, { recursive: true })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(2)
    expect(text(h.err)).toContain('does not look like an installation')
    buildLegacy(join(h.dir, 'legacy-b'), { config: LEGACY_CONFIG, noSession: true })
    h.err.length = 0
    expect(await run(h, 'import', '--from', join(h.dir, 'legacy-b'), '--yes')).toBe(1)
    expect(text(h.err)).toContain('has no WhatsApp session')
    expect(await accounts(h)).toEqual([])
  })

  it('needs --from, and a valid account id', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--yes')).toBe(2)
    expect(text(h.err)).toContain('--from')
    expect(await run(h, 'import', '--from', root, '--account', '../x')).toBe(2)
  })
})

describe('msum import: is the previous tool running?', () => {
  const touchNow = async (path: string): Promise<void> => {
    const { utimesSync } = await import('node:fs')
    const now = new Date()
    utimesSync(path, now, now)
  }
  const old = new Date('2026-01-01T00:00:00Z')

  it('refuses when a -wal file is next to the database, saying so and how to clear it', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const wal = join(root, 'data', 'whatsapp.db-wal')
    writeFileSync(wal, '')
    const { utimesSync } = await import('node:fs')
    utimesSync(wal, old, old)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('looks like it is still running')
    expect(text(h.err)).toContain('whatsapp.db-wal exists')
    expect(text(h.err)).toContain('Stopping it')
    expect(text(h.err)).toContain('--force')
    expect(text(h.err)).not.toContain('db-shm')
    expect(await accounts(h)).toEqual([])
  })

  it('refuses when a -shm file is next to the database', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    writeFileSync(join(root, 'data', 'whatsapp.db-shm'), '')
    makeOld(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('whatsapp.db-shm exists')
    expect(text(h.err)).not.toContain('db-wal')
  })

  it('refuses when the database was written within the last minute', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    await touchNow(join(root, 'data', 'whatsapp.db'))
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('written to within the last minute')
    expect(text(h.err)).not.toContain('whatsapp.db-')
  })

  it('refuses when a file of the session was written within the last ten minutes', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    await touchNow(join(root, 'auth', 'pre-key-1.json'))
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('a file of its session (auth/) was written within the last 10 minutes')
    expect(text(h.err)).not.toContain('whatsapp.db')
    // eleven minutes ago is quiet enough
    const { utimesSync } = await import('node:fs')
    const quiet = new Date(Date.now() - 11 * 60_000)
    utimesSync(join(root, 'auth', 'pre-key-1.json'), quiet, quiet)
    h.err.length = 0
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
  })

  it('lists every signal that fires, and reads no file to find them (the source is untouched)', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    writeFileSync(join(root, 'data', 'whatsapp.db-wal'), '')
    writeFileSync(join(root, 'data', 'whatsapp.db-shm'), '')
    await touchNow(join(root, 'auth', 'creds.json'))
    const before = hashTree(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    for (const part of ['db-wal', 'db-shm', 'within the last 10 minutes']) expect(text(h.err)).toContain(part)
    expect(hashTree(root)).toEqual(before)
  })

  it('--force skips the check but still shows the warning and asks, unless --yes', async () => {
    const { h, root } = await setup({ confirm: false })
    buildLegacy(root)
    writeFileSync(join(root, 'data', 'whatsapp.db-shm'), '')
    makeOld(root)
    expect(await run(h, 'import', '--from', root, '--force')).toBe(1)
    expect(text(h.out)).toContain('WARNING')
    expect(h.questions).toHaveLength(1)
    expect(await accounts(h)).toEqual([])
    expect(await run(h, 'import', '--from', root, '--force', '--yes')).toBe(0)
    expect(h.questions).toHaveLength(1) // --yes: no more questions
    expect(await accounts(h)).toEqual(['default'])
  })

  it('says it in Spanish too', async () => {
    const { h, root } = await setup({ config: { ...CONFIG, language: 'es' } })
    buildLegacy(root)
    await touchNow(join(root, 'data', 'whatsapp.db'))
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('parece seguir corriendo')
    expect(text(h.err)).toContain('en el último minuto')
  })
})

describe('msum import: where the data is', () => {
  it('refuses when the database is not where it should be, mentioning WA_DATA_DIR, --data and --session-only', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const { rmSync } = await import('node:fs')
    rmSync(join(root, 'data'), { recursive: true })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('WA_DATA_DIR')
    expect(text(h.err)).toContain('--data <dir>')
    expect(text(h.err)).toContain('--session-only')
    expect(await accounts(h)).toEqual([])
  })

  it('--data points at a relocated data directory, read only, and the liveness checks look there', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const { renameSync, utimesSync } = await import('node:fs')
    const moved = join(h.dir, 'moved-data')
    renameSync(join(root, 'data'), moved)
    const before = { source: hashTree(root), data: hashTree(moved) }
    // it is not in data/ any more: refused without --data
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    // the relocated database is being written to: refused there too
    const now = new Date()
    utimesSync(join(moved, 'whatsapp.db'), now, now)
    h.err.length = 0
    expect(await run(h, 'import', '--from', root, '--data', moved, '--yes')).toBe(1)
    expect(text(h.err)).toContain('written to within the last minute')
    makeOld(moved)
    expect(await run(h, 'import', '--from', root, '--data', moved, '--yes')).toBe(0)
    expect(rows<{ n: number }>(h, 'default', 'SELECT COUNT(*) AS n FROM messages')[0]?.n).toBe(9)
    expect(hashTree(root)).toEqual(before.source)
    expect(hashTree(moved)).toEqual(before.data)
  })

  it('--session-only brings the session, the settings and the prompt, and no messages, pointer or database check', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes', '--session-only')).toBe(0)
    expect(rows<{ n: number }>(h, 'default', 'SELECT COUNT(*) AS n FROM messages')[0]?.n).toBe(0)
    const runtime = h.runtime('default')
    expect(runtime.identity.get()).toBe(MAIN_ME_CHAT)
    expect(await runtime.store.getPointer()).toBeNull()
    runtime.close()
    expect(existsSync(join(h.accountOf('default').authDir, 'creds.json'))).toBe(true)
    expect(JSON.parse(readFileSync(h.accountOf('default').configFile, 'utf8')).ownerName).toBe('Pat Prueba')
    expect(text(h.out)).toContain('0 in 0 conversations')
  })
})

describe('msum import: work directories left by a crash', () => {
  const stale = async (h: Harness, name: string, kind: 'dead' | 'none' | 'live'): Promise<string> => {
    const { hostname } = await import('node:os')
    const { utimesSync } = await import('node:fs')
    const dir = join(h.layout.accountsDir, name)
    mkdirSync(join(dir, 'auth'), { recursive: true })
    writeFileSync(join(dir, 'auth', 'creds.json'), '{"me":{"id":"x"}}')
    if (kind !== 'none') {
      const pid = kind === 'dead' ? 2 ** 22 + 1 : process.ppid
      writeFileSync(join(dir, 'import.lock'), `${JSON.stringify({ pid, host: hostname() })}\n`)
    }
    const past = new Date('2026-01-01T00:00:00Z')
    utimesSync(dir, past, past)
    return dir
  }

  it('an import removes the ones whose pid is dead or missing, and leaves one that is alive', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const dead = await stale(h, '.import-dead', 'dead')
    const none = await stale(h, '.import-none', 'none')
    const live = await stale(h, '.import-live', 'live')
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(none)).toBe(false)
    expect(existsSync(live)).toBe(true) // an import that is running is not touched
    expect(h.logs.some((line) => line.includes('import.staleRemoved') && line.includes('"count":2'))).toBe(true)
    expect(h.logs.join('')).not.toContain('creds')
  })

  it('a directory with no pid file that was just made is an import that is starting, not an abandoned one', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const fresh = join(h.layout.accountsDir, '.import-fresh')
    mkdirSync(fresh, { recursive: true })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('the daemon removes them when it starts', async () => {
    const { h } = await setup()
    const dead = await stale(h, '.import-dead', 'dead')
    const live = await stale(h, '.import-live', 'live')
    const finished = run(h, 'daemon')
    await (await import('../../support/cli-harness.js')).until(() => !existsSync(dead), 'the stale directory to go')
    expect(existsSync(live)).toBe(true)
    h.shutdown()
    expect(await finished).toBe(0)
  })

  it('doctor reports a stale one, saying it holds a copy of a WhatsApp session, and not a live one', async () => {
    const { h } = await setup({ accounts: ['default'] })
    await stale(h, '.import-dead', 'dead')
    await stale(h, '.import-live', 'live')
    expect(await run(h, 'doctor')).toBe(1)
    const output = text(h.out)
    expect(output).toContain('[fail] Accounts: directories of imports that did not finish')
    expect(output).toContain('.import-dead')
    expect(output).not.toContain('.import-live')
    expect(output).toContain('copy of a WhatsApp session')
    expect(output).not.toContain('not account directories') // not also reported as stray entries
  })
})

describe('msum import: what the account excludes (RF-14)', () => {
  it('never stores the chats that the installation or the previous tool excluded, and counts them', async () => {
    const { h, root } = await setup({ config: { ...CONFIG, excludePatterns: ['Beto'] } })
    buildLegacy(root, { config: { ...LEGACY_CONFIG, excluir: ['Grupo Vecinos'] }, prompt: null })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const chats = rows<{ conversation_id: string }>(h, 'default', 'SELECT DISTINCT conversation_id FROM messages')
    expect(chats.map((c) => c.conversation_id)).toEqual([ANA])
    expect(rows<{ n: number }>(h, 'default', 'SELECT COUNT(*) AS n FROM messages')[0]?.n).toBe(4)
    // three of Beto, two of the group: five that were not stored
    expect(text(h.out)).toContain('5 messages of chats that your exclusion patterns exclude (never stored)')
    expect(text(h.out)).toContain('4 in 4 conversations')
    // the settings keep what the installation lacks, and the digest never sees them
    expect(JSON.parse(readFileSync(h.accountOf('default').configFile, 'utf8')).excludePatterns).toEqual([
      'Grupo Vecinos',
    ])
    expect(await run(h, 'digest', '--dry-run')).toBe(0)
    const sent = h.summarizer.requests.map((r) => r.transcript).join('\n')
    expect(sent).not.toContain('DESPUES-GRUPO')
    expect(sent).not.toContain('DESPUES-AUDIO')
  })
})

describe('msum import: the privacy lists are never dropped silently', () => {
  it('refuses the whole import when soloLocal needs an Ollama model that is not there, saying what to fix', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: { proveedor: 'claude', soloLocal: ['banco'] }, prompt: null })
    const before = hashTree(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('"soloLocal"')
    expect(text(h.err)).toContain('needs an Ollama model')
    expect(text(h.err)).toContain('Set an Ollama model')
    expect(text(h.err)).toContain('remove soloLocal')
    expect(h.questions).toEqual([])
    expect(await accounts(h)).toEqual([])
    expect(readdirSync(h.layout.accountsDir)).toEqual([])
    expect(hashTree(root)).toEqual(before)
  })

  it('goes ahead when the installation provides the model', async () => {
    const { h, root } = await setup({ config: { ...CONFIG, provider: { ollama: { model: 'm' } } } })
    buildLegacy(root, { config: { proveedor: 'claude', soloLocal: ['banco'] }, prompt: null })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(JSON.parse(readFileSync(h.accountOf('default').configFile, 'utf8')).localOnlyPatterns).toEqual(['banco'])
  })

  it('refuses a list that is not a list of texts, soloLocal or excluir', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: { proveedor: 'claude', excluir: 'no es una lista' }, prompt: null })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(text(h.err)).toContain('"excluir"')
    expect(text(h.err)).toContain('Fix it in the previous config.json')
    h.err.length = 0
    buildLegacy(join(h.dir, 'legacy2'), {
      config: { proveedor: 'ollama', ollama: { modelo: 'm' }, soloLocal: 7 },
      prompt: null,
    })
    expect(await run(h, 'import', '--from', join(h.dir, 'legacy2'), '--yes')).toBe(1)
    expect(text(h.err)).toContain('"soloLocal"')
    expect(await accounts(h)).toEqual([])
  })

  it('still reports and drops the other invalid options, without refusing', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: { proveedor: 'claude', horasPorDefecto: -4, ocultarResto: true }, prompt: null })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    expect(text(h.out)).toContain('settings with an invalid value: horasPorDefecto')
  })
})

describe('msum import: the daemon never starts an account that is being imported', () => {
  const GAMMA = '9915842349337@s.whatsapp.net'

  /** A daemon host over the same installation, with a fake socket that records which accounts it was asked to open. */
  async function withHost(h: Harness) {
    const { DaemonHost } = await import('../../../src/main/daemon-host.js')
    const { FakeConnection } = await import('../../support/cli-harness.js')
    const connection = new FakeConnection()
    connection.user = { id: MAIN_ME }
    connection.onStart = () => connection.emit({ state: 'connected' })
    const opened: string[] = []
    Object.assign(h.ctx, {
      connectionFactory: async (runtime: { layout: { id: string }; capture: never }) => {
        opened.push(runtime.layout.id)
        connection.capture = runtime.capture
        return connection
      },
    })
    const installation = await openInstallation({ layout: h.layout, clock: h.clock })
    if (!installation.ok) throw new Error('refused')
    const host = new DaemonHost({
      ctx: h.ctx,
      installation: installation.installation,
      onlyAccount: null,
      language: 'en',
      timing: { scheduleReloadMs: 10, sweepMs: 50, shutdownGraceMs: 500, unitBackoffMs: 30 },
    })
    await host.start()
    return {
      host,
      opened,
      /** A second account appears and starts: a look of the daemon that included everything else has happened. */
      async lookAround(id: string): Promise<void> {
        await installation.installation.createAccount(id)
        const runtime = h.runtime(id)
        runtime.identity.bind(GAMMA)
        runtime.close()
        writeFileSync(join(h.accountOf(id).authDir, 'creds.json'), JSON.stringify({ me: { id: GAMMA } }))
        await (await import('../../support/cli-harness.js')).until(() => opened.includes(id), `${id} to start`)
      },
      async close(): Promise<void> {
        await host.stop()
        installation.installation.close()
      },
    }
  }

  it('keeps the lock of the account in it from the rename until the import ends, and a failure after the rename rolls back cleanly', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const world = await withHost(h)
    try {
      const seen: { lock: boolean; session: boolean }[] = []
      Object.assign(h.ctx, {
        afterImportStep: async (step: string) => {
          if (step !== 'renamed') return
          // the account now holds the imported session, and a live lock with it
          seen.push({
            lock: existsSync(h.accountOf('default').linkLockFile),
            session: existsSync(join(h.accountOf('default').authDir, 'creds.json')),
          })
          await world.lookAround('gamma')
          throw new Error('fails after the rename')
        },
      })
      expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
      expect(seen).toEqual([{ lock: true, session: true }])
      expect(world.opened).not.toContain('default')
      // rolled back: no account, no row, no files of it
      expect(existsSync(h.accountOf('default').dir)).toBe(false)
      expect(await accounts(h)).toEqual(['gamma'])
      // and the daemon goes on not seeing it, over more looks
      Object.assign(h.ctx, { afterImportStep: undefined })
      await world.lookAround('delta')
      expect(world.opened).not.toContain('default')
    } finally {
      await world.close()
    }
  })

  it('starts it only after the import has finished and released its lock', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    const world = await withHost(h)
    try {
      Object.assign(h.ctx, {
        afterImportStep: async (step: string) => {
          if (step !== 'renamed') return
          await world.lookAround('gamma')
          // The account is in place with its session, and the host has looked at the installation (it started gamma): it
          // must not have started this one, which the import still holds.
          expect(world.opened).not.toContain('default')
        },
      })
      expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
      // Not asserted here that "default" is still closed: the host polls on its own, so right after the import it may
      // have started the account already (the line that said so was a race, and failed on a loaded machine). That it did
      // not start it DURING the import is what the test above and the order below check.
      await (await import('../../support/cli-harness.js')).until(
        () => world.opened.includes('default'),
        'default to start',
      )
      expect(existsSync(h.accountOf('default').linkLockFile)).toBe(false)
      expect(world.opened.indexOf('default')).toBeGreaterThan(world.opened.indexOf('gamma'))
    } finally {
      await world.close()
    }
  })
})

describe('msum import: no partial account', () => {
  const steps = ['session', 'database', 'config', 'built', 'renamed'] as const

  for (const step of steps) {
    it(`an interruption after "${step}" leaves no account, no row, no files, and the source as it was`, async () => {
      const { h, root } = await setup()
      buildLegacy(root)
      const before = hashTree(root)
      Object.assign(h.ctx, {
        afterImportStep: (done: string) => {
          if (done === step) throw new Error('interrupted')
        },
      })
      expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
      expect(text(h.err)).toContain('Nothing was left behind')
      expect(await accounts(h)).toEqual([])
      expect(readdirSync(h.layout.accountsDir)).toEqual([])
      expect(await withInstallation(h, (i) => i.schedules.list('default'))).toEqual([])
      expect(hashTree(root)).toEqual(before)
    })

    it(`after "${step}" an account that existed empty is put back as it was`, async () => {
      const { h, root } = await setup({ accounts: ['default'] })
      buildLegacy(root)
      Object.assign(h.ctx, {
        afterImportStep: (done: string) => {
          if (done === step) throw new Error('interrupted')
        },
      })
      expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
      expect(await accounts(h)).toEqual(['default'])
      expect(readdirSync(h.layout.accountsDir)).toEqual(['default'])
      expect(existsSync(join(h.account.authDir, 'creds.json'))).toBe(false)
      expect(existsSync(h.account.dbFile)).toBe(false)
    })
  }

  it('a database that cannot be read fails the same way', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    writeFileSync(join(root, 'data', 'whatsapp.db'), 'this is not a database')
    makeOld(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(1)
    expect(await accounts(h)).toEqual([])
    expect(readdirSync(h.layout.accountsDir)).toEqual([])
  })

  it('when only one of several fails, the ones before it stay and the one that failed leaves nothing', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: LEGACY_CONFIG, prompt: null }, { taller: tallerOptions() })
    let databases = 0
    Object.assign(h.ctx, {
      afterImportStep: (done: string) => {
        if (done === 'database' && ++databases === 2) throw new Error('interrupted')
      },
    })
    // default is imported first and succeeds; taller fails after the database step
    expect(await run(h, 'import', '--from', root, '--all', '--yes')).toBe(1)
    expect(await accounts(h)).toEqual(['default'])
    expect(readdirSync(h.layout.accountsDir)).toEqual(['default'])
  })
})

describe('msum import: what is carried over without a legacy database, and RF-51', () => {
  it('imports a session and settings when the previous installation has no database', async () => {
    const { h, root } = await setup()
    buildLegacy(root, { config: LEGACY_CONFIG, prompt: null, data: null })
    expect(await run(h, 'import', '--from', root, '--yes', '--session-only')).toBe(0)
    expect(rows<{ n: number }>(h, 'default', 'SELECT COUNT(*) AS n FROM messages')[0]?.n).toBe(0)
    const runtime = h.runtime('default')
    expect(runtime.identity.get()).toBe(MAIN_ME_CHAT)
    expect(await runtime.store.getPointer()).toBeNull()
    runtime.close()
  })

  it('imports a database that has no pointer, and an older one without the later columns', async () => {
    const { h, root } = await setup()
    const data = standardData()
    buildLegacy(root, { config: null, prompt: null, data: { ...data, state: {} } })
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const runtime = h.runtime('default')
    expect(await runtime.store.getPointer()).toBeNull()
    runtime.close()
    expect(existsSync(h.account.configFile)).toBe(false) // nothing to write: no settings, no prompt
    expect(text(h.out)).toContain('the installation settings already match')
  })

  it("delivery is bound to the imported number: another phone's session cannot receive the digest", async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    const runtime = h.runtime('default')
    try {
      await runtime.store.commit({
        previousPointer: MAIN_POINTER,
        pointer: MAIN_POINTER + 1,
        digest: null,
        parts: ['PRIVATE PART'],
      })
      const sent: string[] = []
      const connection = (user: { id: string }) => ({
        selfChat: () => ({
          user,
          sendTextToSelf: async (value: string) => {
            sent.push(value)
          },
        }),
      })
      // the session of another number: refused, nothing is sent
      const wrong = new DeliverPending(
        runtime.outbox,
        new WhatsAppSelfChatDelivery(connection({ id: TALLER_ME }), runtime.identity),
      )
      expect(await wrong.run()).toEqual({ delivered: 0, failure: 'rejected' })
      expect(sent).toEqual([])
      // the imported session: delivered, to its own chat
      const own = new DeliverPending(
        runtime.outbox,
        new WhatsAppSelfChatDelivery(connection({ id: MAIN_ME }), runtime.identity),
      )
      expect(await own.run()).toEqual({ delivered: 1, failure: null })
      expect(sent).toEqual(['PRIVATE PART'])
    } finally {
      runtime.close()
    }
  })

  it('leaves the imported account to the daemon: it counts as linked, and `accounts` shows it', async () => {
    const { h, root } = await setup()
    buildLegacy(root)
    expect(await run(h, 'import', '--from', root, '--yes')).toBe(0)
    h.out.length = 0
    expect(await run(h, 'accounts')).toBe(0)
    expect(text(h.out)).toMatch(/default\s+whatsapp\s+linked/)
    // a read-only parent would not matter: nothing is written outside the data directory
    chmodSync(root, 0o500)
    chmodSync(root, 0o700)
  })
})
