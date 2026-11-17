import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_SOCKET_METHODS } from '../../support/whatsapp-fakes.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'infrastructure', 'whatsapp')

/** Names of Baileys methods that send, change presence or send receipts (RNF-17, AGENTS.md). */
const SENDERS = [
  ...FORBIDDEN_SOCKET_METHODS,
  'sendRawMessage',
  'sendMessageAck',
  'sendPassiveIq',
  'rejectCall',
  'updateBlockStatus',
  'groupCreate',
  'groupLeave',
  'newsletterCreate',
  'updateProfilePicture',
  'removeProfilePicture',
  'fetchMessageHistory',
  'logout',
  'resyncAppState',
  'requestPairingCode',
  'sendRetryRequest',
  'groupAcceptInvite',
  'newsletterFollow',
  'updateMediaMessage',
  'readMessages',
  'sendReceipt',
  'sendReceipts',
  'sendPresenceUpdate',
  'presenceSubscribe',
  'chatModify',
]

/**
 * Code without comments, so documentation can name what the module does not do. Strings are NOT stripped: a call such
 * as socket['sendMessage']() must be caught.
 */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '')

/**
 * The exact allow-list (RF-51): `sendMessage` may appear in ONE place, the body of the function `sendTextToSelf` in
 * baileys-socket.ts. Returns the code with that body cut out, and the body itself.
 */
const SEND_FILE = 'baileys-socket.ts'
const SEND_FUNCTION = /async function sendTextToSelf\([^)]*\)[^{]*\{\n([\s\S]*?)\n\}\n/

function splitAllowedSender(source: string): { rest: string; body: string | null } {
  const match = SEND_FUNCTION.exec(code(source))
  if (match === null) return { rest: code(source), body: null }
  return { rest: code(source).replace(SEND_FUNCTION, ''), body: match[1] ?? '' }
}

/** Where the name of the only send method may appear: its declaration, its wrapper and its single caller. */
const SEND_METHOD_FILES = ['baileys-socket.ts', 'connection.ts', 'self-chat-delivery.ts']

describe('the adapter is read only (RNF-17)', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    it(`${file} never names a method that sends, sets presence or sends receipts (outside the one allowed sender)`, () => {
      const { rest } = splitAllowedSender(readFileSync(join(dir, file), 'utf-8'))
      const found = SENDERS.filter((name) => new RegExp(`\\b${name}\\b`).test(rest))
      expect(found).toEqual([])
    })
  }

  it('sendMessage appears exactly once in the adapter: inside sendTextToSelf, in baileys-socket.ts', () => {
    const occurrences = files.flatMap((file) => {
      const count = (code(readFileSync(join(dir, file), 'utf-8')).match(/\bsendMessage\b/g) ?? []).length
      return count === 0 ? [] : [`${file}:${count}`]
    })
    expect(occurrences).toEqual([`${SEND_FILE}:1`])
    const { body } = splitAllowedSender(readFileSync(join(dir, SEND_FILE), 'utf-8'))
    expect(body).not.toBeNull()
    expect((body ?? '').match(/\bsendMessage\b/g)).toHaveLength(1)
  })

  it('the sender sends to the jid it computes from the authenticated user, as plain text, and nothing else', () => {
    const { body } = splitAllowedSender(readFileSync(join(dir, SEND_FILE), 'utf-8'))
    expect(body).toContain('const jid = selfChatJid(socket.user)')
    expect(body).toMatch(/socket\.sendMessage\(jid, \{ text, linkPreview: null \}\)/)
    expect(body).not.toMatch(/\b(sendPresenceUpdate|readMessages|relayMessage|sendReceipt)\b/)
    // The function takes the socket and the text: no recipient parameter.
    expect(code(readFileSync(join(dir, SEND_FILE), 'utf-8'))).toMatch(
      /async function sendTextToSelf\(socket: BaileysSocket, text: string\): Promise<void>/,
    )
  })

  it('sendTextToSelf is named only where it is declared, wrapped and called', () => {
    const naming = files.filter((file) => /\bsendTextToSelf\b/.test(code(readFileSync(join(dir, file), 'utf-8'))))
    expect(naming.sort()).toEqual([...SEND_METHOD_FILES].sort())
  })

  it('no file of src/ outside src/infrastructure/whatsapp/ imports baileys', () => {
    const src = join(dir, '..', '..')
    const walk = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(folder, entry.name))
          : entry.name.endsWith('.ts')
            ? [join(folder, entry.name)]
            : [],
      )
    const all = walk(src)
    expect(all.length).toBeGreaterThan(20)
    const offenders = all.filter(
      (file) => !file.startsWith(`${dir}/`) && /['"]baileys(\/[^'"]*)?['"]/.test(code(readFileSync(file, 'utf-8'))),
    )
    expect(offenders).toEqual([])
  })

  it('only baileys-socket.ts and auth-state.ts import Baileys at run time', () => {
    const importing = files.filter(
      (f) =>
        /from 'baileys'/.test(readFileSync(join(dir, f), 'utf-8')) &&
        !/import type/.test(
          readFileSync(join(dir, f), 'utf-8')
            .split('\n')
            .find((l) => l.includes("from 'baileys'")) ?? '',
        ),
    )
    expect(importing.sort()).toEqual(['auth-state.ts', 'baileys-socket.ts'])
  })
})
