import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getCatalog, LANGUAGES } from '../../../src/infrastructure/i18n/index.js'
import {
  isProviderInfoKind,
  PROVIDER_INFO,
  PROVIDER_INFO_KINDS,
  type ProviderInfoKind,
} from '../../../src/infrastructure/llm/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** What the README says under "What the program connects to" (RNF-01), in each language. */
const READMES = [
  {
    file: 'README.md',
    heading: '## What the program connects to',
    bullets: ['- **The LLM provider', '- **With `claude-cli`'],
  },
  {
    file: 'README.es.md',
    heading: '## A qué se conecta el programa',
    bullets: ['- **El proveedor de LLM', '- **Con `claude-cli`'],
  },
] as const

function connectsSection(file: string, heading: string): string {
  const text = readFileSync(join(root, file), 'utf8')
  const start = text.indexOf(`${heading}\n`)
  expect(start, `${file} has "${heading}"`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, end === -1 ? undefined : end)
}

const tableHosts = [...new Set(PROVIDER_INFO_KINDS.flatMap((kind) => PROVIDER_INFO[kind].hosts))]

describe('the provider table and the README (one source of truth for RNF-01)', () => {
  it.each(READMES)('$file lists every host of the table under "What the program connects to"', ({ file, heading }) => {
    const section = connectsSection(file, heading)
    for (const host of tableHosts) expect(section, `${host} in ${file}`).toContain(`\`${host}\``)
  })

  it.each(READMES)('$file names no host for a provider that the table does not know', ({ file, heading, bullets }) => {
    const section = connectsSection(file, heading)
    const lines = section.split('\n').filter((line) => bullets.some((bullet) => line.startsWith(bullet)))
    expect(lines).toHaveLength(bullets.length)
    const mentioned = lines.flatMap((line) =>
      [...line.matchAll(/`([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|net|org|io))`/g)].map((m) => m[1] as string),
    )
    expect(mentioned.length).toBeGreaterThan(0)
    for (const host of mentioned) expect(tableHosts, `${host} of ${file} is in the table`).toContain(host)
  })

  it.each(['README.md', 'README.es.md'])('%s links the data policy of every provider that has one', (file) => {
    const text = readFileSync(join(root, file), 'utf8')
    for (const kind of PROVIDER_INFO_KINDS) {
      const { policyUrl } = PROVIDER_INFO[kind]
      if (policyUrl !== null) expect(text, `${kind} policy in ${file}`).toContain(policyUrl)
    }
  })
})

describe('the provider table', () => {
  it('has one entry per kind, with sensible values', () => {
    expect(Object.keys(PROVIDER_INFO).sort()).toEqual([...PROVIDER_INFO_KINDS].sort())
    // only Ollama keeps the chats on the machine
    for (const kind of PROVIDER_INFO_KINDS) expect(PROVIDER_INFO[kind].dataLeaves).toBe(kind !== 'ollama')
    // an API charges per use, a CLI uses your plan
    expect(PROVIDER_INFO.openai.charge).toBe('pay-per-use')
    expect(PROVIDER_INFO['claude-cli'].charge).toBe('your-plan')
    expect(PROVIDER_INFO.ollama.charge).toBe('free-local')
    // a disabled preset contacts nothing, a compatible server and a generic command have no fixed host
    for (const kind of ['gemini-cli', 'codex-cli', 'generic-cli', 'openai-compatible', 'ollama'] as const) {
      expect(PROVIDER_INFO[kind].hosts).toEqual([])
    }
    // policies are https links
    for (const kind of PROVIDER_INFO_KINDS) {
      expect(PROVIDER_INFO[kind].policyUrl === null || PROVIDER_INFO[kind].policyUrl.startsWith('https://')).toBe(true)
    }
  })

  it('knows its kinds', () => {
    expect(isProviderInfoKind('gemini')).toBe(true)
    expect(isProviderInfoKind('openai-compatible')).toBe(true)
    expect(isProviderInfoKind('cohere')).toBe(false)
  })

  it('has its words in both languages: a description for every kind, a text for every charge', () => {
    for (const language of LANGUAGES) {
      const texts = getCatalog(language).cli.provider
      for (const kind of PROVIDER_INFO_KINDS satisfies readonly ProviderInfoKind[]) {
        expect(texts.descriptions[kind].length, `${language} ${kind}`).toBeGreaterThan(10)
        expect(texts.charge[PROVIDER_INFO[kind].charge].length).toBeGreaterThan(5)
      }
    }
  })
})
