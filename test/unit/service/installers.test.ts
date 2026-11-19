import { describe, expect, it } from 'vitest'
import type { ServiceDefinition } from '../../../src/application/ports/service-installer.js'
import {
  type CommandResult,
  type CommandRunner,
  createServiceInstaller,
  LAUNCHD_LABEL,
  LaunchdInstaller,
  launcherScript,
  RUN_KEY,
  runCommandLine,
  type ServiceFiles,
  type ServiceHost,
  SystemdInstaller,
  systemdUnit,
  WindowsRunKeyInstaller,
} from '../../../src/infrastructure/service/index.js'

// Nothing here reaches a real service manager: the runner is a recorder and the files live in a Map.

const done = (code: number | null, stdout = '', stderr = ''): CommandResult => ({ code, stdout, stderr })

class FakeRunner implements CommandRunner {
  readonly calls: string[] = []
  constructor(private readonly answer: (line: string) => CommandResult = () => done(0)) {}
  async run(file: string, args: readonly string[]): Promise<CommandResult> {
    const line = [file, ...args].join(' ')
    this.calls.push(line)
    return this.answer(line)
  }
}

class MemoryFiles implements ServiceFiles {
  readonly map = new Map<string, string>()
  readonly modes = new Map<string, number>()
  async read(path: string): Promise<string | null> {
    return this.map.get(path) ?? null
  }
  async write(path: string, content: string, mode: number): Promise<void> {
    this.map.set(path, content)
    this.modes.set(path, mode)
  }
  readonly dirs: string[] = []
  async ensureDir(path: string): Promise<void> {
    this.dirs.push(path)
  }
  async remove(path: string): Promise<boolean> {
    return this.map.delete(path)
  }
}

const host = (
  platform: NodeJS.Platform,
  runner: CommandRunner,
  files: ServiceFiles,
  extra: Partial<ServiceHost> = {},
): ServiceHost => ({
  platform,
  home: '/Users/ana maria',
  dataDir: '/Users/ana maria/Library/Application Support/message-summarize',
  configHome: '/home/ana maria/.config',
  uid: 501,
  runner,
  files,
  sleep: async () => {},
  ...extra,
})

const definition: ServiceDefinition = {
  command: ['/opt/node 22/bin/node', '/opt/msum/dist/main/cli.js', 'daemon'],
  env: { MSUM_DATA_DIR: '/data/my msum', PATH: '/usr/local/bin:/usr/bin' },
  dataDir: '/data/my msum',
  logsDir: '/data/my msum/logs',
  startNow: true,
}

