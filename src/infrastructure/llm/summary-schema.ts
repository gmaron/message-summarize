/**
 * JSON schema of the summary an LLM must return. It mirrors `parseSummaryResponse` (src/domain/summary.ts): same keys,
 * same priority values. Shared by every provider that can force a schema (Claude CLI `--json-schema`, Ollama `format`).
 */
export const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    resumen: { type: 'string' },
    pendientes: { type: 'array', items: { type: 'string' } },
    necesita_respuesta: { type: 'boolean' },
    prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] },
  },
  required: ['resumen', 'pendientes', 'necesita_respuesta', 'prioridad'],
} as const

export const SUMMARY_JSON_SCHEMA_TEXT = JSON.stringify(SUMMARY_JSON_SCHEMA)

/**
 * The same schema with `additionalProperties: false`, which the structured-output modes of OpenAI (strict) and
 * Anthropic require on every object. Gemini accepts it too. The shared schema above stays as the CLI and Ollama get it.
 */
export const STRICT_SUMMARY_JSON_SCHEMA = { ...SUMMARY_JSON_SCHEMA, additionalProperties: false } as const

/** Short, safe excerpt of text coming from a provider, for error reasons. Never pass the transcript here. */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}
