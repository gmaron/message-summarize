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

/**
 * Control characters (C0, DEL, C1) and bidirectional overrides. Text from a provider or a server ends up on the user's
 * terminal: an escape sequence in it could rewrite the screen or the terminal title, so it is removed.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_FOR_TERMINAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** Short, safe excerpt of text coming from a provider, for error reasons. Never pass the transcript here. */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(UNSAFE_FOR_TERMINAL, '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}
