import type { WaContent } from './wa-types.js'

/**
 * Keys that are never stored, at any depth: binary noise that is not needed (thumbnails), and everything that carries
 * Signal session, sender-key or app-state keys or per-device secrets (RNF-04). The media descriptors that are needed to
 * download a file again later (`directPath`, `mediaKey`, `url`, `mimetype`, `fileLength`, `seconds`, `fileSha256`,
 * `fileEncSha256`) are NOT in this list.
 */
const DROPPED_KEYS = new Set([
  // thumbnails and previews (binary noise)
  'jpegThumbnail',
  'thumbnail',
  'pngThumbnail',
  'thumbnailSha256',
  'thumbnailEncSha256',
  'streamingSidecar',
  'scansSidecar',
  'midQualityFileSha256',
  'midQualityFileEncSha256',
  // keys and secrets of the Signal / app-state protocols and of the device
  'messageContextInfo',
  'messageSecret',
  'deviceListMetadata',
  'deviceListMetadataVersion',
  'senderKeyDistributionMessage',
  'fastRatchetKeyDistributionMessage',
  'appStateSyncKeyShare',
  'appStateSyncKeyRequest',
  'appStateFatalExceptionNotification',
  'initialSecurityNotificationSettingSync',
  'historySyncNotification',
  'peerDataOperationRequestMessage',
  'peerDataOperationRequestResponseMessage',
  'encPayload',
  'encIv',
])

/** What is dropped even when the payload itself is wanted (a poll vote keeps its encrypted payload). */
const SECRET_KEYS = new Set(['messageSecret', 'messageContextInfo'])

const MAX_DEPTH = 24
/** A message whose JSON is bigger than this keeps no raw (it never happens with a real message). */
const MAX_RAW_CHARS = 1_000_000

const isBytes = (value: unknown): value is Uint8Array => value instanceof Uint8Array

/** A protobuf Long (low/high words with `toNumber`) or a bigint, as a number when safe or else as a string. */
function numeric(value: unknown): number | string | undefined {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  const long = value as { toNumber?: () => number; toString?: () => string } | null
  if (long !== null && typeof long === 'object' && typeof long.toNumber === 'function') {
    const n = long.toNumber()
    return Number.isSafeInteger(n) ? n : String(long.toString?.() ?? n)
  }
  return undefined
}

function clean(value: unknown, depth: number, dropped: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (isBytes(value)) return Buffer.from(value).toString('base64')
  const n = numeric(value)
  if (n !== undefined) return n
  if (depth >= MAX_DEPTH) return undefined
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, dropped) ?? null)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (dropped.has(key)) continue
      const cleaned = clean(inner, depth + 1, dropped)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return undefined
}

/**
 * The decoded content of a message as JSON text: the structure of the protocol message, binary values as base64, Longs
 * as numbers, and the keys of `DROPPED_KEYS` left out. It is the safety net for rules built later, so it keeps the
 * original structure (the caller passes the content with its wrappers already removed). Null when there is nothing.
 */
export function rawJson(content: WaContent | null | undefined): string | null {
  if (content === null || content === undefined) return null
  const cleaned = clean(content, 0, DROPPED_KEYS)
  if (cleaned === undefined) return null
  const json = JSON.stringify(cleaned)
  return json.length > MAX_RAW_CHARS || json === '{}' ? null : json
}

/** A value of the protocol (a vote, for instance) as JSON text, with the same cleaning as `rawJson` but keeping `encPayload`. */
export function rawValueJson(value: unknown): string {
  const json = JSON.stringify(clean(value, 0, SECRET_KEYS) ?? null)
  return json.length > MAX_RAW_CHARS ? 'null' : json
}
