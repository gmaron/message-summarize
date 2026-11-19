import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('no native module sneaks in (docs/requirements.md §6)', () => {
  // Baileys declares sharp (native) as a required peer dependency. Our package.json satisfies it with the empty
  // vendor/sharp-stub, so that no consumer install pulls the native package. If this fails, the real sharp is installed.
  it('sharp resolves only to the empty vendored stub', () => {
    const require = createRequire(import.meta.url)
    const root = join(import.meta.dirname, '..', '..')
    expect(realpathSync(require.resolve('sharp'))).toBe(realpathSync(join(root, 'vendor/sharp-stub/index.js')))
    const img = join(root, 'node_modules/@img')
    expect(existsSync(img) ? readdirSync(img) : []).toEqual([])
    expect(readdirSync(join(root, 'vendor/sharp-stub')).sort()).toEqual(['index.js', 'package.json'])
  })
})
