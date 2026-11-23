import { splitIntoParts } from '../domain/chunk.js'
import { deduplicateAcrossGroups } from '../domain/dedupe.js'
import { isExcluded } from '../domain/exclusion.js'
import { findMassTexts, isMassMessage as isMassOf } from '../domain/mass.js'
import type { Conversation, Message, Participant } from '../domain/model.js'
import { resolveConversationName } from '../domain/names.js'
import { err, ok, type Result } from '../domain/result.js'
import { type ChatResult, composeDigest } from '../domain/sections.js'
import type { DigestSettings } from '../domain/settings.js'
import { parseSummaryResponse } from '../domain/summary.js'
import { CONTEXT_MESSAGES, selectUnreadTail } from '../domain/unread.js'
import { nextPointer, resolveWindow, type SummaryWindow, type WindowError } from '../domain/window.js'
import { assertConcurrency, mapWithConcurrency } from './concurrency.js'
import type { Clock } from './ports/clock.js'
import type { DigestSource } from './ports/digest-source.js'
import type { DigestStore, FailureCode, RunFailedConversation } from './ports/digest-store.js'
import type { RenderedDigest, Renderers, TranscriptEntry } from './ports/rendering.js'
import type { Summarizer } from './ports/summarizer.js'

export const DEFAULT_CONCURRENCY = 4
/** The provider name counted when the summarizer did not say who answered. */
export const UNKNOWN_PROVIDER = 'unknown'

export interface GenerateDigestDeps {
  readonly source: DigestSource
  readonly summarizer: Summarizer
  readonly store: DigestStore
  readonly clock: Clock
  readonly renderers: Renderers
  /**
   * Fallback filter: ids of the owner's own chat(s), read on every run. Capture already drops their content, but data
   * stored before the id was known (or by another version) must never reach the Summarizer. Default: none.
   */
  readonly ownConversationIds?: () => readonly string[]
  /**
   * Runs once the window is known, before the conversations are read: where the audios of the window are transcribed
   * with a bounded wait (RF-15). Whatever it does, the digest goes on: a failure here is ignored.
   */
  readonly beforeWindow?: (window: SummaryWindow) => Promise<void>
}

export interface GenerateDigestRequest {
  /** End of the window, epoch ms. Default: now. */
  readonly until?: number | undefined
  readonly from?: number | undefined
  readonly hours?: number | undefined
  /** A preview returns the digest and saves nothing: no history, no outbox, no pointer (RF-32). */
  readonly preview: boolean
  readonly settings: DigestSettings
  /** The custom prompt template (RF-38). Null: the default one. */
  readonly promptTemplate: string | null
  /** Shown in the title of the digest, for example "WhatsApp". */
  readonly platformName: string
  /** Conversations summarized at once (RNF-10). Default 4. */
  readonly concurrency?: number | undefined
  /** The run record opened by the caller (RF-74). When set, the commit closes it. Ignored in a preview. */
  readonly runId?: number | undefined
}

export interface FailedConversation {
  readonly conversationId: string
  readonly name: string
  /** Internal reason (provider error or schema error). Never goes into the digest, only the count does. */
  readonly reason: string
}

/** The markers the adapters and the use case put at the start of a reason (see `FallbackSummarizer`, the CLIs, Ollama). */
export const LOCAL_ONLY_REASON = 'localOnlyUnavailable'
const INVALID_SUMMARY_PREFIX = 'invalid summary:'
const TIMEOUT_MARKER = /^(?:claude|ollama) timed out after /

/**
 * The code kept for a failure reason: the free text of an adapter never goes to the history. A chained reason
 * ("<first>; fallback: <second>") is decided by the FIRST failure, the one that made the conversation leave its provider.
 * Only the markers the code itself produces are matched, anchored at the start, never words inside a provider's text.
 */
export function failureCode(reason: string): FailureCode {
  const first = (reason.split('; fallback:')[0] ?? reason).trim()
  if (first === LOCAL_ONLY_REASON) return 'localOnlyUnavailable'
  if (TIMEOUT_MARKER.test(first)) return 'timeout'
  if (first.startsWith(INVALID_SUMMARY_PREFIX)) return 'invalidSummary'
  return 'failed'
}

export interface DigestReport {
  readonly window: SummaryWindow
  readonly preview: boolean
  readonly summarized: number
  readonly failed: readonly FailedConversation[]
  /** How many conversations each provider summarized (`unknown` when the summarizer did not say). Empty in an empty window. */
  readonly providers: Readonly<Record<string, number>>
  /** Null when the window had nothing to summarize: there is no digest and nothing is delivered. */
  readonly digest: RenderedDigest | null
  /** What is to be delivered, split into parts. Empty without a digest. In a preview, it is what would be delivered. */
  readonly parts: readonly string[]
  /** The pointer that was saved. Null in a preview. */
  readonly pointer: number | null
}

