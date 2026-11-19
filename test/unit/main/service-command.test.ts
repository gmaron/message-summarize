import { afterEach, describe, expect, it } from 'vitest'
import type {
  ServiceDefinition,
  ServiceFailure,
  ServiceInstaller,
} from '../../../src/application/ports/service-installer.js'
import { err, ok } from '../../../src/domain/result.js'
import { runMain } from '../../../src/main/app.js'
import { acquireDaemonLock } from '../../../src/main/daemon-lock.js'
import { disposeHarnesses, type Harness, makeHarness } from '../../support/cli-harness.js'

afterEach(disposeHarnesses)

class FakeInstaller implements ServiceInstaller {
  readonly installed: ServiceDefinition[] = []
  uninstalls = 0
  changed = true
  removed = true
  failure: ServiceFailure | null = null
  running: boolean | null = true
  isInstalled = true
  hints: ('enableLinger' | 'startAtNextLogin' | 'stopRunningDaemon')[] = ['enableLinger']

  async install(definition: ServiceDefinition) {
    this.installed.push(definition)
    return this.failure === null
      ? ok({ location: '/fake/location', changed: this.changed, hints: this.hints })
      : err(this.failure)
  }
  async uninstall() {
    this.uninstalls++
    return this.failure === null
      ? ok({ removed: this.removed, location: '/fake/location', hints: this.hints })
      : err(this.failure)
  }
  async status() {
    return { installed: this.isInstalled, location: '/fake/location', running: this.running }
  }
}

const entry = ['/fake/node', '/fake/dist/main/cli.js']
const run = (h: Harness, installer: ServiceInstaller | undefined, ...argv: string[]) =>
  runMain(argv, { ...h.ctx, service: { ...(installer ? { installer } : {}), entry } })

