import { describe, expect, it } from 'vitest'
import { getCatalog } from '../../../src/infrastructure/i18n/index.js'
import { parseContent } from '../../../src/infrastructure/whatsapp/content.js'
import { parseExtras, phonesOfVcard } from '../../../src/infrastructure/whatsapp/details.js'
import { rawJson, rawValueJson } from '../../../src/infrastructure/whatsapp/raw.js'
import type { WaContent } from '../../../src/infrastructure/whatsapp/wa-types.js'

const es = getCatalog('es')
const en = getCatalog('en')
const extras = (content: WaContent, outer: WaContent = content) => parseExtras(outer, content, es)

describe('replies', () => {
  it('reads what a text replies to', () => {
    const e = extras({
      extendedTextMessage: {
        text: 'sí, mañana',
        contextInfo: {
          stanzaId: 'Q1',
          participant: '9911963367943@s.whatsapp.net',
          quotedMessage: { conversation: '¿venís?' },
        },
      },
    })
    expect(e.quoted).toEqual({ id: 'Q1', kind: 'text', text: '¿venís?', fromStatus: false })
    expect(e.forwarded).toBe(false)
  })

  it('cuts a long quoted text to the length the capture stores', () => {
    const e = extras({
      extendedTextMessage: {
        text: 'ok',
        contextInfo: { stanzaId: 'Q1', quotedMessage: { conversation: 'x'.repeat(500) } },
      },
    })
    expect(e.quoted?.text).toHaveLength(200)
  })

  it('knows a reply to a status, and what the status was', () => {
    const e = extras({
      extendedTextMessage: {
        text: 'qué lindo!',
        contextInfo: {
          stanzaId: 'S1',
          remoteJid: 'status@broadcast',
          quotedMessage: { imageMessage: { caption: 'mi torta', mimetype: 'image/jpeg' } },
        },
      },
    })
    expect(e.quoted).toEqual({ id: 'S1', kind: 'image', text: 'mi torta', fromStatus: true })
  })

  it('keeps the kind of a quoted media without a caption, and no text', () => {
    const e = extras({
      extendedTextMessage: {
        text: 'gracias',
        contextInfo: { stanzaId: 'Q2', quotedMessage: { audioMessage: { seconds: 3 } } },
      },
    })
    expect(e.quoted).toEqual({ id: 'Q2', kind: 'audio', text: null, fromStatus: false })
  })

  it('is not a reply without a context', () => {
    expect(extras({ conversation: 'hola' }).quoted).toBeNull()
  })

  it('marks a forwarded message', () => {
    expect(extras({ extendedTextMessage: { text: 'x', contextInfo: { isForwarded: true } } }).forwarded).toBe(true)
    expect(extras({ extendedTextMessage: { text: 'x', contextInfo: { forwardingScore: 3 } } }).forwarded).toBe(true)
  })
})

describe('view once', () => {
  it('is marked when a wrapper says so, or the media says so', () => {
    const image = { imageMessage: { mimetype: 'image/jpeg' } }
    expect(extras(image, { viewOnceMessageV2: { message: image } }).viewOnce).toBe(true)
    expect(extras(image, { viewOnceMessage: { message: image } }).viewOnce).toBe(true)
    expect(extras({ videoMessage: { viewOnce: true } }).viewOnce).toBe(true)
    expect(extras(image, { ephemeralMessage: { message: image } }).viewOnce).toBe(false)
    expect(extras(image).viewOnce).toBe(false)
  })
})

describe('media', () => {
  it('reads an image', () => {
    expect(
      extras({ imageMessage: { caption: 'foto', mimetype: 'image/jpeg', fileLength: 1234, width: 800, height: 600 } })
        .media,
    ).toEqual({
      kind: 'image',
      mimetype: 'image/jpeg',
      seconds: null,
      fileLength: 1234,
      fileName: null,
      pageCount: null,
      width: 800,
      height: 600,
      caption: 'foto',
    })
  })

  it('reads a video, an audio and a sticker', () => {
    expect(
      extras({ videoMessage: { seconds: 12, mimetype: 'video/mp4', fileLength: { toNumber: () => 99 } } }).media,
    ).toMatchObject({
      kind: 'video',
      seconds: 12,
      fileLength: 99,
    })
    expect(extras({ audioMessage: { seconds: 5, mimetype: 'audio/ogg; codecs=opus' } }).media).toMatchObject({
      kind: 'audio',
      seconds: 5,
    })
    expect(extras({ stickerMessage: { mimetype: 'image/webp', width: 512, height: 512 } }).media).toMatchObject({
      kind: 'sticker',
      width: 512,
    })
  })

  it('reads a document with its name and pages', () => {
    expect(
      extras({
        documentMessage: { fileName: 'menu.pdf', mimetype: 'application/pdf', pageCount: 4, caption: 'el menú' },
      }).media,
    ).toMatchObject({ kind: 'document', fileName: 'menu.pdf', pageCount: 4, caption: 'el menú' })
    expect(extras({ documentMessage: { title: 'Titulo' } }).media?.fileName).toBe('Titulo')
  })

  it('has none for a text', () => {
    expect(extras({ conversation: 'x' }).media).toBeNull()
  })
})

