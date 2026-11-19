import { describe, expect, it } from 'vitest'
import { isVersionManaged, stableNodePath } from '../../../src/main/node-path.js'

// A fake file system: each path resolves to a real file, or does not exist.
const fsOf = (real: Record<string, string>) => async (path: string) => {
  const target = real[path]
  if (target === undefined) throw new Error('ENOENT')
  return target
}

const CELLAR = '/opt/homebrew/Cellar/node/22.16.0/bin/node'

describe('stableNodePath', () => {
  it('uses the stable Homebrew link when it is the same file', async () => {
    const resolve = fsOf({ [CELLAR]: CELLAR, '/opt/homebrew/opt/node/bin/node': CELLAR })
    expect(await stableNodePath(CELLAR, '/usr/bin', resolve)).toEqual({
      path: '/opt/homebrew/opt/node/bin/node',
      versionManaged: false,
    })
  })

  it('keeps the formula of a versioned node (node@22)', async () => {
    const path = '/usr/local/Cellar/node@22/22.16.0/bin/node'
    const resolve = fsOf({ [path]: path, '/usr/local/opt/node@22/bin/node': path })
    expect((await stableNodePath(path, undefined, resolve)).path).toBe('/usr/local/opt/node@22/bin/node')
  })

  it('falls back to the first node on the PATH that is the same file, never a Cellar path', async () => {
    const resolve = fsOf({ [CELLAR]: CELLAR, '/opt/homebrew/bin/node': CELLAR, '/other/bin/node': '/else' })
    const choice = await stableNodePath(CELLAR, ':/other/bin:/opt/homebrew/bin', resolve)
    expect(choice.path).toBe('/opt/homebrew/bin/node')
  })

  it('keeps the exec path when nothing stable is found, or when it is not a Cellar path', async () => {
    expect((await stableNodePath(CELLAR, '/nowhere', fsOf({ [CELLAR]: CELLAR }))).path).toBe(CELLAR)
    expect((await stableNodePath('/usr/bin/node', '/usr/bin', fsOf({}))).path).toBe('/usr/bin/node')
  })

  it('flags a node inside a version manager directory', async () => {
    for (const path of [
      '/Users/ana/.nvm/versions/node/v22/bin/node',
      '/Users/ana/.volta/tools/image/node/22/bin/node',
      '/Users/ana/.asdf/installs/nodejs/22/bin/node',
      '/Users/ana/.local/share/fnm/node-versions/v22/installation/bin/node',
      'C:\\Users\\Ana\\AppData\\Roaming\\nvm\\v22\\node.exe',
    ]) {
      expect(isVersionManaged(path)).toBe(true)
    }
    expect(isVersionManaged('/usr/local/bin/node')).toBe(false)
    const nvm = '/Users/ana/.nvm/versions/node/v22/bin/node'
    expect((await stableNodePath(nvm, undefined, fsOf({}))).versionManaged).toBe(true)
  })

  it('uses the real file system by default', async () => {
    const choice = await stableNodePath(process.execPath, process.env.PATH)
    expect(choice.path).not.toBe('')
  })
})
