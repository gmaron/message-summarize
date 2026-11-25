import { realpath } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export interface NodeChoice {
  /** The node executable the service will run. */
  readonly path: string
  /** True when it lives in a version manager's directory: it disappears when that version is removed. */
  readonly versionManaged: boolean
}

/** Homebrew installs node under `<prefix>/Cellar/<formula>/<version>/bin/node`, and links it at `<prefix>/opt/<formula>`. */
const CELLAR = /^(.+)\/Cellar\/(node(?:@[\d.]+)?)\/[^/]+\/bin\/node$/
const VERSION_MANAGERS = /[\\/](?:\.nvm|nvm|\.fnm|fnm|fnm_multishells|\.volta|volta|\.asdf|asdf)[\\/]/i

/** True when the path is inside the directory of a node version manager. */
export const isVersionManaged = (path: string): boolean => VERSION_MANAGERS.test(path)

async function sameFile(a: string, b: string, resolve: (path: string) => Promise<string>): Promise<boolean> {
  try {
    return (await resolve(a)) === (await resolve(b))
  } catch {
    return false
  }
}

/**
 * The node a service should run. `process.execPath` of a Homebrew node is the versioned Cellar path, which a `brew
 * upgrade` deletes, so the stable link of the same formula is used when it is the same file; failing that, the first
 * `node` on the PATH that is the same file. Anything else is kept as it is. A node inside a version manager's
 * directory is flagged: the service keeps pointing at that version until `msum service install` is run again.
 */
export async function stableNodePath(
  execPath: string,
  pathVariable: string | undefined,
  resolve: (path: string) => Promise<string> = realpath,
): Promise<NodeChoice> {
  let chosen = execPath
  const cellar = CELLAR.exec(execPath)
  if (cellar !== null) {
    const [, prefix, formula] = cellar
    const link = `${prefix}/opt/${formula}/bin/node`
    if (await sameFile(link, execPath, resolve)) chosen = link
    else {
      for (const dir of (pathVariable ?? '').split(delimiter)) {
        if (dir === '') continue
        const candidate = join(dir, 'node')
        if (!CELLAR.test(candidate) && (await sameFile(candidate, execPath, resolve))) {
          chosen = candidate
          break
        }
      }
    }
  }
  return { path: chosen, versionManaged: isVersionManaged(chosen) }
}
