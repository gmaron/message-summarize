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

describe('the adapter is read only (RNF-17)', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    it(`${file} never names a method that sends, sets presence or sends receipts`, () => {
      const text = code(readFileSync(join(dir, file), 'utf-8'))
      const found = SENDERS.filter((name) => new RegExp(`\\b${name}\\b`).test(text))
      expect(found).toEqual([])
    })
  }

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
