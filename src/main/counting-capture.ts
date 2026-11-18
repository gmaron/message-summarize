import type { CaptureMessages } from '../application/capture-messages.js'

/** The capture use case wrapped to watch what flows through it while an account is being linked. */
export interface CountingCapture {
  /** Pass this to the connection instead of the runtime's capture. Every call reaches the real one unchanged. */
  readonly capture: CaptureMessages
  /** When (epoch ms, real time) the last event came through. */
  lastActivity(): number
  /** Distinct conversations seen: those that got metadata and those that got a stored message. */
  chats(): number
  /** Messages stored that were not there before. */
  messages(): number
  /** Called after every event, so a listener can report progress. Replaceable. */
  onActivity: () => void
}

/**
 * The capture use case, counting calls: `link` (command or web) waits until the initial history stops arriving, and the
 * web shows how many conversations and messages came in (RF-02). Only counts and a time are kept: never an id or a text.
 */
export function countingCapture(capture: CaptureMessages): CountingCapture {
  let last = Date.now()
  let messages = 0
  const chats = new Set<string>()
  const counting: CountingCapture = {
    capture: undefined as unknown as CaptureMessages,
    lastActivity: () => last,
    chats: () => chats.size,
    messages: () => messages,
    onActivity: () => {},
  }
  const touch = (): void => {
    last = Date.now()
    counting.onActivity()
  }
  const passing =
    <E, R>(call: (event: E) => Promise<R>) =>
    async (event: E): Promise<R> => {
      last = Date.now()
      const result = await call(event)
      touch()
      return result
    }
  const wrapped: CaptureMessages = {
    receiveMessage: async (event) => {
      last = Date.now()
      const outcome = await capture.receiveMessage(event)
      if (outcome.stored) {
        chats.add(event.message.conversationId)
        if (outcome.isNew) messages++
      }
      touch()
      return outcome
    },
    editMessage: passing((event) => capture.editMessage(event)),
    messagesRead: passing((event) => capture.messagesRead(event)),
    unreadChanged: passing((event) => capture.unreadChanged(event)),
    unreadSnapshot: passing((event) => capture.unreadSnapshot(event)),
    conversationMetadata: async (event) => {
      last = Date.now()
      await capture.conversationMetadata(event)
      chats.add(event.conversation.id)
      touch()
    },
    participantInfo: passing((event) => capture.participantInfo(event)),
    transcriptReady: passing((event) => capture.transcriptReady(event)),
    // The audios of the history queue up while linking: the daemon's worker downloads them later (RF-15).
    queueMedia: passing((event) => capture.queueMedia(event)),
    mediaFailed: passing((event) => capture.mediaFailed(event)),
  }
  ;(counting as { capture: CaptureMessages }).capture = wrapped
  return counting
}
