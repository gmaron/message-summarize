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

/** What the network guide says about each destination (RNF-01), in each language: the README links to it. */
const GUIDES = [
  {
    file: 'docs/guides/network-and-privacy.md',
    policyFile: 'docs/guides/providers.md',
    headings: ['### The LLM provider you chose', '### With `claude-cli`'],
  },
  {
    file: 'docs/guias/red-y-privacidad.md',
    policyFile: 'docs/guias/proveedores.md',
    headings: ['### El proveedor de LLM que elegiste', '### Con `claude-cli`'],
  },
] as const

function readText(file: string): string {
  return readFileSync(join(root, file), 'utf8')
}

/** The text from a heading to the next heading of the same level. */
function sectionOf(file: string, heading: string): string {
  const text = readText(file)
  const start = text.indexOf(heading)
  expect(start, `${file} has "${heading}"`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf('\n### ', start + heading.length)
  return text.slice(start, end === -1 ? undefined : end)
}

const tableHosts = [...new Set(PROVIDER_INFO_KINDS.flatMap((kind) => PROVIDER_INFO[kind].hosts))]

describe('the provider table and the guides (one source of truth for RNF-01)', () => {
  it.each(GUIDES)('$file lists every host of the table', ({ file }) => {
    const text = readText(file)
    for (const host of tableHosts) expect(text, `${host} in ${file}`).toContain(`\`${host}\``)
  })

  it.each(GUIDES)('$file names no host for a provider that the table does not know', ({ file, headings }) => {
    const mentioned = headings.flatMap((heading) =>
      [...sectionOf(file, heading).matchAll(/`([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|net|org|io))`/g)].map(
        (m) => m[1] as string,
      ),
    )
    expect(mentioned.length).toBeGreaterThan(0)
    for (const host of mentioned) expect(tableHosts, `${host} of ${file} is in the table`).toContain(host)
  })

  it.each(GUIDES)('$policyFile links the data policy of every provider that has one', ({ policyFile }) => {
    const text = readText(policyFile)
    for (const kind of PROVIDER_INFO_KINDS) {
      const { policyUrl } = PROVIDER_INFO[kind]
      if (policyUrl !== null) expect(text, `${kind} policy in ${policyFile}`).toContain(policyUrl)
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
