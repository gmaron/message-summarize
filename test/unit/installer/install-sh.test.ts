import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { allowSubprocess } from '../../support/network-guard.js'
import { isWindows } from '../../support/platform.js'

// install.sh runs under the real /bin/sh with a hermetic PATH: symlinks to the few system tools it needs, plus fakes
// of uname, curl, node, npm and ldd. Nothing reaches the network (the fake curl serves local files), and everything
// is installed under a temporary HOME. The real end-to-end install (npm registry) is done by hand, not here.
const root = join(import.meta.dirname, '..', '..', '..')
const script = join(root, 'install.sh')
const NODE_VERSION = /^NODE_VERSION="([^"]+)"/m.exec(readFileSync(script, 'utf8'))?.[1] ?? ''

const SYSTEM_TOOLS = [
  'awk',
  'basename',
  'cat',
  'chmod',
  'cp',
  'cut',
  'date',
  'dirname',
  'grep',
  'head',
  'ln',
  'ls',
  'mkdir',
  'mktemp',
  'mv',
  'rm',
  'sed',
  'sha256sum',
  'shasum',
  'sleep',
  'tar',
  'touch',
  'tr',
  'wc',
]

const FAKE_UNAME = `#!/bin/sh
case "$1" in -m) echo "$FAKE_ARCH" ;; *) echo "$FAKE_OS" ;; esac
`
const FAKE_LDD = `#!/bin/sh
echo "musl libc (x86_64)" >&2
`
const FAKE_CURL = `#!/bin/sh
echo "$*" >> "$FAKE_LOG/curl.log"
url=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --proto | --proto-redir | --connect-timeout | --retry) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
src="$FAKE_DIST/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
`
const FAKE_NODE = `#!/bin/sh
if [ "\${1:-}" = "-v" ]; then echo "\${FAKE_NODE_VERSION:-v22.20.0}"; exit 0; fi
exec /bin/sh "$@"
`
const FAKE_NPM = `#!/bin/sh
echo "$*" >> "$FAKE_LOG/npm.log"
[ -z "\${FAKE_NPM_FAIL:-}" ] || exit 1
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix=$2; fi
  shift
done
pkg="$prefix/node_modules/message-summarize/dist/main"
mkdir -p "$pkg"
cat > "$pkg/cli.js" <<'CLI'
printf '%s\\n' "$*" >> "$FAKE_LOG/msum.log"
case "$*" in
  "init") [ -z "\${FAKE_INIT_FAIL:-}" ] || exit 1 ;;
  "service install") [ -z "\${FAKE_SERVICE_FAIL:-}" ] || exit 1 ;;
  "service uninstall") [ -z "\${FAKE_UNINSTALL_FAIL:-}" ] || exit 1 ;;
  "open --print") echo "http://127.0.0.1:8787/#token=SECRET-TOKEN" ;;
  "open") echo "http://127.0.0.1:8787/#token=SECRET-TOKEN" ;;
esac
CLI
`

let dir: string
let home: string
let tools: string
let fakes: string
let dist: string
let log: string
let revoke: () => void = () => undefined

beforeAll(() => {
  if (isWindows) return
  revoke = allowSubprocess('/bin/sh')
})
afterAll(() => revoke())

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

beforeEach(() => {
  if (isWindows) return
  dir = mkdtempSync(join(tmpdir(), 'msum-install-'))
  home = join(dir, 'home')
  tools = join(dir, 'tools')
  fakes = join(dir, 'fakes')
  dist = join(dir, 'dist')
  log = join(dir, 'log')
  for (const path of [home, tools, fakes, dist, log]) mkdirSync(path)
  for (const name of SYSTEM_TOOLS) {
    for (const folder of ['/usr/bin', '/bin']) {
      if (existsSync(join(folder, name))) {
        symlinkSync(join(folder, name), join(tools, name))
        break
      }
    }
  }
  writeExecutable(join(fakes, 'uname'), FAKE_UNAME)
})
afterEach(() => {
  if (!isWindows) rmSync(dir, { recursive: true, force: true })
})