describe('location', () => {
  it('reads a place and a live location', () => {
    expect(
      extras({
        locationMessage: { degreesLatitude: -34.9, degreesLongitude: -57.95, name: 'Plaza', address: 'Calle 7' },
      }).location,
    ).toEqual({ lat: -34.9, lng: -57.95, name: 'Plaza', address: 'Calle 7', live: false })
    expect(extras({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }).location).toEqual({
      lat: 1,
      lng: 2,
      name: null,
      address: null,
      live: true,
    })
  })
})

const VCARD = (name: string, ...tels: string[]) =>
  ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, ...tels, 'END:VCARD'].join('\n')

describe('shared contacts', () => {
  it('parses the phones of a vCard in the usual shapes', () => {
    expect(
      phonesOfVcard(
        VCARD(
          'Ana',
          'TEL;type=CELL;waid=99119633:+99 11 9633 0000',
          'item1.TEL;waid=99119634:+99 11 9634 0000',
          'TEL:555',
        ),
      ),
    ).toEqual(['+99 11 9633 0000', '+99 11 9634 0000', '555'])
    expect(phonesOfVcard(null)).toEqual([])
    expect(phonesOfVcard(VCARD('Sin teléfono'))).toEqual([])
  })

  it('reads one contact, and one row per contact of an array', () => {
    expect(extras({ contactMessage: { displayName: 'Ana', vcard: VCARD('Ana', 'TEL:+99 1') } }).contacts).toEqual([
      { displayName: 'Ana', phones: ['+99 1'] },
    ])
    expect(
      extras({
        contactsArrayMessage: {
          contacts: [
            { displayName: 'Beto', vcard: VCARD('Beto', 'TEL:+99 2') },
            { displayName: 'Cora', vcard: VCARD('Cora') },
          ],
        },
      }).contacts,
    ).toEqual([
      { displayName: 'Beto', phones: ['+99 2'] },
      { displayName: 'Cora', phones: [] },
    ])
  })
})

describe('polls', () => {
  it('reads the question, the options and how many can be chosen', () => {
    expect(
      extras({
        pollCreationMessageV3: {
          name: '¿Cuándo?',
          options: [{ optionName: 'Lunes' }, { optionName: 'Martes' }],
          selectableOptionsCount: 1,
        },
      }).poll,
    ).toEqual({ question: '¿Cuándo?', options: ['Lunes', 'Martes'], selectableCount: 1 })
  })
})

describe('business: orders and products', () => {
  const order: WaContent = {
    orderMessage: {
      orderId: 'ORD-1',
      itemCount: 3,
      totalAmount1000: 12_000_000,
      totalCurrencyCode: 'ARS',
      orderTitle: 'Torta',
      message: 'para el sábado',
    },
  }
  const product: WaContent = {
    productMessage: {
      product: { productId: 'P-9', title: 'Alfajor', priceAmount1000: 500_000, currencyCode: 'ARS', retailerId: 'R-1' },
    },
  }

  it('reads an order, with the total in currency units', () => {
    expect(extras(order).order).toEqual({
      orderId: 'ORD-1',
      itemCount: 3,
      totalAmount: 12_000,
      currency: 'ARS',
      title: 'Torta',
      message: 'para el sábado',
    })
  })

  it('reads a product', () => {
    expect(extras(product).product).toEqual({
      productId: 'P-9',
      title: 'Alfajor',
      price: 500,
      currency: 'ARS',
      retailerId: 'R-1',
    })
  })

  it('shows an order and a product in a transcript, in the language of the account', () => {
    const o = parseContent(order, es)
    expect(o?.kind).toBe('order')
    expect(o?.text).toMatch(/^\[pedido de catálogo: 3 artículos, .*12\.000.*\]$/)
    expect(parseContent(order, en)?.text).toMatch(/^\[catalog order: 3 items, .*12,000.*\]$/)
    const p = parseContent(product, es)
    expect(p?.kind).toBe('product')
    expect(p?.text).toMatch(/^\[producto de catálogo: Alfajor, .*500.*\]$/)
    expect(parseContent({ orderMessage: { itemCount: 1 } }, es)?.text).toBe('[pedido de catálogo: 1 artículo]')
    expect(parseContent({ orderMessage: {} }, es)?.text).toBe('[pedido de catálogo]')
  })
})

