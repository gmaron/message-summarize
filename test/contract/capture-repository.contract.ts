import { afterEach, describe, expect, it } from 'vitest'
import type { UnreadEffect } from '../../src/application/ports/capture-repository.js'
import type { CaptureFixture, PersistenceBackend } from '../support/persistence-backends.js'
import { conversation, message, participant } from '../unit/domain/factories.js'

const all = { since: 0, until: 1_000_000 }

/** Contract of the CaptureRepository port (src/application/ports/capture-repository.ts), for every adapter. */
export function describeCaptureRepositoryContract(backend: PersistenceBackend): void {
  describe(`CaptureRepository contract (${backend.name})`, () => {
    const open: CaptureFixture[] = []
    const make = (): CaptureFixture => {
      const fixture = backend.capture()
      open.push(fixture)
      return fixture
    }
    afterEach(() => {
      for (const fixture of open.splice(0)) fixture.close()
    })
    const texts = async (f: CaptureFixture, id = 'c1') => (await f.source.messagesInWindow(id, all)).map((m) => m.text)

    describe('messages', () => {
      it('says whether a message is new, and a replay changes nothing', async () => {
        const f = make()
        expect((await f.repository.insertMessage(message({ id: 'a' }))).isNew).toBe(true)
        expect((await f.repository.insertMessage(message({ id: 'a' }))).isNew).toBe(false)
        expect(await f.source.messagesInWindow('c1', all)).toHaveLength(1)
      })

      it('says whether the stored message has a transcript', async () => {
        const f = make()
        const audio = message({ id: 'a', kind: 'audio', text: '[audio]' })
        expect(await f.repository.insertMessage(audio)).toEqual({
          isNew: true,
          hasTranscript: false,
          mediaHandled: false,
        })
        await f.repository.setTranscript('c1', 'a', 'hello')
        expect(await f.repository.insertMessage(audio)).toEqual({
          isNew: false,
          hasTranscript: true,
          mediaHandled: false,
        })
        expect(await f.repository.insertMessage(message({ id: 'b', kind: 'audio', transcript: 't' }))).toEqual({
          isNew: true,
          hasTranscript: true,
          mediaHandled: false,
        })
      })

      it('records the file of an audio (RF-15): it is handled, and a replay does not ask for it again', async () => {
        const f = make()
        const audio = message({ id: 'a', kind: 'audio', text: '[audio]' })
        await f.repository.insertMessage(audio)
        expect(await f.repository.setMedia('c1', 'a', 'file.ogg')).toBe(true)
        expect((await f.repository.insertMessage(audio)).mediaHandled).toBe(true)
        expect(await f.repository.setMedia('c1', 'zzz', 'file.ogg')).toBe(false)
        // Only an audio has a file.
        await f.repository.insertMessage(message({ id: 't', text: 'hi' }))
        expect(await f.repository.setMedia('c1', 't', 'file.ogg')).toBe(false)
      })

      it('queues the download of an audio with its descriptor, once, and it is handled from then on', async () => {
        const f = make()
        const descriptor = {
          directPath: '/v/t62.7117-24/1_2_n.enc?ccb=11-4',
          mediaKey: new Uint8Array(32).fill(9),
          mimetype: 'audio/ogg; codecs=opus',
          fileLength: 321,
        }
        const audio = message({ id: 'a', kind: 'audio', text: '[audio]' })
        await f.repository.insertMessage(audio)
        expect(await f.repository.queueDownload('c1', 'a', descriptor)).toBe(true)
        expect(f.rawAudio('c1', 'a')).toMatchObject({ status: 'download_pending', hasDescriptor: true, attempts: 0 })
        expect((await f.repository.insertMessage(audio)).mediaHandled).toBe(true)
        // asked again: nothing changes
        expect(await f.repository.queueDownload('c1', 'a', { ...descriptor, directPath: '/v/other' })).toBe(false)
        expect((await f.downloads.nextDownload(Date.now()))?.descriptor).toEqual(descriptor)
      })

      it('does not queue a download for an unknown message, a message that is not an audio, or one that has a transcript', async () => {
        const f = make()
        const descriptor = { directPath: '/v/x', mediaKey: new Uint8Array(32), mimetype: 'audio/ogg', fileLength: null }
        await f.repository.insertMessage(message({ id: 't', text: 'hi' }))
        await f.repository.insertMessage(message({ id: 'done', kind: 'audio', transcript: 'already' }))
        expect(await f.repository.queueDownload('c1', 'zzz', descriptor)).toBe(false)
        expect(await f.repository.queueDownload('c1', 't', descriptor)).toBe(false)
        expect(await f.repository.queueDownload('c1', 'done', descriptor)).toBe(false)
        expect(await f.downloads.countDownloads()).toBe(0)
      })

      it('storing the file or recording a failure clears the descriptor, the decryption key included', async () => {
        const f = make()
        const descriptor = {
          directPath: '/v/x',
          mediaKey: new Uint8Array(32).fill(5),
          mimetype: 'audio/ogg',
          fileLength: 9,
        }
        for (const id of ['stored', 'failed']) {
          await f.repository.insertMessage(message({ id, kind: 'audio', text: '[audio]' }))
          await f.repository.queueDownload('c1', id, descriptor)
          expect(f.rawAudio('c1', id)?.hasDescriptor).toBe(true)
        }
        await f.repository.setMedia('c1', 'stored', 'f.ogg')
        await f.repository.setMediaFailure('c1', 'failed', 'invalid-media-path')
        expect(f.rawAudio('c1', 'stored')).toMatchObject({ status: 'pending', mediaRef: 'f.ogg', hasDescriptor: false })
        expect(f.rawAudio('c1', 'failed')).toMatchObject({
          status: 'failed',
          error: 'invalid-media-path',
          hasDescriptor: false,
        })
      })

      it('records a failed download on the audio, which is then handled too', async () => {
        const f = make()
        const audio = message({ id: 'a', kind: 'audio', text: '[audio]' })
        await f.repository.insertMessage(audio)
        expect(await f.repository.setMediaFailure('c1', 'a', 'too-large')).toBe(true)
        expect((await f.repository.insertMessage(audio)).mediaHandled).toBe(true)
        expect(await f.repository.setMediaFailure('c1', 'zzz', 'timeout')).toBe(false)
      })

      it('does not record a failure on an audio that has a transcript already', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', kind: 'audio', transcript: 'done already' }))
        expect(await f.repository.setMediaFailure('c1', 'a', 'timeout')).toBe(false)
        expect((await f.source.messagesInWindow('c1', all))[0]?.transcript).toBe('done already')
      })

      it('keeps position, fills a missing text and never nulls one', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', text: null, kind: 'audio' }))
        await f.repository.insertMessage(message({ id: 'b', text: 'second' }))
        await f.repository.insertMessage(message({ id: 'a', text: 'with text', kind: 'audio' }))
        await f.repository.insertMessage(message({ id: 'b', text: null }))
        expect(await texts(f)).toEqual(['with text', 'second'])
      })

      it('rejects an unknown kind', async () => {
        const f = make()
        await expect(f.repository.insertMessage(message({ kind: 'hologram' as never }))).rejects.toThrow(/kind/)
      })

      it('stores a transcript, false for an unknown message', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', kind: 'audio', text: null }))
        expect(await f.repository.setTranscript('c1', 'a', 'hello')).toBe(true)
        expect(await f.repository.setTranscript('c1', 'zzz', 'hello')).toBe(false)
        expect((await f.source.messagesInWindow('c1', all))[0]?.transcript).toBe('hello')
      })

      it('cleans a masked sender name and keeps the known one', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', senderName: 'Ana' }))
        await f.repository.insertMessage(message({ id: 'a', senderName: '+54∙∙15' }))
        expect((await f.source.messagesInWindow('c1', all))[0]?.senderName).toBe('Ana')
      })
    })

    describe('conversations and participants', () => {
      it('finds what was stored, with cleaned names, and null for the unknown', async () => {
        const f = make()
        expect(await f.repository.findConversation('c1')).toBeNull()
        expect(await f.repository.findParticipant('p1')).toBeNull()
        await f.repository.upsertConversation(conversation({ name: '+54∙∙15' }))
        await f.repository.upsertParticipant(participant({ savedName: 'Ana', publicName: '+54∙∙15' }))
        expect(await f.repository.findConversation('c1')).toEqual(conversation({ name: null }))
        expect(await f.repository.findParticipant('p1')).toEqual(participant({ savedName: 'Ana' }))
      })

      it('a null name never erases a known one', async () => {
        const f = make()
        await f.repository.upsertConversation(conversation({ name: 'Group' }))
        await f.repository.upsertConversation(conversation({ name: null, address: 'new' }))
        expect(await f.repository.findConversation('c1')).toMatchObject({ name: 'Group', address: 'new' })
        await f.repository.upsertParticipant(participant({ savedName: 'Ana', publicName: 'Anita' }))
        await f.repository.upsertParticipant(participant({ savedName: null, publicName: 'Ani' }))
        expect(await f.repository.findParticipant('p1')).toEqual(participant({ savedName: 'Ana', publicName: 'Ani' }))
      })

      it('creates a stub conversation by hint and a hint never changes an existing one', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', conversationId: 'g' }), { isGroup: true })
        await f.repository.insertMessage(message({ id: 'b', conversationId: 'p' }))
        await f.repository.upsertConversation(conversation({ id: 'x', isGroup: false }))
        await f.repository.insertMessage(message({ id: 'c', conversationId: 'x' }), { isGroup: true })
        expect(await f.repository.findConversation('g')).toEqual({
          id: 'g',
          isGroup: true,
          name: null,
          participantId: null,
          address: 'g',
        })
        expect(await f.repository.findConversation('p')).toMatchObject({ isGroup: false, participantId: 'p' })
        expect(await f.repository.findConversation('x')).toMatchObject({ isGroup: false })
      })
    })

    describe('edits (RF-11)', () => {
      it('applies an edit to a stored message and ignores one that is not newer', async () => {
        const f = make()
        const edited = (text: string) => message({ id: 'a', text })
        await f.repository.insertMessage(message({ id: 'a', text: 'original' }))
        expect(await f.repository.recordEdit(edited('second'), 6_000)).toBe('applied')
        expect(await f.repository.recordEdit(edited('first'), 5_000)).toBe('ignored')
        expect(await f.repository.recordEdit(edited('same time'), 6_000)).toBe('ignored')
        expect(await texts(f)).toEqual(['second'])
        expect(await f.repository.recordEdit(edited('third'), 7_000)).toBe('applied')
        expect(await texts(f)).toEqual(['third'])
      })

      it('an edit with a null text never erases the stored text, and still counts as the edit', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', text: 'original' }))
        expect(await f.repository.recordEdit(message({ id: 'a', text: null }), 5_000)).toBe('applied')
        expect(await texts(f)).toEqual(['original'])
        expect(await f.repository.recordEdit(message({ id: 'a', text: 'older' }), 4_000)).toBe('ignored')
        expect(await f.repository.recordEdit(message({ id: 'a', text: 'later' }), 6_000)).toBe('applied')
        expect(await texts(f)).toEqual(['later'])
      })

      it('a replay of the original does not undo an edit', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', text: 'original' }))
        await f.repository.recordEdit(message({ id: 'a', text: 'edited' }), 5_000)
        await f.repository.insertMessage(message({ id: 'a', text: 'original' }))
        expect(await texts(f)).toEqual(['edited'])
      })

      it('an edit whose original is missing is stored as the message itself', async () => {
        const f = make()
        const edit = message({ id: 'a', text: '(edited) new', timestamp: 5_000, senderId: 'p7', fromMe: false })
        expect(await f.repository.recordEdit(edit, 5_000, { isGroup: true })).toBe('inserted')
        expect(await f.source.messagesInWindow('c1', all)).toEqual([edit])
        expect(await f.repository.findConversation('c1')).toMatchObject({ isGroup: true })
      })

      it('when the original arrives later the edited text stays and the earlier timestamp wins', async () => {
        const f = make()
        await f.repository.recordEdit(message({ id: 'a', text: '(edited) new', timestamp: 5_000 }), 5_000)
        const result = await f.repository.insertMessage(message({ id: 'a', text: 'original', timestamp: 1_000 }))
        expect(result.isNew).toBe(false)
        const [stored] = await f.source.messagesInWindow('c1', all)
        expect([stored?.text, stored?.timestamp]).toEqual(['(edited) new', 1_000])
        // a replay of the original, and a stale or newer edit, behave as usual
        await f.repository.insertMessage(message({ id: 'a', text: 'original', timestamp: 1_000 }))
        expect(await f.repository.recordEdit(message({ id: 'a', text: 'older' }), 4_000)).toBe('ignored')
        expect(await f.repository.recordEdit(message({ id: 'a', text: '(edited) newer' }), 6_000)).toBe('applied')
        expect(await texts(f)).toEqual(['(edited) newer'])
      })

      it('a message stored by an edit keeps the timestamp of a later duplicate of the edit', async () => {
        const f = make()
        await f.repository.recordEdit(message({ id: 'a', text: 'v1', timestamp: 5_000 }), 5_000)
        await f.repository.recordEdit(message({ id: 'a', text: 'v2', timestamp: 9_000 }), 9_000)
        const [stored] = await f.source.messagesInWindow('c1', all)
        expect([stored?.text, stored?.timestamp]).toEqual(['v2', 5_000])
      })

      it('an edit is not a new message: it has no effect on the unread state', async () => {
        const f = make()
        await f.repository.recordEdit(message({ id: 'a', text: 'x' }), 5_000)
        expect(await f.source.unreadState('c1')).toEqual({ kind: 'unknown' })
      })

      describe('only the author edits a message', () => {
        const ownMessage = (overrides: Parameters<typeof message>[0] = {}) =>
          message({ fromMe: true, senderId: null, senderAddress: null, ...overrides })

        it('a group member cannot edit the message of another member: ignored, nothing changes', async () => {
          const f = make()
          await f.repository.insertMessage(message({ id: 'a', senderId: 'p1', text: 'original' }), { isGroup: true })
          const forged = message({ id: 'a', senderId: 'p2', text: '(edited) forged' })
          expect(await f.repository.recordEdit(forged, 5_000, { isGroup: true })).toBe('ignored')
          expect(await f.source.messagesInWindow('c1', all)).toEqual([
            message({ id: 'a', senderId: 'p1', text: 'original' }),
          ])
          // the forged edit did not take the edit slot: the author's own, older edit still applies
          expect(
            await f.repository.recordEdit(message({ id: 'a', senderId: 'p1', text: '(edited) real' }), 4_000),
          ).toBe('applied')
          expect(await texts(f)).toEqual(['(edited) real'])
        })

        it('someone else cannot edit an own message, and the owner cannot edit another one', async () => {
          const f = make()
          await f.repository.insertMessage(ownMessage({ id: 'mine', text: 'my words' }), { isGroup: true })
          await f.repository.insertMessage(message({ id: 'theirs', senderId: 'p1', text: 'their words' }), {
            isGroup: true,
          })
          const byOther = message({ id: 'mine', senderId: 'p2', text: '(edited) forged' })
          const byOwnerOfTheirs = ownMessage({ id: 'theirs', text: '(edited) forged' })
          expect(await f.repository.recordEdit(byOther, 5_000, { isGroup: true })).toBe('ignored')
          expect(await f.repository.recordEdit(byOwnerOfTheirs, 5_000, { isGroup: true })).toBe('ignored')
          expect(await texts(f)).toEqual(['my words', 'their words'])
        })

        it('the side counts even when neither message has a sender id', async () => {
          const f = make()
          // an incoming group message whose participant was unknown has no sender id, like an own message
          await f.repository.insertMessage(message({ id: 'a', senderId: null, text: 'anonymous' }), { isGroup: true })
          await f.repository.insertMessage(ownMessage({ id: 'b', text: 'mine', timestamp: 2_000 }), { isGroup: true })
          expect(await f.repository.recordEdit(ownMessage({ id: 'a', text: '(edited) x' }), 5_000)).toBe('ignored')
          expect(await f.repository.recordEdit(message({ id: 'b', senderId: null, text: '(edited) y' }), 5_000)).toBe(
            'ignored',
          )
          expect(await texts(f)).toEqual(['anonymous', 'mine'])
        })

        it('the side counts for a provisional message too, even without sender ids', async () => {
          const f = make()
          await f.repository.recordEdit(message({ id: 'a', senderId: null, text: '(edited) anonymous' }), 5_000)
          await f.repository.insertMessage(ownMessage({ id: 'a', text: 'really mine' }))
          expect((await f.source.messagesInWindow('c1', all)).map((m) => [m.text, m.fromMe])).toEqual([
            ['really mine', true],
          ])
        })

        it('the same author still edits, an own message included', async () => {
          const f = make()
          await f.repository.insertMessage(message({ id: 'a', senderId: 'p1', text: 'original' }))
          await f.repository.insertMessage(ownMessage({ id: 'mine', text: 'my words', timestamp: 2_000 }))
          expect(await f.repository.recordEdit(message({ id: 'a', senderId: 'p1', text: '(edited) x' }), 5_000)).toBe(
            'applied',
          )
          expect(await f.repository.recordEdit(ownMessage({ id: 'mine', text: '(edited) y' }), 5_000)).toBe('applied')
          expect(await texts(f)).toEqual(['(edited) x', '(edited) y'])
        })

        it('a provisional message stored by an edit loses to an original from a different author', async () => {
          const f = make()
          const forged = message({ id: 'a', senderId: 'p2', text: '(edited) forged', timestamp: 5_000 })
          expect(await f.repository.recordEdit(forged, 5_000, { isGroup: true })).toBe('inserted')
          const original = message({ id: 'a', senderId: 'p1', text: 'real words', timestamp: 4_000, senderName: 'Ana' })
          expect((await f.repository.insertMessage(original, { isGroup: true })).isNew).toBe(false)
          expect(await f.source.messagesInWindow('c1', all)).toEqual([original])
          // the mark is cleared: the real author edits normally, even with an edit time older than the forged one
          expect(
            await f.repository.recordEdit(message({ id: 'a', senderId: 'p1', text: '(edited) real' }), 3_000),
          ).toBe('applied')
          expect(await texts(f)).toEqual(['(edited) real'])
        })

        it('a provisional message from an own edit loses to an original from someone else, and the reverse', async () => {
          const f = make()
          await f.repository.recordEdit(ownMessage({ id: 'a', text: '(edited) mine?' }), 5_000)
          await f.repository.insertMessage(message({ id: 'a', senderId: 'p1', text: 'theirs' }))
          await f.repository.recordEdit(message({ id: 'b', senderId: 'p1', text: '(edited) theirs?' }), 5_000)
          await f.repository.insertMessage(ownMessage({ id: 'b', text: 'mine' }))
          expect((await f.source.messagesInWindow('c1', all)).map((m) => [m.id, m.text, m.fromMe, m.senderId])).toEqual(
            [
              ['a', 'theirs', false, 'p1'],
              ['b', 'mine', true, null],
            ],
          )
        })

        it('a provisional message from the same author keeps the edited text when the original arrives', async () => {
          const f = make()
          await f.repository.recordEdit(
            message({ id: 'a', senderId: 'p1', text: '(edited) new', timestamp: 5_000 }),
            5_000,
          )
          await f.repository.insertMessage(message({ id: 'a', senderId: 'p1', text: 'original', timestamp: 1_000 }))
          const [stored] = await f.source.messagesInWindow('c1', all)
          expect([stored?.text, stored?.timestamp]).toEqual(['(edited) new', 1_000])
        })
      })
    })

    describe('read marks', () => {
      const seed = async (f: CaptureFixture) => {
        await f.repository.insertMessage(message({ id: 'in1', timestamp: 1_000 }))
        await f.repository.insertMessage(message({ id: 'own', timestamp: 1_100, fromMe: true, senderId: null }))
        await f.repository.insertMessage(message({ id: 'in2', timestamp: 1_200 }))
        await f.repository.insertMessage(message({ id: 'in3', timestamp: 1_300 }))
        await f.repository.insertMessage(message({ id: 'other', conversationId: 'c2', timestamp: 1_000 }))
      }
      const reads = async (f: CaptureFixture, id = 'c1') =>
        (await f.source.messagesInWindow(id, all)).map((m) => [m.id, m.read])

      it('reading a message marks it and the earlier incoming ones, not later, own or other chats', async () => {
        const f = make()
        await seed(f)
        await f.repository.markReadThrough('c1', ['in2', 'unknown'])
        expect(await reads(f)).toEqual([
          ['in1', true],
          ['own', false],
          ['in2', true],
          ['in3', false],
        ])
        expect(await reads(f, 'c2')).toEqual([['other', false]])
      })

      it('an own or unknown id marks nothing', async () => {
        const f = make()
        await seed(f)
        await f.repository.markReadThrough('c1', ['own', 'unknown'])
        expect((await reads(f)).filter(([, r]) => r)).toEqual([])
      })

      it('marks every incoming message of one conversation as read', async () => {
        const f = make()
        await seed(f)
        await f.repository.markAllIncomingRead('c1')
        expect(await reads(f)).toEqual([
          ['in1', true],
          ['own', false],
          ['in2', true],
          ['in3', true],
        ])
        expect(await reads(f, 'c2')).toEqual([['other', false]])
      })

      it('a replay never makes a read message unread', async () => {
        const f = make()
        await seed(f)
        await f.repository.markAllIncomingRead('c1')
        await f.repository.insertMessage(message({ id: 'in1', timestamp: 1_000, read: false }))
        expect((await reads(f))[0]).toEqual(['in1', true])
      })
    })

    describe('unread state (RF-12)', () => {
      const state = (f: CaptureFixture, id = 'c1') => f.source.unreadState(id)

      it('a live update is stored; the stub conversation follows the hint', async () => {
        const f = make()
        await f.repository.setUnread('g', { kind: 'markedUnread' }, { isGroup: true })
        expect(await state(f, 'g')).toEqual({ kind: 'markedUnread' })
        expect(await f.repository.findConversation('g')).toMatchObject({ isGroup: true })
      })

      const incoming = (f: CaptureFixture, conversationId: string, id: string, effect: UnreadEffect, extra = {}) =>
        f.repository.insertMessage(message({ id, conversationId, ...extra }), {}, effect)

      it('a new message with the increment effect goes from unknown, markedUnread or a count to count + 1', async () => {
        const f = make()
        await incoming(f, 'a', '1', 'increment')
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 1 })
        await incoming(f, 'a', '2', 'increment')
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 2 })
        await f.repository.setUnread('b', { kind: 'markedUnread' })
        await incoming(f, 'b', '1', 'increment')
        expect(await state(f, 'b')).toEqual({ kind: 'count', count: 1 })
        await f.repository.setUnread('c', { kind: 'count', count: 0 })
        await incoming(f, 'c', '1', 'increment')
        expect(await state(f, 'c')).toEqual({ kind: 'count', count: 1 })
      })

      it('the markRead effect marks every incoming message of the conversation read and sets the counter to 0', async () => {
        const f = make()
        await incoming(f, 'a', '1', 'increment')
        await incoming(f, 'a', '2', 'increment', { timestamp: 1_001 })
        await incoming(f, 'b', '1', 'increment')
        await f.repository.insertMessage(
          message({ id: 'mine', conversationId: 'a', fromMe: true, senderId: null, timestamp: 1_002 }),
          {},
          'markRead',
        )
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 0 })
        expect((await f.source.messagesInWindow('a', all)).map((m) => [m.id, m.read])).toEqual([
          ['1', true],
          ['2', true],
          ['mine', false],
        ])
        expect(await state(f, 'b')).toEqual({ kind: 'count', count: 1 })
        expect((await f.source.messagesInWindow('b', all))[0]?.read).toBe(false)
      })

      it('the none effect leaves the state alone', async () => {
        const f = make()
        await incoming(f, 'a', '1', 'none')
        expect(await state(f, 'a')).toEqual({ kind: 'unknown' })
      })

      it('a replay never has an effect, whatever the effect asked', async () => {
        const f = make()
        await incoming(f, 'a', '1', 'increment')
        await incoming(f, 'a', '1', 'increment')
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 1 })
        await f.repository.setUnread('a', { kind: 'count', count: 5 })
        await incoming(f, 'a', '1', 'markRead')
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 5 })
        expect((await f.source.messagesInWindow('a', all))[0]?.read).toBe(false)
      })

      it('a message stored by an edit and then replayed has no effect either', async () => {
        const f = make()
        await f.repository.recordEdit(message({ id: 'a', conversationId: 'a', text: 'x' }), 5_000)
        await incoming(f, 'a', 'a', 'increment')
        expect(await state(f, 'a')).toEqual({ kind: 'unknown' })
      })

      it('the first snapshot fills a conversation with no state', async () => {
        const f = make()
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 3 }, 500)
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 3 })
      })

      it('a live update after the snapshot started wins over a snapshot batch that arrives later', async () => {
        const f = make()
        f.clock.time = 600
        await f.repository.setUnread('a', { kind: 'count', count: 0 })
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 5 }, 500)
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 0 })
      })

      it('an increment after the snapshot started also wins over it', async () => {
        const f = make()
        f.clock.time = 600
        await incoming(f, 'a', '1', 'increment')
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 5 }, 500)
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 1 })
      })

      it('a live update after a snapshot replaces it', async () => {
        const f = make()
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 5 }, 500)
        f.clock.time = 700
        await f.repository.setUnread('a', { kind: 'markedUnread' })
        expect(await state(f, 'a')).toEqual({ kind: 'markedUnread' })
      })

      it('a later reconnect snapshot replaces a stale value of a previous session', async () => {
        const f = make()
        f.clock.time = 100
        await f.repository.setUnread('a', { kind: 'count', count: 9 })
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 2 }, 5_000)
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 2 })
      })

      it('a snapshot does not overwrite an update made at the same instant', async () => {
        const f = make()
        f.clock.time = 500
        await f.repository.setUnread('a', { kind: 'count', count: 1 })
        await f.repository.setUnreadFromSnapshot('a', { kind: 'count', count: 8 }, 500)
        expect(await state(f, 'a')).toEqual({ kind: 'count', count: 1 })
      })

      it('a conversation upsert does not touch the unread state', async () => {
        const f = make()
        await f.repository.upsertConversation(conversation())
        await f.repository.setUnread('c1', { kind: 'count', count: 4 })
        await f.repository.upsertConversation(conversation({ name: 'Renamed' }))
        expect(await state(f)).toEqual({ kind: 'count', count: 4 })
      })
    })

    describe('own text in other conversations (RF-33)', () => {
      it('counts distinct other conversations with exactly this own text', async () => {
        const f = make()
        const own = (id: string, conversationId: string, text: string) =>
          f.repository.insertMessage(message({ id, conversationId, text, fromMe: true, senderId: null }))
        await own('1', 'c1', 'same text')
        await own('2', 'c2', 'same text')
        await own('3', 'c2', 'same text') // same conversation twice counts once
        await own('4', 'c3', 'same text')
        await own('5', 'c4', 'Same text') // not exact
        await own('6', 'c5', 'same text ') // not exact
        await f.repository.insertMessage(message({ id: '7', conversationId: 'c6', text: 'same text' })) // incoming
        expect(await f.repository.countOtherConversationsWithOwnText('c1', 'same text')).toBe(2)
        expect(await f.repository.countOtherConversationsWithOwnText('c9', 'same text')).toBe(3)
        expect(await f.repository.countOtherConversationsWithOwnText('c1', 'nothing')).toBe(0)
      })
    })

    describe('extras, reactions and poll votes', () => {
      it('shows the reply of a message to the read port, and nothing for one that is not a reply', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a', timestamp: 1 }), {}, 'none', {
          quoted: { id: 'Q', kind: 'image', text: 'mi torta', fromStatus: true },
        })
        await f.repository.insertMessage(message({ id: 'b', timestamp: 2 }), {}, 'none', { raw: '{}', forwarded: true })
        const [a, b] = await f.source.messagesInWindow('c1', all)
        expect(a?.reply).toEqual({ kind: 'image', text: 'mi torta', fromStatus: true })
        expect(b?.reply).toBeUndefined()
      })

      it('does not change the text, the unread state or the effect of a message', async () => {
        const f = make()
        const result = await f.repository.insertMessage(message({ id: 'a' }), {}, 'increment', {
          raw: '{"conversation":"hello"}',
          forwarded: true,
          viewOnce: true,
        })
        expect(result.isNew).toBe(true)
        expect(await texts(f)).toEqual(['hello'])
        expect(await f.source.unreadState('c1')).toEqual({ kind: 'count', count: 1 })
      })

      it('keeps reactions apart from the messages: they are never read as messages or counted as unread', async () => {
        const f = make()
        await f.repository.insertMessage(message({ id: 'a' }))
        const reaction = {
          conversationId: 'c1',
          targetId: 'a',
          senderId: 'p1',
          fromMe: false,
          emoji: '👍',
          timestamp: 5,
        }
        await f.repository.recordReaction(reaction)
        await f.repository.recordReaction({ ...reaction, emoji: '' })
        await f.repository.recordReaction({ ...reaction, conversationId: 'c-new', targetId: 'zz' }, { isGroup: false })
        expect(await texts(f)).toEqual(['hello'])
        expect(await f.source.messagesInWindow('c-new', all)).toEqual([])
        expect(await f.source.unreadState('c1')).toEqual({ kind: 'unknown' })
      })

      it('accepts a poll vote and a replay of it', async () => {
        const f = make()
        const vote = { conversationId: 'c1', pollId: 'P', senderId: 'p1', fromMe: false, timestamp: 5, raw: '{}' }
        await f.repository.recordPollVote(vote, { isGroup: false })
        await expect(f.repository.recordPollVote(vote)).resolves.toBeUndefined()
        expect(await f.source.messagesInWindow('c1', all)).toEqual([])
      })
    })
  })
}