interface Options {
  readonly node?: boolean
  readonly curl?: boolean
  readonly env?: Record<string, string>
}

function run(args: string[], options: Options = {}) {
  if (options.node === true) {
    writeExecutable(join(fakes, 'node'), FAKE_NODE)
    writeExecutable(join(fakes, 'npm'), FAKE_NPM)
  }
  if (options.curl !== false) writeExecutable(join(fakes, 'curl'), FAKE_CURL)
  return spawnSync('/bin/sh', [script, ...args], {
    encoding: 'utf8',
    cwd: dir,
    env: {
      PATH: `${fakes}:${tools}`,
      HOME: home,
      TMPDIR: dir,
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/zsh',
      MSUM_DATA_DIR: join(home, 'data'),
      FAKE_OS: 'Darwin',
      FAKE_ARCH: 'arm64',
      FAKE_LOG: log,
      FAKE_DIST: dist,
      ...options.env,
    },
  })
}

const logOf = (name: string): string => (existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : '')
const msumCalls = (): string[] => logOf('msum.log').split('\n').filter(Boolean)
const out = (result: { stdout: string; stderr: string }): string => `${result.stdout}${result.stderr}`
const tree = (path: string): string[] => readdirSync(path, { recursive: true }).map(String).sort()
const bin = (name: string): string => join(home, '.local', 'bin', name)
const prefix = (): string => join(home, '.local', 'share', 'message-summarize-app')

/** Puts a fake Node.js release (a tarball with `bin/node` and `bin/npm`) and its SHASUMS256.txt where curl finds them. */
function serveNode(os: string, arch: string, sumOverride?: string): void {
  const name = `node-v${NODE_VERSION}-${os}-${arch}`
  const build = join(dir, 'build')
  mkdirSync(join(build, name, 'bin'), { recursive: true })
  writeExecutable(join(build, name, 'bin', 'node'), FAKE_NODE)
  writeExecutable(join(build, name, 'bin', 'npm'), FAKE_NPM)
  const created = spawnSync('/bin/sh', ['-c', `tar -czf '${join(dist, `${name}.tar.gz`)}' -C '${build}' '${name}'`])
  expect(created.status).toBe(0)
  const sum = createHash('sha256')
    .update(readFileSync(join(dist, `${name}.tar.gz`)))
    .digest('hex')
  writeFileSync(
    join(dist, 'SHASUMS256.txt'),
    `${'0'.repeat(64)}  node-v${NODE_VERSION}-other.tar.gz\n${sumOverride ?? sum}  ${name}.tar.gz\n`,
  )
}

