import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

describe('no native module sneaks in (docs/requirements.md §6)', () => {
  // Baileys declares sharp (native) as a required peer dependency. The project's .npmrc (legacy-peer-deps) keeps it
  // out of the install. If this fails, the .npmrc is missing or was not applied: `npm install` pulled sharp in.
  it('sharp cannot be resolved from the project', () => {
    const require = createRequire(import.meta.url)
    expect(() => require.resolve('sharp')).toThrow(/Cannot find module/)
  })
})
