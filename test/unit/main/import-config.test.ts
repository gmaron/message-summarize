import { describe, expect, it } from 'vitest'
import { type AppConfig, parseConfig } from '../../../src/main/config.js'
import { mapLegacyConfig } from '../../../src/main/import-config.js'

const defaults = (raw: Record<string, unknown> = {}): AppConfig => {
  const result = parseConfig(raw, 'UTC')
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}
const map = (legacy: Record<string, unknown> | null, raw: Record<string, unknown> = {}) =>
  mapLegacyConfig(legacy, { raw, baseline: defaults(raw) })

describe('mapLegacyConfig: every option of the previous tool', () => {
  it.each([
    ['miNombre', 'Pat Prueba', { ownerName: 'Pat Prueba' }],
    ['excluir', ['uno', 'dos'], { excludePatterns: ['uno', 'dos'] }],
    ['horasPorDefecto', 12, { defaultWindowHours: 12 }],
    ['soloNoLeidos', true, { unreadOnly: true }],
    ['sinAgendarEnRojo', true, { flagUnsaved: true }],
    ['ocultarResto', true, { hideRest: true }],
    ['maxCaracteresPorChat', 5000, { maxCharsPerConversation: 5000 }],
  ])('%s becomes the equivalent option', (legacyName, value, expected) => {
    // an Ollama model is only needed by the options that use it: these do not
    const mapped = map({ proveedor: 'claude', [legacyName]: value })
    expect(mapped.config).toEqual({ ...expected, provider: { primary: 'claude-cli' } })
    expect(mapped.invalid).toEqual([])
  })

  it('soloLocal becomes localOnlyPatterns, with the Ollama model it needs', () => {
    const mapped = map({ proveedor: 'claude', soloLocal: ['banco'], ollama: { modelo: 'm' } })
    expect(mapped.config.localOnlyPatterns).toEqual(['banco'])
    expect(mapped.invalid).toEqual([])
  })

  it('proveedor "claude" is claude-cli with an Ollama backup when an Ollama model is set', () => {
    expect(map({ proveedor: 'claude' }).config).toEqual({ provider: { primary: 'claude-cli' } })
    expect(map({ proveedor: 'claude', ollama: { modelo: 'm' } }).config).toEqual({
      provider: { primary: 'claude-cli', backup: 'ollama', ollama: { model: 'm' } },
    })
  })

  it('proveedor "ollama" (also the default of the previous tool) is ollama, with its settings', () => {
    const mapped = map({ proveedor: 'ollama', ollama: { url: 'http://10.0.0.5:11434', modelo: 'm', contexto: 4096 } })
    expect(mapped.config).toEqual({
      provider: { primary: 'ollama', ollama: { baseUrl: 'http://10.0.0.5:11434', model: 'm', numCtx: 4096 } },
    })
    expect(map({ ollama: { modelo: 'm' } }).config).toEqual({ provider: { primary: 'ollama', ollama: { model: 'm' } } })
  })

  it('claude.comando and claude.modelo become claudeCli.command and model', () => {
    const mapped = map({ proveedor: 'claude', claude: { comando: '/opt/claude', modelo: 'haiku' } })
    expect(mapped.config).toEqual({
      provider: { primary: 'claude-cli', claudeCli: { command: '/opt/claude', model: 'haiku' } },
    })
    expect(mapped.written).toEqual(
      expect.arrayContaining(['provider.primary', 'provider.claudeCli.command', 'provider.claudeCli.model']),
    )
  })
})

