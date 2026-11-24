import { type AskHint, matchAskHints } from '../domain/ask-hints.js'
import { type AskSelection, isUsefulMessage, lastUsefulOwn, pickUnanswered } from '../domain/ask-selection.js'
import {
  ASK_EXTRACT_CONCURRENCY,
  ASK_MAX_TOTAL_CHARS,
  ASK_PART_CHARS,
  type AskBlock,
  buildParts,
  cleanQuestion,
  isNothing,
  totalChars,
} from '../domain/ask-text.js'
import { isExcluded } from '../domain/exclusion.js'
import { findMassTexts, isMassMessage } from '../domain/mass.js'
import type { Message, Participant } from '../domain/model.js'
import { resolveConversationName } from '../domain/names.js'
import { err, ok, type Result } from '../domain/result.js'
import type { DigestSettings } from '../domain/settings.js'
import { CONTEXT_MESSAGES, selectUnreadTail } from '../domain/unread.js'
import type { SummaryWindow } from '../domain/window.js'
import { type AnswerFailureClass, classifyAnswerFailure } from './answer-failure.js'
import { assertConcurrency, mapWithConcurrency } from './concurrency.js'
import type { Answerer } from './ports/answerer.js'
import type { DigestSource } from './ports/digest-source.js'
import type { Renderers, TranscriptEntry } from './ports/rendering.js'

/** What the model is told and shown, in the language of the installation (an adapter fills it from the catalogs). */
export interface AskTexts {
  /** The line that opens a chat: its kind and name; `continued` marks a chat that goes on from the previous part. */
  chatHeading(kind: 'saved' | 'unsaved' | 'group', name: string, continued: boolean): string
  /** The line between what was already answered (or read) and what is pending. */
  readonly contextMarker: { readonly unanswered: string; readonly unread: string }
  /** The system prompt of the call that writes the answer. `hints` are the owner's texts that apply to the request. */
  systemPrompt(input: { ownerName: string; hints: readonly string[]; unansweredOnly: boolean }): string
  /** The system prompt of a call that only extracts what is useful from one part. */
  extractPrompt(input: { ownerName: string; unansweredOnly: boolean }): string
  /** What the single call gets: the period, the request and the messages. */
  input(input: { period: string; question: string; messages: string }): string
  extractInput(input: { period: string; question: string; part: number; parts: number; messages: string }): string
  /** What the final call gets: the extracts of every part that had something. */
  mergeInput(input: { period: string; question: string; extracts: readonly string[] }): string
  /** The answer when no part had anything for the request (no call is made then). */
  readonly nothingFound: string
}

export interface AskChatsDeps {
  readonly source: DigestSource
  /** The same providers as the digest, with their free-text mode and the fallback to the backup. */
  readonly answerer: Answerer
  readonly renderers: Renderers
  readonly texts: AskTexts
  /** What the prompts call the owner when the account has no `ownerName` ("the owner"). */
  readonly ownerNameFallback: string
  /** Ids of the owner's own chat(s): never read (the same fallback filter as the digest). Default: none. */
  readonly ownConversationIds?: () => readonly string[]
  /**
   * The patterns of the "local only" conversations in force now (RF-43). Their text goes into a request only when the
   * answerer says it never leaves the machine. Default: none.
   */
  readonly localOnlyPatterns?: () => readonly string[]
}

export interface AskChatsRequest {
  readonly question: string
  readonly window: SummaryWindow
  /** Only conversations that match one of these patterns (a name, a phone number or `id:<id>`). Empty: all of them. */
  readonly chats?: readonly string[]
  /** Which messages of each chat are read. */
  readonly selection: AskSelection
  readonly settings: DigestSettings
  /** The owner's context for requests that mention certain words. Only a request uses it, never the digest. */
  readonly askHints?: readonly AskHint[]
  /** Told after each part is read and when the final answer starts: `done` of `total` parts. */
  readonly onProgress?: (progress: AskProgress) => void
}