describe('msum service', () => {
  it('install registers node + the CLI entry + daemon, with an allowlisted environment', async () => {
    const h = await makeHarness({
      env: { MSUM_DATA_DIR: '/x/data', PATH: '/bin:/usr/bin', ANTHROPIC_API_KEY: 'sk-made-up' },
    })
    const installer = new FakeInstaller()
    expect(await run(h, installer, 'service', 'install')).toBe(0)
    expect(installer.installed).toEqual([
      {
        command: ['/fake/node', '/fake/dist/main/cli.js', 'daemon'],
        env: { MSUM_DATA_DIR: h.layout.dataDir, PATH: '/bin:/usr/bin' },
        dataDir: h.layout.dataDir,
        logsDir: `${h.layout.dataDir}/logs`,
        startNow: true,
      },
    ])
    expect(JSON.stringify(installer.installed)).not.toContain('sk-made-up')
    expect(h.out.join('\n')).toContain('Service installed (/fake/location)')
    expect(h.out.join('\n')).toContain('loginctl enable-linger')
  })

  it('always bakes in the data directory (the service manager has no XDG_DATA_HOME), but not an empty PATH', async () => {
    const h = await makeHarness({ env: { PATH: '' } })
    const installer = new FakeInstaller()
    await run(h, installer, 'service', 'install')
    expect(installer.installed[0]?.env).toEqual({ MSUM_DATA_DIR: h.layout.dataDir })
  })

  it('says so when nothing changed, and when it did not apply', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    installer.changed = false
    installer.hints = []
    expect(await run(h, installer, 'service', 'install')).toBe(0)
    expect(h.out).toEqual(['The service is already installed and up to date (/fake/location). Nothing was changed.'])
  })

  it('a refusal of the system is reported with exit 1', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    installer.failure = { step: 'launchctl bootstrap', detail: 'Input/output error' }
    expect(await run(h, installer, 'service', 'install')).toBe(1)
    expect(h.err).toEqual(['The service was not changed: "launchctl bootstrap" failed (Input/output error).'])
    expect(await run(h, installer, 'service', 'uninstall')).toBe(1)
  })

  it('uninstall removes, and says so when there was nothing to remove', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    const installer = new FakeInstaller()
    installer.hints = ['stopRunningDaemon']
    expect(await run(h, installer, 'service', 'uninstall')).toBe(0)
    expect(h.out[0]).toBe('Servicio quitado (/fake/location). El daemon ya no arranca con tu sesión.')
    expect(h.out[1]).toContain('Un daemon que esté corriendo ahora no se detiene')
    installer.removed = false
    installer.hints = []
    h.out.length = 0
    expect(await run(h, installer, 'service', 'uninstall')).toBe(0)
    expect(h.out).toEqual(['El servicio no está instalado. No se cambió nada.'])
    expect(installer.uninstalls).toBe(2)
  })

  it('status shows the registration and the daemon of the lock file, and changes nothing', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    expect(await run(h, installer, 'service', 'status')).toBe(0)
    expect(h.out).toEqual(['Service installed (/fake/location), running now.', 'No daemon is running now.'])
    h.out.length = 0
    installer.running = null
    const lock = await acquireDaemonLock(h.layout.lockFile)
    expect(await run(h, installer, 'service')).toBe(0)
    expect(h.out[0]).toBe('Service installed (/fake/location).')
    expect(h.out[1]).toContain(`A daemon is running now (pid ${process.pid})`)
    if (lock.ok) await lock.release()
    h.out.length = 0
    installer.isInstalled = false
    await run(h, installer, 'service', 'status')
    expect(h.out[0]).toContain('Service not installed')
    expect(installer.installed).toEqual([])
  })

  it('an installed-but-stopped service is reported as not running now', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    installer.running = false
    await run(h, installer, 'service', 'status')
    expect(h.out[0]).toBe('Service installed (/fake/location), not running now.')
  })

  it('the real entry must exist: from the sources there is nothing to register', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    // No `entry` override: the compiled CLI is looked up next to this module (src/main/cli.js does not exist).
    expect(await runMain(['service', 'install'], { ...h.ctx, service: { installer } })).toBe(1)
    expect(h.err[0]).toMatch(/is not built \(.*cli\.js does not exist\)/)
    expect(installer.installed).toEqual([])
  })

  it('without an installer for this platform it is an error, not a guess', async () => {
    const h = await makeHarness()
    // The real installer of this machine is never reached: the unsupported case is covered through the platform guard.
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'freebsd' })
    try {
      expect(await run(h, undefined, 'service', 'status')).toBe(1)
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
    expect(h.err).toEqual([
      'Installing the service is not supported on "freebsd". Run "msum daemon" yourself, or use Docker.',
    ])
  })

  it('does not start the service now next to a daemon started by hand, and says what to do', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    installer.running = false
    const lock = await acquireDaemonLock(h.layout.lockFile)
    expect(await run(h, installer, 'service', 'install')).toBe(0)
    expect(installer.installed[0]?.startNow).toBe(false)
    expect(h.out.join('\n')).toContain(`A daemon you started yourself is running (pid ${process.pid})`)
    if (lock.ok) await lock.release()
  })

  it('a daemon that the service itself runs is not "by hand": the service is updated normally', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    installer.running = true
    const lock = await acquireDaemonLock(h.layout.lockFile)
    await run(h, installer, 'service', 'install')
    expect(installer.installed[0]?.startNow).toBe(true)
    expect(h.out.join('\n')).not.toContain('started yourself')
    if (lock.ok) await lock.release()
  })

  it('warns when node comes from a version manager', async () => {
    const h = await makeHarness({ config: { language: 'es' } })
    const installer = new FakeInstaller()
    const nvmNode = '/Users/ana/.nvm/versions/node/v22.16.0/bin/node'
    await runMain(['service', 'install'], { ...h.ctx, service: { installer, entry: [nvmNode, '/x/cli.js'] } })
    expect(h.out.join('\n')).toContain('administrador de versiones')
  })

  it('rejects an unknown action and extra arguments before touching anything', async () => {
    const h = await makeHarness()
    const installer = new FakeInstaller()
    expect(await run(h, installer, 'service', 'restart')).toBe(2)
    expect(await run(h, installer, 'service', 'install', 'now')).toBe(2)
    expect(await run(h, installer, 'service', 'install', '--yes')).toBe(2)
    expect(installer.installed).toEqual([])
  })
})