describe('mapLegacyConfig: what is written and what is reported', () => {
  it('writes only what differs from what the installation already gives the account', () => {
    const raw = {
      provider: { primary: 'claude-cli', claudeCli: { model: 'opus' } },
      defaultWindowHours: 12,
      hideRest: true,
    }
    const mapped = map(
      {
        proveedor: 'claude',
        claude: { comando: 'claude', modelo: 'opus' }, // the installation has this model already
        horasPorDefecto: 12, // same as the installation
        ocultarResto: false, // different
        soloNoLeidos: false, // same as the default
      },
      raw,
    )
    expect(mapped.config).toEqual({ hideRest: false })
    expect(mapped.written).toEqual(['hideRest'])
  })

  it('adds the privacy lists to the installation, writing only what it lacks', () => {
    const raw = { excludePatterns: ['ya'], localOnlyPatterns: ['local'], provider: { ollama: { model: 'm' } } }
    const mapped = map({ proveedor: 'claude', excluir: ['ya', 'nuevo'], soloLocal: ['local', 'otro'] }, raw)
    expect(mapped.config.excludePatterns).toEqual(['nuevo'])
    expect(mapped.config.localOnlyPatterns).toEqual(['otro'])
    expect(map({ proveedor: 'claude', excluir: ['ya'] }, raw).config.excludePatterns).toBeUndefined()
  })

  it('reports the options that have no equivalent, by their own name, including unknown ones', () => {
    const mapped = map({
      proveedor: 'claude',
      leerImagenes: true,
      web: { permitidos: [] },
      algoNuevo: 1,
    })
    expect([...mapped.unmapped].sort()).toEqual(['algoNuevo', 'leerImagenes', 'web'])
    expect(mapped.config).toEqual({ provider: { primary: 'claude-cli' } })
  })

  describe('audio transcription (RF-15, RF-23)', () => {
    it('diasDeAudiosDelHistorial becomes transcription.historyAudioDays, and whisper.idioma transcription.language', () => {
      const mapped = map({ proveedor: 'claude', diasDeAudiosDelHistorial: 30, whisper: { idioma: 'es' } })
      expect(mapped.config).toEqual({
        provider: { primary: 'claude-cli' },
        transcription: { historyAudioDays: 30, language: 'es' },
      })
      expect(mapped.written).toEqual(
        expect.arrayContaining(['transcription.historyAudioDays', 'transcription.language']),
      )
      expect(mapped.unmapped).toEqual([])
      expect(mapped.invalid).toEqual([])
    })

    it('writes only what differs from the default: the same 14 days is not written', () => {
      const mapped = map({ proveedor: 'claude', diasDeAudiosDelHistorial: 14 })
      expect(mapped.config).toEqual({ provider: { primary: 'claude-cli' } })
    })

    it('whisper.modelo becomes transcription.model when its file is a known ggml model, whatever folder it was in', () => {
      for (const modelo of ['models/ggml-base.bin', '/opt/whisper/ggml-small.en.bin', 'ggml-large-v3-turbo-q5_0.bin']) {
        const name = /ggml-(.+)\.bin$/.exec(modelo)?.[1]
        expect(map({ proveedor: 'claude', whisper: { modelo } }).config.transcription, modelo).toEqual({
          model: name,
        })
      }
    })

    it('whisper.modelo that is not a known model is reported by name, not guessed', () => {
      const mapped = map({ proveedor: 'claude', whisper: { modelo: 'models/whisper-de-prueba.bin', idioma: 'es' } })
      expect(mapped.unmapped).toEqual(['whisper.modelo'])
      expect(mapped.config.transcription).toEqual({ language: 'es' })
    })

    it('never turns transcription on: it would start downloading the audios of the account', () => {
      const mapped = map({
        proveedor: 'claude',
        diasDeAudiosDelHistorial: 30,
        whisper: { modelo: 'models/ggml-base.bin', idioma: 'es' },
      })
      expect(mapped.config.transcription).not.toHaveProperty('enabled')
    })

    it('drops, and reports, a value that is not valid here instead of writing it', () => {
      const mapped = map({ proveedor: 'claude', diasDeAudiosDelHistorial: -3, whisper: { idioma: 'Español' } })
      expect(mapped.config.transcription).toBeUndefined()
      expect(mapped.invalid.length).toBeGreaterThan(0)
    })
  })

  it('reports values that are not valid here, and does not write them', () => {
    const mapped = map({
      proveedor: 'claude',
      horasPorDefecto: -3,
      excluir: 'no es una lista',
      maxCaracteresPorChat: 1.5,
      soloNoLeidos: 'si',
      miNombre: '   ',
      ocultarResto: true,
    })
    expect([...mapped.invalid].sort()).toEqual([
      'excluir',
      'horasPorDefecto',
      'maxCaracteresPorChat',
      'miNombre',
      'soloNoLeidos',
    ])
    expect(mapped.config).toEqual({ hideRest: true, provider: { primary: 'claude-cli' } })
  })

  it('reports an unknown provider, and an Ollama provider that has no model', () => {
    const unknown = map({ proveedor: 'gpt', ocultarResto: true })
    expect(unknown.invalid).toContain('proveedor')
    expect(unknown.config).toEqual({ hideRest: true })
    // the default of the previous tool is Ollama, which this program cannot use without a model
    const noModel = map({ proveedor: 'ollama', ocultarResto: true })
    expect(noModel.invalid).toContain('proveedor')
    expect(noModel.config).toEqual({ hideRest: true })
  })

  it('never drops a privacy list silently: it comes back as blocked', () => {
    // soloLocal needs an Ollama model, and there is none anywhere
    const noModel = map({ proveedor: 'claude', soloLocal: ['banco'], ocultarResto: true })
    expect(noModel.blocked).toEqual([{ legacyKey: 'soloLocal', reason: 'needsOllamaModel' }])
    // the same list is fine when the installation has a model
    const withModel = map({ proveedor: 'claude', soloLocal: ['banco'] }, { provider: { ollama: { model: 'm' } } })
    expect(withModel.blocked).toEqual([])
    expect(withModel.config.localOnlyPatterns).toEqual(['banco'])
    // or the previous config has one
    expect(map({ proveedor: 'claude', soloLocal: ['banco'], ollama: { modelo: 'm' } }).blocked).toEqual([])
    // lists that are not lists of texts
    expect(map({ proveedor: 'claude', excluir: 'no es una lista' }).blocked).toEqual([
      { legacyKey: 'excluir', reason: 'invalid' },
    ])
    expect(map({ proveedor: 'claude', excluir: ['ok', 3] }).blocked).toEqual([
      { legacyKey: 'excluir', reason: 'invalid' },
    ])
    expect(map({ proveedor: 'claude', soloLocal: { a: 1 }, ollama: { modelo: 'm' } }).blocked).toEqual([
      { legacyKey: 'soloLocal', reason: 'invalid' },
    ])
    // an empty list is nothing to protect, and a list that is not there neither
    expect(map({ proveedor: 'claude', soloLocal: [], excluir: [] }).blocked).toEqual([])
    expect(map({ proveedor: 'claude' }).blocked).toEqual([])
    // other options may still be reported and dropped, without blocking
    const other = map({ proveedor: 'claude', horasPorDefecto: -1 })
    expect(other.invalid).toContain('horasPorDefecto')
    expect(other.blocked).toEqual([])
  })

  it('writes nothing for a missing or empty configuration, and ignores a language, time zone or schedules', () => {
    expect(map(null)).toEqual({ config: {}, written: [], unmapped: [], invalid: [], blocked: [] })
    const mapped = map({ proveedor: 'claude' })
    expect(mapped.config).not.toHaveProperty('language')
    expect(mapped.config).not.toHaveProperty('timezone')
    expect(mapped.config).not.toHaveProperty('schedules')
  })
})