export interface AskProgress {
  readonly phase: 'reading' | 'writing'
  readonly done: number
  readonly total: number
}

export interface AskReport {
  readonly window: SummaryWindow
  readonly selection: AskSelection
  /** Conversations whose messages went into the request. */
  readonly chats: number
  readonly messages: number
  /** Conversations left out because they are "local only" and the provider is external (RF-43). Only the count. */
  readonly leftOutLocalOnly: number
  /** How many parts the text was read in (1: one call). */
  readonly parts: number
  /** Model calls made. */
  readonly calls: number
  /** Who wrote the final answer. */
  readonly provider: string
  /** The answer, in simple markdown. Private text. */
  readonly answer: string
}

export type AskChatsError =
  | { readonly kind: 'emptyQuestion' }
  | { readonly kind: 'invalidWindow' }
  /** Nothing to read: no chat has messages for the selection in the period. */
  | { readonly kind: 'noMessages'; readonly leftOutLocalOnly: number }
  /** More text than a request can read: the owner has to shorten the period or choose chats. */
  | { readonly kind: 'tooMuch'; readonly chars: number }
  /** A model call failed; `failure` is only the class of the reason, never its text. */
  | { readonly kind: 'answerFailed'; readonly failure: AnswerFailureClass }

export type AskChats = (request: AskChatsRequest) => Promise<Result<AskReport, AskChatsError>>

/**
 * Answers a free request of the owner ("who asked me for something", "what is pending") over the chats of a period, with
 * ONE answer written by a model that sees all the chats together. Nothing is saved and nothing moves (no pointer, no
 * digest history, no outbox): it only reads.
 *
 * The text is every selected chat under its own heading. Up to `ASK_PART_CHARS` it is one call. Larger, it is split into
 * parts: one extract call per part (a few at a time) that returns only what is useful, then one final call that merges
 * the extracts. More than `ASK_MAX_TOTAL_CHARS` is refused. Exclusions come first and cannot be overridden by the chat
 * filter; the owner's own chat and chats where only the owner wrote are never read; mass messages are left out; and
 * "local only" conversations never reach a provider that is not on the machine (RF-43).
 */