// install.sh is only for macOS and Linux: its tests run it under /bin/sh with symlinks to /usr/bin tools and chmod, none
// of which exists on Windows, so the describes that execute it are skipped there. The static reads of the script
// (the pinned Node.js, the last line, the safety basics) run everywhere.
describe('install.sh', () => {
  it('pins a Node.js that satisfies the engines of the package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines: { node: string } }
    expect(pkg.engines.node).toBe('>=22.16')
    const [major, minor] = NODE_VERSION.split('.').map(Number)
    expect(major === 22 && (minor ?? 0) >= 16).toBe(true)
  })

  describe.skipIf(isWindows)('--dry-run', () => {
    it('changes nothing, with a system node', () => {
      const result = run(['--dry-run'], { node: true })
      expect(result.status).toBe(0)
      expect(out(result)).toContain('Dry run')
      expect(out(result)).toContain('msum service install')
      expect(tree(home)).toEqual([])
      expect(msumCalls()).toEqual([])
      expect(logOf('npm.log')).toBe('')
    })

    it('says it would download Node.js from nodejs.org, and downloads nothing', () => {
      const result = run(['--dry-run'])
      expect(result.status).toBe(0)
      expect(out(result)).toContain(`Node.js ${NODE_VERSION} from nodejs.org`)
      expect(tree(home)).toEqual([])
      expect(logOf('curl.log')).toBe('')
    })

    it('prints in Spanish when the language is Spanish', () => {
      const result = run(['--dry-run'], { node: true, env: { LANG: 'es_AR.UTF-8' } })
      expect(out(result)).toContain('Simulacro')
    })
  })

  describe.skipIf(isWindows)('platform', () => {
    it('rejects an unsupported system and points at Docker', () => {
      const result = run(['--yes'], { env: { FAKE_OS: 'FreeBSD' } })
      expect(result.status).toBe(3)
      expect(out(result)).toContain('Unsupported system: FreeBSD')
      expect(out(result)).toContain('Docker')
      expect(tree(home)).toEqual([])
    })

    it('rejects an unsupported architecture', () => {
      const result = run(['--dry-run'], { env: { FAKE_OS: 'Linux', FAKE_ARCH: 'armv7l' } })
      expect(result.status).toBe(3)
      expect(out(result)).toContain('armv7l')
    })

    it('stops on musl instead of installing a glibc node', () => {
      writeExecutable(join(fakes, 'ldd'), FAKE_LDD)
      const result = run(['--yes'], { env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64' } })
      expect(result.status).toBe(3)
      expect(out(result)).toContain('musl')
      expect(out(result)).toContain('Docker')
      expect(logOf('curl.log')).toBe('')
    })

    it('does not mind musl when a recent node is already there', () => {
      writeExecutable(join(fakes, 'ldd'), FAKE_LDD)
      const result = run(['--yes', '--no-service', '--no-open'], {
        node: true,
        env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64' },
      })
      expect(result.status, out(result)).toBe(0)
      expect(out(result)).not.toContain('musl')
    })

    it('fails with a clear message when neither curl nor wget exists', () => {
      const result = run(['--yes'], { curl: false })
      expect(result.status).toBe(4)
      expect(out(result)).toContain('curl nor wget')
    })
  })

  describe.skipIf(isWindows)('private Node.js', () => {
    it('downloads from nodejs.org, verifies the checksum and uses it in the shims', () => {
      serveNode('darwin', 'arm64')
      const result = run(['--yes', '--no-service', '--no-open'])
      expect(result.status, out(result)).toBe(0)
      const urls = logOf('curl.log').split('\n').filter(Boolean)
      expect(urls.length).toBe(2)
      for (const line of urls) expect(line).toContain(`https://nodejs.org/dist/v${NODE_VERSION}/`)
      expect(urls.join('\n')).toContain(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`)
      expect(readFileSync(bin('msum'), 'utf8')).toContain(join(prefix(), 'node', 'bin', 'node'))
      expect(msumCalls()).toContain('init')
    })

    it('picks the linux x64 build on Linux x86_64', () => {
      serveNode('linux', 'x64')
      const result = run(['--yes', '--no-service', '--no-open'], { env: { FAKE_OS: 'Linux', FAKE_ARCH: 'x86_64' } })
      expect(result.status, out(result)).toBe(0)
      expect(logOf('curl.log')).toContain(`node-v${NODE_VERSION}-linux-x64.tar.gz`)
    })

    it('prefers the arm64 build under Rosetta', () => {
      writeExecutable(join(fakes, 'sysctl'), '#!/bin/sh\necho 1\n')
      serveNode('darwin', 'arm64')
      const result = run(['--yes', '--no-service', '--no-open'], { env: { FAKE_ARCH: 'x86_64' } })
      expect(result.status, out(result)).toBe(0)
      expect(logOf('curl.log')).toContain('darwin-arm64')
    })

    it('says a failed download is a download problem, not a checksum one', () => {
      const result = run(['--yes', '--no-service', '--no-open'])
      expect(result.status).toBe(1)
      expect(out(result)).toContain('Could not download')
      expect(out(result)).not.toContain('checksum')
    })

    it('fails hard on a checksum mismatch and installs nothing', () => {
      serveNode('darwin', 'arm64', 'f'.repeat(64))
      const result = run(['--yes', '--no-service', '--no-open'])
      expect(result.status).toBe(5)
      expect(out(result)).toContain('does not match the official checksum')
      expect(existsSync(join(prefix(), 'node'))).toBe(false)
      expect(existsSync(bin('msum'))).toBe(false)
      expect(logOf('npm.log')).toBe('')
    })

    it('fails when the official checksum list has no line for the file', () => {
      serveNode('darwin', 'arm64')
      writeFileSync(join(dist, 'SHASUMS256.txt'), `${'0'.repeat(64)}  something-else.tar.gz\n`)
      const result = run(['--yes', '--no-service', '--no-open'])
      expect(result.status).toBe(1)
      expect(existsSync(join(prefix(), 'node'))).toBe(false)
    })
  })

  describe.skipIf(isWindows)('install', () => {
    it('installs the tarball with the safe npm flags and creates both commands', () => {
      const tarball = join(dir, 'message-summarize-0.0.0.tgz')
      writeFileSync(tarball, 'x')
      const result = run(['--yes', '--no-service', '--no-open', '--tarball', tarball], { node: true })
      expect(result.status, out(result)).toBe(0)
      const npm = logOf('npm.log')
      expect(npm).toContain('--ignore-scripts')
      expect(npm).toContain('--no-fund')
      expect(npm).toContain('--no-audit')
      expect(npm).toContain(`--prefix ${prefix()}`)
      expect(npm.trim().endsWith(tarball)).toBe(true)
      for (const name of ['msum', 'message-summarize']) {
        const check = spawnSync('/bin/sh', [bin(name), 'ping'], { encoding: 'utf8', env: { FAKE_LOG: log } })
        expect(check.status).toBe(0)
      }
      expect(msumCalls()).toEqual(['init', 'ping', 'ping'])
      expect(existsSync(join(prefix(), '.message-summarize-prefix'))).toBe(true)
    })

    it('installs the requested version from npm', () => {
      const result = run(['--yes', '--no-service', '--no-open', '--version', 'next'], { node: true })
      expect(result.status, out(result)).toBe(0)
      expect(logOf('npm.log').trim().endsWith('message-summarize@next')).toBe(true)
    })

    it('reports an npm failure with exit code 1 and creates no commands', () => {
      const result = run(['--yes', '--no-service', '--no-open'], { node: true, env: { FAKE_NPM_FAIL: '1' } })
      expect(result.status).toBe(1)
      expect(existsSync(bin('msum'))).toBe(false)
    })

    it('can be run again to upgrade: same result, no second download', () => {
      serveNode('darwin', 'arm64')
      const first = run(['--yes', '--no-service', '--no-open'])
      expect(first.status, out(first)).toBe(0)
      const shim = readFileSync(bin('msum'), 'utf8')
      const second = run(['--yes', '--no-service', '--no-open'])
      expect(second.status, out(second)).toBe(0)
      expect(readFileSync(bin('msum'), 'utf8')).toBe(shim)
      expect(logOf('curl.log').split('\n').filter(Boolean).length).toBe(2)
      expect(logOf('npm.log').split('\n').filter(Boolean).length).toBe(2)
      expect(msumCalls()).toEqual(['init', 'init'])
    })

    it('does not overwrite a command it did not create', () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(bin('msum'), '#!/bin/sh\necho mine\n')
      const result = run(['--yes', '--no-service', '--no-open'], { node: true })
      expect(result.status).toBe(1)
      expect(readFileSync(bin('msum'), 'utf8')).toContain('echo mine')
    })

    it('refuses an install folder that holds the data folder, is inside it, or is somebody else’s', () => {
      const holdsData = run(['--yes', '--prefix', join(home, 'x')], {
        node: true,
        env: { MSUM_DATA_DIR: join(home, 'x', 'data') },
      })
      expect(holdsData.status).toBe(1)
      expect(out(holdsData)).toContain('contains your data folder')
      const inside = run(['--yes', '--prefix', join(home, 'data', 'app')], { node: true })
      expect(inside.status).toBe(1)
      expect(out(inside)).toContain('inside your data folder')
      expect(existsSync(join(home, 'data'))).toBe(false)
      expect(run(['--yes', '--prefix', home], { node: true }).status).toBe(1)
      const other = join(dir, 'other')
      mkdirSync(other)
      writeFileSync(join(other, 'precious.txt'), 'x')
      const foreign = run(['--yes', '--prefix', other], { node: true })
      expect(foreign.status).toBe(1)
      expect(readFileSync(join(other, 'precious.txt'), 'utf8')).toBe('x')
    })

    it('compares physical paths: a link to the data folder, a relative data folder', () => {
      mkdirSync(join(home, 'real'))
      symlinkSync(join(home, 'real'), join(home, 'link'))
      const viaLink = run(['--yes', '--prefix', join(home, 'real', 'app')], {
        node: true,
        env: { MSUM_DATA_DIR: join(home, 'link') },
      })
      expect(viaLink.status).toBe(1)
      expect(out(viaLink)).toContain('inside your data folder')
      const prefixLink = run(['--yes', '--prefix', join(home, 'link', 'app')], {
        node: true,
        env: { MSUM_DATA_DIR: join(home, 'real') },
      })
      expect(prefixLink.status).toBe(1)
      // the run starts in `dir`: `home/rel` is the data folder, written relative
      const relative = run(['--yes', '--prefix', join(home, 'rel', 'app')], {
        node: true,
        env: { MSUM_DATA_DIR: 'home/rel' },
      })
      expect(relative.status).toBe(1)
      expect(out(relative)).toContain('inside your data folder')
    })

    it('ignores a blank MSUM_DATA_DIR and uses the default of the system', () => {
      const inDefault = join(home, 'Library', 'Application Support', 'message-summarize', 'a')
      const result = run(['--yes', '--prefix', inDefault], { node: true, env: { MSUM_DATA_DIR: '   ' } })
      expect(result.status).toBe(1)
      expect(out(result)).toContain('inside your data folder')
    })

    it('keeps the previous install when an upgrade fails, and the only copy a stopped run left', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      const keep = join(prefix(), 'node_modules', 'keep.txt')
      writeFileSync(keep, 'old')
      const failed = run(['--yes', '--no-service', '--no-open'], { node: true, env: { FAKE_NPM_FAIL: '1' } })
      expect(failed.status).toBe(1)
      expect(readFileSync(keep, 'utf8')).toBe('old')
      expect(existsSync(join(prefix(), 'node_modules.old'))).toBe(false)
      // a run killed after moving the tree aside: node_modules is missing and node_modules.old is the only good copy
      renameSync(join(prefix(), 'node_modules'), join(prefix(), 'node_modules.old'))
      const failedAgain = run(['--yes', '--no-service', '--no-open'], { node: true, env: { FAKE_NPM_FAIL: '1' } })
      expect(failedAgain.status).toBe(1)
      expect(readFileSync(keep, 'utf8')).toBe('old')
    })

    it('rejects unknown options and invalid versions', () => {
      expect(run(['--nope'], { node: true }).status).toBe(2)
      expect(run(['--version'], { node: true }).status).toBe(2)
      expect(run(['--version', '--evil'], { node: true }).status).toBe(2)
    })
  })

  describe.skipIf(isWindows)('service and web', () => {
    const fullRun = (extra: string[] = [], env: Record<string, string> = {}) =>
      run(['--yes', ...extra], { node: true, env })

    it('runs init, service install and open by default, and prints the token only once', () => {
      const result = fullRun()
      expect(result.status, out(result)).toBe(0)
      expect(msumCalls()).toEqual(['init', 'service install', 'open --print', 'open'])
      expect(out(result).split('SECRET-TOKEN').length - 1).toBe(1)
    })

    it('--no-service skips the service and only tries the web once', () => {
      const result = fullRun(['--no-service'])
      expect(result.status, out(result)).toBe(0)
      expect(msumCalls()).not.toContain('service install')
      expect(out(result)).toContain('msum daemon')
    })

    it('--no-open skips the web', () => {
      const result = fullRun(['--no-open'])
      expect(result.status, out(result)).toBe(0)
      expect(msumCalls()).toEqual(['init', 'service install'])
    })

    it('--no-service --no-open only initializes', () => {
      expect(fullRun(['--no-service', '--no-open']).status).toBe(0)
      expect(msumCalls()).toEqual(['init'])
    })

    it('reports a failing msum init with its own message', () => {
      const result = fullRun(['--no-service', '--no-open'], { FAKE_INIT_FAIL: '1' })
      expect(result.status).toBe(1)
      expect(out(result)).toContain('msum init failed')
    })

    it('exits 6 when the service cannot be registered, but still finishes the install', () => {
      const result = fullRun(['--no-open'], { FAKE_SERVICE_FAIL: '1' })
      expect(result.status).toBe(6)
      expect(out(result)).toContain('msum daemon')
      expect(existsSync(bin('msum'))).toBe(true)
    })
  })

  describe.skipIf(isWindows)('PATH', () => {
    it('prints the exact line to add when ~/.local/bin is not on the PATH, and edits nothing', () => {
      const result = run(['--yes', '--no-service', '--no-open'], { node: true })
      expect(out(result)).toContain('export PATH="$HOME/.local/bin:$PATH"')
      expect(existsSync(join(home, '.zshenv'))).toBe(false)
      expect(existsSync(join(home, '.profile'))).toBe(false)
    })

    it('says nothing when it is already on the PATH', () => {
      const result = run(['--yes', '--no-service', '--no-open'], {
        node: true,
        env: { PATH: `${join(home, '.local', 'bin')}:${fakes}:${tools}` },
      })
      expect(out(result)).not.toContain('export PATH')
    })

    const line = 'export PATH="$HOME/.local/bin:$PATH"'
    const modify = (shell: string) =>
      run(['--yes', '--no-service', '--no-open', '--modify-path'], { node: true, env: { SHELL: shell } })

    it('--modify-path appends the line to .zshenv for zsh, once', () => {
      for (let i = 0; i < 2; i++) expect(modify('/bin/zsh').status).toBe(0)
      expect(readFileSync(join(home, '.zshenv'), 'utf8').split(line).length - 1).toBe(1)
      expect(existsSync(join(home, '.zshrc'))).toBe(false)
    })

    it('--modify-path for bash edits the first of .bash_profile, .bash_login, .profile that exists', () => {
      writeFileSync(join(home, '.bash_login'), '# mine\n')
      writeFileSync(join(home, '.profile'), '# other\n')
      expect(modify('/bin/bash').status).toBe(0)
      expect(readFileSync(join(home, '.bash_login'), 'utf8')).toContain(line)
      expect(readFileSync(join(home, '.profile'), 'utf8')).toBe('# other\n')
      expect(existsSync(join(home, '.bash_profile'))).toBe(false)
    })

    it('--modify-path for bash creates .bash_profile only when none exists', () => {
      expect(modify('/bin/bash').status).toBe(0)
      expect(readFileSync(join(home, '.bash_profile'), 'utf8')).toContain(line)
    })

    it('--modify-path does not claim success for fish or an unknown shell, and edits nothing', () => {
      for (const [shell, expected] of [
        ['/usr/bin/fish', 'fish_add_path $HOME/.local/bin'],
        ['/bin/tcsh', line],
      ] as const) {
        const result = modify(shell)
        expect(result.status).toBe(0)
        expect(out(result)).toContain(expected)
        expect(out(result)).toContain('nothing was edited')
        expect(out(result)).not.toContain('Added ')
      }
      expect(readdirSync(home).filter((name) => name.startsWith('.') && name !== '.local')).toEqual([])
    })
  })

  describe.skipIf(isWindows)('--uninstall', () => {
    it('removes the program and the commands, keeps the data and says where it is', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      const data = join(home, 'data')
      mkdirSync(data)
      writeFileSync(join(data, 'app.db'), 'my summaries')
      writeFileSync(join(home, 'unrelated.txt'), 'x')
      const result = run(['--uninstall', '--yes'], { node: true })
      expect(result.status, out(result)).toBe(0)
      expect(existsSync(prefix())).toBe(false)
      expect(existsSync(bin('msum'))).toBe(false)
      expect(existsSync(bin('message-summarize'))).toBe(false)
      expect(readFileSync(join(data, 'app.db'), 'utf8')).toBe('my summaries')
      expect(readFileSync(join(home, 'unrelated.txt'), 'utf8')).toBe('x')
      expect(out(result)).toContain(`NOT deleted: it is in ${data}`)
      expect(msumCalls()).toContain('service uninstall')
    })

    it('uses the prefix the shim belongs to, not the default', () => {
      const custom = join(home, 'custom-app')
      expect(run(['--yes', '--no-service', '--no-open', '--prefix', custom], { node: true }).status).toBe(0)
      const result = run(['--uninstall', '--yes'], { node: true })
      expect(result.status, out(result)).toBe(0)
      expect(existsSync(custom)).toBe(false)
      expect(existsSync(bin('msum'))).toBe(false)
      expect(msumCalls()).toContain('service uninstall')
    })

    it('keeps everything when the service cannot be removed', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      const result = run(['--uninstall', '--yes'], { node: true, env: { FAKE_UNINSTALL_FAIL: '1' } })
      expect(result.status).toBe(1)
      expect(out(result)).toContain('could not be removed')
      expect(existsSync(bin('msum'))).toBe(true)
      expect(existsSync(prefix())).toBe(true)
    })

    it('does not claim success when the program is gone but a service unit is left: prints the manual step', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      rmSync(join(prefix(), 'node_modules'), { recursive: true })
      const unit = join(home, '.config', 'systemd', 'user', 'message-summarize.service')
      mkdirSync(join(unit, '..'), { recursive: true })
      writeFileSync(unit, '[Service]\n')
      const result = run(['--uninstall', '--yes'], { node: true, env: { FAKE_OS: 'Linux' } })
      expect(result.status).toBe(6)
      expect(out(result)).toContain('Remove it by hand')
      expect(out(result)).toContain(`systemctl --user disable --now message-summarize.service; rm "${unit}"`)
      expect(out(result)).not.toContain('Removed the program')
      expect(existsSync(bin('msum'))).toBe(false)
      expect(existsSync(unit)).toBe(true)
    })

    it('names the plist on macOS', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      rmSync(join(prefix(), 'node_modules'), { recursive: true })
      const plist = join(home, 'Library', 'LaunchAgents', 'dev.message-summarize.daemon.plist')
      mkdirSync(join(plist, '..'), { recursive: true })
      writeFileSync(plist, '<plist/>')
      const result = run(['--uninstall', '--yes'], { node: true })
      expect(result.status).toBe(6)
      expect(out(result)).toContain(plist)
    })

    it('leaves a command that is not ours, and does nothing when nothing is installed', () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true })
      writeFileSync(bin('msum'), '#!/bin/sh\necho mine\n')
      const result = run(['--uninstall', '--yes'], { node: true })
      expect(result.status, out(result)).toBe(0)
      expect(readFileSync(bin('msum'), 'utf8')).toContain('echo mine')
      expect(out(result)).toContain('Nothing to remove')
    })

    it('--dry-run removes nothing', () => {
      expect(run(['--yes', '--no-service', '--no-open'], { node: true }).status).toBe(0)
      const before = tree(home)
      const result = run(['--uninstall', '--dry-run'], { node: true })
      expect(result.status).toBe(0)
      expect(tree(home)).toEqual(before)
    })
  })

  it('runs nothing until the whole script has arrived: the last line is main', () => {
    const lines = readFileSync(script, 'utf8').trimEnd().split('\n')
    expect(lines.at(-1)).toBe('main "$@"')
    // a script cut anywhere before that line has no top-level commands that act
    const cut = lines.slice(0, -1).join('\n')
    expect(cut).not.toMatch(/^(rm|mv|mkdir|curl|npm)\b/m)
  })

  it('has the safety basics: set -eu, no eval, no sudo, only nodejs.org', () => {
    const text = readFileSync(script, 'utf8')
    expect(text).toMatch(/^set -eu$/m)
    expect(text).not.toMatch(/\beval\b/)
    expect(text).not.toMatch(/^\s*sudo /m)
    const hosts = [...text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi)].map((match) => match[1])
    expect(new Set(hosts)).toEqual(new Set(['nodejs.org', 'raw.githubusercontent.com', 'github.com']))
  })
})
