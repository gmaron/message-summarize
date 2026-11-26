import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMain } from '../../../../src/main/app.js'
import { disposeHarnesses, makeHarness } from '../../../support/cli-harness.js'

afterEach(() => {
  vi.restoreAllMocks()
  disposeHarnesses()
})

describe('msum doctor points to the real test of the provider', () => {
  it('hints "msum provider test" for the selected providers, and still calls nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const h = await makeHarness({
      config: { language: 'en', provider: { primary: 'anthropic', anthropic: { model: 'claude-sonnet-5-5' } } },
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789ABCDEF' },
    })
    await runMain(['doctor'], h.ctx)
    expect(h.out.join('\n')).toContain('run "msum provider test"')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('in Spanish, and not when no provider was chosen', async () => {
    const es = await makeHarness({ config: { language: 'es', provider: { primary: 'claude-cli' } } })
    await runMain(['doctor'], es.ctx)
    expect(es.out.join('\n')).toContain('corré "msum provider test"')
    const none = await makeHarness({ config: { language: 'en' } })
    await runMain(['doctor'], none.ctx)
    expect(none.out.join('\n')).not.toContain('msum provider test')
  })
})
