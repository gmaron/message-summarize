import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationTranscript, TranscriptEntry } from '../../../src/application/ports/rendering.js'
import type { Message, Participant } from '../../../src/domain/model.js'
import type { ChatResult } from '../../../src/domain/sections.js'
import type { ChatSummary } from '../../../src/domain/summary.js'

export const BA = 'America/Argentina/Buenos_Aires'

/** Epoch ms of a local time in Buenos Aires (UTC-3, no daylight saving). */
export const ba = (month: number, day: number, hour: number, minute: number): number =>
  Date.UTC(2026, month - 1, day, hour + 3, minute)

type EntryOverrides = Partial<Omit<Message, 'timestamp'>> & { copies?: number; isMass?: boolean }

const build = (
  timestamp: number,
  fromMe: boolean,
  participant: Participant | null,
  text: string | null,
  overrides: EntryOverrides,
): TranscriptEntry => {
  const { copies = 0, isMass = false, ...rest } = overrides
  return {
    message: {
      timestamp,
      fromMe,
      senderName: null,
      senderAddress: '+5491100000001',
      kind: 'text',
      text,
      transcript: null,
      copies,
      ...rest,
    },
    participant,
    isMass,
  }
}

/** A message from a saved contact. */
export const from = (name: string, timestamp: number, text: string | null, overrides: EntryOverrides = {}) =>
  build(timestamp, false, { id: name, savedName: name, publicName: null }, text, overrides)

/** A message of the owner. */
export const mine = (timestamp: number, text: string | null, overrides: EntryOverrides = {}) =>
  build(timestamp, true, null, text, overrides)

export const transcript = (overrides: Partial<ConversationTranscript> = {}): ConversationTranscript => ({
  name: 'Ana Gómez',
  isGroup: false,
  messages: [],
  context: [],
  ownerName: 'Sofía',
  maxChars: 24_000,
  ...overrides,
})

export const result = (
  name: string,
  summary: string,
  extra: Partial<ChatSummary> & { messageCount?: number; unsaved?: boolean } = {},
): ChatResult => {
  const { messageCount = 1, unsaved = false, ...s } = extra
  return {
    name,
    messageCount,
    unsaved,
    summary: { summary, todos: [], needsReply: false, priority: 'medium', ...s },
  }
}

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'golden')

/** Reads a file of the golden set (read only). */
export const golden = (path: string): string => readFileSync(join(goldenDir, path), 'utf8')
export const goldenJson = (path: string): unknown => JSON.parse(golden(path))

/** The invented filler of the truncation scenario: "<tag>01 <tag>02 ..." of exactly n characters. */
export const fill = (n: number, tag: string): string => {
  let s = ''
  for (let i = 1; s.length < n; i++) s += `${tag}${String(i).padStart(2, '0')} `
  s = s.slice(0, n)
  return s.endsWith(' ') ? `${s.slice(0, -1)}.` : s
}
