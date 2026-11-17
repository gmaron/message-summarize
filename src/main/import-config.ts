import { type AppConfig, mergeConfigJson, parseConfig } from './config.js'

type Obj = Record<string, unknown>
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

export interface MappedConfig {
  /** The `config.json` of the account: only the options that differ from what the installation already gives it. */
  readonly config: Obj
  /** The options of this program that were set, by name ("provider.primary"). */
  readonly written: readonly string[]
  /** Options of the previous tool that have no equivalent here (by their own name). */
  readonly unmapped: readonly string[]
  /** Options of the previous tool whose value is not valid here: they were not imported. */
  readonly invalid: readonly string[]
  /**
   * Privacy lists (`soloLocal`: chats that never leave the computer; `excluir`: chats that are never stored) that could
   * NOT be imported. Never dropped silently: the import refuses while any is here.
   */
  readonly blocked: readonly PrivacyBlock[]
}

export interface PrivacyBlock {
  readonly legacyKey: 'soloLocal' | 'excluir'
  /** `needsOllamaModel`: the list is fine, but this program needs an Ollama model for local-only chats and has none. */
  readonly reason: 'invalid' | 'needsOllamaModel'
}

/** Options of the previous tool that have no equivalent here, and why they do not matter (see the README). */
const KNOWN_UNMAPPED = ['leerImagenes', 'diasDeAudiosDelHistorial', 'whisper', 'web']

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * Maps the configuration of the previous tool (Spanish option names) to this program's. Each legacy option has its
 * equivalent:
 *
 * | previous tool              | this program                       |
 * | miNombre                   | ownerName                          |
 * | excluir                    | excludePatterns                    |
 * | horasPorDefecto            | defaultWindowHours                 |
 * | soloNoLeidos               | unreadOnly                         |
 * | sinAgendarEnRojo           | flagUnsaved                        |
 * | ocultarResto               | hideRest                           |
 * | maxCaracteresPorChat       | maxCharsPerConversation            |
 * | soloLocal                  | localOnlyPatterns                  |
 * | proveedor "claude"/"ollama"| provider.primary "claude-cli"/"ollama" (and `backup: "ollama"` for "claude" when an
 * |                            | Ollama model is set: the previous tool fell back to Ollama when Claude failed) |
 * | claude.comando / .modelo   | provider.claudeCli.command / .model |
 * | ollama.url / .modelo / .contexto | provider.ollama.baseUrl / .model / .numCtx |
 *
 * `leerImagenes`, `diasDeAudiosDelHistorial`, `whisper`, `web` and any other option have no equivalent: they are
 * reported. The previous tool had no language, time zone or schedules in its configuration (the schedules lived in the
 * cron of its sandbox or in launchd), so none of those is written.
 *
 * Only what differs from `baseline` (what the account would get from the installation's config.json) is written, and
 * the result is validated as a whole with the installation's file: an option that does not validate is dropped and
 * reported, never written.
 */
export function mapLegacyConfig(
  legacy: Obj | null,
  installation: { readonly raw: Obj; readonly baseline: AppConfig },
): MappedConfig {
  const written: string[] = []
  const unmapped: string[] = []
  const invalid: string[] = []
  if (legacy === null) return { config: {}, written, unmapped, invalid, blocked: [] }

  // The previous tool's names that were understood; everything else is reported.
  const understood = new Set([
    'miNombre',
    'excluir',
    'horasPorDefecto',
    'soloNoLeidos',
    'sinAgendarEnRojo',
    'ocultarResto',
    'maxCaracteresPorChat',
    'soloLocal',
    'proveedor',
    'claude',
    'ollama',
  ])
  for (const key of Object.keys(legacy)) if (!understood.has(key)) unmapped.push(key)
  for (const key of KNOWN_UNMAPPED) if (key in legacy && !unmapped.includes(key)) unmapped.push(key)

  // Candidate options, keyed by OUR top-level name, with the legacy name they come from (for reporting).
  const candidates = new Map<string, { value: unknown; from: string }>()
  const take = (legacyKey: string, ours: string): void => {
    if (legacyKey in legacy) candidates.set(ours, { value: legacy[legacyKey], from: legacyKey })
  }
  take('miNombre', 'ownerName')
  take('excluir', 'excludePatterns')
  take('horasPorDefecto', 'defaultWindowHours')
  take('soloNoLeidos', 'unreadOnly')
  take('sinAgendarEnRojo', 'flagUnsaved')
  take('ocultarResto', 'hideRest')
  take('maxCaracteresPorChat', 'maxCharsPerConversation')
  take('soloLocal', 'localOnlyPatterns')

  // The provider: the previous tool defaulted to Ollama, and `proveedor: "claude"` fell back to Ollama.
  const provider: Obj = {}
  const proveedor = legacy.proveedor ?? 'ollama'
  const claude = isObject(legacy.claude) ? legacy.claude : {}
  const ollama = isObject(legacy.ollama) ? legacy.ollama : {}
  if (proveedor === 'claude') provider.primary = 'claude-cli'
  else if (proveedor === 'ollama') provider.primary = 'ollama'
  else invalid.push('proveedor')
  if (proveedor === 'claude' && typeof ollama.modelo === 'string') provider.backup = 'ollama'
  if ('comando' in claude || 'modelo' in claude) {
    provider.claudeCli = {
      ...('comando' in claude ? { command: claude.comando } : {}),
      ...('modelo' in claude ? { model: claude.modelo } : {}),
    }
  }
  if ('url' in ollama || 'modelo' in ollama || 'contexto' in ollama) {
    provider.ollama = {
      ...('url' in ollama ? { baseUrl: ollama.url } : {}),
      ...('modelo' in ollama ? { model: ollama.modelo } : {}),
      ...('contexto' in ollama ? { numCtx: ollama.contexto } : {}),
    }
  }
  if (Object.keys(provider).length > 0) candidates.set('provider', { value: provider, from: 'proveedor' })

  const { baseline } = installation
  const build = (): Obj => {
    const account: Obj = {}
    for (const [name, { value }] of candidates) account[name] = value
    return account
  }

  // Drop the options that do not validate (with the installation's file under them), until the result does.
  let needsOllamaModel = false
  for (let round = 0; round < 12; round++) {
    const result = parseConfig(mergeConfigJson(installation.raw, build()), baseline.timezone)
    if (result.ok) break
    if (result.error.some((issue) => issue.option === 'provider.ollama.model' && issue.code === 'required')) {
      needsOllamaModel = true
    }
    const bad = new Set(result.error.map((issue) => issue.option.split(/[.[]/)[0] as string))
    let dropped = false
    for (const name of bad) {
      const candidate = candidates.get(name)
      if (candidate === undefined) continue
      candidates.delete(name)
      invalid.push(candidate.from)
      dropped = true
    }
    if (!dropped) {
      // Something the installation's own file got wrong: nothing of this can be written safely.
      for (const { from } of candidates.values()) invalid.push(from)
      candidates.clear()
      break
    }
  }

  // A privacy list that did not make it is never dropped silently: it is returned so that the import can refuse.
  const blocked: PrivacyBlock[] = []
  for (const [legacyKey, ours] of [
    ['soloLocal', 'localOnlyPatterns'],
    ['excluir', 'excludePatterns'],
  ] as const) {
    const value = legacy[legacyKey]
    const hasList = legacyKey in legacy && !(Array.isArray(value) && value.length === 0)
    if (!hasList || candidates.has(ours)) continue
    blocked.push({
      legacyKey,
      reason: legacyKey === 'soloLocal' && needsOllamaModel && isStringList(value) ? 'needsOllamaModel' : 'invalid',
    })
  }

  const config: Obj = {}
  const note = (name: string): void => {
    written.push(name)
  }
  const sameList = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((item, i) => item === b[i])
  const raw = build()
  const differs = (value: unknown, current: unknown): boolean => {
    if (isStringList(value) && isStringList(current)) return !sameList(value, current)
    return value !== current
  }

  const scalar: [string, unknown][] = [
    ['ownerName', baseline.digest.ownerName],
    ['defaultWindowHours', baseline.digest.defaultWindowHours],
    ['maxCharsPerConversation', baseline.digest.maxCharsPerConversation],
    ['unreadOnly', baseline.digest.unreadOnly],
    ['flagUnsaved', baseline.digest.flagUnsaved],
    ['hideRest', baseline.digest.hideRest],
  ]
  for (const [name, current] of scalar) {
    if (name in raw && differs(raw[name], current)) {
      config[name] = raw[name]
      note(name)
    }
  }
  // The two privacy lists are added to the installation's, never replaced: only what the installation lacks is written.
  for (const [name, current] of [
    ['excludePatterns', baseline.digest.excludePatterns],
    ['localOnlyPatterns', baseline.localOnlyPatterns],
  ] as const) {
    const value = raw[name]
    if (!isStringList(value)) continue
    const extra = value.filter((item) => !current.includes(item))
    if (extra.length > 0) {
      config[name] = extra
      note(name)
    }
  }
  const mappedProvider = isObject(raw.provider) ? raw.provider : null
  if (mappedProvider !== null) {
    const out: Obj = {}
    const put = (path: string[], value: unknown, current: unknown): void => {
      if (value === undefined || !differs(value, current)) return
      let node = out
      for (const key of path.slice(0, -1)) {
        node[key] = isObject(node[key]) ? node[key] : {}
        node = node[key] as Obj
      }
      node[path[path.length - 1] as string] = value
      note(`provider.${path.join('.')}`)
    }
    put(['primary'], mappedProvider.primary, baseline.provider.primary)
    put(['backup'], mappedProvider.backup, baseline.provider.backup)
    const cli = isObject(mappedProvider.claudeCli) ? mappedProvider.claudeCli : {}
    put(['claudeCli', 'command'], cli.command, baseline.provider.claudeCli.command)
    put(['claudeCli', 'model'], cli.model, baseline.provider.claudeCli.model)
    const oll = isObject(mappedProvider.ollama) ? mappedProvider.ollama : {}
    put(['ollama', 'baseUrl'], oll.baseUrl, baseline.provider.ollama.baseUrl)
    put(['ollama', 'model'], oll.model, baseline.provider.ollama.model)
    put(['ollama', 'numCtx'], oll.numCtx, baseline.provider.ollama.numCtx)
    if (Object.keys(out).length > 0) config.provider = out
  }

  return { config, written, unmapped: [...new Set(unmapped)], invalid: [...new Set(invalid)], blocked }
}
