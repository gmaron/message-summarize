import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const config = fileURLToPath(new URL('../../../vite.web.config.ts', import.meta.url))
const sourceRoot = fileURLToPath(new URL('../../../src/interfaces/web', import.meta.url))
let out = ''

/** Every file under a directory, relative to it. */
function files(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)],
  )
}

// One build for the whole file (about a second).
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'msum-web-'))
  await build({
    configFile: config,
    logLevel: 'silent',
    build: { outDir: out, emptyOutDir: true, reportCompressedSize: false },
  })
}, 60_000)

afterAll(() => rmSync(out, { recursive: true, force: true }))

const read = (name: string) => readFileSync(join(out, name), 'utf8')
const scriptNames = () => files(out).filter((name) => name.endsWith('.js'))

describe('the built web (RNF-19 and the CSP)', () => {
  it('is under 100 KB of JavaScript gzipped', () => {
    expect(scriptNames().length).toBeGreaterThan(0)
    const total = scriptNames().reduce((sum, name) => sum + gzipSync(readFileSync(join(out, name))).length, 0)
    expect(total).toBeLessThan(100 * 1024)
  })

  it('has no inline script and no style attributes, and loads its CSS from a file', () => {
    const html = read('index.html')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="/)
      expect(body?.trim()).toBe('')
    }
    expect(html).not.toMatch(/<style\b/)
    expect(html).not.toMatch(/\sstyle=/)
    expect(html).not.toMatch(/\son[a-z]+=/)
    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="[^"]+\.css"/)
    for (const name of files(out).filter((file) => /\.(js|css|html)$/.test(file))) {
      const text = read(name)
      expect(text, name).not.toMatch(/\sstyle="/)
      expect(text, name).not.toMatch(/\beval\(/)
      expect(text, name).not.toMatch(/new Function\(/)
    }
  })

  it('carries the texts of the web and not the prompts or the texts of the command line', () => {
    const code = scriptNames().map(read).join('\n')
    expect(code).toContain('Summarize now')
    expect(code).toContain('Resumir ahora')
    expect(code).not.toContain('Sos el asistente')
    expect(code).not.toContain('Usage:')
  })

  it('never renders data as markup, and has no style attributes or directives in its components (the digest comes from chats of third parties)', () => {
    for (const name of files(sourceRoot).filter((file) => /\.(svelte|ts)$/.test(file))) {
      const text = readFileSync(join(sourceRoot, name), 'utf8')
      expect(text, name).not.toContain('{@html')
      expect(text, name).not.toContain('innerHTML')
      if (name.endsWith('.svelte')) expect(text, name).not.toMatch(/\sstyle[:=]/)
    }
  })
})
