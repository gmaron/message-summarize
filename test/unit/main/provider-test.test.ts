import { describe, expect, it } from 'vitest'
import { PROVIDERS } from '../../../src/main/config.js'
import { classifyProviderError, TEST_TIMEOUT_MS, TEST_TRANSCRIPT } from '../../../src/main/provider-test.js'

describe('classifyProviderError (RF-41)', () => {
  it.each([
    ['could not run claude: ENOENT', 'notFound'],
    ['could not run /opt/bin/claude: EACCES', 'notFound'],
    // the CLI is checked with --help before it runs (RF-49): a missing program says so
    ['claude was not found', 'notFound'],
    ['claude could not be checked: its --help did not run', 'failed'],
    ['claude timed out after 90s', 'timeout'],
    ['ollama timed out after 60s', 'timeout'],
    ['could not reach ollama: fetch failed', 'unreachable'],
    ['claude returned no structured output', 'invalidSummary'],
    ['invalid summary: resumen must be a string', 'invalidSummary'],
    ['claude returned no structured output; retry: invalid summary: x', 'invalidSummary'],
    ['claude exited with code 0: stdout was 12 chars', 'invalidSummary'],
    ['ollama returned content that is not JSON', 'invalidSummary'],
    ['ollama returned no message content', 'invalidSummary'],
    ['ollama answered 500: model not found', 'failed'],
    ['claude exited with code 2: boom', 'failed'],
    ['claude: Not logged in', 'failed'],
    ['', 'failed'],
  ])('%s is %s', (reason, code) => {
    expect(classifyProviderError(reason)).toBe(code)
  })
})

describe('the test of a provider', () => {
  it('is bounded: a minute and a half for Claude, one minute for Ollama', () => {
    expect(TEST_TIMEOUT_MS['claude-cli']).toBe(90_000)
    expect(TEST_TIMEOUT_MS.ollama).toBe(60_000)
    // every provider the configuration knows has a limit, and none waits longer than a minute and a half
    expect(Object.keys(TEST_TIMEOUT_MS).sort()).toEqual([...PROVIDERS].sort())
    expect(Math.max(...Object.values(TEST_TIMEOUT_MS))).toBeLessThanOrEqual(90_000)
  })

  it('summarizes a made-up chat that holds no real-looking data', () => {
    expect(TEST_TRANSCRIPT).toMatch(/made-up/)
    expect(TEST_TRANSCRIPT).not.toMatch(/\d{6,}/)
    expect(TEST_TRANSCRIPT).not.toMatch(/@/)
  })
})
