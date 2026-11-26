import type { CaptureRepository } from '../application/ports/capture-repository.js'
import type { Transcriber } from '../application/ports/transcriber.js'
import type { PendingAudio } from '../application/ports/transcription-store.js'
import { exactIdOf, isExcluded } from '../domain/exclusion.js'
import { resolveConversationName } from '../domain/names.js'
import { err } from '../domain/result.js'
import { ClaudeImageReader } from '../infrastructure/vision/index.js'
import type { AppConfig } from './config.js'

/**
 * Whether images are read with this configuration: it is on AND the provider is the Claude Code CLI, the only one that
 * reads images today. Any other provider (an API, Ollama, another CLI) leaves images as "[image]": nothing is sent
 * anywhere that the owner did not pick as provider, and `doctor` says why.
 */
export function imageReadingActive(config: AppConfig): boolean {
  return config.imageReading.enabled && config.provider.primary === 'claude-cli'
}

/** The reader of images of this configuration, or null when images are not read. */
export function buildImageReader(config: AppConfig, env: NodeJS.ProcessEnv): Transcriber | null {
  if (!imageReadingActive(config)) return null
  return new ClaudeImageReader({
    command: config.provider.claudeCli.command,
    model: config.provider.claudeCli.model,
    timeoutMs: config.imageReading.timeoutMs,
    env,
    verify: true,
  })
}

/**
 * One transcriber for the whole media queue: audios go to whisper, images to the image reader. Either may be absent
 * (that kind is off): its files answer `unavailable` and stay pending, but capture never queues a kind that is off. Null
 * when both are off, so the whole queue is off.
 */
export function routeMedia(audio: Transcriber | null, images: Transcriber | null): Transcriber | null {
  if (audio === null && images === null) return null
  if (images === null) return audio
  return {
    transcribe: (request) => {
      const target = request.kind === 'image' ? images : audio
      return target === null
        ? Promise.resolve(err({ kind: 'unavailable' as const, reason: 'off' }))
        : target.transcribe(request)
    },
    close: async () => {
      await Promise.all([audio?.close?.(), images.close?.()])
    },
  }
}

/**
 * The second lock of the local-only rule (the first is in capture): right before an image is read, is its conversation
 * local-only by the patterns in force NOW? A chat marked local-only after its image was queued is still protected.
 */
export function mayReadImage(
  repository: CaptureRepository,
  localOnlyPatterns: () => readonly string[],
): (item: PendingAudio) => Promise<boolean> {
  return async (item) => {
    const patterns = localOnlyPatterns()
    if (patterns.length === 0) return true
    const stored = await repository.findConversation(item.conversationId)
    if (stored === null) return false // unknown conversation: do not send what cannot be checked
    const person = stored.participantId === null ? null : await repository.findParticipant(stored.participantId)
    const { name } = resolveConversationName(stored, person, { unnamedGroup: '' })
    // Fail closed: the check in capture also sees the name the event brought, which is not stored with the queued
    // image. A group whose name is not known now cannot be compared with a name pattern, so its image is not read.
    if (name === '' && patterns.some((pattern) => exactIdOf(pattern) === null)) return false
    return !isExcluded(patterns, item.conversationId, name)
  }
}

/**
 * What the image reader of a configuration depends on besides `imageReading`: whether the provider allows it and which
 * Claude Code it runs. A change makes the unit restart, so images are never sent after the provider stopped being the one
 * the owner agreed to; `null` when images are not read.
 */
export function imageReaderSettings(config: AppConfig): string | null {
  return imageReadingActive(config) ? JSON.stringify(config.provider.claudeCli) : null
}
