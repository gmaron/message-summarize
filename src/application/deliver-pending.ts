import type { DeliveryChannel, DeliveryFailure } from './ports/delivery-channel.js'
import type { OutboxRepository } from './ports/outbox.js'

/** `storage`: the outbox could not be read or updated. */
export type DeliverPendingFailure = DeliveryFailure | 'storage'

export interface DeliverPendingResult {
  /** Parts delivered and marked sent by this run. */
  readonly delivered: number
  /** Why the run stopped early. Null when the outbox was emptied. Whatever is left stays queued, in order. */
  readonly failure: DeliverPendingFailure | null
}

interface Slot {
  promise: Promise<DeliverPendingResult>
}

/**
 * RF-50, RF-52: sends the queued parts of the digests to the account's own chat.
 *
 * - One part at a time, oldest first. A part is marked sent only after the channel confirmed it, so a crash in
 *   between can repeat a part but never lose one.
 * - "Sent" is as strong as the channel's confirmation. For WhatsApp that is "written to the socket", not "received by
 *   the server": a connection that drops right after the write can lose that part (the previous tool had the same
 *   limit). Acknowledgements are not implemented yet.
 * - It stops at the first failure: later parts must not overtake it. The next run (on connect, or after the next
 *   digest commit) picks up from the same part.
 * - Single flight: while a run is going, another call does not start a second one (the same part would be sent
 *   twice). It asks the running one to look at the outbox once more before it finishes, so parts committed in the
 *   meantime are not left waiting, and returns that run's result. The run releases the slot in the same synchronous
 *   step in which it checks that nobody asked again, so a call can never land between "nothing more to do" and "free".
 */
export class DeliverPending {
  private current: Slot | null = null
  private again = false

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly channel: DeliveryChannel,
  ) {}

  run(): Promise<DeliverPendingResult> {
    if (this.current !== null) {
      this.again = true
      return this.current.promise
    }
    const slot = {} as Slot
    slot.promise = Promise.resolve().then(() => this.loop(slot))
    this.current = slot
    return slot.promise
  }

  /** Frees the slot, but only if it is still this run's: a newer run is never cleared by an older one. */
  private release(slot: Slot): void {
    if (this.current === slot) this.current = null
  }

  private async loop(slot: Slot): Promise<DeliverPendingResult> {
    let delivered = 0
    try {
      for (;;) {
        this.again = false
        const pass = await this.pass()
        delivered += pass.delivered
        // No await between the check of `again` and the release.
        if (pass.failure !== null || !this.again) {
          this.release(slot)
          return { delivered, failure: pass.failure }
        }
      }
    } catch (error) {
      this.release(slot)
      throw error
    }
  }

  private async pass(): Promise<DeliverPendingResult> {
    let items: Awaited<ReturnType<OutboxRepository['pending']>>
    try {
      items = await this.outbox.pending()
    } catch {
      return { delivered: 0, failure: 'storage' }
    }
    let delivered = 0
    for (const item of items) {
      let result: Awaited<ReturnType<DeliveryChannel['deliver']>>
      try {
        result = await this.channel.deliver(item.text)
      } catch {
        // A channel reports failures as values; a throw is a bug in it, and is treated like any other error.
        return { delivered, failure: 'error' }
      }
      if (!result.ok) return { delivered, failure: result.error }
      try {
        await this.outbox.markSent(item.id)
      } catch {
        // Sent but not marked: it would go out again next time. Stop here rather than keep sending.
        return { delivered, failure: 'storage' }
      }
      delivered++
    }
    return { delivered, failure: null }
  }
}
