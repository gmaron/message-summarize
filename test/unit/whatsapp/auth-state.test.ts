import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proto } from 'baileys'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTH_DIR_MODE,
  AUTH_FILE_MODE,
  loadSecureAuthState,
  settleAuthWrites,
  temporaryName,
} from '../../../src/infrastructure/whatsapp/auth-state.js'
import { isWindows } from '../../support/platform.js'

const mode = (path: string): number => statSync(path).mode & 0o777

const roots: string[] = []
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'message-summarize-authstate-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('secure auth state (RNF-04)', () => {
  // RF-46: POSIX modes do not exist on Windows, so the check of 0700/0600 is skipped there (the code is untouched).
  it.skipIf(isWindows)('creates the directory 0700 and writes every file 0600, whatever the umask', async () => {
    const previous = process.umask(0o000)
    try {
      const dir = join(root(), 'session')
      const { state, saveCreds } = await loadSecureAuthState(dir)
      expect(mode(dir)).toBe(AUTH_DIR_MODE)
      await saveCreds()
      await state.keys.set({ 'pre-key': { '1': { private: Buffer.from('a'), public: Buffer.from('b') } } })
      expect(readdirSync(dir).sort()).toEqual(['creds.json', 'pre-key-1.json'])
      for (const file of readdirSync(dir)) expect(mode(join(dir, file))).toBe(AUTH_FILE_MODE)
    } finally {
      process.umask(previous)
    }
  })

  it.skipIf(isWindows)(
    'tightens an existing directory and its files (an older version, or another tool, left them open)',
    async () => {
      const dir = join(root(), 'old')
      mkdirSync(dir, { mode: 0o755 })
      writeFileSync(join(dir, 'creds.json'), '{}', { mode: 0o644 })
      chmodSync(join(dir, 'creds.json'), 0o644)
      await loadSecureAuthState(dir)
      expect(mode(dir)).toBe(AUTH_DIR_MODE)
      expect(mode(join(dir, 'creds.json'))).toBe(AUTH_FILE_MODE)
    },
  )

  it('what is saved is loaded back, buffers included, and a deleted key is gone', async () => {
    const dir = join(root(), 'session')
    const first = await loadSecureAuthState(dir)
    await first.saveCreds()
    await first.state.keys.set({ session: { 'a/b:1': Buffer.from('secret') } })
    const second = await loadSecureAuthState(dir)
    expect(second.state.creds.registrationId).toBe(first.state.creds.registrationId)
    expect(
      Buffer.from(second.state.creds.noiseKey.private).equals(Buffer.from(first.state.creds.noiseKey.private)),
    ).toBe(true)
    const got = await second.state.keys.get('session', ['a/b:1', 'missing'])
    expect(Buffer.from(got['a/b:1'] as unknown as Uint8Array).toString()).toBe('secret')
    expect(got.missing).toBeNull()
    await second.state.keys.set({ session: { 'a/b:1': null } })
    expect((await second.state.keys.get('session', ['a/b:1']))['a/b:1']).toBeNull()
    expect(readdirSync(dir).filter((f) => f.startsWith('session'))).toEqual([])
  })

  it('writes without leaving temporary files, and many writes of one file keep a valid file', async () => {
    const dir = join(root(), 'session')
    const { saveCreds } = await loadSecureAuthState(dir)
    await Promise.all(Array.from({ length: 20 }, () => saveCreds()))
    expect(readdirSync(dir)).toEqual(['creds.json'])
    expect((await loadSecureAuthState(dir)).state.creds.registrationId).toBeTypeOf('number')
  })

  it('refuses a path that is a file', async () => {
    const file = join(root(), 'file')
    writeFileSync(file, 'x')
    await expect(loadSecureAuthState(file)).rejects.toThrow('not a directory')
  })

  it('two states over the same directory share the write queue: a file is never read half written', async () => {
    const dir = join(root(), 'session')
    const a = await loadSecureAuthState(dir)
    const b = await loadSecureAuthState(dir)
    const blob = (n: number) => ({ private: Buffer.alloc(200_000, n), public: Buffer.from('p') })
    let writes = 0
    const writers = [a, b].map(async (side, i) => {
      for (let n = 0; n < 15; n++) {
        await side.state.keys.set({ 'pre-key': { shared: blob(i * 20 + n) } })
        writes++
      }
    })
    // While they write, the file is read over and over: it is always a complete JSON document.
    const readers = Promise.all(
      Array.from({ length: 30 }, async () => {
        const got = await a.state.keys.get('pre-key', ['shared'])
        if (writes > 0)
          expect(Buffer.from((got.shared as unknown as { private: Uint8Array }).private)).toHaveLength(200_000)
      }),
    )
    await Promise.all([...writers, readers])
    await settleAuthWrites()
    expect(readdirSync(dir)).toEqual(['pre-key-shared.json'])
    const end = await loadSecureAuthState(dir)
    const final = await end.state.keys.get('pre-key', ['shared'])
    expect(Buffer.from((final.shared as unknown as { private: Uint8Array }).private)).toHaveLength(200_000)
  })

  it('temporary names are unique per call, and the files are renamed away', async () => {
    const names = new Set(Array.from({ length: 200 }, () => temporaryName('/x/creds.json')))
    expect(names.size).toBe(200)
    for (const name of names) expect(name).toMatch(/^\/x\/creds\.json\.\d+\.[0-9a-f-]{36}\.tmp$/)
    const dir = join(root(), 'session')
    const a = await loadSecureAuthState(dir)
    const b = await loadSecureAuthState(dir)
    await Promise.all([a.saveCreds(), b.saveCreds(), a.saveCreds(), b.saveCreds()])
    expect(readdirSync(dir)).toEqual(['creds.json'])
  })

  it('writes of one file from two states land in the order they were started', async () => {
    const dir = join(root(), 'session')
    const a = await loadSecureAuthState(dir)
    const b = await loadSecureAuthState(dir)
    const big = { private: Buffer.alloc(8_000_000, 1), public: Buffer.from('big') }
    const small = { private: Buffer.from('small'), public: Buffer.from('small') }
    const first = a.state.keys.set({ 'pre-key': { order: big } })
    const second = b.state.keys.set({ 'pre-key': { order: small } })
    await Promise.all([first, second])
    const got = await a.state.keys.get('pre-key', ['order'])
    expect(Buffer.from((got.order as unknown as { public: Uint8Array }).public).toString()).toBe('small')
  })

  it('settle waits for the writes in flight, so nothing is written after it returns', async () => {
    const dir = join(root(), 'session')
    const { state, saveCreds, settle } = await loadSecureAuthState(dir)
    void saveCreds()
    void state.keys.set({ 'pre-key': { '1': { private: Buffer.from('a'), public: Buffer.from('b') } } })
    await settle()
    const after = readdirSync(dir).sort()
    expect(after).toEqual(['creds.json', 'pre-key-1.json'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(readdirSync(dir).sort()).toEqual(after)
  })

  it('an app-state-sync-key is loaded back as the protobuf message', async () => {
    const dir = join(root(), 'session')
    const { state } = await loadSecureAuthState(dir)
    const key = proto.Message.AppStateSyncKeyData.create({ keyData: Buffer.from('key-bytes') })
    await state.keys.set({ 'app-state-sync-key': { KEY1: key } })
    const got = await (await loadSecureAuthState(dir)).state.keys.get('app-state-sync-key', ['KEY1', 'NONE'])
    expect(got.KEY1).toBeInstanceOf(proto.Message.AppStateSyncKeyData)
    expect(Buffer.from((got.KEY1 as { keyData: Uint8Array }).keyData).toString()).toBe('key-bytes')
    expect(got.NONE).toBeNull()
  })
})