describe('launchd (macOS)', () => {
  const plistPath = `/Users/ana maria/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
  const target = `gui/501/${LAUNCHD_LABEL}`

  /** `launchctl print` answers 113 until something was bootstrapped, 0 after. */
  const launchctl = (state: { loaded: boolean }, bootstrapCode = 0) =>
    new FakeRunner((line) => {
      if (line.startsWith('launchctl print')) {
        return state.loaded ? done(0, 'state = running\n') : done(113, '', 'Could not find service')
      }
      if (line.startsWith('launchctl bootstrap')) {
        if (bootstrapCode === 0) state.loaded = true
        return done(bootstrapCode, '', bootstrapCode === 0 ? '' : 'Bootstrap failed: 5: Input/output error\nmore')
      }
      if (line.startsWith('launchctl bootout')) {
        state.loaded = false
        return done(0)
      }
      return done(0)
    })

  it('writes the exact plist: KeepAlive, RunAtLoad, one string per argument, escaped values, output to /dev/null', async () => {
    const files = new MemoryFiles()
    const installer = new LaunchdInstaller(host('darwin', launchctl({ loaded: false }), files))
    const result = await installer.install({ ...definition, env: { MSUM_DATA_DIR: '/data/a&b <x>', PATH: '/bin' } })
    expect(result).toEqual({ ok: true, value: { location: plistPath, changed: true, hints: [] } })
    expect(files.map.get(plistPath)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.message-summarize.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node 22/bin/node</string>
    <string>/opt/msum/dist/main/cli.js</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MSUM_DATA_DIR</key>
    <string>/data/a&amp;b &lt;x&gt;</string>
    <key>PATH</key>
    <string>/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`)
  })

  it('omits the environment block when there is nothing to bake in', async () => {
    const files = new MemoryFiles()
    await new LaunchdInstaller(host('darwin', launchctl({ loaded: false }), files)).install({ ...definition, env: {} })
    expect(files.map.get(plistPath)).not.toContain('EnvironmentVariables')
  })

  it('loads the agent into the gui/<uid> domain, and a second install changes nothing', async () => {
    const state = { loaded: false }
    const runner = launchctl(state)
    const files = new MemoryFiles()
    const installer = new LaunchdInstaller(host('darwin', runner, files))
    await installer.install(definition)
    expect(runner.calls).toEqual([`launchctl print ${target}`, `launchctl bootstrap gui/501 ${plistPath}`])
    runner.calls.length = 0
    const again = await installer.install(definition)
    expect(again).toEqual({ ok: true, value: { location: plistPath, changed: false, hints: [] } })
    expect(runner.calls).toEqual([`launchctl print ${target}`])
  })

  it('replaces a loaded agent whose definition changed: bootout, then bootstrap', async () => {
    const state = { loaded: false }
    const runner = launchctl(state)
    const files = new MemoryFiles()
    const installer = new LaunchdInstaller(host('darwin', runner, files))
    await installer.install(definition)
    runner.calls.length = 0
    const result = await installer.install({ ...definition, command: ['/other/node', '/x/cli.js', 'daemon'] })
    expect(result.ok && result.value.changed).toBe(true)
    expect(runner.calls).toEqual([
      `launchctl print ${target}`,
      `launchctl bootout ${target}`,
      `launchctl bootstrap gui/501 ${plistPath}`,
    ])
  })

  it('reports the first line of what launchctl said when it refuses', async () => {
    const installer = new LaunchdInstaller(host('darwin', launchctl({ loaded: false }, 5), new MemoryFiles()))
    expect(await installer.install(definition)).toEqual({
      ok: false,
      error: { step: 'launchctl bootstrap', detail: 'Bootstrap failed: 5: Input/output error' },
    })
  })

  it('uninstalls: bootout and delete; with nothing installed it does nothing', async () => {
    const state = { loaded: false }
    const runner = launchctl(state)
    const files = new MemoryFiles()
    const installer = new LaunchdInstaller(host('darwin', runner, files))
    await installer.install(definition)
    runner.calls.length = 0
    expect(await installer.uninstall()).toEqual({ ok: true, value: { removed: true, location: plistPath, hints: [] } })
    expect(runner.calls).toEqual([`launchctl print ${target}`, `launchctl bootout ${target}`])
    expect(files.map.size).toBe(0)
    runner.calls.length = 0
    expect(await installer.uninstall()).toEqual({ ok: true, value: { removed: false, location: plistPath, hints: [] } })
    expect(runner.calls).toEqual([`launchctl print ${target}`])
  })

  it('removes a plist that is not loaded without calling bootout', async () => {
    const files = new MemoryFiles()
    files.map.set(plistPath, 'x')
    const runner = launchctl({ loaded: false })
    const result = await new LaunchdInstaller(host('darwin', runner, files)).uninstall()
    expect(result.ok && result.value.removed).toBe(true)
    expect(runner.calls).toEqual([`launchctl print ${target}`])
  })

  it('does not delete the plist when bootout fails', async () => {
    const files = new MemoryFiles()
    files.map.set(plistPath, 'x')
    const runner = new FakeRunner((line) =>
      line.startsWith('launchctl print') ? done(0, 'state = running') : done(1, '', 'Operation not permitted'),
    )
    const result = await new LaunchdInstaller(host('darwin', runner, files)).uninstall()
    expect(result).toEqual({ ok: false, error: { step: 'launchctl bootout', detail: 'Operation not permitted' } })
    expect(files.map.has(plistPath)).toBe(true)
  })

  it('status: not installed, installed but stopped, running', async () => {
    const files = new MemoryFiles()
    const state = { loaded: false }
    const installer = new LaunchdInstaller(host('darwin', launchctl(state), files))
    expect(await installer.status()).toEqual({ installed: false, location: plistPath, running: false })
    files.map.set(plistPath, 'x')
    expect(await installer.status()).toEqual({ installed: true, location: plistPath, running: false })
    state.loaded = true
    expect(await installer.status()).toEqual({ installed: true, location: plistPath, running: true })
  })

  it('a loaded agent that is waiting to restart is not running', async () => {
    const files = new MemoryFiles()
    files.map.set(plistPath, 'x')
    const runner = new FakeRunner(() => done(0, '\tstate = waiting\n'))
    expect((await new LaunchdInstaller(host('darwin', runner, files)).status()).running).toBe(false)
  })

  it('creates the logs directory before it loads the agent', async () => {
    const files = new MemoryFiles()
    await new LaunchdInstaller(host('darwin', launchctl({ loaded: false }), files)).install(definition)
    expect(files.dirs).toEqual(['/data/my msum/logs'])
  })

  it('retries bootstrap on an I/O error with a pause, and gives up after three attempts', async () => {
    const sleeps: number[] = []
    let failures = 2
    const flaky = new FakeRunner((line) => {
      if (line.startsWith('launchctl print')) return done(113)
      if (line.startsWith('launchctl bootstrap') && failures-- > 0) {
        return done(5, '', 'Bootstrap failed: 5: Input/output error')
      }
      return done(0)
    })
    const flakyHost = host('darwin', flaky, new MemoryFiles(), { sleep: async (ms) => void sleeps.push(ms) })
    expect((await new LaunchdInstaller(flakyHost).install(definition)).ok).toBe(true)
    expect(flaky.calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(3)
    expect(sleeps).toEqual([500, 500])

    const always = launchctl({ loaded: false }, 5)
    const failed = await new LaunchdInstaller(host('darwin', always, new MemoryFiles())).install(definition)
    expect(failed.ok).toBe(false)
    expect(always.calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(3)
  })

  it('does not retry a failure that is not an I/O error', async () => {
    const runner = new FakeRunner((line) => (line.startsWith('launchctl print') ? done(113) : done(1, '', 'Bad plist')))
    await new LaunchdInstaller(host('darwin', runner, new MemoryFiles())).install(definition)
    expect(runner.calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(1)
  })

  it('removes the plist it wrote when bootstrap fails, so "not changed" is true', async () => {
    const files = new MemoryFiles()
    const result = await new LaunchdInstaller(host('darwin', launchctl({ loaded: false }, 1), files)).install(
      definition,
    )
    expect(result.ok).toBe(false)
    expect(files.map.size).toBe(0)
  })

  it('restores the previous plist and loads it again when a replacement fails', async () => {
    const state = { loaded: true }
    const files = new MemoryFiles()
    files.map.set(plistPath, 'previous plist')
    const runner: FakeRunner = new FakeRunner((line) => {
      if (line.startsWith('launchctl print')) return state.loaded ? done(0) : done(113)
      if (line.startsWith('launchctl bootout')) {
        state.loaded = false
        return done(0)
      }
      const bootstraps = runner.calls.filter((c) => c.startsWith('launchctl bootstrap')).length
      return bootstraps === 1 ? done(1, '', 'Bad plist') : done(0)
    })
    const result = await new LaunchdInstaller(host('darwin', runner, files)).install(definition)
    expect(result.ok).toBe(false)
    expect(files.map.get(plistPath)).toBe('previous plist')
    expect(runner.calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(2)
  })

  it('a bootout that fails (other than "not loaded") stops the replacement and restores the plist', async () => {
    const files = new MemoryFiles()
    files.map.set(plistPath, 'previous plist')
    const runner = new FakeRunner((line) =>
      line.startsWith('launchctl print') ? done(0) : done(1, '', 'Operation not permitted'),
    )
    const result = await new LaunchdInstaller(host('darwin', runner, files)).install(definition)
    expect(result).toEqual({ ok: false, error: { step: 'launchctl bootout', detail: 'Operation not permitted' } })
    expect(files.map.get(plistPath)).toBe('previous plist')
    expect(runner.calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(false)
  })

  it('a bootout that says the job is not loaded is not a failure', async () => {
    const runner = new FakeRunner((line) => {
      if (line.startsWith('launchctl print')) return done(0)
      if (line.startsWith('launchctl bootout')) return done(3, '', 'Boot-out failed: 3: No such process')
      return done(0)
    })
    const result = await new LaunchdInstaller(host('darwin', runner, new MemoryFiles())).install(definition)
    expect(result.ok).toBe(true)
  })

  it('startNow false registers the plist for the next login without loading it', async () => {
    const files = new MemoryFiles()
    const runner = launchctl({ loaded: false })
    const result = await new LaunchdInstaller(host('darwin', runner, files)).install({ ...definition, startNow: false })
    expect(result).toEqual({ ok: true, value: { location: plistPath, changed: true, hints: [] } })
    expect(files.map.has(plistPath)).toBe(true)
    expect(runner.calls).toEqual([`launchctl print ${target}`])
  })

  it('refuses a value with a line break', async () => {
    const installer = new LaunchdInstaller(host('darwin', launchctl({ loaded: false }), new MemoryFiles()))
    await expect(installer.install({ ...definition, command: ['/a\nb', 'daemon'] })).rejects.toThrow('line break')
  })
})

describe('systemd --user (Linux)', () => {
  const unitPath = '/home/ana maria/.config/systemd/user/message-summarize.service'

  it('writes the exact unit: quoted words, Restart=always, SuccessExitStatus, environment, WantedBy=default.target', () => {
    expect(systemdUnit(definition)).toBe(`[Unit]
Description=message-summarize daemon
After=network-online.target

[Service]
Type=simple
ExecStart="/opt/node 22/bin/node" "/opt/msum/dist/main/cli.js" "daemon"
Environment="MSUM_DATA_DIR=/data/my msum"
Environment="PATH=/usr/local/bin:/usr/bin"
Restart=always
RestartSec=5
SuccessExitStatus=130 143

[Install]
WantedBy=default.target
`)
  })

  it('escapes quotes, backslashes, percent and (in ExecStart only) dollar signs', () => {
    const unit = systemdUnit({
      ...definition,
      command: ['/p/a "b" \\c 100% $HOME/node', 'daemon'],
      env: { X: 'v"1" 100% $keep' },
    })
    expect(unit).toContain('ExecStart="/p/a \\"b\\" \\\\c 100%% $$HOME/node" "daemon"')
    expect(unit).toContain('Environment="X=v\\"1\\" 100%% $keep"')
  })

  it('writes the unit, reloads, enables and starts it, and hints at lingering without running it', async () => {
    const runner = new FakeRunner()
    const files = new MemoryFiles()
    const result = await new SystemdInstaller(host('linux', runner, files)).install(definition)
    expect(result).toEqual({ ok: true, value: { location: unitPath, changed: true, hints: ['enableLinger'] } })
    expect(files.map.get(unitPath)).toBe(systemdUnit(definition))
    expect(runner.calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now message-summarize.service',
    ])
    expect(runner.calls.join('\n')).not.toContain('linger')
  })

  it('a second install changes nothing and does not restart; a changed unit restarts a running daemon', async () => {
    const runner = new FakeRunner()
    const installer = new SystemdInstaller(host('linux', runner, new MemoryFiles()))
    await installer.install(definition)
    runner.calls.length = 0
    const again = await installer.install(definition)
    expect(again.ok && again.value.changed).toBe(false)
    expect(runner.calls).not.toContain('systemctl --user restart message-summarize.service')
    runner.calls.length = 0
    const changed = await installer.install({ ...definition, env: {} })
    expect(changed.ok && changed.value.changed).toBe(true)
    expect(runner.calls).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now message-summarize.service',
      'systemctl --user restart message-summarize.service',
    ])
  })

  it.each([
    ['daemon-reload', 'systemctl --user daemon-reload'],
    ['enable --now', 'systemctl --user enable'],
    ['restart', 'systemctl --user restart'],
  ])('reports a failing systemctl %s', async (step, prefix) => {
    const files = new MemoryFiles()
    if (step === 'restart') files.map.set(unitPath, 'old unit')
    const runner = new FakeRunner((line) =>
      line.startsWith(prefix) ? done(1, '', 'Failed to connect to bus\nsecond line') : done(0),
    )
    const result = await new SystemdInstaller(host('linux', runner, files)).install(definition)
    expect(result).toEqual({
      ok: false,
      error: { step: `systemctl ${step}`, detail: 'Failed to connect to bus' },
    })
  })

  it('uninstalls: disable --now, delete, reload; with nothing installed it does nothing', async () => {
    const runner = new FakeRunner()
    const files = new MemoryFiles()
    const installer = new SystemdInstaller(host('linux', runner, files))
    await installer.install(definition)
    runner.calls.length = 0
    expect(await installer.uninstall()).toEqual({ ok: true, value: { removed: true, location: unitPath, hints: [] } })
    expect(runner.calls).toEqual([
      'systemctl --user disable --now message-summarize.service',
      'systemctl --user daemon-reload',
    ])
    expect(files.map.size).toBe(0)
    runner.calls.length = 0
    expect(await installer.uninstall()).toEqual({ ok: true, value: { removed: false, location: unitPath, hints: [] } })
    expect(runner.calls).toEqual([])
  })

  it('uninstall removes the unit even when disable fails (never enabled), and reports a failing reload', async () => {
    const files = new MemoryFiles()
    files.map.set(unitPath, 'x')
    const runner = new FakeRunner((line) =>
      line.includes('disable') || line.includes('reload') ? done(1, '', 'no') : done(0),
    )
    const result = await new SystemdInstaller(host('linux', runner, files)).uninstall()
    expect(result).toEqual({ ok: false, error: { step: 'systemctl daemon-reload', detail: 'no' } })
    expect(files.map.size).toBe(0)
  })

  it('startNow false enables without --now when the unit is not running, and never restarts', async () => {
    const runner = new FakeRunner((line) => (line.includes('is-active') ? done(3, 'inactive\n') : done(0)))
    const files = new MemoryFiles()
    files.map.set(unitPath, 'old unit')
    await new SystemdInstaller(host('linux', runner, files)).install({ ...definition, startNow: false })
    expect(runner.calls).toEqual([
      'systemctl --user is-active message-summarize.service',
      'systemctl --user daemon-reload',
      'systemctl --user enable message-summarize.service',
    ])
  })

  it('startNow false still restarts a unit that the service is running', async () => {
    const runner = new FakeRunner((line) => (line.includes('is-active') ? done(0, 'active\n') : done(0)))
    const files = new MemoryFiles()
    files.map.set(unitPath, 'old unit')
    await new SystemdInstaller(host('linux', runner, files)).install({ ...definition, startNow: false })
    expect(runner.calls).toContain('systemctl --user restart message-summarize.service')
  })

  it('a failed install removes the unit it wrote, or puts the old one back', async () => {
    const failing = () =>
      new FakeRunner((line) => (line.startsWith('systemctl --user enable') ? done(1, '', 'no') : done(0)))
    const fresh = new MemoryFiles()
    await new SystemdInstaller(host('linux', failing(), fresh)).install(definition)
    expect(fresh.map.size).toBe(0)
    const old = new MemoryFiles()
    old.map.set(unitPath, 'old unit')
    const runner = failing()
    await new SystemdInstaller(host('linux', runner, old)).install(definition)
    expect(old.map.get(unitPath)).toBe('old unit')
    expect(runner.calls.at(-1)).toBe('systemctl --user daemon-reload')
  })

  it('status: not installed, inactive, active', async () => {
    const files = new MemoryFiles()
    let active = 'inactive\n'
    const runner = new FakeRunner(() => done(active === 'active\n' ? 0 : 3, active))
    const installer = new SystemdInstaller(host('linux', runner, files))
    expect(await installer.status()).toEqual({ installed: false, location: unitPath, running: false })
    expect(runner.calls).toEqual([])
    files.map.set(unitPath, 'x')
    expect(await installer.status()).toEqual({ installed: true, location: unitPath, running: false })
    active = 'active\n'
    expect(await installer.status()).toEqual({ installed: true, location: unitPath, running: true })
    expect(runner.calls).toEqual([
      'systemctl --user is-active message-summarize.service',
      'systemctl --user is-active message-summarize.service',
    ])
  })
})