/** Why no digest was produced. */
export type GenerateDigestError =
  /** The window is invalid. Nothing was touched. */
  | { readonly kind: 'invalidWindow'; readonly errors: readonly WindowError[] }
  /** Another run moved the pointer while this one was working. Nothing was saved. */
  | { readonly kind: 'concurrentRun' }

export type GenerateDigest = (request: GenerateDigestRequest) => Promise<Result<DigestReport, GenerateDigestError>>

interface Candidate {
  readonly conversation: Conversation
  readonly messages: readonly Message[]
  readonly context: readonly Message[]
}

interface Prepared {
  readonly conversation: Conversation
  readonly name: string
  readonly saved: boolean
  readonly entries: readonly TranscriptEntry[]
  readonly contextEntries: readonly TranscriptEntry[]
}

/** Builds the GenerateDigest use case (RF-30 to RF-37). */
export function createGenerateDigest(deps: GenerateDigestDeps): GenerateDigest {
  const { source, summarizer, store, clock, renderers } = deps

  return async (request) => {
    const { settings, preview } = request
    const concurrency = request.concurrency ?? DEFAULT_CONCURRENCY
    assertConcurrency(concurrency)

    const pointer = await store.getPointer()
    const windowResult = resolveWindow({
      until: request.until ?? clock.now(),
      from: request.from,
      hours: request.hours,
      pointer,
      defaultHours: settings.defaultWindowHours,
    })
    if (!windowResult.ok) return err({ kind: 'invalidWindow', errors: windowResult.error })
    const window = windowResult.value

    const finish = async (
      rendered: RenderedDigest | null,
      deliveryParts: readonly string[],
      summarized: number,
      failedCount: number,
      providers: Readonly<Record<string, number>>,
      failedConversations: readonly RunFailedConversation[],
    ): Promise<Result<number | null, GenerateDigestError>> => {
      if (preview) return ok(null)
      const newPointer = nextPointer(window.until, pointer)
      const committed = await store.commit({
        previousPointer: pointer,
        pointer: newPointer,
        digest:
          rendered === null
            ? null
            : {
                since: window.since,
                until: window.until,
                createdAt: clock.now(),
                text: rendered.fullLines.join('\n'),
                summarized,
                failed: failedCount,
              },
        parts: deliveryParts,
        ...(request.runId === undefined
          ? {}
          : {
              run: {
                runId: request.runId,
                finishedAt: clock.now(),
                since: window.since,
                until: window.until,
                summarized,
                failed: failedCount,
                providers,
                failedConversations,
              },
            }),
      })
      return committed.ok ? ok(newPointer) : err({ kind: 'concurrentRun' })
    }

    try {
      await deps.beforeWindow?.(window)
    } catch {
      // Transcripts are an extra: the digest is made with what is there.
    }
    const prepared = await prepare(window, settings)

    if (prepared.length === 0) {
      // An empty window still advances the pointer (inherited behavior).
      const saved = await finish(null, [], 0, 0, {}, [])
      if (!saved.ok) return err(saved.error)
      return ok({
        window,
        preview,
        summarized: 0,
        failed: [],
        providers: {},
        digest: null,
        parts: [],
        pointer: saved.value,
      })
    }

    const systemPrompt = renderers.systemPrompt.render(request.promptTemplate, settings.ownerName)
    const outcomes = await mapWithConcurrency(prepared, concurrency, (item) =>
      summarizeOne(item, systemPrompt, settings),
    )

    const results: ChatResult[] = []
    const failed: FailedConversation[] = []
    const providers: Record<string, number> = {}
    for (const outcome of outcomes) {
      if (outcome.ok) {
        results.push(outcome.value.chat)
        providers[outcome.value.provider] = (providers[outcome.value.provider] ?? 0) + 1
      } else failed.push(outcome.error)
    }

    const digest = renderers.digest.render({
      sections: composeDigest(results, settings.flagUnsaved),
      errors: failed.length,
      since: window.since,
      until: window.until,
      unreadOnly: settings.unreadOnly,
      hideRest: settings.hideRest,
      platformName: request.platformName,
    })
    const parts = splitIntoParts(digest.deliveryLines)
    const saved = await finish(
      digest,
      parts,
      results.length,
      failed.length,
      providers,
      failed.map((f) => ({ id: f.conversationId, name: f.name, reason: failureCode(f.reason) })),
    )
    if (!saved.ok) return err(saved.error)
    return ok({
      window,
      preview,
      summarized: results.length,
      failed,
      providers,
      digest,
      parts,
      pointer: saved.value,
    })
  }

  /** Loads, filters and deduplicates the conversations to summarize, in the order the source gave them. */
  async function prepare(window: SummaryWindow, settings: DigestSettings): Promise<Prepared[]> {
    const ownIds = new Set(deps.ownConversationIds?.() ?? [])
    const conversations = (await source.conversationsWithMessages(window)).filter((c) => !ownIds.has(c.id))
    if (conversations.length === 0) return []
    const mass = findMassTexts(await source.ownMessageTexts())
    const isMassMessage = (m: Message): boolean => isMassOf(mass, m)

    const candidates: Candidate[] = []
    for (const conversation of conversations) {
      let messages = await source.messagesInWindow(conversation.id, window)
      let context: readonly Message[] = []
      if (settings.unreadOnly) {
        const state = await source.unreadState(conversation.id)
        const limit = state.kind === 'count' ? state.count : 0
        const lastIncoming = limit > 0 ? await source.lastIncoming(conversation.id, limit) : []
        const tail = selectUnreadTail(state, messages, lastIncoming)
        messages = tail.messages
        if (tail.contextBefore !== null) {
          context = await source.messagesBefore(conversation.id, tail.contextBefore, CONTEXT_MESSAGES)
        }
      }
      // Mass messages are removed after the unread tail, so they can still show up as context.
      messages = messages.filter((m) => !isMassMessage(m))
      if (messages.length > 0) candidates.push({ conversation, messages, context })
    }

    const ids = new Set<string>()
    for (const { conversation, messages, context } of candidates) {
      if (conversation.participantId !== null) ids.add(conversation.participantId)
      for (const m of [...messages, ...context]) if (m.senderId !== null) ids.add(m.senderId)
    }
    const people = await source.participants([...ids])
    const personOf = (id: string | null): Participant | null => (id === null ? null : (people.get(id) ?? null))

    const kept: (Candidate & { name: string; saved: boolean })[] = []
    for (const { conversation, messages, context } of candidates) {
      const { name, saved } = resolveConversationName(conversation, personOf(conversation.participantId), {
        unnamedGroup: renderers.transcript.unnamedGroup,
      })
      if (isExcluded(settings.excludePatterns, conversation.id, name)) continue
      // Nothing to catch up on when only the owner wrote.
      if (messages.every((m) => m.fromMe)) continue
      kept.push({ conversation, messages, context, name, saved })
    }

    // The deduplicator needs `isGroup` and `messages` at the top level.
    const deduplicated = deduplicateAcrossGroups(kept.map((p) => ({ ...p, isGroup: p.conversation.isGroup })))
    const entry = (m: Message, copies: number): TranscriptEntry => ({
      message: { ...m, copies },
      participant: m.fromMe ? null : personOf(m.senderId),
      isMass: isMassMessage(m),
    })
    return deduplicated.map(({ conversation, name, saved, messages, context }) => ({
      conversation,
      name,
      saved,
      entries: messages.map((m) => entry(m, m.copies)),
      contextEntries: context.map((m) => entry(m, 0)),
    }))
  }

  async function summarizeOne(
    item: Prepared,
    systemPrompt: string,
    settings: DigestSettings,
  ): Promise<Result<{ chat: ChatResult; provider: string }, FailedConversation>> {
    const fail = (reason: string) => err({ conversationId: item.conversation.id, name: item.name, reason })
    // Any throw (rendering, the port, a malformed outcome) is the failure of this conversation, not of the digest.
    try {
      const transcript = renderers.transcript.render({
        name: item.name,
        isGroup: item.conversation.isGroup,
        messages: item.entries,
        context: item.contextEntries,
        ownerName: settings.ownerName,
        maxChars: settings.maxCharsPerConversation,
      })
      const raw = await summarizer.summarize({
        conversation: { id: item.conversation.id, name: item.name, isGroup: item.conversation.isGroup },
        systemPrompt,
        transcript,
      })
      if (typeof raw !== 'object' || raw === null || typeof raw.ok !== 'boolean') {
        return fail('the summarizer returned something that is not a result')
      }
      if (!raw.ok) return fail(String(raw.error))
      const parsed = parseSummaryResponse(raw.value)
      if (!parsed.ok) return fail(`${INVALID_SUMMARY_PREFIX} ${parsed.error.join('; ')}`)
      return ok({
        chat: {
          name: item.name,
          messageCount: item.entries.length,
          unsaved: !item.saved,
          summary: parsed.value,
        },
        provider: typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : UNKNOWN_PROVIDER,
      })
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
}