export function createAskChats(deps: AskChatsDeps): AskChats {
  const { source, answerer, renderers, texts } = deps

  return async (request) => {
    const question = cleanQuestion(request.question)
    if (question === '') return err({ kind: 'emptyQuestion' })
    const { window, settings, selection } = request
    if (!(window.since < window.until)) return err({ kind: 'invalidWindow' })

    const ownIds = new Set(deps.ownConversationIds?.() ?? [])
    const conversations = (await source.conversationsWithMessages(window)).filter((c) => !ownIds.has(c.id))
    // The same selection as the digest: mass messages do not count, and a chat where only the owner wrote has nothing to ask.
    const mass = conversations.length === 0 ? new Set<string>() : findMassTexts(await source.ownMessageTexts())
    const loaded: {
      conversation: (typeof conversations)[number]
      messages: readonly Message[]
      context: readonly Message[]
      lastIncoming: number
    }[] = []
    for (const conversation of conversations) {
      let messages = await source.messagesInWindow(conversation.id, window)
      let context: readonly Message[] = []
      if (selection === 'unread') {
        const state = await source.unreadState(conversation.id)
        const limit = state.kind === 'count' ? state.count : 0
        const lastIncomingMessages = limit > 0 ? await source.lastIncoming(conversation.id, limit) : []
        const tail = selectUnreadTail(state, messages, lastIncomingMessages)
        messages = tail.messages
        if (tail.contextBefore !== null) {
          context = await source.messagesBefore(conversation.id, tail.contextBefore, CONTEXT_MESSAGES)
        }
      } else if (selection === 'unanswered') {
        // Where the owner last answered (any time, not only in the window): what is after it is what is pending.
        const own = await source.lastOwn(conversation.id, OWN_LOOKBACK)
        // What is pending does not stop at the start of the window: read from the owner's last answer on.
        const lastOwn = lastUsefulOwn(own, mass)
        // Never wrote (an individual chat): everything of the chat is pending. A group where they never wrote is skipped.
        const from = lastOwn === undefined ? (conversation.isGroup ? window.since : 0) : Math.min(window.since, lastOwn)
        if (from < window.since) {
          messages = await source.messagesInWindow(conversation.id, { since: from, until: window.until })
        }
        const pick = pickUnanswered(conversation.isGroup, messages, own, mass, window.since)
        messages = pick.messages
        if (pick.contextBefore !== null) {
          context = (await source.messagesBefore(conversation.id, pick.contextBefore, pick.contextLimit)).filter(
            isUsefulMessage,
          )
        }
      }
      // Mass messages are removed after the unread tail, so they can still show up as context (as in the digest).
      messages = messages.filter((m) => !isMassMessage(mass, m))
      let lastIncoming = -Infinity
      for (const m of messages) if (!m.fromMe && m.timestamp > lastIncoming) lastIncoming = m.timestamp
      if (lastIncoming > -Infinity) loaded.push({ conversation, messages, context, lastIncoming })
    }

    const ids = new Set<string>()
    for (const { conversation, messages, context } of loaded) {
      if (conversation.participantId !== null) ids.add(conversation.participantId)
      for (const m of [...messages, ...context]) if (m.senderId !== null) ids.add(m.senderId)
    }
    const people = await source.participants([...ids])
    const personOf = (id: string | null): Participant | null => (id === null ? null : (people.get(id) ?? null))

    const filters = (request.chats ?? []).map((c) => c.trim()).filter((c) => c !== '')
    const named = loaded
      .map((item) => ({
        ...item,
        ...resolveConversationName(item.conversation, personOf(item.conversation.participantId), {
          unnamedGroup: renderers.transcript.unnamedGroup,
        }),
      }))
      // The privacy exclusions come first and cannot be overridden by the filter of the request.
      .filter((c) => !isExcluded(settings.excludePatterns, c.conversation.id, c.name))
      .filter((c) => filters.length === 0 || isExcluded(filters, c.conversation.id, c.name))
    // RF-43: the text of a request goes to one provider and mixes chats, so a "local only" chat is in it only when
    // the provider never sends anything out. Otherwise it is left out and only counted.
    const localOnly = deps.localOnlyPatterns?.() ?? []
    const allowed = named.filter((c) => answerer.local || !isExcluded(localOnly, c.conversation.id, c.name))
    const leftOutLocalOnly = named.length - allowed.length
    // The most recent incoming message first; the id breaks ties so the order is the same every time.
    allowed.sort(
      (a, b) =>
        b.lastIncoming - a.lastIncoming ||
        (a.conversation.id < b.conversation.id ? -1 : a.conversation.id > b.conversation.id ? 1 : 0),
    )
    if (allowed.length === 0) return err({ kind: 'noMessages', leftOutLocalOnly })

    const entryOf = (m: Message): TranscriptEntry => ({
      message: { ...m, copies: 0 },
      participant: m.fromMe ? null : personOf(m.senderId),
      isMass: isMassMessage(mass, m),
    })
    const blocks: AskBlock[] = allowed.map((item) => {
      const kind = item.conversation.isGroup ? 'group' : item.saved ? 'saved' : 'unsaved'
      const render = (list: readonly Message[]) =>
        renderers.transcript.lines({ entries: list.map(entryOf), ownerName: settings.ownerName })
      const marker = selection === 'unanswered' ? texts.contextMarker.unanswered : texts.contextMarker.unread
      const lines =
        item.context.length > 0
          ? [...render(item.context), marker, ...render(item.messages)]
          : [...render(item.messages)]
      return { heading: (continued) => texts.chatHeading(kind, item.name, continued), lines }
    })
    // A provider with a smaller limit of its own (a context window, an argument) gets smaller parts.
    const partChars = Math.min(ASK_PART_CHARS, answerer.maxPartChars ?? ASK_PART_CHARS)
    const parts = buildParts(blocks, partChars)
    const chars = totalChars(parts)
    if (chars > ASK_MAX_TOTAL_CHARS) return err({ kind: 'tooMuch', chars })

    const period = `${renderers.transcript.formatDateTime(window.since)} – ${renderers.transcript.formatDateTime(window.until)}`
    const ownerName = settings.ownerName?.trim() ? settings.ownerName : deps.ownerNameFallback
    const unansweredOnly = selection === 'unanswered'
    const hints = matchAskHints(request.askHints ?? [], question)
    const messageCount = allowed.reduce((n, c) => n + c.messages.length, 0)
    const report = (answer: string, provider: string, calls: number): Result<AskReport, AskChatsError> =>
      ok({
        window,
        selection,
        chats: allowed.length,
        messages: messageCount,
        leftOutLocalOnly,
        parts: parts.length,
        calls,
        provider,
        answer,
      })

    const systemPrompt = texts.systemPrompt({ ownerName, hints, unansweredOnly })
    const failed = (failure: AnswerFailureClass): Result<AskReport, AskChatsError> =>
      err({ kind: 'answerFailed', failure })
    if (parts.length === 1) {
      const result = await callAnswerer(answerer, {
        systemPrompt,
        input: texts.input({ period, question, messages: parts[0] ?? '' }),
      })
      return result.ok ? report(result.text, result.provider, 1) : failed(result.failure)
    }

    const concurrency = ASK_EXTRACT_CONCURRENCY
    assertConcurrency(concurrency)
    let done = 0
    let firstFailure: AnswerFailureClass | null = null
    request.onProgress?.({ phase: 'reading', done, total: parts.length })
    const extractPrompt = texts.extractPrompt({ ownerName, unansweredOnly })
    const extracts = await mapWithConcurrency(parts, concurrency, async (part, index) => {
      // One failed part fails the request: no new call is started after it (those already running finish).
      if (firstFailure !== null) return null
      const result = await callAnswerer(answerer, {
        systemPrompt: extractPrompt,
        input: texts.extractInput({ period, question, part: index + 1, parts: parts.length, messages: part }),
      })
      if (!result.ok) {
        firstFailure ??= result.failure
        return null
      }
      done += 1
      request.onProgress?.({ phase: 'reading', done, total: parts.length })
      return result
    })
    if (firstFailure !== null) return failed(firstFailure)
    const useful = extracts.flatMap((e) => (e === null || isNothing(e.text) ? [] : [e.text]))
    // Nothing found in any part: there is nothing to merge, so no final call is made.
    if (useful.length === 0) return report(texts.nothingFound, extracts[0]?.provider ?? 'unknown', parts.length)
    request.onProgress?.({ phase: 'writing', done: parts.length, total: parts.length })
    const final = await callAnswerer(answerer, {
      systemPrompt,
      input: texts.mergeInput({ period, question, extracts: useful }),
    })
    return final.ok ? report(final.text, final.provider, parts.length + 1) : failed(final.failure)
  }
}

/** How many of the owner's latest messages of a chat are looked at to find where they last answered. */
const OWN_LOOKBACK = 100

type Called = { ok: true; text: string; provider: string } | { ok: false; failure: AnswerFailureClass }

async function callAnswerer(answerer: Answerer, request: Parameters<Answerer['answer']>[0]): Promise<Called> {
  try {
    const result = await answerer.answer(request)
    if (typeof result !== 'object' || result === null) return { ok: false, failure: 'other' }
    // The reason is text from the provider: only its class is kept.
    if (result.ok !== true) return { ok: false, failure: classifyAnswerFailure(String(result.error ?? '')) }
    const text = result.text.trim()
    if (text === '') return { ok: false, failure: 'other' }
    return {
      ok: true,
      text,
      provider: typeof result.provider === 'string' && result.provider !== '' ? result.provider : 'unknown',
    }
  } catch {
    return { ok: false, failure: 'other' }
  }
}