describe('Run key (Windows)', () => {
  const win: ServiceDefinition = {
    command: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ana Perez\\msum\\dist\\main\\cli.js', 'daemon'],
    env: { MSUM_DATA_DIR: "C:\\Users\\Ana Perez\\O'Neil\\data" },
    dataDir: 'C:\\Users\\Ana Perez\\AppData\\Roaming\\message-summarize',
    logsDir: 'C:\\Users\\Ana Perez\\AppData\\Roaming\\message-summarize\\logs',
    startNow: true,
  }
  const launcherPath = 'C:\\Users\\Ana Perez\\AppData\\Roaming\\message-summarize\\daemon-launcher.ps1'
  const line = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}"`
  const windows = (files: MemoryFiles, runner: CommandRunner) =>
    new WindowsRunKeyInstaller(host('win32', runner, files, { dataDir: win.dataDir, uid: null }))

  /** `reg query` fails until `reg add` ran, and then shows the value like reg.exe does. */
  const reg = (state: { value: string | null }) =>
    new FakeRunner((call) => {
      if (call.startsWith('reg query')) {
        return state.value === null
          ? done(1, '', 'ERROR: unable to find')
          : done(0, `\n    message-summarize    REG_SZ    ${state.value}\n`)
      }
      if (call.startsWith('reg add')) {
        state.value = call.slice(call.indexOf('/d ') + 3, call.lastIndexOf(' /f'))
        return done(0)
      }
      if (call.startsWith('reg delete')) {
        state.value = null
        return done(0)
      }
      return done(0)
    })

  it('writes the exact launcher: BOM, CRLF, quoted values, loop with backoff, ends when its file is gone', () => {
    expect(launcherScript(win)).toBe(
      `\uFEFF${[
        '# Generated by "msum service install". It starts the daemon and starts it again after a crash.',
        "$ErrorActionPreference = 'Continue'",
        "$env:MSUM_DATA_DIR = 'C:\\Users\\Ana Perez\\O''Neil\\data'",
        '$delay = 5',
        'while ($true) {',
        '  if (-not (Test-Path -LiteralPath $PSCommandPath)) { exit 0 }',
        '  $started = Get-Date',
        "  & 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Ana Perez\\msum\\dist\\main\\cli.js' 'daemon' *> $null",
        '  if ($LASTEXITCODE -eq 0) { exit 0 }',
        '  if (((Get-Date) - $started).TotalSeconds -ge 60) { $delay = 5 }',
        '  Start-Sleep -Seconds $delay',
        '  $delay = [Math]::Min($delay * 2, 20)',
        '}',
        '',
      ].join('\r\n')}`,
    )
  })

  it('doubles the typographic quotes too and rejects a bad variable name', () => {
    expect(launcherScript({ ...win, env: { A: 'x\u2019y' } })).toContain("$env:A = 'x\u2019\u2019y'")
    expect(() => launcherScript({ ...win, env: { 'A B': 'x' } })).toThrow('invalid variable name')
    expect(() => launcherScript({ ...win, command: [] })).toThrow('no command')
  })

  it('the Run value starts PowerShell hidden on the launcher', () => {
    expect(runCommandLine(launcherPath)).toBe(line)
  })

  it('installs: launcher in the data dir and a reg add of the Run value, no admin, no scheduler', async () => {
    const state = { value: null as string | null }
    const runner = reg(state)
    const files = new MemoryFiles()
    const result = await windows(files, runner).install(win)
    const location = `${RUN_KEY}\\message-summarize`
    expect(result).toEqual({ ok: true, value: { location, changed: true, hints: ['startAtNextLogin'] } })
    expect(files.map.get(launcherPath)).toBe(launcherScript(win))
    expect(runner.calls).toEqual([
      `reg query ${RUN_KEY} /v message-summarize`,
      `reg add ${RUN_KEY} /v message-summarize /t REG_SZ /d ${line} /f`,
    ])
    expect(runner.calls.join('\n')).not.toMatch(/schtasks|sc\.exe|sc create/)
  })

  it('a second install changes nothing; a different launcher is rewritten', async () => {
    const state = { value: null as string | null }
    const runner = reg(state)
    const files = new MemoryFiles()
    const installer = windows(files, runner)
    await installer.install(win)
    runner.calls.length = 0
    const again = await installer.install(win)
    expect(again.ok && again.value.changed).toBe(false)
    expect(runner.calls).toEqual([`reg query ${RUN_KEY} /v message-summarize`])
    const changed = await installer.install({ ...win, env: {} })
    expect(changed.ok && changed.value.changed).toBe(true)
  })

  it('reports a failing reg add', async () => {
    const runner = new FakeRunner((call) =>
      call.startsWith('reg add') ? done(1, '', 'ERROR: Access is denied.') : done(1),
    )
    expect(await windows(new MemoryFiles(), runner).install(win)).toEqual({
      ok: false,
      error: { step: 'reg add', detail: 'ERROR: Access is denied.' },
    })
  })

  it('uninstalls: reg delete and the launcher; with nothing installed it does nothing', async () => {
    const state = { value: null as string | null }
    const runner = reg(state)
    const files = new MemoryFiles()
    const installer = windows(files, runner)
    await installer.install(win)
    runner.calls.length = 0
    const location = `${RUN_KEY}\\message-summarize`
    expect(await installer.uninstall()).toEqual({
      ok: true,
      value: { removed: true, location, hints: ['stopRunningDaemon'] },
    })
    expect(runner.calls).toEqual([
      `reg query ${RUN_KEY} /v message-summarize`,
      `reg delete ${RUN_KEY} /v message-summarize /f`,
    ])
    expect(files.map.size).toBe(0)
    runner.calls.length = 0
    expect(await installer.uninstall()).toEqual({ ok: true, value: { removed: false, location, hints: [] } })
    expect(runner.calls).toEqual([`reg query ${RUN_KEY} /v message-summarize`])
  })

  it('uninstall deletes the launcher the Run value names, even when the data directory changed', async () => {
    const files = new MemoryFiles()
    const elsewhere = 'D:\\old data\\daemon-launcher.ps1'
    files.map.set(elsewhere, 'x')
    files.map.set(launcherPath, 'new location')
    const runner = reg({ value: `powershell.exe -WindowStyle Hidden -File "${elsewhere}"` })
    await windows(files, runner).uninstall()
    expect(files.map.has(elsewhere)).toBe(false)
    expect(files.map.has(launcherPath)).toBe(true)
  })

  it('uninstall never deletes a file that is not named like the launcher', async () => {
    const files = new MemoryFiles()
    const other = 'C:\\Users\\Ana Perez\\precious.txt'
    files.map.set(other, 'x')
    await windows(files, reg({ value: `powershell.exe -File "${other}"` })).uninstall()
    expect(files.map.has(other)).toBe(true)
  })

  it('keeps the launcher when reg delete fails', async () => {
    const files = new MemoryFiles()
    files.map.set(launcherPath, 'x')
    const runner = new FakeRunner((call) => (call.startsWith('reg delete') ? done(1, '', 'ERROR: denied') : done(0)))
    expect(await windows(files, runner).uninstall()).toEqual({
      ok: false,
      error: { step: 'reg delete', detail: 'ERROR: denied' },
    })
    expect(files.map.has(launcherPath)).toBe(true)
  })

  it('cleans a leftover launcher whose value is gone', async () => {
    const files = new MemoryFiles()
    files.map.set(launcherPath, 'x')
    const result = await windows(files, reg({ value: null })).uninstall()
    expect(result.ok && result.value.removed).toBe(true)
  })

  it('status: the value decides, and running is unknown', async () => {
    const state = { value: null as string | null }
    const installer = windows(new MemoryFiles(), reg(state))
    const location = `${RUN_KEY}\\message-summarize`
    expect(await installer.status()).toEqual({ installed: false, location, running: null })
    state.value = line
    expect(await installer.status()).toEqual({ installed: true, location, running: null })
  })
})

describe('createServiceInstaller', () => {
  it('picks the adapter of the platform and none for the others', () => {
    const make = (platform: NodeJS.Platform) =>
      createServiceInstaller(host(platform, new FakeRunner(), new MemoryFiles()))
    expect(make('darwin')).toBeInstanceOf(LaunchdInstaller)
    expect(make('linux')).toBeInstanceOf(SystemdInstaller)
    expect(make('win32')).toBeInstanceOf(WindowsRunKeyInstaller)
    expect(make('freebsd')).toBeNull()
  })
})