describe('raw content', () => {
  it('keeps the structure and the media descriptors, drops thumbnails, and writes buffers as base64', () => {
    const json = rawJson({
      imageMessage: {
        mimetype: 'image/jpeg',
        fileLength: { toNumber: () => 2048 },
        jpegThumbnail: new Uint8Array([1, 2, 3]),
        directPath: '/v/t62/x.enc',
        mediaKey: new Uint8Array([4, 5, 6]),
        fileSha256: new Uint8Array([7]),
        fileEncSha256: new Uint8Array([8]),
        url: 'https://mmg.whatsapp.net/x',
        seconds: 3,
        caption: 'hola',
      },
    } as WaContent)
    const raw = JSON.parse(json as string)
    expect(raw.imageMessage).toEqual({
      mimetype: 'image/jpeg',
      fileLength: 2048,
      directPath: '/v/t62/x.enc',
      mediaKey: 'BAUG',
      fileSha256: 'Bw==',
      fileEncSha256: 'CA==',
      url: 'https://mmg.whatsapp.net/x',
      seconds: 3,
      caption: 'hola',
    })
  })

  it('never stores session or identity keys, secrets or the context of the device', () => {
    const json = rawJson({
      conversation: 'hola',
      senderKeyDistributionMessage: { groupId: 'g', axolotlSenderKeyDistributionMessage: new Uint8Array([1]) },
      messageContextInfo: {
        deviceListMetadata: { senderKeyHash: new Uint8Array([2]) },
        messageSecret: new Uint8Array([3]),
      },
      protocolMessage: { appStateSyncKeyShare: { keys: [{ keyId: 'k', keyData: { keyData: new Uint8Array([4]) } }] } },
    } as unknown as WaContent) as string
    expect(JSON.parse(json)).toEqual({ conversation: 'hola', protocolMessage: {} })
    for (const word of ['senderKey', 'messageSecret', 'keyData', 'deviceList']) expect(json).not.toContain(word)
  })

  it('keeps the quoted message inside the context, cleaned the same way', () => {
    const raw = JSON.parse(
      rawJson({
        extendedTextMessage: {
          text: 'ok',
          contextInfo: {
            stanzaId: 'Q',
            quotedMessage: { imageMessage: { caption: 'c', jpegThumbnail: new Uint8Array([1]) } },
          },
        },
      } as WaContent) as string,
    )
    expect(raw.extendedTextMessage.contextInfo.quotedMessage).toEqual({ imageMessage: { caption: 'c' } })
  })

  it('is null when there is nothing, and big numbers do not break it', () => {
    expect(rawJson(null)).toBeNull()
    expect(rawJson({})).toBeNull()
    const long = { toNumber: () => 2 ** 60, toString: () => '1152921504606846976' }
    expect(
      JSON.parse(rawJson({ audioMessage: { fileLength: long } } as WaContent) as string).audioMessage.fileLength,
    ).toBe('1152921504606846976')
  })

  it('keeps the encrypted payload of a vote, but not the secrets', () => {
    const json = rawValueJson({ vote: { encPayload: new Uint8Array([9]) }, messageSecret: new Uint8Array([1]) })
    expect(JSON.parse(json)).toEqual({ vote: { encPayload: 'CQ==' } })
  })
})

describe('parseExtras of a whole message', () => {
  it('puts the raw content in with the rest', () => {
    const e = extras({
      extendedTextMessage: { text: 'hola', contextInfo: { stanzaId: 'Q', quotedMessage: { conversation: 'x' } } },
    })
    expect(JSON.parse(e.raw as string).extendedTextMessage.text).toBe('hola')
    expect(e.quoted?.id).toBe('Q')
  })
})
