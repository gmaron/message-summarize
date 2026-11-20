import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')
const read = (name: string): string => readFileSync(join(root, name), 'utf8')

/** The lines of a file without comments and blanks. */
const code = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))

const dockerfile = read('docker/Dockerfile')
const compose = read('docker/compose.yaml')
const dockerignore = code(read('.dockerignore'))
const [baseStage = '', afterBase = ''] = dockerfile.split('FROM base AS cli')
const [cliStage = ''] = afterBase.split('FROM base AS runtime')

/** The entries of every `ports:` list of a compose file, each as its own text (short or long syntax). */
function portEntries(text: string): string[] {
  const lines = text.split('\n')
  const entries: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)ports:\s*$/.exec(lines[i] ?? '')
    if (head === null) continue
    const indent = (head[1] ?? '').length
    let current: string[] | null = null
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      if (line.length - line.trimStart().length <= indent) break
      if (line.trim().startsWith('- ')) {
        if (current !== null) entries.push(current.join(' '))
        current = [line.trim()]
      } else current?.push(line.trim())
    }
    if (current !== null) entries.push(current.join(' '))
  }
  return entries
}

/** Entries that publish a port anywhere but the loopback of the host (RNF-03). */
function exposedPorts(text: string): string[] {
  return portEntries(text).filter((entry) =>
    /target:/.test(entry)
      ? !/host_ip:\s*["']?127\.0\.0\.1["']?(\s|$)/.test(entry)
      : !/^-\s*["']127\.0\.0\.1:\d+:\d+(\/\w+)?["']$/.test(entry),
  )
}

describe('Dockerfile vendored sharp stub', () => {
  it('copies the stub before npm ci and into the runtime image, so node_modules/sharp does not dangle', () => {
    const buildStage = dockerfile.split('AS whisper')[0] ?? ''
    expect(buildStage.indexOf('COPY vendor/sharp-stub ./vendor/sharp-stub')).toBeGreaterThan(-1)
    expect(buildStage.indexOf('COPY vendor/sharp-stub')).toBeLessThan(buildStage.indexOf('RUN npm ci'))
    expect(baseStage).toContain('COPY --from=build --chown=root:root /app/vendor ./vendor')
  })
})

describe('docker/compose.yaml', () => {
  it('publishes ports on 127.0.0.1 only (RNF-03)', () => {
    expect(portEntries(compose).length).toBeGreaterThan(0)
    expect(exposedPorts(compose)).toEqual([])
  })

  it('the port check catches what it must', () => {
    const bad = (entry: string): string[] => exposedPorts(`services:\n  a:\n    ports:\n      ${entry}\n`)
    expect(bad('- "8787:8787"')).toHaveLength(1)
    expect(bad('- "0.0.0.0:8787:8787"')).toHaveLength(1)
    expect(bad('- 8787')).toHaveLength(1)
    expect(bad('- target: 8787\n        published: 8787')).toHaveLength(1)
    expect(bad('- target: 8787\n        published: 8787\n        host_ip: 0.0.0.0')).toHaveLength(1)
    expect(bad('- "127.0.0.1:8787:8787"')).toHaveLength(0)
    expect(bad('- target: 8787\n        published: 8787\n        host_ip: 127.0.0.1')).toHaveLength(0)
  })

  it('never binds a wildcard address or the host network', () => {
    expect(code(compose).join('\n')).not.toMatch(/0\.0\.0\.0|\[::\]|network_mode:\s*host/)
  })

  it('keeps the data in a named volume and restarts unless stopped', () => {
    expect(compose).toContain('msum-data:/data')
    expect(compose).toMatch(/restart:\s*unless-stopped/)
  })

  it('does not run privileged or as root, and carries no secrets', () => {
    const lines = code(compose).join('\n')
    expect(lines).not.toMatch(/privileged:\s*true|user:\s*["']?(0|root)/)
    expect(lines).not.toMatch(/API_KEY|TOKEN=|SECRET|PASSWORD/i)
  })

  it('has an opt-in cli variant', () => {
    expect(compose).toMatch(/profiles:\s*\["cli"\]/)
    expect(compose).toMatch(/target:\s*cli/)
  })
})

describe('docker/Dockerfile', () => {
  const lines = code(dockerfile)

  it('ends with the runtime stage, so `docker build` without a target does not install the CLIs', () => {
    expect(lines.at(-1)).toBe('FROM base AS runtime')
  })

  it('has no EXPOSE (it only invites -P) and sets the web host through the environment', () => {
    expect(lines.some((line) => line.startsWith('EXPOSE'))).toBe(false)
    expect(dockerfile).toMatch(/MSUM_WEB_HOST=0\.0\.0\.0/)
  })

  it('verifies the whisper.cpp commit and installs the OpenMP runtime', () => {
    expect(dockerfile).toMatch(/ARG WHISPER_CPP_COMMIT=[0-9a-f]{40}/)
    expect(dockerfile).toMatch(/rev-parse HEAD\)" = "\$\{WHISPER_CPP_COMMIT\}"/)
    expect(dockerfile).toContain('libgomp1')
  })

  it('turns off the Claude Code self-update in the cli target', () => {
    expect(cliStage).toMatch(/DISABLE_AUTOUPDATER=1/)
    expect(cliStage).toMatch(/CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1/)
  })

  it('has the build, base and cli targets', () => {
    expect(lines.filter((line) => /^FROM \S+ AS (build|base)$/.test(line))).toHaveLength(2)
    expect(lines).toContain('FROM base AS cli')
  })

  it('runs as the non-root msum user in the base and the cli targets', () => {
    expect(baseStage).toMatch(/^USER msum$/m)
    expect(baseStage).toMatch(/usermod -l msum/)
    expect(baseStage).not.toMatch(/^USER\s+(root|0)\s*$/m)
    // The cli target needs root only to install, and goes back to msum.
    expect(code(cliStage).at(-1)).toBe('USER msum')
  })

  it('keeps the data directory on a volume and starts the daemon under tini', () => {
    expect(dockerfile).toContain('MSUM_DATA_DIR=/data')
    expect(lines).toContain('VOLUME /data')
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/bin\/tini"/)
    expect(lines).toContain('CMD ["msum", "daemon"]')
  })

  it('has a healthcheck that needs no curl', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*healthcheck\.mjs/)
    expect(dockerfile).not.toMatch(/curl|wget/)
  })

  it('sets no secret or credential in ENV or ARG', () => {
    const declared = lines.filter((line) => /^(ENV|ARG)\s/.test(line) || /^[A-Z_]+=\S*\s*\\?$/.test(line))
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.join('\n')).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i)
  })

  it('copies nothing personal into the image', () => {
    const copies = lines.filter((line) => line.startsWith('COPY'))
    expect(copies.length).toBeGreaterThan(0)
    for (const line of copies) {
      expect(line).not.toMatch(/\.sandbox|\bauth\b|secrets|web-token|(?<![\w.])config\.json|\.env|\bdata\b/)
      expect(line).not.toMatch(/^COPY\s+(--\S+\s+)*\.\s/)
    }
  })

  it('pins what the cli target installs', () => {
    expect(cliStage).toMatch(/ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+/)
    expect(cliStage).toMatch(/ARG GEMINI_CLI_VERSION=\d+\.\d+\.\d+/)
    expect(cliStage).toMatch(/ARG CODEX_VERSION=\d+\.\d+\.\d+/)
    expect(cliStage).not.toMatch(/@latest/)
  })

  it('builds whisper.cpp at a pinned tag', () => {
    expect(dockerfile).toMatch(/ARG WHISPER_CPP_VERSION=v\d+\.\d+\.\d+/)
  })
})

describe('.dockerignore', () => {
  it.each(['.git', 'node_modules', '.sandbox', 'auth', 'data', 'dist', '.env', '**/secrets.json'])(
    'excludes %s',
    (entry) => {
      expect(dockerignore).toContain(entry)
    },
  )
})
