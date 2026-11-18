import { describe, expect, it } from 'vitest'
import { classifyProviderError, TEST_TIMEOUT_MS, TEST_TRANSCRIPT } from '../../../src/main/provider-test.js'

describe('classifyProviderError (RF-41)', () => {
  it.each([
    ['could not run claude: ENOENT', 'notFound'],
    ['could not run /opt/bin/claude: EACCES', 'notFound'],
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
    expect(TEST_TIMEOUT_MS).toEqual({ 'claude-cli': 90_000, ollama: 60_000 })
  })

  it('summarizes a made-up chat that holds no real-looking data', () => {
    expect(TEST_TRANSCRIPT).toMatch(/made-up/)
    expect(TEST_TRANSCRIPT).not.toMatch(/\d{6,}/)
    expect(TEST_TRANSCRIPT).not.toMatch(/@/)
  })
})
