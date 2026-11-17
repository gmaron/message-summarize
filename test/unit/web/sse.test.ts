import { afterEach, describe, expect, it } from 'vitest'
import { connectEvents } from '../../../src/interfaces/web/lib/sse.js'
import { FakeEventSource } from './support.js'

afterEach(() => {
  FakeEventSource.all = []
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('connectEvents', () => {
  it('forwards the events of the daemon parsed, and ignores a block that is not JSON', () => {
    const got: [string, unknown][] = []
    connectEvents(() => new FakeEventSource(), { event: (n, d) => got.push([n, d]), open: () => {}, broken: () => {} })
    const source = FakeEventSource.last()
    source.emit('qr', { account: 'a', seq: 1 })
    source.emit('sync', { account: 'a', chats: 1, messages: 2, done: false })
    source.emitRaw('digest', 'not json')
    expect(got).toEqual([
      ['qr', { account: 'a', seq: 1 }],
      ['sync', { account: 'a', chats: 1, messages: 2, done: false }],
    ])
  })

  it('says whether an open is a reconnect, opens a new stream when the browser gave up, and stops on close()', async () => {
    const opens: boolean[] = []
    const stream = connectEvents(
      () => new FakeEventSource(),
      { event: () => {}, open: (again) => opens.push(again), broken: () => {} },
      5,
    )
    const first = FakeEventSource.last()
    first.emit('open')
    first.emit('open') // the browser's own reconnect
    expect(opens).toEqual([false, true])
    first.readyState = 2
    first.emit('error')
    await wait(30)
    expect(FakeEventSource.all.length).toBe(2)
    FakeEventSource.last().emit('open')
    expect(opens).toEqual([false, true, true])
    stream.close()
    const second = FakeEventSource.last()
    expect(second.closed).toBe(true)
    second.emit('error')
    await wait(30)
    expect(FakeEventSource.all.length).toBe(2)
  })
})
