import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeHarnesses } from '../../../support/cli-harness.js'
import { disposeWorlds, world } from '../../../support/web-world.js'

/** While set, every write of an account config sees the file change under it (a hand edit that keeps landing). */
const state = vi.hoisted(() => ({ editing: null as string | null, n: 0, extra: '' }))

vi.mock('../../../../src/main/config/config-writer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/config/config-writer.js')>()
  const { writeFileSync: write } = await import('node:fs')
  return {
    ...real,
    updateAccountConfig: (options: Parameters<typeof real.updateAccountConfig>[0]) =>
      real.updateAccountConfig({
        ...options,
        beforeCommit: () => {
          if (state.editing !== null && options.dryRun !== true)
            write(state.editing, `{${state.extra}"concurrency":1${'0'.repeat(++state.n)}}\n`)
        },
      }),
  }
})

afterEach(async () => {
  state.editing = null
  state.extra = ''
  await disposeWorlds()
  disposeHarnesses()
})

describe('a config file that keeps changing under the write (409 concurrentEdit)', () => {
  it('PUT answers 409 and leaves the config as the other writer left it', async () => {
    const w = await world({ accounts: ['alpha'] })
    const file = w.h.accountOf('alpha').configFile
    writeFileSync(file, '{}\n')
    state.editing = file
    const reply = await w.api('PUT', '/api/accounts/alpha/prompt', { text: 'hello' })
    expect(reply).toEqual({ status: 409, body: { error: 'concurrentEdit' } })
    expect(readFileSync(file, 'utf8')).toContain('"concurrency"')
    expect(readFileSync(file, 'utf8')).not.toContain('promptFile')
  })

  it('DELETE answers 409 and keeps the prompt file', async () => {
    const w = await world({ accounts: ['alpha'] })
    const dir = w.h.accountOf('alpha').dir
    const file = w.h.accountOf('alpha').configFile
    writeFileSync(join(dir, 'prompt.md'), 'kept')
    writeFileSync(file, '{"promptFile":"prompt.md"}\n')
    state.extra = '"promptFile":"prompt.md",'
    state.editing = file
    const reply = await w.api('DELETE', '/api/accounts/alpha/prompt')
    expect(reply).toEqual({ status: 409, body: { error: 'concurrentEdit' } })
    expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toBe('kept')
    expect(existsSync(join(dir, 'prompt.previous.md'))).toBe(false)
    expect(statSync(join(dir, 'prompt.md')).isFile()).toBe(true)
  })
})
